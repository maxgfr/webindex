// Reading a page the way a browser shows it: the `browser` rung of
// fetchAndExtract (see src/fetch.ts).
//
// Each read renders the URL in a scratch tab of the dedicated browser (the
// launch policy applies: the saved one if we launched it, else a fresh launch;
// never a browser we were only attached to, unless `cdp` names it), waits for load
// and a short quiet spell on the network, takes the DOM as rendered and runs it
// through the same extraction as a fetched page. The tab is closed and the
// socket let go afterwards, whatever happened; the browser keeps running. The
// agent's own tab is never touched and session.json never written: a read in
// the middle of an agent's work does not move it to another tab.
//
// A full-page anti-bot challenge is not fought: the read comes back empty,
// saying how a human can solve it in the visible browser.
//
// Reads are rationed per process (BROWSER_CONCURRENCY, one by default): the
// callers fan out to 4-16 URLs at once, and as many tabs rendering together
// would bury the browser.

import { brand, envInt } from "../brand.js";
import { type ExtractResult, extractFromHtml } from "../fetch.js";
import type { CdpHandler } from "./cdp.js";
import { detectChallenge } from "./challenge.js";
import { browserDeps, type BrowserDeps } from "./deps.js";
import type { LaunchOptions } from "./launch.js";
import { type BrowserSession, openBrowserSession } from "./session.js";
import { withBrowserLock } from "./state.js";
import { waitFor } from "./wait.js";

/** How long the default read waits for a quiet network after load. */
const IDLE_CAP_MS = 3000;
/** What the browser may read: a PDF or a download is the fetch's document ladder's to read. */
const WEB_PAGE = /^(?:text\/html|application\/xhtml\+xml)$/i;

export interface ReadPageOptions extends LaunchOptions {
  /** As fetchAndExtract's: the shape of the text. */
  format?: "text" | "markdown";
  fullPage?: boolean;
  stripConsent?: boolean;
  keepHtml?: boolean;
  /**
   * The whole render, from the moment a tab is free; BROWSER_TIMEOUT_MS
   * (30 s) by default. The tab is closed when it runs out.
   */
  timeoutMs?: number;
  /** Abandons the read, or the wait for a free tab. */
  signal?: AbortSignal;
  /**
   * `load` reads as soon as the page has loaded; `idle` then waits for a quiet
   * network for up to half the timeout. By default, load and up to 3 s of quiet.
   * Waiting for quiet is never fatal: a page that keeps polling is read anyway.
   */
  waitUntil?: "load" | "idle";
}

// --- the per-process ration of tabs -----------------------------------------

let active = 0;
const queue: { limit: number; go: () => void }[] = [];

function pump(): void {
  for (let next = queue[0]; next && active < next.limit; next = queue[0]) {
    queue.shift();
    active++;
    next.go();
  }
}

/** Wait for a free slot (first come, first served); resolves with its release. */
async function acquire(limit: number, signal: AbortSignal | undefined, cancelled: () => Error): Promise<() => void> {
  if (queue.length === 0 && active < limit) active++;
  else {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        queue.splice(queue.indexOf(waiter), 1);
        reject(cancelled());
      };
      const waiter = {
        limit,
        go: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(waiter);
    });
  }
  return () => {
    active--;
    pump();
  };
}

// --- the read ----------------------------------------------------------------

/** What one evaluate brings back of the rendered page. */
const DOCUMENT = "({ html: document.documentElement ? document.documentElement.outerHTML : '', url: location.href })";

interface Run {
  session?: BrowserSession;
  /** Set once the caller stopped waiting: the work winds down at its next step. */
  stopped: boolean;
}

