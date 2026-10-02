// The one browser session webindex drives, reconnectable across processes.
//
// There is no daemon. Each CLI call resolves the DevTools port (launch.ts),
// connects to the BROWSER-level socket, attaches to the tab it worked on last
// time (port + targetId from session.json) in flat mode, does its work and
// detaches: the browser and the tab stay up, and the next call picks them up
// again. The MCP server keeps one BrowserSession for its whole life instead.
//
// Tabs get short ids (`t1`, `t2`…) for the agent. They are persisted in
// session.json as { tN: targetId } so that `t2` still names the same tab on the
// next call; a tab that appeared since gets the next number, one that is gone is
// dropped.
//
// Closing is asymmetric on purpose: a browser we launched may be shut down, one
// we only attached to (the user's, through --cdp) never is — we only forget it.

import { join } from "node:path";
import { brand } from "../brand.js";
import { CdpError, type CdpClient, type CdpHandler, type CdpSession } from "./cdp.js";
import { type BrowserDeps, browserDeps } from "./deps.js";
import { loopbackSocketUrl, type TargetInfo } from "./discovery.js";
import { type Endpoint, isSameBrowser, type LaunchOptions, readActivePort, resolveEndpoint } from "./launch.js";
import { profileDir } from "./profile.js";
import { clearNetwork, clearRefs, clearSession, readSession, withBrowserLock, writeSession } from "./state.js";

const NAVIGATION_TIMEOUT_MS = 30_000;
const BROWSER_CLOSE_TIMEOUT_MS = 5000;
/** A page showing a dialog on load never answers Runtime.evaluate; the status is not worth waiting for. */
const STATUS_TIMEOUT_MS = 2000;
/**
 * A tab answers the attach at once, unless a JavaScript dialog froze it: the
 * browser hands a dialog only to the connection that saw it open, so the page
 * behind one opened between two commands answers nothing until it is closed.
 */
const ATTACH_TIMEOUT_MS = 5000;
const TAB_ID = /^t([1-9]\d*)$/;

export interface OpenOptions extends LaunchOptions {
  /** Work in a fresh tab instead of the one used last time. */
  newTab?: boolean;
  /** Navigate there once attached. */
  url?: string;
  /**
   * Work in a fresh tab that is nobody's: session.json is never written, so
   * the agent's current tab and tab ids stay as they were. The caller closes
   * the tab when done (a page read for `fetch`, see read.ts).
   */
  scratch?: boolean;
}

export type WaitUntil = "load" | "domcontentloaded" | "none";

export interface NavigateOptions {
  /** Which lifecycle event of the new document to wait for; `load` by default. */
  waitUntil?: WaitUntil;
  timeoutMs?: number;
}

export interface NavigationResult {
  url: string;
  /** Identifies the document; refs taken on another one are stale. */
  loaderId: string;
  /** The HTTP status of the document, when the page exposes it. */
  status?: number;
  /** The new document committed but did not finish loading in time (see navigate). */
  note?: string;
}

export interface BrowserTab {
  id: string;
  targetId: string;
  url: string;
  title: string;
  active: boolean;
}

export interface BrowserStatus {
  alive: boolean;
  port?: number;
  launchedByUs?: boolean;
  profile?: string;
  headless?: boolean;
  targetId?: string;
  url?: string;
  title?: string;
  tabs?: BrowserTab[];
}

export interface CloseOptions {
  /** Also wipe the refs and network logs of every tab, not only ours. */
  all?: boolean;
}

interface FrameInfo {
  id: string;
  loaderId: string;
  url: string;
  urlFragment?: string;
}

interface NavEvent {
  /** `commit`: the main frame's new document committed (Page.frameNavigated). */
  kind: "lifecycle" | "same-document" | "bfcache" | "commit";
  frameId: string;
  loaderId?: string;
  name?: string;
}

const LIFECYCLE: Record<Exclude<WaitUntil, "none">, string> = { load: "load", domcontentloaded: "DOMContentLoaded" };

