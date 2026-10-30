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
// saying how a human can solve it in the visible browser. A read asked to hand
// it over (`human`) goes one step further and asks the human itself: first a
// native dialog (src/ask.ts, `<PREFIX>_HUMAN_ASK`) asks whether to bring it
// forward now — once for this process's reads, never inside the page — and on
// a yes the tab is brought to the front, a line on stderr names the page, and the read waits —
// the challenge as `wait --clear` does, a consent or sign-in wall until the page
// reads as a page — then reads it from that same tab. With no window anyone can
// see (no display, a headless browser, a CI run) it waits for nobody and comes
// back as it would have without. What covers the page
// (a cookie wall, a consent panel, a modal) is not read for it: the page is
// read from a copy without its overlays, dialogs and consent vendors' containers
// (overlay.ts); --full-page reads the whole document, as it does over HTTP.
//
// Reads are rationed per process (BROWSER_CONCURRENCY, one by default): the
// callers fan out to 4-16 URLs at once, and as many tabs rendering together
// would bury the browser.
//
// A read that finds no browser launches one, and it outlives the read: the next
// read, in this process or another, picks it up. A consumer whose run is over
// calls closeBrowserReads(), which closes it only if a read of this very process
// started it and it is still that browser.

import { type HumanAnswer, humanAskMode, humanAskTimeoutMs } from "../ask.js";
import { brand, envInt, envName } from "../brand.js";
import { type ExtractResult, extractFromHtml } from "../fetch.js";
import type { CdpHandler } from "./cdp.js";
import { type Challenge, detectChallenge } from "./challenge.js";
import { browserDeps, type BrowserDeps } from "./deps.js";
import { isSameBrowser, type LaunchOptions, socketPath } from "./launch.js";
import { loopbackSocketUrl } from "./discovery.js";
import { canShowWindow, type HumanHandoff, humanWall } from "./mode.js";
import { READ_DOCUMENT } from "./overlay.js";
import { type BrowserSession, closeLaunched, openBrowserSession } from "./session.js";
import { readSession, withBrowserLock } from "./state.js";
import { WaitTimeoutError, waitFor } from "./wait.js";

/** How long the default read waits for a quiet network after load. */
const IDLE_CAP_MS = 3000;
/** What the browser may read: a PDF or a download is the fetch's document ladder's to read. */
const WEB_PAGE = /^(?:text\/html|application\/xhtml\+xml)$/i;
/** How long a human has to get past a wall, by default: as long as `wait --clear` gives them. */
const HUMAN_TIMEOUT_MS = 300_000;
/** The default wait for a human: HUMAN_TIMEOUT_MS, 10 s to an hour, 5 minutes unset. Read at each read: the env may change between them. */
const humanTimeoutMs = (): number => envInt("HUMAN_TIMEOUT_MS", HUMAN_TIMEOUT_MS, 10_000, 3_600_000);
/** How often a sign-in or consent wall is looked at again while the human works. */
const WALL_POLL_MS = 1000;
/** How long the page a cleared wall leads to may take to load before it is read as it is. */
const AFTER_WALL_LOAD_MS = 10_000;

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
  /**
   * Hand a page that needs a human to the human (HumanHandoff): on a blocking
   * challenge, or a consent or sign-in wall, the read brings its tab up in the
   * visible browser, says on stderr which page needs them, and waits for the
   * wall to go — on top of `timeoutMs` — before reading it. The person is asked
   * first (`ask`, `<PREFIX>_HUMAN_ASK`). The result says how that went in
   * `handoff`. Off by default: a read never waits on anyone unasked.
   */
  human?: boolean | HumanHandoff;
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

// --- the browser this process's reads launched ---------------------------------

/** How long closeBrowserReads waits by default for the reads still in flight. */
const DRAIN_MS = 5000;

interface Launched {
  host: string;
  port: number;
  /** The browser socket: its path (a GUID drawn at each start) tells this browser from any later one on the port. */
  wsBrowserUrl: string;
  pid?: number;
  /** The seams the launching read ran with: closing goes through the same ones. */
  deps: BrowserDeps;
}

/** Set by a read that spawned the browser, in this process only; cleared by closeBrowserReads. */
let launched: Launched | undefined;
/** Every read of this process not finished yet, its tab's cleanup included. */
const inflight = new Set<Promise<unknown>>();

