import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envName } from "../src/brand.js";
import type { BrowserDeps } from "../src/browser/deps.js";
import { type BrowserSession, browserStatus, closeBrowser, openBrowserSession, withPage } from "../src/browser/session.js";
import { appendNetwork, readNetwork, readRefs, readSession, type Session, writeRefs, writeSession } from "../src/browser/state.js";
import { profileDir } from "../src/browser/profile.js";
import { FakeCdp } from "./helpers/fake-cdp.js";
import { scriptBrowser } from "./helpers/fake-browser.js";
import { fakeSpawn } from "./helpers/fake-spawn.js";

let fake: FakeCdp;
let home: string;
let script: ReturnType<typeof scriptBrowser>;
const open: BrowserSession[] = [];
const kills: [number, string | number | undefined][] = [];

beforeEach(async () => {
  fake = await FakeCdp.start();
  script = scriptBrowser(fake);
  kills.length = 0;
  home = mkdtempSync(join(tmpdir(), "wi-session-"));
  process.env[envName("BROWSER_DIR")] = home;
});
afterEach(async () => {
  for (const s of open.splice(0)) await s.detach();
  await fake.close();
  rmSync(home, { recursive: true, force: true });
});

const deps = (over: Partial<BrowserDeps> = {}): Partial<BrowserDeps> => ({
  spawn: fakeSpawn({ port: fake.port }).spawn,
  detectBrowser: () => ({ kind: "chrome", path: "/fake/chrome" }),
  kill: (pid, signal) => void kills.push([pid, signal]),
  ...over,
});
const attach = async (over: Parameters<typeof openBrowserSession>[0] = {}) => {
  const s = await openBrowserSession({ cdp: fake.port, deps: deps(), ...over });
  open.push(s);
  return s;
};
const methods = (sessionId?: string) => fake.calls.filter((c) => sessionId === undefined || c.sessionId === sessionId).map((c) => c.method);
const ours = (over: Partial<Session> = {}): Session => ({
  version: 1,
  port: fake.port,
  wsBrowserUrl: fake.browserWsUrl,
  pid: 4242,
  launchedByUs: true,
  profile: "default",
  headless: false,
  targetId: "T1",
  updatedAt: 1,
  ...over,
});
const table = { loaderId: "L0", url: "about:blank", next: 2, refs: { e1: 5 } };

