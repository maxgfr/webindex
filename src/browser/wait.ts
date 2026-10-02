// Waiting: explicit conditions (`waitFor`) and the stabilisation after an
// action (`settle`). Both poll through the injected `now`/`sleep`, so tests run
// on a fake clock.

import { brand } from "../brand.js";
import type { CdpHandler, CdpSession } from "./cdp.js";
import { probeChallenge } from "./challenge.js";
import { type BrowserDeps, browserDeps } from "./deps.js";

export type WaitCondition =
  | { text: string }
  | { gone: string }
  | { selector: string }
  | { url: string }
  | { load: true }
  | { idle: true }
  | { ms: number }
  | { clear: true };

export interface WaitOptions {
  /** 30 s, or 300 s for `clear` (a human solving a captcha). */
  timeoutMs?: number;
  deps?: Partial<BrowserDeps>;
  /** Stops the wait between two polls (an MCP client's cancel): it rejects with WaitCancelledError. */
  signal?: AbortSignal;
}

export interface WaitResult {
  waitedMs: number;
  /** Which condition held: "text", "gone", "selector", "url", "load", "idle", "ms" or "clear". */
  matched: string;
}

/** The failed condition in words: what the agent should read, not the JSON it was given. */
function timeoutText(c: WaitCondition, elapsedMs: number): string {
  if ("text" in c) return `text ${JSON.stringify(c.text)} did not appear after ${elapsedMs} ms`;
  if ("gone" in c) return `text ${JSON.stringify(c.gone)} is still on the page after ${elapsedMs} ms`;
  if ("selector" in c) return `no element matches ${JSON.stringify(c.selector)} after ${elapsedMs} ms`;
  if ("url" in c) return `the url did not match ${JSON.stringify(c.url)} after ${elapsedMs} ms`;
  if ("load" in c) return `the page did not finish loading after ${elapsedMs} ms`;
  if ("idle" in c) return `the network did not go idle after ${elapsedMs} ms`;
  if ("clear" in c)
    return `the challenge is still there after ${elapsedMs} ms — a human must solve it in the browser window (\`${brand().cli} browser open <url>\` shows it), then run wait --clear again`;
  return `timed out after ${elapsedMs} ms`;
}

export class WaitTimeoutError extends Error {
  constructor(
    readonly condition: WaitCondition,
    readonly elapsedMs: number,
  ) {
    super(timeoutText(condition, elapsedMs));
    this.name = "WaitTimeoutError";
  }
}

/** A wait stopped by its signal before its condition held. */
export class WaitCancelledError extends Error {
  constructor() {
    super("the wait was cancelled");
    this.name = "WaitCancelledError";
  }
}

const POLL_MS = 250;
const DEFAULT_TIMEOUT_MS = 30_000;
const CLEAR_TIMEOUT_MS = 300_000;
/** A page showing a dialog never answers Runtime.evaluate; that poll just counts as "not yet". */
const EVAL_TIMEOUT_MS = 2000;
const IDLE_MS = 500;

const SETTLE_NAV_WINDOW_MS = 150;
const SETTLE_STEP_MS = 50;
const SETTLE_QUIET_MS = 300;
const SETTLE_MAX_INFLIGHT = 2;
const SETTLE_TIMEOUT_MS = 5000;

/** What the waits need of a session: the tab's flat CDP session. */
export interface WaitSession {
  page: CdpSession;
}

// --- network -------------------------------------------------------------------

/** Count requests in flight from the moment it is created. Network is enabled, and left on. */
async function watchNetwork(page: CdpSession) {
  const inflight = new Set<string>();
  const handlers: [string, CdpHandler][] = [
    ["Network.requestWillBeSent", (p) => inflight.add(String(p.requestId))],
    ["Network.loadingFinished", (p) => inflight.delete(String(p.requestId))],
    ["Network.loadingFailed", (p) => inflight.delete(String(p.requestId))],
  ];
  for (const [m, h] of handlers) page.on(m, h);
  await page.send("Network.enable").catch(() => {});
  return {
    count: () => inflight.size,
    stop: () => {
      for (const [m, h] of handlers) page.off(m, h);
    },
  };
}

// --- conditions ------------------------------------------------------------------

async function evaluate(page: CdpSession, expression: string): Promise<unknown> {
  try {
    const r = await page.send<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression, returnByValue: true }, { timeoutMs: EVAL_TIMEOUT_MS });
    return r.result?.value;
  } catch {
    // The context goes away while the page navigates: ask again next poll.
    return undefined;
  }
}