function track<T>(p: Promise<T>): Promise<T> {
  inflight.add(p);
  const done = () => inflight.delete(p);
  p.then(done, done);
  return p;
}

export interface CloseReadsOptions {
  /** How long to wait for the reads still in flight in this process; 5 s by default. */
  waitMs?: number;
  /** The seams to close through; by default, the ones the launching read used. */
  deps?: Partial<BrowserDeps>;
}

/**
 * Close the browser that a read of this process launched, at the end of a
 * consumer's run: once the reads still in flight here are done (or after
 * `waitMs`), and only if the browser answering on its port is still that one
 * (`Browser.close`, then SIGTERM to its pid if it refuses). A browser the reads
 * only reused, one named with `cdp`, one an agent's session has taken over since,
 * or nothing launched at all: `{ closed: false }`, untouched. Reads of other
 * processes are not waited for. Never throws; a second call is a no-op.
 */
export async function closeBrowserReads(opts: CloseReadsOptions = {}): Promise<{ closed: boolean }> {
  try {
    if (inflight.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<void>((r) => {
        timer = setTimeout(r, opts.waitMs ?? DRAIN_MS);
        timer.unref?.();
      });
      await Promise.race([Promise.allSettled([...inflight]), bound]);
      clearTimeout(timer);
    }
    const ours = launched;
    launched = undefined;
    if (!ours) return { closed: false };
    const deps = opts.deps ? browserDeps({ ...ours.deps, ...opts.deps }) : ours.deps;
    if (!(await isSameBrowser(deps, ours.port, ours.host, ours.wsBrowserUrl))) return { closed: false };
    // `browser open` (another process) may have found it on the profile and made it the agent's: theirs now.
    const saved = readSession();
    if (saved?.wsBrowserUrl && socketPath(saved.wsBrowserUrl) === socketPath(ours.wsBrowserUrl)) return { closed: false };
    let cdp: Awaited<ReturnType<BrowserDeps["connectCdp"]>>;
    try {
      cdp = await deps.connectCdp(loopbackSocketUrl(ours.wsBrowserUrl));
    } catch {
      // It answered as ours a moment ago: its pid is still the one we started.
      if (ours.pid === undefined) return { closed: false };
      deps.kill(ours.pid, "SIGTERM");
      return { closed: true };
    }
    try {
      await closeLaunched(cdp, ours.pid, deps);
    } finally {
      await cdp.close();
    }
    return { closed: true };
  } catch {
    return { closed: false };
  }
}

// --- the read ----------------------------------------------------------------