describe("openBrowserSession", () => {
  it("attaches to the first page in flat mode, enables the page domains and persists the session", async () => {
    fake.addTarget("https://a.test/", "A");
    fake.addTarget("https://x.test/sw.js", "sw", "service_worker");
    fake.addTarget("https://b.test/", "B");
    const s = await attach();
    expect(s.targetId).toBe("T1");
    expect(s.sessionId).toBe("S1");
    expect(s.port).toBe(fake.port);
    expect(s.launchedByUs).toBe(false);
    expect(fake.calls[0]).toEqual({ method: "Target.attachToTarget", params: { targetId: "T1", flatten: true }, sessionId: undefined });
    expect(methods("S1")).toEqual(["Page.enable", "Runtime.enable", "DOM.enable", "Page.setLifecycleEventsEnabled"]);
    expect(fake.calls.find((c) => c.method === "Page.setLifecycleEventsEnabled")?.params).toEqual({ enabled: true });
    expect(methods()).not.toContain("Network.enable");
    expect(readSession()).toMatchObject({
      version: 1,
      port: fake.port,
      launchedByUs: false,
      profile: "default",
      headless: false,
      targetId: "T1",
      tabs: { t1: "T1", t2: "T3" },
    });
  });

  it("reconnects to the saved tab on the next call, and opens a new one on request", async () => {
    fake.addTarget("https://a.test/");
    fake.addTarget("https://b.test/");
    const first = await attach();
    await first.selectTab("t2");
    await first.detach();
    const again = await attach();
    expect(again.targetId).toBe("T2");
    await again.detach();
    const fresh = await attach({ newTab: true });
    expect(fresh.targetId).toBe("T3");
    expect(fake.calls.find((c) => c.method === "Target.createTarget")?.params).toEqual({ url: "about:blank" });
    expect(readSession()?.targetId).toBe("T3");
  });

  it("falls back to the first page when the saved tab is gone", async () => {
    fake.addTarget("https://a.test/");
    writeSession(ours({ launchedByUs: false, targetId: "GONE" }));
    const s = await attach();
    expect(s.targetId).toBe("T1");
  });

  it("creates a page when the browser has none", async () => {
    const s = await attach();
    expect(s.targetId).toBe("T1");
    expect(methods()).toContain("Target.createTarget");
  });

  it("navigates to opts.url once attached", async () => {
    fake.addTarget();
    const s = await attach({ url: "https://start.test/" });
    expect(await s.currentUrl()).toBe("https://start.test/");
  });

  it("closes its connection when attaching fails", async () => {
    fake.addTarget();
    fake.handle("Target.attachToTarget", () => {
      throw { message: "attach refused" };
    });
    await expect(openBrowserSession({ cdp: fake.port, deps: deps() })).rejects.toThrow(/attach refused/);
  });

  it("closes the tab it created for newTab when attaching to it fails", async () => {
    fake.addTarget();
    fake.handle("Target.attachToTarget", () => {
      throw { message: "attach refused" };
    });
    await expect(openBrowserSession({ cdp: fake.port, newTab: true, deps: deps() })).rejects.toThrow(/attach refused/);
    expect(fake.requests).toContain("GET /json/close/T2");
    expect(fake.targets.map((t) => t.id)).toEqual(["T1"]);
  });

  it("launches a separate browser when nothing is running", async () => {
    fake.addTarget();
    const spawned = fakeSpawn({ port: fake.port });
    const s = await openBrowserSession({ deps: deps({ spawn: spawned.spawn }) });
    open.push(s);
    expect(spawned.calls).toHaveLength(1);
    expect(s.launchedByUs).toBe(true);
    expect(readSession()).toMatchObject({ launchedByUs: true, pid: 4242 });
  });

  it("works in a scratch tab of its own without saving anything: the agent's tab stays current", async () => {
    fake.addTarget("https://agent.test/");
    writeSession(ours({ launchedByUs: false, wsBrowserUrl: undefined, targetId: "T1", tabs: { t1: "T1" } }));
    const before = readSession();
    const s = await attach({ scratch: true });
    expect(s.targetId).toBe("T2");
    expect(fake.calls.find((c) => c.method === "Target.attachToTarget")?.params).toEqual({ targetId: "T2", flatten: true });
    await s.navigate("https://read.test/");
    await s.listTabs();
    s.save();
    expect(readSession()).toEqual(before);
  });

  it("does not create session.json for a scratch tab either", async () => {
    fake.addTarget();
    await attach({ scratch: true });
    expect(readSession()).toBeNull();
  });
});

describe("a tab frozen by a dialog", () => {
  it("names the likely dialog when the tab does not answer the attach, after 5 s instead of 30", async () => {
    fake.addTarget();
    fake.handle("Page.enable", () => new Promise(() => {}));
    const t = Date.now();
    const err = await attach().catch((e) => e);
    expect(Date.now() - t).toBeLessThan(9000);
    expect(err.message).toBe(
      "the tab does not answer; most likely a JavaScript dialog the page opened between commands — answer it in the window, or `webindex-tests browser close`",
    );
  }, 15_000);

  it("lets a CDP error of the attach through as it is", async () => {
    fake.addTarget();
    fake.handle("Page.enable", () => {
      throw { code: -32000, message: "Page domain refused" };
    });
    await expect(attach()).rejects.toThrow(/Page domain refused/);
  });
});