/** The event waited for did not come in time; any other failure (a cancelled navigation, a closed connection) is not this. */
class NavigationTimeoutError extends Error {}

/** Has this event shown the document `loaderId` committed in that frame? Any lifecycle event of it past the start says so too. */
const committedIn =
  (frameId: string, isNew: (loaderId: string | undefined) => boolean) =>
  (e: NavEvent): boolean =>
    e.frameId === frameId && isNew(e.loaderId) && (e.kind === "commit" || (e.kind === "lifecycle" && e.name !== "init"));

/** What a navigation that committed but has not loaded in time says instead of failing. */
const stillLoading = (timeoutMs: number): string => `still loading after ${timeoutMs} ms — take a snapshot or \`${brand().cli} browser wait --load\``;

// --- tab ids -----------------------------------------------------------------

/** The `tN → targetId` entries of a saved map that are well formed. */
function cleanTabs(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof v !== "object" || v === null) return out;
  for (const [id, targetId] of Object.entries(v)) if (TAB_ID.test(id) && typeof targetId === "string") out[id] = targetId;
  return out;
}

const sameTabs = (a: Record<string, string>, b: Record<string, string>): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

const tabNumber = (id: string): number => Number(TAB_ID.exec(id)?.[1] ?? 0);

/**
 * Bring the map in line with the pages that exist: vanished tabs are dropped,
 * new ones numbered after the highest id the map held — counting the vanished,
 * so a closed `t2` is not handed straight to a different tab — in target id
 * order: /json/list is sorted by recent activity, and ids must not follow it.
 */
function syncTabs(map: Record<string, string>, pages: TargetInfo[]): Record<string, string> {
  const live = new Set(pages.map((p) => p.id));
  let high = 0;
  const out: Record<string, string> = {};
  const kept = new Set<string>();
  for (const [id, targetId] of Object.entries(map)) {
    high = Math.max(high, tabNumber(id));
    if (live.has(targetId) && !kept.has(targetId)) {
      out[id] = targetId;
      kept.add(targetId);
    }
  }
  const unseen = pages.map((p) => p.id).filter((id) => !kept.has(id));
  for (const id of unseen.sort()) out[`t${++high}`] = id;
  return out;
}

/** A tab by short id (or target id). */
function pick(tabs: BrowserTab[], id: string): BrowserTab {
  const tab = tabs.find((t) => t.id === id || t.targetId === id);
  if (!tab) throw new Error(`no tab ${id}: list the tabs to see their ids`);
  return tab;
}

function tabList(map: Record<string, string>, pages: TargetInfo[], current: string): BrowserTab[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  return Object.entries(map)
    .sort(([a], [b]) => tabNumber(a) - tabNumber(b))
    .map(([id, targetId]) => {
      const p = byId.get(targetId);
      return { id, targetId, url: p?.url ?? "", title: p?.title ?? "", active: targetId === current };
    });
}

// --- CDP helpers -------------------------------------------------------------

async function createTarget(cdp: CdpClient): Promise<string> {
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  return targetId;
}

/** Attach in flat mode and enable what every later command relies on. Network stays off: the recorder turns it on. */
async function attachPage(cdp: CdpClient, targetId: string): Promise<string> {
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  const page = cdp.session(sessionId);
  const o = { timeoutMs: ATTACH_TIMEOUT_MS };
  try {
    await Promise.all([
      page.send("Page.enable", undefined, o),
      page.send("Runtime.enable", undefined, o),
      page.send("DOM.enable", undefined, o),
      page.send("Page.setLifecycleEventsEnabled", { enabled: true }, o),
    ]);
  } catch (e) {
    if (e instanceof CdpError || cdp.closed) throw e;
    throw new Error(
      `the tab does not answer; most likely a JavaScript dialog the page opened between commands — answer it in the window, or \`${brand().cli} browser close\``,
    );
  }
  return sessionId;
}