/** What one evaluate brings back of the rendered page, all of it (--full-page). */
const WHOLE_DOCUMENT = "({ html: document.documentElement ? document.documentElement.outerHTML : '', url: location.href })";

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
  if (session.spawned) {
    const { host, port, pid, browserSocket } = session;
    launched = { host, port, wsBrowserUrl: browserSocket, ...(pid !== undefined ? { pid } : {}), deps };
  }
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
    // Asked at each read: the page a human gets through to is a document of its own, with its own status.
    const statusNow = () => status ?? nav.status ?? 200;
    const code = statusNow();
    const take = async (): Promise<ExtractResult> => {
      const got = await page.send<{ result?: { value?: { html?: unknown; url?: unknown } } }>(
        "Runtime.evaluate",
        { expression: opts.fullPage ? WHOLE_DOCUMENT : READ_DOCUMENT, returnByValue: true },
        { timeoutMs },
      );
      const finalUrl = typeof got.result?.value?.url === "string" ? got.result.value.url : nav.url;
      const html = typeof got.result?.value?.html === "string" ? got.result.value.html : "";
      return { ...extractFromHtml(html, finalUrl, opts), finalUrl, status: statusNow(), extractor: "browser" };
    };
    const challenge = await detectChallenge(session);
    const first = await take();
    const blocked = (c: Challenge): ExtractResult => ({
      text: "",
      finalUrl: first.finalUrl,
      status: code >= 400 ? code : 403,
      extractor: "browser",
      note: `${c.kind} challenge — open it with \`${brand().cli} browser open ${url}\` and let the human solve it`,
    });
    const asIs = challenge?.blocking ? blocked(challenge) : first;
    if (!opts.human) return asIs;
    const found = challenge?.blocking ? `${challenge.kind} challenge` : humanWall(first.text);
    if (!found) return first;
    const wall = `${/^[aeiou]/i.test(found) ? "an" : "a"} ${found}`;
    // Nobody to show it to: no wait, the read as it would have been.
    const nobody = session.headless ? "the browser runs headless" : canShowWindow(deps.platform) ? undefined : "no window can be shown here";
    if (nobody) return { ...asIs, note: [asIs.note, `It needs a human, and ${nobody}.`].filter(Boolean).join(" "), handoff: "no-window" };
    const human = opts.human === true ? {} : opts.human;
    // Asked before anything comes forward: once for this process's reads, never inside the page.
    const asks = askFirst(human, deps);
    const answer = asks === "never" ? "never" : asks === "ask" ? await answerFor(url, found, deps) : "unavailable";
    if (answer === "never" || answer === "later" || answer === "no-answer") {
      const why =
        answer === "never"
          ? `It needs a human, and handoffs are off (${envName("HUMAN_ASK")}=never).`
          : answer === "later"
            ? "It needs a human, who chose to get past it later."
            : "It needs a human, and nobody answered the question whether to bring it forward.";
      return { ...asIs, note: [asIs.note, why].filter(Boolean).join(" "), handoff: "declined" };
    }
    const cleared = await handOff(session, url, wall, !!challenge?.blocking, human, deps, take, opts.signal);
    // Said yes, and nobody got past it: nobody is there now, and the next page is not brought forward either.
    if (answer === "solve" && !cleared) answered = { answer: "no-answer", at: deps.now() };
    if (answer === "solve" && cleared) await deps.notifyHuman(1, 1).catch(() => false);
    // A challenge that clears in place leaves its own 403 as the last document heard: the page is read, so it is a 200.
    if (cleared)
      return {
        ...cleared,
        status: cleared.status >= 400 ? 200 : cleared.status,
        note: [cleared.note, `Read after a human got past ${wall}.`].filter(Boolean).join(" "),
        handoff: "cleared",
      };
    const secs = Math.round((human.timeoutMs ?? humanTimeoutMs()) / 1000);
    return { ...asIs, note: [asIs.note, `Nobody got past it within ${secs} s.`].filter(Boolean).join(" "), handoff: "timeout" };
  } finally {
    page.off("Network.responseReceived", onResponse);
    // Over HTTP, so the tab goes even when the socket already has.
    await deps.discovery.closeTarget(session.port, session.targetId, session.host).catch(() => {});
    await session.detach();
  }
}

// --- asking the person first ---------------------------------------------------

/** How long one answer holds for the reads of this process: one question per batch, not one per page. */
const ANSWER_HOLDS_MS = 600_000;
/** How long past the question's own give-up time a read waits for its answer. */
const ASK_GRACE_MS = 15_000;
let answered: { answer: HumanAnswer; at: number } | undefined;
let asking: Promise<HumanAnswer> | undefined;

/** Whether this handoff asks first (`ask`), hands the page over unasked (`hand`), or hands nothing over (`never`). */
function askFirst(human: HumanHandoff, deps: BrowserDeps): "ask" | "hand" | "never" {
  if (human.ask === false) return "hand";
  if (human.ask === true) return "ask";
  const mode = humanAskMode(deps.env("HUMAN_ASK") ?? "ask");
  return mode === "always" ? "hand" : mode;
}

/**
 * The person's answer for this process's reads: asked once (reads in flight
 * together share the one question), then held for ANSWER_HOLDS_MS.
 */
function answerFor(url: string, check: string, deps: BrowserDeps): Promise<HumanAnswer> {
  if (answered && deps.now() - answered.at < ANSWER_HOLDS_MS) return Promise.resolve(answered.answer);
  asking ??= deps
    .askHuman([{ url, check }])
    .catch((): HumanAnswer => "unavailable")
    .then((answer) => {
      answered = { answer, at: deps.now() };
      asking = undefined;
      return answer;
    });
  return asking;
}

/** Test seam: forget the person's last answer. */
export function forgetHumanAnswer(): void {
  answered = undefined;
  asking = undefined;
}

/**
 * Put the tab in front of the human, say which page needs them, and wait until
 * the wall is gone: a challenge as `wait --clear` waits for it (two clear looks
 * in a row), then — that one gone, or a consent or sign-in wall from the start —
 * until the page reads as a page. Returns that read, or undefined when the wall
 * was still up at the end of the human's time.
 */
