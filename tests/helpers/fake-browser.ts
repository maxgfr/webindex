import type { FakeCdp } from "./fake-cdp.js";

// Scripts the browser-level CDP commands a BrowserSession uses on top of a
// FakeCdp: flat-mode attach, tab creation, frame tree, navigation with
// lifecycle events, history and reload. Each target keeps its own history.

export interface FakePage {
  history: string[];
  index: number;
  loaderId: string;
}

export interface ScriptOptions {
  /**
   * When the lifecycle events of a navigation are sent: before the command's
   * answer (a race), after it, or never; `dcl` sends them after it but stops at
   * DOMContentLoaded, as a page whose load never comes (a cold server, a hung script);
   * `commit` only commits (Page.frameNavigated), as a page held before
   * DOMContentLoaded by a render-blocking script. `never` does not even commit.
   */
  lifecycle?: "before" | "after" | "never" | "dcl" | "commit";
  /** The value `performance…responseStatus` evaluates to. */
  status?: number;
}

export function scriptBrowser(fake: FakeCdp, opts: ScriptOptions = {}) {
  const sessions = new Map<string, string>();
  const pages = new Map<string, FakePage>();
  let sessionN = 0;
  let loaderN = 0;
  const target = (id: string) => {
    const t = fake.targets.find((x) => x.id === id);
    if (!t) throw { code: -32602, message: `No target with given id ${id}` };
    return t;
  };
  const page = (id: string): FakePage => {
    let p = pages.get(id);
    if (!p) pages.set(id, (p = { history: [target(id).url], index: 0, loaderId: `L${++loaderN}` }));
    return p;
  };
  const targetOf = (sessionId?: string) => {
    const id = sessionId ? sessions.get(sessionId) : undefined;
    if (!id) throw { code: -32001, message: `Session with given id not found: ${sessionId}` };
    return id;
  };
  const events = (frameId: string, loaderId: string, sessionId: string, names = ["init", "DOMContentLoaded", "load"]) => {
    for (const name of names) fake.emit("Page.lifecycleEvent", { frameId, loaderId, name, timestamp: 1 }, sessionId);
  };
  /** A new document commits in the target behind `sessionId`. */
  const commit = (sessionId: string, url: string): { frameId: string; loaderId: string } => {
    const id = targetOf(sessionId);
    const p = page(id);
    p.loaderId = `L${++loaderN}`;
    const t = target(id);
    t.url = url;
    t.title = `Title of ${url}`;
    const loaderId = p.loaderId;
    const mode = opts.lifecycle ?? "after";
    const navigated = () => fake.emit("Page.frameNavigated", { frame: { id, loaderId, url }, type: "Navigation" }, sessionId);
    if (mode === "before") {
      navigated();
      events(id, loaderId, sessionId);
    } else if (mode !== "never") setTimeout(navigated, 2);
    if (mode === "after") setTimeout(() => events(id, loaderId, sessionId), 5);
    else if (mode === "dcl") setTimeout(() => events(id, loaderId, sessionId, ["init", "commit", "DOMContentLoaded"]), 5);
    return { frameId: id, loaderId };
  };

  fake.handle("Target.attachToTarget", (p: { targetId: string }) => {
    target(p.targetId);
    const sessionId = `S${++sessionN}`;
    sessions.set(sessionId, p.targetId);
    return { sessionId };
  });
  fake.handle("Target.createTarget", (p: { url: string }) => ({ targetId: fake.addTarget(p.url).id }));
  fake.handle("Target.getTargetInfo", (p: { targetId: string }) => {
    const t = target(p.targetId);
    return { targetInfo: { targetId: t.id, type: t.type, title: t.title, url: t.url, attached: true } };
  });
  fake.handle("Page.getFrameTree", (_p, sessionId) => {
    const id = targetOf(sessionId);
    return { frameTree: { frame: { id, loaderId: page(id).loaderId, url: target(id).url, securityOrigin: "", mimeType: "text/html" } } };
  });
  fake.handle("Page.navigate", (p: { url: string }, sessionId) => {
    const id = targetOf(sessionId);
    if (p.url.includes("unreachable")) return { frameId: id, errorText: "net::ERR_NAME_NOT_RESOLVED" };
    const pg = page(id);
    if (p.url.startsWith("#")) {
      target(id).url = target(id).url.replace(/#.*$/, "") + p.url;
      return { frameId: id }; // same-document: no loaderId
    }
    pg.history = [...pg.history.slice(0, pg.index + 1), p.url];
    pg.index = pg.history.length - 1;
    return commit(sessionId as string, p.url);
  });
  fake.handle("Page.getNavigationHistory", (_p, sessionId) => {
    const pg = page(targetOf(sessionId));
    return { currentIndex: pg.index, entries: pg.history.map((url, i) => ({ id: i + 100, url, userTypedURL: url, title: "", transitionType: "link" })) };
  });
  fake.handle("Page.navigateToHistoryEntry", (p: { entryId: number }, sessionId) => {
    const pg = page(targetOf(sessionId));
    pg.index = p.entryId - 100;
    commit(sessionId as string, pg.history[pg.index] as string);
    return {};
  });
  fake.handle("Page.reload", (_p, sessionId) => {
    commit(sessionId as string, target(targetOf(sessionId)).url);
    return {};
  });
  fake.handle("Runtime.evaluate", () => ({ result: { type: "number", value: opts.status ?? 200 } }));

  return { sessions, pages, commit, options: opts };
}