describe("dialogs", () => {
  it("hears the dialogs of whichever tab is current, with the page that heard each", async () => {
    fake.addTarget();
    const s = await attach();
    const heard: [string, string][] = [];
    const off = s.onDialog((d, page) => heard.push([String(d.message), page.sessionId]));
    fake.emit("Page.javascriptDialogOpening", { type: "alert", message: "one" }, "S1");
    await s.newTab();
    fake.emit("Page.javascriptDialogOpening", { type: "alert", message: "old tab" }, "S1");
    fake.emit("Page.javascriptDialogOpening", { type: "alert", message: "two" }, s.sessionId);
    await s.listTabs(); // a round trip: the events above have arrived
    off();
    fake.emit("Page.javascriptDialogOpening", { type: "alert", message: "after" }, s.sessionId);
    await s.listTabs();
    expect(heard).toEqual([
      ["one", "S1"],
      ["two", s.sessionId],
    ]);
  });

  it("stops waiting for a navigation the page's beforeunload dialog cancelled", async () => {
    fake.addTarget();
    script.options.lifecycle = "never";
    const s = await attach();
    const declined = (sessionId: string) => {
      fake.emit("Page.javascriptDialogOpening", { type: "beforeunload", message: "" }, sessionId);
      fake.emit("Page.javascriptDialogClosed", { result: false, userInput: "" }, sessionId);
    };
    const nav = fake.handlerOf("Page.navigate");
    fake.handle("Page.navigate", (p, sessionId) => {
      declined(sessionId as string);
      return nav?.(p, sessionId);
    });
    const t = Date.now();
    await expect(s.navigate("https://away.test/")).rejects.toThrow(
      "navigation to https://away.test/ was cancelled: the page asked to confirm leaving it (beforeunload), and that was declined",
    );
    fake.handle("Page.reload", (_p, sessionId) => {
      declined(sessionId as string);
      return {};
    });
    await expect(s.reload()).rejects.toThrow(/reloading was cancelled: the page asked to confirm leaving it \(beforeunload\)/);
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it("keeps waiting when the beforeunload dialog was accepted, or another dialog closed", async () => {
    fake.addTarget();
    script.options.lifecycle = "after";
    const s = await attach();
    const nav = fake.handlerOf("Page.navigate");
    fake.handle("Page.navigate", (p, sessionId) => {
      fake.emit("Page.javascriptDialogOpening", { type: "beforeunload", message: "" }, sessionId);
      fake.emit("Page.javascriptDialogClosed", { result: true, userInput: "" }, sessionId);
      fake.emit("Page.javascriptDialogOpening", { type: "confirm", message: "?" }, sessionId);
      fake.emit("Page.javascriptDialogClosed", { result: false, userInput: "" }, sessionId);
      return nav?.(p, sessionId);
    });
    await expect(s.navigate("https://away.test/")).resolves.toMatchObject({ url: "https://away.test/" });
  });
});

describe("navigation", () => {
  it("waits for the load of the new document, clears the tab's refs and reports the status", async () => {
    fake.addTarget();
    script.options.status = 201;
    const s = await attach();
    writeRefs(s.targetId, table);
    const r = await s.navigate("https://n.test/page");
    expect(r).toEqual({ url: "https://n.test/page", loaderId: "L2", status: 201 });
    expect(readRefs(s.targetId)).toBeNull();
    expect(await s.loaderId()).toBe("L2");
    expect(await s.title()).toBe("Title of https://n.test/page");
  });

  it("does not miss lifecycle events that arrive before Page.navigate answers", async () => {
    fake.addTarget();
    script.options.lifecycle = "before";
    const s = await attach();
    await expect(s.navigate("https://race.test/", { timeoutMs: 2000 })).resolves.toMatchObject({ loaderId: "L2" });
  });

  it("waits for DOMContentLoaded, or not at all", async () => {
    fake.addTarget();
    script.options.lifecycle = "never";
    const s = await attach();
    const r = await s.navigate("https://fast.test/", { waitUntil: "none" });
    expect(r).toEqual({ url: "https://fast.test/", loaderId: "L2" });
    script.options.lifecycle = "after";
    await expect(s.navigate("https://dcl.test/", { waitUntil: "domcontentloaded" })).resolves.toMatchObject({ url: "https://dcl.test/" });
  });

  it("rejects with the browser's errorText", async () => {
    fake.addTarget();
    const s = await attach();
    await expect(s.navigate("https://unreachable.test/")).rejects.toThrow(/navigation to https:\/\/unreachable.test\/ failed: net::ERR_NAME_NOT_RESOLVED/);
  });

  it("times out when the page never loads", async () => {
    fake.addTarget();
    script.options.lifecycle = "never";
    const s = await attach();
    await expect(s.navigate("https://slow.test/", { timeoutMs: 50 })).rejects.toThrow(/did not reach load within 50 ms/);
  });

  it("returns at once on a same-document navigation and keeps the refs", async () => {
    fake.addTarget("https://h.test/");
    script.options.lifecycle = "never";
    const s = await attach();
    writeRefs(s.targetId, table);
    const r = await s.navigate("#part");
    expect(r.loaderId).toBe("L1");
    expect(readRefs(s.targetId)).not.toBeNull();
  });

  it("tolerates a page whose status cannot be read", async () => {
    fake.addTarget();
    fake.handle("Runtime.evaluate", () => ({ result: { type: "undefined" } }));
    const s = await attach();
    expect((await s.navigate("https://nostatus.test/")).status).toBeUndefined();
    fake.handle("Runtime.evaluate", () => {
      throw { message: "Execution context was destroyed." };
    });
    expect((await s.navigate("https://gone.test/")).status).toBeUndefined();
  });

  it("gives up on the status after ~2 s instead of holding the lock for 30 s (an alert() on load)", async () => {
    fake.addTarget();
    const s = await attach();
    fake.handle("Runtime.evaluate", () => new Promise(() => {}));
    const t = Date.now();
    expect((await s.navigate("https://alert.test/")).status).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(5000);
  }, 10_000);

  it("stops waiting when the connection drops mid-navigation", async () => {
    fake.addTarget();
    script.options.lifecycle = "never";
    const s = await attach();
    const p = s.navigate("https://drop.test/");
    setTimeout(() => fake.dropClients(), 30);
    await expect(p).rejects.toThrow(/connection closed while waiting for the page to load/);
  });

  it("settles a history move restored from the back/forward cache, or within the document", async () => {
    fake.addTarget("https://one.test/");
    const s = await attach();
    await s.navigate("https://two.test/");
    fake.handle("Page.navigateToHistoryEntry", (_p, sid) => {
      fake.emit("Page.frameNavigated", { frame: { id: "T1", loaderId: "L9", url: "https://x.test/" }, type: "Navigation" }, sid);
      fake.emit("Page.frameNavigated", { frame: { id: "T1", loaderId: "L1", url: "https://one.test/" }, type: "BackForwardCacheRestore" }, sid);
      return {};
    });
    writeRefs("T1", table);
    await s.back();
    expect(readRefs("T1")).toBeNull();
    fake.handle("Page.navigateToHistoryEntry", (_p, sid) => {
      fake.emit("Page.navigatedWithinDocument", { frameId: "T1", url: "https://two.test/#a" }, sid);
      return {};
    });
    writeRefs("T1", table);
    await s.back();
    expect(readRefs("T1")).not.toBeNull();
  });

  it("goes back, forward and reloads, each waiting for load and clearing refs", async () => {
    fake.addTarget("https://one.test/");
    const s = await attach();
    await s.navigate("https://two.test/");
    writeRefs(s.targetId, table);
    expect(await s.back()).toMatchObject({ url: "https://one.test/" });
    expect(readRefs(s.targetId)).toBeNull();
    expect(await s.forward()).toMatchObject({ url: "https://two.test/" });
    const before = await s.loaderId();
    const r = await s.reload();
    expect(r.url).toBe("https://two.test/");
    expect(r.loaderId).not.toBe(before);
    expect(fake.calls.filter((c) => c.method === "Page.navigateToHistoryEntry").map((c) => c.params)).toEqual([{ entryId: 100 }, { entryId: 101 }]);
  });

  it("refuses to go back or forward past the ends of history", async () => {
    fake.addTarget("https://only.test/");
    const s = await attach();
    await expect(s.back()).rejects.toThrow(/no previous page/);
    await expect(s.forward()).rejects.toThrow(/no next page/);
  });
});

describe("tabs", () => {
  it("keeps tN ids stable across two openBrowserSession calls, drops vanished ones, numbers new ones next", async () => {
    fake.addTarget("https://a.test/", "A");
    fake.addTarget("https://b.test/", "B");
    const first = await attach();
    expect((await first.listTabs()).map((t) => [t.id, t.targetId, t.active])).toEqual([
      ["t1", "T1", true],
      ["t2", "T2", false],
    ]);
    await first.detach();
    fake.targets.splice(0, 1); // T1 closed by the user
    fake.addTarget("https://c.test/", "C");
    const second = await attach();
    expect(await second.listTabs()).toEqual([
      { id: "t2", targetId: "T2", url: "https://b.test/", title: "B", active: true },
      { id: "t3", targetId: "T3", url: "https://c.test/", title: "C", active: false },
    ]);
    expect(readSession()?.tabs).toEqual({ t2: "T2", t3: "T3" });
  });

  it("selects a tab by id: re-attaches, activates it and remembers it", async () => {
    fake.addTarget("https://a.test/");
    fake.addTarget("https://b.test/");
    const s = await attach();
    const tab = await s.selectTab("t2");
    expect(tab).toMatchObject({ id: "t2", targetId: "T2", active: true });
    expect(s.targetId).toBe("T2");
    expect(s.sessionId).toBe("S2");
    expect(s.page.sessionId).toBe("S2");
    expect(fake.requests).toContain("GET /json/activate/T2");
    expect(methods()).toContain("Target.detachFromTarget");
    expect(methods("S2")).toEqual(["Page.enable", "Runtime.enable", "DOM.enable", "Page.setLifecycleEventsEnabled"]);
    expect(readSession()?.targetId).toBe("T2");
    await expect(s.selectTab("t9")).rejects.toThrow(/no tab t9/);
  });

  it("opens a new tab, navigates it and makes it current", async () => {
    fake.addTarget("https://a.test/");
    const s = await attach();
    const tab = await s.newTab("https://new.test/");
    expect(tab).toMatchObject({ id: "t2", targetId: "T2", url: "https://new.test/", active: true });
    expect(s.targetId).toBe("T2");
    const blank = await s.newTab();
    expect(blank).toMatchObject({ id: "t3", url: "about:blank" });
  });

  it("closes the tab newTab created when it cannot be attached to", async () => {
    fake.addTarget("https://a.test/");
    const s = await attach();
    fake.handle("Target.attachToTarget", () => {
      throw { message: "attach refused" };
    });
    await expect(s.newTab()).rejects.toThrow(/attach refused/);
    expect(fake.targets.map((t) => t.id)).toEqual(["T1"]);
    expect(s.targetId).toBe("T1");
  });

  it("closes a tab, forgets its state, and moves off it when it was current", async () => {
    fake.addTarget("https://a.test/");
    fake.addTarget("https://b.test/");
    const s = await attach();
    writeRefs("T1", table);
    appendNetwork("T1", [{ url: "x" }]);
    await s.closeTab("t1");
    expect(fake.requests).toContain("GET /json/close/T1");
    expect(s.targetId).toBe("T2");
    expect(readRefs("T1")).toBeNull();
    expect(readNetwork("T1")).toEqual([]);
    expect((await s.listTabs()).map((t) => t.id)).toEqual(["t2"]);
  });

  it("opens a blank tab before closing the last one, so the browser stays up", async () => {
    fake.addTarget("https://a.test/");
    const s = await attach();
    await s.closeTab("t1");
    expect(s.targetId).toBe("T2");
    expect((await s.listTabs()).map((t) => [t.id, t.url])).toEqual([["t2", "about:blank"]]);
  });

  it("closes a background tab without moving", async () => {
    fake.addTarget("https://a.test/");
    fake.addTarget("https://b.test/");
    const s = await attach();
    await s.closeTab("t2");
    expect(s.targetId).toBe("T1");
  });
});

describe("detach, shutdown and status", () => {
  it("detach closes the socket only: the browser and the tab stay", async () => {
    fake.addTarget();
    const s = await attach();
    await s.detach();
    expect(s.cdp.closed).toBe(true);
    expect(methods()).not.toContain("Browser.close");
    expect(fake.targets).toHaveLength(1);
    expect(readSession()?.targetId).toBe("T1");
  });

  it("shutdown closes a browser we launched and clears our state", async () => {
    fake.addTarget();
    writeSession(ours());
    const s = await openBrowserSession({ deps: deps() });
    writeRefs("T1", table);
    appendNetwork("T1", [{ url: "x" }]);
    await s.shutdown();
    expect(methods()).toContain("Browser.close");
    expect(kills).toEqual([]);
    expect(readSession()).toBeNull();
    expect(readRefs("T1")).toBeNull();
    expect(readNetwork("T1")).toEqual([]);
    expect(s.cdp.closed).toBe(true);
  });

  it("falls back to killing the pid when Browser.close fails", async () => {
    fake.addTarget();
    fake.handle("Browser.close", () => {
      throw { message: "nope" };
    });
    writeSession(ours());
    const s = await openBrowserSession({ deps: deps() });
    await s.shutdown();
    expect(kills).toEqual([[4242, "SIGTERM"]]);
  });

  it("never closes a browser it only attached to", async () => {
    fake.addTarget();
    const s = await attach();
    writeRefs("T1", table);
    writeRefs("OTHER", table);
    await s.shutdown();
    expect(methods()).not.toContain("Browser.close");
    expect(readSession()).toBeNull();
    expect(readRefs("T1")).toBeNull();
    expect(readRefs("OTHER")).not.toBeNull();
  });

  it("shutdown --all wipes every tab's refs and network log", async () => {
    fake.addTarget();
    const s = await attach();
    writeRefs("OTHER", table);
    appendNetwork("OTHER", [{ url: "x" }]);
    await s.shutdown({ all: true });
    expect(readRefs("OTHER")).toBeNull();
    expect(readNetwork("OTHER")).toEqual([]);
    expect(existsSync(join(home, "refs"))).toBe(false);
  });

  it("status of a live session", async () => {
    fake.addTarget("https://s.test/", "S");
    const s = await attach();
    expect(await s.status()).toEqual({
      alive: true,
      port: fake.port,
      launchedByUs: false,
      profile: "default",
      headless: false,
      targetId: "T1",
      url: "https://s.test/",
      title: "S",
      tabs: [{ id: "t1", targetId: "T1", url: "https://s.test/", title: "S", active: true }],
    });
  });
});

describe("browserStatus and closeBrowser (no session to open)", () => {
  it("reports nothing running without throwing or launching", async () => {
    const spawned = fakeSpawn({ port: fake.port });
    expect(await browserStatus({ deps: deps({ spawn: spawned.spawn }) })).toEqual({ alive: false });
    expect(spawned.calls).toHaveLength(0);
  });

  it("reports a saved session whose browser died", async () => {
    const dead = await FakeCdp.start();
    const port = dead.port;
    await dead.close();
    writeSession(ours({ port }));
    expect(await browserStatus({ deps: deps() })).toEqual({ alive: false, port, launchedByUs: true, profile: "default", headless: false, targetId: "T1" });
  });

  it("reports a live saved session from /json/list alone", async () => {
    fake.addTarget("https://s.test/", "S");
    writeSession(ours({ tabs: { t4: "T1" } }));
    const st = await browserStatus({ deps: deps() });
    expect(st).toMatchObject({ alive: true, port: fake.port, targetId: "T1", url: "https://s.test/", title: "S" });
    expect(st.tabs).toEqual([{ id: "t4", targetId: "T1", url: "https://s.test/", title: "S", active: true }]);
    expect(fake.calls).toHaveLength(0);
  });

  it("saves the ids it hands out and numbers new tabs independently of /json/list order", async () => {
    fake.addTarget("https://a.test/", "A");
    fake.addTarget("https://b.test/", "B");
    fake.addTarget("https://c.test/", "C");
    writeSession(ours({ tabs: { t1: "T1" } }));
    const ids = (st: Awaited<ReturnType<typeof browserStatus>>) => st.tabs?.map((t) => [t.id, t.targetId]);
    const first = ids(await browserStatus({ deps: deps() }));
    expect(first).toEqual([
      ["t1", "T1"],
      ["t2", "T2"],
      ["t3", "T3"],
    ]);
    expect(readSession()?.tabs).toEqual({ t1: "T1", t2: "T2", t3: "T3" });
    // Chrome orders /json/list by recent activity: the ids must not follow it.
    fake.targets.reverse();
    expect(ids(await browserStatus({ deps: deps() }))).toEqual(first);
    const s = await attach();
    expect((await s.listTabs()).map((t) => [t.id, t.targetId])).toEqual(first);
  });

  it("numbers unseen tabs by target id, whatever order /json/list gives", async () => {
    fake.addTarget("https://a.test/");
    fake.addTarget("https://b.test/");
    fake.addTarget("https://c.test/");
    fake.targets.reverse();
    const s = await attach({ newTab: false });
    expect((await s.listTabs()).map((t) => [t.id, t.targetId])).toEqual([
      ["t1", "T1"],
      ["t2", "T2"],
      ["t3", "T3"],
    ]);
  });

  it("closeBrowser shuts a launched browser without spawning one", async () => {
    fake.addTarget();
    writeSession(ours());
    const spawned = fakeSpawn({ port: fake.port });
    expect(await closeBrowser({ deps: deps({ spawn: spawned.spawn }) })).toEqual({ closed: true, launchedByUs: true });
    expect(methods()).toContain("Browser.close");
    expect(spawned.calls).toHaveLength(0);
    expect(readSession()).toBeNull();
  });

  it("closeBrowser never closes another browser that took over our saved port", async () => {
    fake.addTarget();
    writeSession(ours({ wsBrowserUrl: `ws://127.0.0.1:${fake.port}/devtools/browser/our-dead-guid` }));
    expect(await closeBrowser({ deps: deps() })).toEqual({ closed: false, launchedByUs: true });
    expect(methods()).not.toContain("Browser.close");
    expect(kills).toEqual([]);
    expect(readSession()).toBeNull();
  });

  it("closeBrowser forgets an attached browser without closing it", async () => {
    writeSession(ours({ launchedByUs: false }));
    expect(await closeBrowser({ deps: deps() })).toEqual({ closed: false, launchedByUs: false });
    expect(methods()).not.toContain("Browser.close");
    expect(readSession()).toBeNull();
  });

  it("closeBrowser closes the browser running on our profile that no session names (one a fetch read launched)", async () => {
    fake.addTarget();
    mkdirSync(profileDir(), { recursive: true });
    writeFileSync(join(profileDir(), "DevToolsActivePort"), `${fake.port}\n/devtools/browser/fake\n`);
    expect(await closeBrowser({ deps: deps() })).toEqual({ closed: true, launchedByUs: true });
    expect(methods()).toContain("Browser.close");
    expect(kills).toEqual([]); // no pid known: never a kill
  });

  it("closeBrowser leaves alone a foreign browser on the port our profile's file names", async () => {
    fake.addTarget();
    mkdirSync(profileDir(), { recursive: true });
    writeFileSync(join(profileDir(), "DevToolsActivePort"), `${fake.port}\n/devtools/browser/a-crashed-run-guid\n`);
    expect(await closeBrowser({ deps: deps() })).toEqual({ closed: false, launchedByUs: false });
    expect(methods()).not.toContain("Browser.close");
  });

  it("closeBrowser leaves the profile's browser alone while a live attached session is saved", async () => {
    mkdirSync(profileDir(), { recursive: true });
    writeFileSync(join(profileDir(), "DevToolsActivePort"), `${fake.port}\n/devtools/browser/fake\n`);
    writeSession(ours({ launchedByUs: false }));
    expect(await closeBrowser({ deps: deps() })).toEqual({ closed: false, launchedByUs: false });
    // An attached browser whose socket path was not recorded is live while its port answers.
    writeSession(ours({ launchedByUs: false, wsBrowserUrl: undefined }));
    expect(await closeBrowser({ deps: deps() })).toEqual({ closed: false, launchedByUs: false });
    expect(methods()).not.toContain("Browser.close");
  });

  it("closeBrowser with nothing running only clears state", async () => {
    writeRefs("OTHER", table);
    expect(await closeBrowser({ all: true, deps: deps() })).toEqual({ closed: false, launchedByUs: false });
    expect(readRefs("OTHER")).toBeNull();
  });
});

describe("withPage", () => {
  it("runs fn on a session, persists it, detaches and releases the lock", async () => {
    fake.addTarget("https://a.test/");
    fake.addTarget("https://b.test/");
    let seen: BrowserSession | undefined;
    const out = await withPage({ cdp: fake.port, deps: deps() }, async (s) => {
      seen = s;
      expect(existsSync(join(home, "lock"))).toBe(true);
      await s.selectTab("t2");
      return 42;
    });
    expect(out).toBe(42);
    expect(seen?.cdp.closed).toBe(true);
    expect(existsSync(join(home, "lock"))).toBe(false);
    expect(readSession()?.targetId).toBe("T2");
  });

  it("detaches and releases the lock when fn throws", async () => {
    fake.addTarget();
    let seen: BrowserSession | undefined;
    await expect(
      withPage({ cdp: fake.port, deps: deps() }, async (s) => {
        seen = s;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(seen?.cdp.closed).toBe(true);
    expect(existsSync(join(home, "lock"))).toBe(false);
  });

  it("does not resurrect the session file after fn shut the browser down", async () => {
    fake.addTarget();
    await withPage({ cdp: fake.port, deps: deps() }, (s) => s.shutdown());
    expect(readSession()).toBeNull();
  });
});