/** A JavaScript dialog as the page announces it (Page.javascriptDialogOpening). */
export interface DialogEvent {
  type: string;
  message: string;
  url?: string;
}

/** Hears a dialog, with the page session that heard it: the one that can answer it. */
export type DialogListener = (d: DialogEvent, page: CdpSession) => void;

/** Ask a browser we launched to quit; kill its pid only if it refused while still connected. */
async function closeLaunched(cdp: CdpClient, pid: number | undefined, deps: BrowserDeps): Promise<void> {
  try {
    await cdp.send("Browser.close", undefined, { timeoutMs: BROWSER_CLOSE_TIMEOUT_MS });
  } catch {
    // A dropped connection means it is going down; a refusal or a hang means it is not.
    if (cdp.closed || pid === undefined) return;
    try {
      deps.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

/** Drop what we kept about a browser: the session, and the refs and network logs of its tabs (or of every tab). */
function forget(targetIds: Iterable<string>, all: boolean | undefined): void {
  clearSession();
  if (all) {
    clearRefs();
    clearNetwork();
    return;
  }
  for (const id of new Set(targetIds)) {
    clearRefs(id);
    clearNetwork(id);
  }
}

// --- the session -------------------------------------------------------------

export class BrowserSession {
  private tabs: Record<string, string>;
  private current: { targetId: string; sessionId: string; page: CdpSession };
  /** Targets closed by this session that /json/list may still report for a moment. */
  private readonly closed = new Set<string>();
  /** Dialog listeners, each bound to the current tab's session and moved with it. */
  private readonly dialogListeners = new Map<DialogListener, CdpHandler>();
  private ended = false;

  /** @internal use openBrowserSession */
  constructor(
    /** The browser-level connection. */
    readonly cdp: CdpClient,
    private readonly endpoint: Endpoint,
    private readonly wsBrowserUrl: string,
    private readonly deps: BrowserDeps,
    targetId: string,
    sessionId: string,
    tabs: Record<string, string>,
    /** A scratch tab's session: it saves nothing. */
    private readonly scratch = false,
  ) {
    this.current = { targetId, sessionId, page: cdp.session(sessionId) };
    this.tabs = tabs;
  }

  get port(): number {
    return this.endpoint.port;
  }
  get host(): string {
    return this.endpoint.host;
  }
  get launchedByUs(): boolean {
    return this.endpoint.launchedByUs;
  }
  get pid(): number | undefined {
    return this.endpoint.pid;
  }
  get profile(): string {
    return this.endpoint.profile;
  }
  get headless(): boolean {
    return this.endpoint.headless;
  }
  /** What the launch had to say (extensions the browser will not load), once: the next call gets nothing. */
  takeNotes(): string[] {
    const notes = this.endpoint.notes ?? [];
    this.endpoint.notes = undefined;
    return notes;
  }
  get targetId(): string {
    return this.current.targetId;
  }
  get sessionId(): string {
    return this.current.sessionId;
  }
  /** The current tab's flat session. It changes with selectTab/newTab/closeTab: read it, do not keep it. */
  get page(): CdpSession {
    return this.current.page;
  }

  /** Write session.json (port, ownership, current tab, tab ids). A no-op once shut down, and for a scratch tab. */
  save(): void {
    if (this.ended || this.scratch) return;
    const { host, port, pid, launchedByUs, profile, headless } = this.endpoint;
    writeSession({
      version: 1,
      ...(host !== "127.0.0.1" ? { host } : {}),
      port,
      wsBrowserUrl: this.wsBrowserUrl,
      ...(pid !== undefined ? { pid } : {}),
      launchedByUs,
      profile,
      headless,
      targetId: this.targetId,
      tabs: this.tabs,
      updatedAt: this.deps.now(),
    });
  }

  // --- page --------------------------------------------------------------------

  private async frame(): Promise<FrameInfo> {
    const { frameTree } = await this.page.send<{ frameTree: { frame: FrameInfo } }>("Page.getFrameTree");
    return frameTree.frame;
  }

  async currentUrl(): Promise<string> {
    const f = await this.frame();
    return f.url + (f.urlFragment ?? "");
  }

  async loaderId(): Promise<string> {
    return (await this.frame()).loaderId;
  }

  async title(): Promise<string> {
    const { targetInfo } = await this.cdp.send<{ targetInfo: { title?: string } }>("Target.getTargetInfo", { targetId: this.targetId });
    return targetInfo.title ?? "";
  }

  /** The document's HTTP status from the Navigation Timing entry; undefined when the page does not say. */
  private async responseStatus(): Promise<number | undefined> {
    try {
      const r = await this.page.send<{ result?: { value?: unknown } }>(
        "Runtime.evaluate",
        { expression: "performance.getEntriesByType('navigation')[0]?.responseStatus", returnByValue: true },
        { timeoutMs: STATUS_TIMEOUT_MS },
      );
      const v = r.result?.value;
      return typeof v === "number" && v > 0 ? v : undefined;
    } catch {
      return undefined;
    }
  }

  private async loaded(): Promise<NavigationResult> {
    const f = await this.frame();
    const status = await this.responseStatus();
    return { url: f.url + (f.urlFragment ?? ""), loaderId: f.loaderId, ...(status !== undefined ? { status } : {}) };
  }

  /**
   * Start recording navigation events BEFORE the command that causes them: the
   * browser may report the new document's lifecycle before it answers the
   * command itself, and an event listened for too late never comes again.
   */
  private watch() {
    const page = this.page;
    const seen: NavEvent[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    /** A beforeunload dialog is up: if it is declined, the navigation will not happen. */
    let leaving = false;
    let cancelled = false;
    const push = (e: NavEvent) => {
      seen.push(e);
      wake?.();
    };
    const handlers: [string, CdpHandler][] = [
      ["Page.lifecycleEvent", (p) => push({ kind: "lifecycle", frameId: p.frameId, loaderId: p.loaderId, name: p.name })],
      ["Page.navigatedWithinDocument", (p) => push({ kind: "same-document", frameId: p.frameId })],
      // A page restored from the back/forward cache fires no lifecycle event. Any other is a new
      // document committing: in the main frame, what a navigation that has not loaded yet has got to.
      [
        "Page.frameNavigated",
        (p) => {
          if (p.type === "BackForwardCacheRestore") push({ kind: "bfcache", frameId: p.frame?.id, loaderId: p.frame?.loaderId });
          else if (p.frame && !p.frame.parentId) push({ kind: "commit", frameId: p.frame.id, loaderId: p.frame.loaderId });
        },
      ],
      ["Page.javascriptDialogOpening", (p) => (leaving = p?.type === "beforeunload")],
      [
        "Page.javascriptDialogClosed",
        (p) => {
          if (leaving && p?.result === false) {
            cancelled = true;
            wake?.();
          }
          leaving = false;
        },
      ],
    ];
    for (const [method, h] of handlers) page.on(method, h);
    const offClose = this.cdp.onClose(() => {
      closed = true;
      wake?.();
    });
    return {
      stop: () => {
        for (const [method, h] of handlers) page.off(method, h);
        offClose();
      },
      /** Whether such an event has come, whatever was waited for. */
      saw: (match: (e: NavEvent) => boolean): boolean => seen.some(match),
      until: (match: (e: NavEvent) => boolean, timeoutMs: number, what: string, cancelledWhat: string) =>
        new Promise<NavEvent>((resolve, reject) => {
          const timer = setTimeout(() => {
            wake = undefined;
            reject(new NavigationTimeoutError(`${what} within ${timeoutMs} ms`));
          }, timeoutMs);
          wake = () => {
            const hit = seen.find(match);
            if (hit) resolve(hit);
            else if (cancelled) reject(new Error(`${cancelledWhat} was cancelled: the page asked to confirm leaving it (beforeunload), and that was declined`));
            else if (closed) reject(new Error("the browser connection closed while waiting for the page to load"));
            else return;
            clearTimeout(timer);
            wake = undefined;
          };
          wake();
        }),
    };
  }

  /**
   * Load `url` in the current tab and wait for the new document's `load` (or
   * `DOMContentLoaded`, or nothing). The tab's refs are cleared: they named
   * nodes of the document that is going away. A navigation the browser refuses
   * (`errorText`: DNS failure, refused connection…) rejects, and so does one
   * that did not even commit in time. One that committed but has not loaded
   * (a cold server, a render-blocking script that holds even DOMContentLoaded)
   * is the page now, still loading: it resolves, with a `note`.
   */
  async navigate(url: string, opts: NavigateOptions = {}): Promise<NavigationResult> {
    const waitUntil = opts.waitUntil ?? "load";
    const timeoutMs = opts.timeoutMs ?? NAVIGATION_TIMEOUT_MS;
    const nav = this.watch();
    try {
      const r = await this.page.send<{ frameId: string; loaderId?: string; errorText?: string }>("Page.navigate", { url }, { timeoutMs });
      if (r.errorText) throw new Error(`navigation to ${url} failed: ${r.errorText}`);
      if (!r.loaderId) {
        // Same document (a fragment): nothing reloads, the refs still hold.
        const f = await this.frame();
        return { url: f.url + (f.urlFragment ?? ""), loaderId: f.loaderId };
      }
      clearRefs(this.targetId);
      if (waitUntil === "none") return { url, loaderId: r.loaderId };
      const name = LIFECYCLE[waitUntil];
      try {
        await nav.until(
          (e) => e.kind === "lifecycle" && e.name === name && e.loaderId === r.loaderId,
          timeoutMs,
          `navigation to ${url} did not reach ${name}`,
          `navigation to ${url}`,
        );
      } catch (e) {
        if (!(e instanceof NavigationTimeoutError) || !nav.saw(committedIn(r.frameId, (l) => l === r.loaderId))) throw e;
        return { ...(await this.loaded()), note: stillLoading(timeoutMs) };
      }
      return await this.loaded();
    } finally {
      nav.stop();
    }
  }

  /**
   * Run a history move or a reload and wait until the main frame shows another
   * document (or the same one, scrolled). One that committed but has not loaded
   * in time resolves with a `note`, as in navigate.
   */
  private async settle(what: string, trigger: (timeoutMs: number) => Promise<unknown>, timeoutMs = NAVIGATION_TIMEOUT_MS): Promise<NavigationResult> {
    const before = await this.frame();
    const nav = this.watch();
    try {
      // The command answers once the new document starts arriving: a slow server holds it as long as the wait itself.
      await trigger(timeoutMs);
      const isNew = (l: string | undefined) => l !== before.loaderId;
      let hit: NavEvent;
      try {
        hit = await nav.until(
          (e) =>
            e.frameId === before.id &&
            (e.kind === "same-document" || e.kind === "bfcache" || (e.kind === "lifecycle" && e.name === "load" && isNew(e.loaderId))),
          timeoutMs,
          `${what} did not reach load`,
          what,
        );
      } catch (e) {
        if (!(e instanceof NavigationTimeoutError) || !nav.saw(committedIn(before.id, isNew))) throw e;
        clearRefs(this.targetId);
        return { ...(await this.loaded()), note: stillLoading(timeoutMs) };
      }
      if (hit.kind !== "same-document") clearRefs(this.targetId);
      return await this.loaded();
    } finally {
      nav.stop();
    }
  }

  private async history(step: -1 | 1, timeoutMs?: number): Promise<NavigationResult> {
    const h = await this.page.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory");
    const entry = h.entries[h.currentIndex + step];
    if (!entry) throw new Error(step < 0 ? "no previous page in this tab's history" : "no next page in this tab's history");
    return this.settle(
      step < 0 ? "going back" : "going forward",
      (t) => this.page.send("Page.navigateToHistoryEntry", { entryId: entry.id }, { timeoutMs: t }),
      timeoutMs,
    );
  }

  back(opts: { timeoutMs?: number } = {}): Promise<NavigationResult> {
    return this.history(-1, opts.timeoutMs);
  }

  forward(opts: { timeoutMs?: number } = {}): Promise<NavigationResult> {
    return this.history(1, opts.timeoutMs);
  }

  reload(opts: { timeoutMs?: number } = {}): Promise<NavigationResult> {
    return this.settle("reloading", (t) => this.page.send("Page.reload", undefined, { timeoutMs: t }), opts.timeoutMs);
  }

  // --- tabs --------------------------------------------------------------------

  /** The browser's tabs with their stable short ids; the map is refreshed and saved. */
  async listTabs(): Promise<BrowserTab[]> {
    const pages = (await this.deps.discovery.listPages(this.port, this.host)).filter((p) => !this.closed.has(p.id));
    this.tabs = syncTabs(this.tabs, pages);
    this.save();
    return tabList(this.tabs, pages, this.targetId);
  }

  /**
   * Hear the JavaScript dialogs of whichever tab is current, across tab
   * switches, each with the page session that can answer it. Returns its unsubscribe.
   */
  onDialog(listener: DialogListener): () => void {
    this.hookDialogs(listener, this.page);
    return () => {
      const h = this.dialogListeners.get(listener);
      if (h) this.page.off("Page.javascriptDialogOpening", h);
      this.dialogListeners.delete(listener);
    };
  }

  private hookDialogs(listener: DialogListener, page: CdpSession): void {
    const h: CdpHandler = (p) =>
      listener({ type: String(p?.type ?? "alert"), message: String(p?.message ?? ""), ...(typeof p?.url === "string" ? { url: p.url } : {}) }, page);
    page.on("Page.javascriptDialogOpening", h);
    this.dialogListeners.set(listener, h);
  }

  /** Move this session onto another tab: attach to it, let go of the old one, bring it to the front. */
  private async switchTo(targetId: string): Promise<void> {
    const old = this.current.sessionId;
    const sessionId = await attachPage(this.cdp, targetId);
    const oldPage = this.current.page;
    this.current = { targetId, sessionId, page: this.cdp.session(sessionId) };
    for (const [listener, h] of [...this.dialogListeners]) {
      oldPage.off("Page.javascriptDialogOpening", h);
      this.hookDialogs(listener, this.current.page);
    }
    await this.cdp.send("Target.detachFromTarget", { sessionId: old }).catch(() => {});
    await this.deps.discovery.activateTarget(this.port, targetId, this.host);
    this.save();
  }

  async selectTab(id: string): Promise<BrowserTab> {
    const tab = pick(await this.listTabs(), id);
    await this.switchTo(tab.targetId);
    return { ...tab, active: true };
  }

  /** Open a tab, make it current and, given a url, load it. */
  async newTab(url?: string, opts: NavigateOptions = {}): Promise<BrowserTab> {
    const targetId = await createTarget(this.cdp);
    try {
      await this.switchTo(targetId);
    } catch (e) {
      // A tab we opened and could not use is only clutter.
      await this.deps.discovery.closeTarget(this.port, targetId, this.host).catch(() => {});
      throw e;
    }
    if (url !== undefined) await this.navigate(url, opts);
    return pick(await this.listTabs(), targetId);
  }

  /**
   * Close a tab and forget its refs and network log. Closing the current tab
   * moves to another one first; closing the last opens a blank one, since a
   * browser left with no tab may quit.
   */
  async closeTab(id: string): Promise<void> {
    const tabs = await this.listTabs();
    const tab = pick(tabs, id);
    if (tab.targetId === this.targetId) {
      const next = tabs.find((t) => t.targetId !== tab.targetId);
      await this.switchTo(next ? next.targetId : await createTarget(this.cdp));
    }
    await this.deps.discovery.closeTarget(this.port, tab.targetId, this.host);
    this.closed.add(tab.targetId);
    clearRefs(tab.targetId);
    clearNetwork(tab.targetId);
    await this.listTabs();
  }

  // --- lifetime ------------------------------------------------------------------

  /** Close the socket only. The browser and its tabs keep running; the next call reconnects. */
  async detach(): Promise<void> {
    await this.cdp.close();
  }

  /**
   * End the session. A browser we launched is closed (`Browser.close`, then
   * SIGTERM to its pid if it refuses); one we attached to is left running. Either
   * way session.json and our tabs' refs and network logs go (every tab's with `all`).
   */
  async shutdown(opts: CloseOptions = {}): Promise<void> {
    this.ended = true;
    if (this.launchedByUs) await closeLaunched(this.cdp, this.pid, this.deps);
    await this.cdp.close();
    forget([this.targetId, ...Object.values(this.tabs)], opts.all);
  }

  async status(): Promise<BrowserStatus> {
    const tabs = await this.listTabs();
    const cur = tabs.find((t) => t.active);
    return {
      alive: true,
      port: this.port,
      launchedByUs: this.launchedByUs,
      profile: this.profile,
      headless: this.headless,
      targetId: this.targetId,
      url: cur?.url ?? "",
      title: cur?.title ?? "",
      tabs,
    };
  }
}

/**
 * Connect to the browser (attaching to, reusing or launching one by the launch
 * policy) and attach to a tab: a new one when asked (or a scratch one), else
 * the saved one if it still exists, else the first page, else a fresh one.
 */
export async function openBrowserSession(opts: OpenOptions = {}): Promise<BrowserSession> {
  const deps = browserDeps(opts.deps);
  const endpoint = await resolveEndpoint({ ...opts, deps });
  // Read after resolving: a dead session has just been cleared, and a saved
  // session only says something about the browser on the same port.
  const saved = readSession();
  const same = saved !== null && saved.port === endpoint.port && (saved.host ?? "127.0.0.1") === endpoint.host ? saved : null;
  const { webSocketDebuggerUrl } = await deps.discovery.getVersion(endpoint.port, endpoint.host);
  const cdp = await deps.connectCdp(loopbackSocketUrl(webSocketDebuggerUrl));
  let created: string | undefined;
  try {
    const pages = await deps.discovery.listPages(endpoint.port, endpoint.host);
    let targetId: string;
    if (opts.newTab || opts.scratch) targetId = created = await createTarget(cdp);
    else if (same && pages.some((p) => p.id === same.targetId)) targetId = same.targetId;
    else targetId = pages[0]?.id ?? (await createTarget(cdp));
    const sessionId = await attachPage(cdp, targetId);
    const session = new BrowserSession(cdp, endpoint, webSocketDebuggerUrl, deps, targetId, sessionId, cleanTabs(same?.tabs), opts.scratch);
    if (!opts.scratch) await session.listTabs(); // numbers the tabs and saves the session
    if (opts.url !== undefined) await session.navigate(opts.url);
    return session;
  } catch (e) {
    // A tab opened for this session and never handed out is only clutter.
    if (created !== undefined) await deps.discovery.closeTarget(endpoint.port, created, endpoint.host).catch(() => {});
    await cdp.close();
    throw e;
  }
}

/**
 * What is running, from session.json and /json/list alone: never launches,
 * attaches or throws. The only write is the tab ids it hands out, saved.
 */
export async function browserStatus(opts: { deps?: Partial<BrowserDeps> } = {}): Promise<BrowserStatus> {
  const deps = browserDeps(opts.deps);
  const saved = readSession();
  if (!saved) return { alive: false };
  const host = saved.host ?? "127.0.0.1";
  const base = { port: saved.port, launchedByUs: saved.launchedByUs, profile: saved.profile, headless: saved.headless, targetId: saved.targetId };
  let pages: TargetInfo[];
  try {
    pages = await deps.discovery.listPages(saved.port, host);
  } catch {
    return { alive: false, ...base };
  }
  let map = syncTabs(cleanTabs(saved.tabs), pages);
  if (!sameTabs(map, cleanTabs(saved.tabs))) {
    // Ids handed out must name the same tabs on the next call, so they are saved:
    // under the lock, onto the session as it is by then. A busy lock skips it;
    // the numbering is deterministic, so the next call arrives at the same ids.
    try {
      map = await withBrowserLock(
        async () => {
          const current = readSession();
          if (!current || current.port !== saved.port || (current.host ?? "127.0.0.1") !== host) return map;
          const next = syncTabs(cleanTabs(current.tabs), pages);
          writeSession({ ...current, tabs: next, updatedAt: deps.now() });
          return next;
        },
        { deps, waitMs: 2000 },
      );
    } catch {
      /* busy: shown, not saved */
    }
  }
  const tabs = tabList(map, pages, saved.targetId);
  const cur = tabs.find((t) => t.active);
  return { alive: true, ...base, url: cur?.url ?? "", title: cur?.title ?? "", tabs };
}

/** Connect to the browser-level socket on `port` and ask it to quit (SIGTERM to `pid` if it refuses). */
async function closeAt(deps: BrowserDeps, port: number, host: string, pid: number | undefined): Promise<void> {
  const cdp = await deps.connectCdp(loopbackSocketUrl((await deps.discovery.getVersion(port, host)).webSocketDebuggerUrl));
  try {
    await closeLaunched(cdp, pid, deps);
  } finally {
    await cdp.close();
  }
}

/**
 * `browser close` from a fresh process: shut the saved browser down if we
 * launched it, without launching or attaching to anything first, then forget it.
 *
 * With no live session, the browser running on our dedicated profile is closed
 * instead: it is ours whatever started it — a fetch read launches one without
 * saving a session. Only if the port its DevToolsActivePort names still serves
 * the socket that file names: a crashed run's port may be another browser's now.
 */
export async function closeBrowser(
  opts: CloseOptions & { profile?: string; deps?: Partial<BrowserDeps> } = {},
): Promise<{ closed: boolean; launchedByUs: boolean }> {
  const deps = browserDeps(opts.deps);
  const saved = readSession();
  const host = saved?.host ?? "127.0.0.1";
  // Whether the saved session still names a running browser, by the rule resolveEndpoint applies.
  const live = !saved
    ? false
    : saved.wsBrowserUrl
      ? await isSameBrowser(deps, saved.port, host, saved.wsBrowserUrl)
      : !saved.launchedByUs && (await deps.discovery.isPortAlive(saved.port, host));
  let closed = false;
  let launchedByUs = saved?.launchedByUs ?? false;
  if (saved?.launchedByUs && live) {
    await closeAt(deps, saved.port, host, saved.pid);
    closed = true;
  } else if (!live) {
    const own = await readActivePort(deps, join(profileDir(opts.profile ?? saved?.profile), "DevToolsActivePort"));
    if (own && (await isSameBrowser(deps, own.port, "127.0.0.1", own.path))) {
      await closeAt(deps, own.port, "127.0.0.1", undefined); // its pid is unknown: never a kill
      closed = launchedByUs = true;
    }
  }
  forget(saved ? [saved.targetId, ...Object.values(cleanTabs(saved.tabs))] : [], opts.all);
  return { closed, launchedByUs };
}

/**
 * The CLI's unit of work: under the cross-process browser lock, open the
 * session, run `fn`, save where it left the session, and always detach — the
 * browser stays up for the next call, and the lock is released even on a throw.
 */
export async function withPage<T>(opts: OpenOptions, fn: (s: BrowserSession) => Promise<T>): Promise<T> {
  const deps = browserDeps(opts.deps);
  return withBrowserLock(
    async () => {
      const session = await openBrowserSession({ ...opts, deps });
      try {
        const out = await fn(session);
        session.save();
        return out;
      } finally {
        await session.detach();
      }
    },
    { deps },
  );
}