/** `/re/flags` is a regex, a pattern with `*` a glob over the whole url, anything else a substring. */
function urlMatcher(pattern: string): (url: string) => boolean {
  const re = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (re) {
    try {
      const rx = new RegExp(re[1] as string, re[2]);
      return (u) => rx.test(u);
    } catch {
      /* not a regex after all: a substring */
    }
  }
  if (pattern.includes("*")) {
    const rx = new RegExp(
      `^${pattern
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    );
    return (u) => rx.test(u);
  }
  return (u) => u.includes(pattern);
}

const KEYS = ["text", "gone", "selector", "url", "load", "idle", "ms", "clear"] as const;

/** One poll of a condition: true when it holds. */
type Check = () => Promise<boolean>;

function checker(page: CdpSession, cond: WaitCondition, now: () => number, net: { count(): number } | undefined): Check {
  const hasText = (t: string) => evaluate(page, `(document.body ? document.body.innerText : "").includes(${JSON.stringify(t)})`);
  if ("text" in cond) return async () => (await hasText(cond.text)) === true;
  if ("gone" in cond) return async () => (await hasText(cond.gone)) === false;
  if ("selector" in cond) {
    const sel = JSON.stringify(cond.selector);
    return async () =>
      (await evaluate(
        page,
        `(() => { try { const el = document.querySelector(${sel}); return !!el && el.getClientRects().length > 0; } catch { return false; } })()`,
      )) === true;
  }
  if ("url" in cond) {
    const match = urlMatcher(cond.url);
    return async () => {
      const href = await evaluate(page, "location.href");
      return typeof href === "string" && match(href);
    };
  }
  if ("load" in cond) return async () => (await evaluate(page, 'document.readyState === "complete"')) === true;
  if ("idle" in cond) {
    let quietSince: number | undefined;
    return async () => {
      if ((net?.count() ?? 0) > 0) {
        quietSince = undefined;
        return false;
      }
      quietSince ??= now();
      return now() - quietSince >= IDLE_MS;
    };
  }
  // clear: no blocking challenge on two polls in a row. A probe that could not
  // run (a timeout, a page mid-navigation, a page error) says nothing: it breaks
  // the streak, or a wall still up would end the human's turn.
  let streak = 0;
  return async () => {
    const probe = await probeChallenge({ page });
    streak = probe.ok && !probe.challenge?.blocking ? streak + 1 : 0;
    return streak >= 2;
  };
}

/** Poll until the condition holds; throw WaitTimeoutError when it does not within the timeout. */
export async function waitFor(session: WaitSession, cond: WaitCondition, opts: WaitOptions = {}): Promise<WaitResult> {
  const present = KEYS.filter((k) => k in cond);
  if (present.length !== 1) throw new TypeError(`invalid wait condition ${JSON.stringify(cond)}: give exactly one of ${KEYS.join(", ")}`);
  const { now, sleep } = browserDeps(opts.deps);
  const start = now();
  const live = () => {
    if (opts.signal?.aborted) throw new WaitCancelledError();
  };
  if ("ms" in cond) {
    // In poll-sized steps, so that a cancel is heard.
    for (let left = cond.ms; ; left = cond.ms - (now() - start)) {
      live();
      if (left <= 0) break;
      await sleep(Math.min(POLL_MS, left));
    }
    return { waitedMs: now() - start, matched: "ms" };
  }
  const timeoutMs = opts.timeoutMs ?? ("clear" in cond ? CLEAR_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const net = "idle" in cond ? await watchNetwork(session.page) : undefined;
  try {
    const check = checker(session.page, cond, now, net);
    for (;;) {
      live();
      if (await check()) return { waitedMs: now() - start, matched: present[0] as string };
      const elapsed = now() - start;
      if (elapsed >= timeoutMs) throw new WaitTimeoutError(cond, elapsed);
      await sleep(Math.min(POLL_MS, timeoutMs - elapsed));
    }
  } finally {
    net?.stop();
  }
}

// --- settle ----------------------------------------------------------------------

export interface SettleOptions {
  timeoutMs?: number;
  deps?: Partial<BrowserDeps>;
}

export interface SettleResult {
  /** The main frame loaded (or was loading) another document around the action. */
  navigated: boolean;
  waitedMs: number;
}

export interface ArmedSettle {
  /** Wait for what the action set off: its navigation to load, then a quiet network. */
  done(): Promise<SettleResult>;
  /** Release the listeners and the network watch without waiting: for when the action between arm and done failed. Idempotent. */
  cancel(): void;
}

/**
 * Start watching BEFORE the action: the events of a navigation the action
 * starts (and the requests it makes) are gone by the time anyone asks for them
 * afterwards. Everything is registered, and the main frame known, before this
 * resolves. `done()` then waits.
 */
export async function armSettle(session: WaitSession, opts: SettleOptions = {}): Promise<ArmedSettle> {
  const { page } = session;
  const { now, sleep } = browserDeps(opts.deps);
  const timeoutMs = opts.timeoutMs ?? SETTLE_TIMEOUT_MS;

  let mainId: string | undefined;
  let armedLoader: string | undefined;
  // Per frame id, so events that arrive while the main frame id is still unknown are not lost.
  const started = new Set<string>();
  const stopped = new Set<string>();
  /** The loaderId each frame committed ("" when the event did not say). */
  const committed = new Map<string, string>();
  /** The loaderId of every `load` event since the frame started loading ("" when absent). */
  const loads = new Map<string, string[]>();
  const handlers: [string, CdpHandler][] = [
    [
      "Page.frameStartedLoading",
      (p) => {
        const id = String(p.frameId);
        started.add(id);
        stopped.delete(id);
        committed.delete(id);
        loads.delete(id);
      },
    ],
    [
      "Page.frameNavigated",
      (p) => {
        if (p.frame?.parentId) return;
        const id = String(p.frame?.id);
        mainId ??= p.frame?.id;
        started.add(id);
        stopped.delete(id);
        committed.set(id, p.frame?.loaderId ?? "");
      },
    ],
    [
      "Page.lifecycleEvent",
      (p) => {
        if (p.name !== "load") return;
        const id = String(p.frameId);
        loads.set(id, [...(loads.get(id) ?? []), p.loaderId ?? ""]);
      },
    ],
    // A download or a 204 stops loading without ever firing load. Only a stop after a start is the navigation's.
    ["Page.frameStoppedLoading", (p) => started.has(String(p.frameId)) && stopped.add(String(p.frameId))],
  ];
  for (const [m, h] of handlers) page.on(m, h);
  const net = await watchNetwork(page);
  let released = false;
  const stop = () => {
    if (released) return;
    released = true;
    for (const [m, h] of handlers) page.off(m, h);
    net.stop();
  };
  const tree = async (): Promise<{ id?: string; loaderId?: string }> => {
    try {
      const f = (await page.send<{ frameTree: { frame: { id: string; loaderId?: string } } }>("Page.getFrameTree")).frameTree.frame;
      return { id: f.id, loaderId: f.loaderId };
    } catch {
      return {};
    }
  };
  const t = await tree();
  mainId ??= t.id;
  armedLoader = t.loaderId;

  let used = false;
  return {
    async done(): Promise<SettleResult> {
      if (released && !used) return { navigated: false, waitedMs: 0 }; // cancelled
      if (used) throw new Error("this settle was already awaited");
      used = true;
      const start = now();
      const deadline = start + timeoutMs;
      const step = () => sleep(Math.min(SETTLE_STEP_MS, Math.max(deadline - now(), 0)));
      const sawNavigation = () => mainId !== undefined && started.has(mainId);
      /** The navigation's own end: a stop, or the load of the document that is loading (not the old one's). */
      const navigationFinished = () => {
        if (mainId === undefined) return false;
        if (stopped.has(mainId)) return true;
        const commit = committed.get(mainId);
        return (loads.get(mainId) ?? []).some((l) => l === "" || (commit !== undefined ? commit === "" || l === commit : l !== armedLoader));
      };
      try {
        // A document that is not the one we armed on: its navigation went unheard, and it has committed.
        let committedElsewhere = false;
        // The document is still loading: not a navigation, but it is waited for.
        let docLoading = false;
        if (!sawNavigation()) {
          const t = await tree();
          const readyState = await evaluate(page, "document.readyState");
          committedElsewhere = armedLoader !== undefined && t.loaderId !== undefined && t.loaderId !== armedLoader;
          docLoading = typeof readyState === "string" && readyState !== "complete";
          if (committedElsewhere) mainId ??= t.id;
        }
        // The action's own navigation may be about to start: watch for it either way.
        while (!sawNavigation() && now() - start < SETTLE_NAV_WINDOW_MS && now() < deadline) await step();
        // Let it load. Once events show a navigation, the OLD document's readyState says nothing: only its events do.
        const loaded = async () => {
          if (sawNavigation()) return navigationFinished();
          if (committedElsewhere || docLoading) return (await evaluate(page, "document.readyState")) === "complete";
          return true;
        };
        while (now() < deadline && !(await loaded())) await step();
        const navigated = sawNavigation() || committedElsewhere;
        // Quiet network: counted from the load (or from the start, if nothing navigated).
        let quietSince = navigated || docLoading ? undefined : start;
        while (now() < deadline) {
          if (net.count() > SETTLE_MAX_INFLIGHT) quietSince = undefined;
          else quietSince ??= now();
          if (quietSince !== undefined && now() - quietSince >= SETTLE_QUIET_MS) break;
          await step();
        }
        return { navigated, waitedMs: now() - start };
      } finally {
        stop();
      }
    },
    cancel: stop,
  };
}

/**
 * Settle after an action already done: arm and wait in one go. Navigations that
 * began before the call are only seen through the document's state; to catch
 * the events of the action itself, armSettle first and call done() after it.
 */
export async function settle(session: WaitSession, opts: SettleOptions = {}): Promise<SettleResult> {
  return (await armSettle(session, opts)).done();
}