async function render(url: string, opts: ReadPageOptions, deps: BrowserDeps, timeoutMs: number, run: Run): Promise<ExtractResult> {
  const { cdp, profile, headless, binary } = opts;
  // The lock covers the launch and attach only: two processes launching on one
  // profile at once would trip over each other. The read itself is in our own tab.
  const session = await withBrowserLock(
    async () => {
      // Given up on while waiting for the lock: launching a browser now would be for nobody.
      if (run.stopped) throw new Error("stopped");
      // A browser the user only attached is theirs: a background read never borrows it, nor their cookies.
      return openBrowserSession({ cdp, profile, headless, binary, deps, scratch: true, ownOnly: true });
    },
    { deps },
  );
  run.session = session;
  const page = session.page;
  let status: number | undefined;
  let mime: string | undefined;
  let mainFrame: string | undefined;
  // The main frame's document, not a script's or an iframe's; after redirects, the last one.
  const onResponse: CdpHandler = (p) => {
    if (p.type !== "Document" || p.frameId !== mainFrame || typeof p.response?.status !== "number") return;
    status = p.response.status;
    mime = typeof p.response.mimeType === "string" ? p.response.mimeType : undefined;
  };
  try {
    if (run.stopped) throw new Error("stopped");
    mainFrame = (await page.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree")).frameTree.frame.id;
    page.on("Network.responseReceived", onResponse);
    await page.send("Network.enable");
    // A link to a file would land in the user's own Downloads. Refused in this
    // tab only — the agent's tab may legitimately download — and the page is
    // not loaded at all when the browser will not say so.
    await page.send("Page.setDownloadBehavior", { behavior: "deny" }).catch((e: Error) => {
      throw new Error(`could not refuse downloads in the reading tab (${e.message}), so ${url} was not loaded`);
    });
    const nav = await session.navigate(url, { waitUntil: "load", timeoutMs });
    if (mime && !WEB_PAGE.test(mime)) throw new Error(`${url} is not a web page but ${mime}`);
    if (opts.waitUntil !== "load") {
      const idleMs = opts.waitUntil === "idle" ? timeoutMs / 2 : Math.min(IDLE_CAP_MS, timeoutMs);
      await waitFor(session, { idle: true }, { timeoutMs: idleMs, deps }).catch(() => {});
    }
    const challenge = await detectChallenge(session);
    const got = await page.send<{ result?: { value?: { html?: unknown; url?: unknown } } }>(
      "Runtime.evaluate",
      { expression: DOCUMENT, returnByValue: true },
      { timeoutMs },
    );
    const finalUrl = typeof got.result?.value?.url === "string" ? got.result.value.url : nav.url;
    const code = status ?? nav.status ?? 200;
    if (challenge?.blocking) {
      return {
        text: "",
        finalUrl,
        status: code >= 400 ? code : 403,
        extractor: "browser",
        note: `${challenge.kind} challenge — open it with \`${brand().cli} browser open ${url}\` and let the human solve it`,
      };
    }
    const html = typeof got.result?.value?.html === "string" ? got.result.value.html : "";
    return { ...extractFromHtml(html, finalUrl, opts), finalUrl, status: code, extractor: "browser" };
  } finally {
    page.off("Network.responseReceived", onResponse);
    // Over HTTP, so the tab goes even when the socket already has.
    await deps.discovery.closeTarget(session.port, session.targetId, session.host).catch(() => {});
    await session.detach();
  }
}

/**
 * Render `url` in a scratch tab of the dedicated browser and extract it as
 * fetchAndExtract would have (`extractor: "browser"`; `status` is the main
 * document's HTTP status). Throws when the browser cannot be had or the page
 * cannot be loaded, when the read runs out of time, and when it is cancelled.
 */
export async function readRenderedPage(url: string, opts: ReadPageOptions = {}): Promise<ExtractResult> {
  const cancelled = () => new Error(`reading ${url} in the browser was cancelled`);
  const { signal } = opts;
  if (signal?.aborted) throw cancelled();
  const deps = browserDeps(opts.deps);
  const timeoutMs = opts.timeoutMs ?? envInt("BROWSER_TIMEOUT_MS", 30_000, 5000, 300_000);
  const release = await acquire(envInt("BROWSER_CONCURRENCY", 1, 1, 4), signal, cancelled);
  if (signal?.aborted) {
    release();
    throw cancelled();
  }
  const run: Run = { stopped: false };
  const work = render(url, opts, deps, timeoutMs, run);
  // The slot is given back once the tab is closed, not when the caller stops waiting.
  work.then(release, release);
  let stop!: (e: Error) => void;
  const cut = new Promise<never>((_, reject) => {
    stop = reject;
  });
  const timer = setTimeout(() => stop(new Error(`reading ${url} in the browser did not finish within ${timeoutMs} ms`)), timeoutMs);
  const onAbort = () => stop(cancelled());
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([work, cut]);
  } catch (e) {
    // Out of time or cancelled: closing the socket fails whatever the work is
    // waiting on, and its own cleanup closes the tab.
    run.stopped = true;
    work.catch(() => {});
    await run.session?.detach();
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
