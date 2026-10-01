// Waiting: explicit conditions (`waitFor`) and the stabilisation after an
// action (`settle`). Both poll through the injected `now`/`sleep`, so tests run
// on a fake clock.

import type { CdpHandler, CdpSession } from "./cdp.js";
import { detectChallenge } from "./challenge.js";
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
}

export interface WaitResult {
  waitedMs: number;
}

export class WaitTimeoutError extends Error {
  constructor(
    readonly condition: WaitCondition,
    readonly elapsedMs: number,
  ) {
    super(`timed out waiting for ${JSON.stringify(condition)} after ${elapsedMs} ms`);
    this.name = "WaitTimeoutError";
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
  // clear: no blocking challenge on two polls in a row
  let streak = 0;
  return async () => {
    const c = await detectChallenge({ page });
    streak = c?.blocking ? 0 : streak + 1;
    return streak >= 2;
  };
}

/** Poll until the condition holds; throw WaitTimeoutError when it does not within the timeout. */
export async function waitFor(session: WaitSession, cond: WaitCondition, opts: WaitOptions = {}): Promise<WaitResult> {
  const present = KEYS.filter((k) => k in cond);
  if (present.length !== 1) throw new TypeError(`invalid wait condition ${JSON.stringify(cond)}: give exactly one of ${KEYS.join(", ")}`);
  const { now, sleep } = browserDeps(opts.deps);
  const start = now();
  if ("ms" in cond) {
    await sleep(cond.ms);
    return { waitedMs: now() - start };
  }
  const timeoutMs = opts.timeoutMs ?? ("clear" in cond ? CLEAR_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const net = "idle" in cond ? await watchNetwork(session.page) : undefined;
  try {
    const check = checker(session.page, cond, now, net);
    for (;;) {
      if (await check()) return { waitedMs: now() - start };
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
  /** The main frame started loading another document right after the action. */
  navigated: boolean;
  waitedMs: number;
}

/**
 * After an action: if it started a navigation (within ~150 ms), wait for that
 * document's `load`; then wait for the network to be quiet (at most 2 requests in
 * flight for 300 ms). Bounded by the timeout, and never throws on it: a page that
 * keeps polling is as settled as it will get.
 */
export async function settle(session: WaitSession, opts: SettleOptions = {}): Promise<SettleResult> {
  const { page } = session;
  const { now, sleep } = browserDeps(opts.deps);
  const timeoutMs = opts.timeoutMs ?? SETTLE_TIMEOUT_MS;
  const start = now();
  const deadline = start + timeoutMs;

  let mainId: string | undefined;
  try {
    mainId = (await page.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree")).frameTree.frame.id;
  } catch {
    /* a main frame announced by frameNavigated will do */
  }
  let navigating = false;
  let loaded = false;
  const handlers: [string, CdpHandler][] = [
    [
      "Page.frameStartedLoading",
      (p) => {
        if (p.frameId !== mainId) return;
        navigating = true;
        loaded = false;
      },
    ],
    [
      "Page.frameNavigated",
      (p) => {
        if (p.frame?.parentId) return;
        mainId ??= p.frame?.id;
        navigating = true;
        loaded = false;
      },
    ],
    [
      "Page.lifecycleEvent",
      (p) => {
        if (p.name === "load" && p.frameId === mainId) loaded = true;
      },
    ],
  ];
  for (const [m, h] of handlers) page.on(m, h);
  const net = await watchNetwork(page);
  const done = (navigated: boolean): SettleResult => ({ navigated, waitedMs: now() - start });
  try {
    // Did the action start a navigation?
    while (!navigating && now() - start < SETTLE_NAV_WINDOW_MS && now() < deadline) await sleep(Math.min(SETTLE_STEP_MS, deadline - now()));
    const navigated = navigating;
    // Let it load.
    while (navigated && !loaded && now() < deadline) await sleep(Math.min(SETTLE_STEP_MS, deadline - now()));
    // Quiet network: counted from the load (or from the start, if nothing navigated).
    let quietSince = navigated ? undefined : start;
    while (now() < deadline) {
      if (net.count() > SETTLE_MAX_INFLIGHT) quietSince = undefined;
      else quietSince ??= now();
      if (quietSince !== undefined && now() - quietSince >= SETTLE_QUIET_MS) break;
      await sleep(Math.min(SETTLE_STEP_MS, deadline - now()));
    }
    return done(navigated);
  } finally {
    for (const [m, h] of handlers) page.off(m, h);
    net.stop();
  }
}