async function handOff(
  session: BrowserSession,
  url: string,
  wall: string,
  challenged: boolean,
  human: HumanHandoff,
  deps: BrowserDeps,
  take: () => Promise<ExtractResult>,
  signal: AbortSignal | undefined,
): Promise<ExtractResult | undefined> {
  const tell = human.tell ?? ((m: string) => void process.stderr.write(`${m}\n`));
  const timeoutMs = human.timeoutMs ?? humanTimeoutMs();
  const start = deps.now();
  const left = () => timeoutMs - (deps.now() - start);
  const { cli, name } = brand();
  // Only now does the browser come forward: the reads keep it in the background, small, in a corner.
  const restore = await session.showToHuman();
  tell(
    `${cli}: ${url} is behind ${wall}. It is open in the ${name} browser window (its own profile, not your browser): ` +
      `get past it there and the read goes on by itself — waiting up to ${Math.round(timeoutMs / 1000)} s.`,
  );
  try {
    if (challenged) await waitFor(session, { clear: true }, { timeoutMs, deps, ...(signal ? { signal } : {}) });
    for (;;) {
      // What the wall gave way to may still be loading: a bounded wait, then read it as it is.
      await waitFor(session, { load: true }, { timeoutMs: Math.max(1, Math.min(AFTER_WALL_LOAD_MS, left())), deps }).catch(() => {});
      const challenge = await detectChallenge(session);
      if (!challenge?.blocking) {
        const r = await take();
        if (!humanWall(r.text)) {
          tell(`${cli}: got past it — read ${url}.`);
          return r;
        }
      }
      if (left() <= 0) break;
      if (signal?.aborted) throw new Error(`reading ${url} in the browser was cancelled`);
      await deps.sleep(Math.min(WALL_POLL_MS, left()));
    }
  } catch (e) {
    if (!(e instanceof WaitTimeoutError)) throw e;
  } finally {
    await restore();
  }
  tell(`${cli}: ${url} is still behind ${wall} after ${Math.round(timeoutMs / 1000)} s — read without it.`);
  return undefined;
}

/**
 * Render `url` in a scratch tab of the dedicated browser and extract it as
 * fetchAndExtract would have (`extractor: "browser"`; `status` is the main
 * document's HTTP status). Throws when the browser cannot be had or the page
 * cannot be loaded, when the read runs out of time, and when it is cancelled.
 */
export function readRenderedPage(url: string, opts: ReadPageOptions = {}): Promise<ExtractResult> {
  return track(read(url, opts));
}

async function read(url: string, opts: ReadPageOptions): Promise<ExtractResult> {
  const cancelled = () => new Error(`reading ${url} in the browser was cancelled`);
  const { signal } = opts;
  if (signal?.aborted) throw cancelled();
  const deps = browserDeps(opts.deps);
  const timeoutMs = opts.timeoutMs ?? envInt("BROWSER_TIMEOUT_MS", 30_000, 5000, 300_000);
  // A handoff waits for the human on top of the render: the load before it, the read after it.
  const human = opts.human === true ? {} : opts.human || undefined;
  // …and, when it asks first, on top of the question.
  const humanMs = human ? (human.timeoutMs ?? humanTimeoutMs()) + (askFirst(human, deps) === "ask" ? humanAskTimeoutMs() + ASK_GRACE_MS : 0) : 0;
  const release = await acquire(envInt("BROWSER_CONCURRENCY", 1, 1, 4), signal, cancelled);
  if (signal?.aborted) {
    release();
    throw cancelled();
  }
  const run: Run = { stopped: false };
  // Tracked on its own: it may still be closing its tab after the caller stopped waiting.
  const work = track(render(url, opts, deps, timeoutMs, run));
  // The slot is given back once the tab is closed, not when the caller stops waiting.
  work.then(release, release);
  let stop!: (e: Error) => void;
  const cut = new Promise<never>((_, reject) => {
    stop = reject;
  });
  const budgetMs = humanMs ? 2 * timeoutMs + humanMs : timeoutMs;
  const timer = setTimeout(() => stop(new Error(`reading ${url} in the browser did not finish within ${budgetMs} ms`)), budgetMs);
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
