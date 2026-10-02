import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envName } from "../src/brand.js";
import type { BrowserDeps } from "../src/browser/deps.js";
import { READ_DOCUMENT } from "../src/browser/overlay.js";
import { readRenderedPage } from "../src/browser/read.js";
import { closeBrowser } from "../src/browser/session.js";
import { readSession, type Session, writeSession } from "../src/browser/state.js";
import { FakeCdp, type FakeHandler } from "./helpers/fake-cdp.js";
import { scriptBrowser } from "./helpers/fake-browser.js";
import { fakeClock } from "./helpers/fake-page.js";
import { fakeSpawn } from "./helpers/fake-spawn.js";

let fake: FakeCdp;
let home: string;
let script: ReturnType<typeof scriptBrowser>;
/** What the page's document answers, per url. */
let pages: Record<string, { html: string; status?: number; mime?: string; finalUrl?: string; probe?: Record<string, unknown>; bare?: boolean }>;
let navigate: FakeHandler;

const ARTICLE = `<html><head><title>Rendered</title></head><body><nav>Home</nav><article><h1>Inserted by script</h1><p>${"Hydrated content. ".repeat(20)}</p></article></body></html>`;

beforeEach(async () => {
  fake = await FakeCdp.start();
  script = scriptBrowser(fake);
  home = mkdtempSync(join(tmpdir(), "wi-read-"));
  process.env[envName("BROWSER_DIR")] = home;
  pages = {};
  const urlOf = (sessionId?: string) => fake.targets.find((t) => t.id === script.sessions.get(sessionId as string))?.url ?? "";
  // The main document's response, a sub-resource and a child frame's document: only the first is the page's status.
  navigate = (p: { url: string }, sessionId) => {
    if (p.url.includes("unreachable")) return { frameId: script.sessions.get(sessionId as string), errorText: "net::ERR_NAME_NOT_RESOLVED" };
    const r = script.commit(sessionId as string, p.url);
    const status = pages[p.url]?.status;
    if (status !== undefined) {
      fake.emit(
        "Network.responseReceived",
        { requestId: "R0", frameId: "CHILD", type: "Document", response: { url: "https://ads.test/", status: 500 } },
        sessionId,
      );
      const mime = pages[p.url]?.mime;
      fake.emit(
        "Network.responseReceived",
        { requestId: "R1", frameId: r.frameId, type: "Document", response: { url: p.url, status, ...(mime ? { mimeType: mime } : {}) } },
        sessionId,
      );
      fake.emit(
        "Network.responseReceived",
        { requestId: "R2", frameId: r.frameId, type: "Script", response: { url: `${p.url}app.js`, status: 410 } },
        sessionId,
      );
    }
    return r;
  };
  fake.handle("Page.navigate", navigate);
  fake.handle("Runtime.evaluate", (p: { expression: string }, sessionId) => {
    const url = urlOf(sessionId);
    const page = pages[url];
    if (p.expression.includes("outerHTML") && page?.bare) return { result: { type: "object", value: {} } };
    if (p.expression.includes("outerHTML")) return { result: { type: "object", value: { html: page?.html ?? "<html></html>", url: page?.finalUrl ?? url } } };
    if (p.expression.includes("document.cookie")) return { result: { type: "object", value: { url, title: "", text: "", ...page?.probe } } };
    return { result: { type: "undefined" } }; // the Navigation Timing status: not exposed
  });
});
afterEach(async () => {
  await fake.close();
  rmSync(home, { recursive: true, force: true });
});

const deps = (over: Partial<BrowserDeps> = {}): Partial<BrowserDeps> => ({
  spawn: fakeSpawn({ port: fake.port }).spawn,
  detectBrowser: () => ({ kind: "chrome", path: "/fake/chrome" }),
  kill: () => {},
  ...over,
});
const agentSession = (): Session => ({
  version: 1,
  port: fake.port,
  launchedByUs: false,
  profile: "default",
  headless: false,
  targetId: "T1",
  tabs: { t1: "T1" },
  updatedAt: 1,
});
const created = () => fake.calls.filter((c) => c.method === "Target.createTarget").length;
const ids = () => fake.targets.map((t) => t.id);
/** Hold every Page.navigate until released, to keep reads in flight. */
function gateNavigation() {
  const held: (() => void)[] = [];
  fake.handle("Page.navigate", async (p, s) => {
    await new Promise<void>((r) => held.push(r));
    return navigate(p, s);
  });
  return held;
}

describe("readRenderedPage", () => {
  it("renders the page in a fresh tab, extracts it like a fetch would, then closes the tab and leaves the agent's tab current", async () => {
    fake.addTarget("https://agent.test/");
    writeSession(agentSession());
    pages["https://spa.test/"] = { html: ARTICLE, status: 200, mime: "text/html", finalUrl: "https://spa.test/home" };
    const r = await readRenderedPage("https://spa.test/", { cdp: fake.port, waitUntil: "load", deps: deps() });
    expect(r).toMatchObject({ title: "Rendered", finalUrl: "https://spa.test/home", status: 200, extractor: "browser" });
    expect(r.text).toContain("# Inserted by script");
    expect(r.text).not.toContain("Home");
    expect(r).not.toHaveProperty("html");
    expect(created()).toBe(1);
    expect(fake.requests).toContain("GET /json/close/T2");
    expect(ids()).toEqual(["T1"]);
    expect(readSession()).toEqual(agentSession());
    // Network is on before the navigation, so the document's response is heard.
    const order = fake.calls.filter((c) => c.sessionId === "S1").map((c) => c.method);
    expect(order.indexOf("Network.enable")).toBeLessThan(order.indexOf("Page.navigate"));
    // ...and downloads are refused in this tab alone, before anything loads: never browser-wide.
    const deny = fake.calls.find((c) => c.method === "Page.setDownloadBehavior");
    expect(deny).toEqual({ method: "Page.setDownloadBehavior", params: { behavior: "deny" }, sessionId: "S1" });
    expect(order.indexOf("Page.setDownloadBehavior")).toBeLessThan(order.indexOf("Page.navigate"));
    expect(fake.calls.map((c) => c.method)).not.toContain("Browser.setDownloadBehavior");
  });

  it("does not read at all when downloads cannot be refused in its tab", async () => {
    pages["https://spa.test/"] = { html: ARTICLE };
    fake.addTarget();
    fake.handle("Page.setDownloadBehavior", () => {
      throw { message: "'Page.setDownloadBehavior' wasn't found" };
    });
    await expect(readRenderedPage("https://spa.test/", { cdp: fake.port, waitUntil: "load", deps: deps() })).rejects.toThrow(/downloads/);
    expect(fake.calls.map((c) => c.method)).not.toContain("Page.navigate");
    expect(ids()).toEqual(["T1"]);
  });

  it("passes the shape options through to the extraction", async () => {
    pages["https://spa.test/"] = { html: ARTICLE.replace("</p>", ' <a href="/x">x</a></p>') };
    const r = await readRenderedPage("https://spa.test/", {
      cdp: fake.port,
      waitUntil: "load",
      format: "markdown",
      fullPage: true,
      keepHtml: true,
      deps: deps(),
    });
    expect(r.text).toContain("Home");
    expect(r.text).toContain("[x](https://spa.test/x)");
    expect(r.html).toContain("<article>");
  });

  it("reads a copy of the page without its overlays, dialogs and consent panels; --full-page reads it all", async () => {
    pages["https://spa.test/"] = { html: ARTICLE };
    const reads = () => fake.calls.filter((c) => c.method === "Runtime.evaluate" && String(c.params.expression).includes("outerHTML")).map((c) => c.params);
    await readRenderedPage("https://spa.test/", { cdp: fake.port, waitUntil: "load", deps: deps() });
    expect(reads()).toEqual([{ expression: READ_DOCUMENT, returnByValue: true }]);
    await readRenderedPage("https://spa.test/", { cdp: fake.port, waitUntil: "load", fullPage: true, deps: deps() });
    expect(reads()[1]?.expression).not.toContain("cloneNode");
  });

  it("reports the main document's own status, not a sub-resource's or a child frame's", async () => {
    pages["https://gone.test/"] = { html: ARTICLE, status: 404 };
    const r = await readRenderedPage("https://gone.test/", { cdp: fake.port, waitUntil: "load", deps: deps() });
    expect(r.status).toBe(404);
  });

  it("says 200 when no response was heard and the page exposes no status", async () => {
    pages["https://quiet.test/"] = { html: ARTICLE };
    const r = await readRenderedPage("https://quiet.test/", { cdp: fake.port, waitUntil: "load", deps: deps() });
    expect(r.status).toBe(200);
  });

  it("waits for a quiet network after load by default, and goes on when it never comes", async () => {
    pages["https://busy.test/"] = { html: ARTICLE };
    // A request that never finishes: the idle wait times out (capped), which is not fatal.
    fake.handle("Network.enable", (_p, sessionId) => {
      fake.emit("Network.requestWillBeSent", { requestId: "poll" }, sessionId);
      return {};
    });
    const clock = fakeClock();
    const r = await readRenderedPage("https://busy.test/", { cdp: fake.port, deps: deps({ now: clock.now, sleep: clock.sleep }) });
    expect(r.extractor).toBe("browser");
    expect(clock.at() - 1000).toBeGreaterThanOrEqual(3000);
    expect(fake.calls.map((c) => c.method).filter((m) => m === "Network.enable").length).toBeGreaterThanOrEqual(2);
  });

  it("waits for idle up to the whole budget with waitUntil: idle", async () => {
    pages["https://idle.test/"] = { html: ARTICLE };
    const clock = fakeClock();
    const r = await readRenderedPage("https://idle.test/", { cdp: fake.port, waitUntil: "idle", deps: deps({ now: clock.now, sleep: clock.sleep }) });
    expect(r.text).toContain("Inserted by script");
  });

  it("does not try to get through a blocking challenge: empty text, a blocked status and how to let a human solve it", async () => {
    pages["https://walled.test/"] = { html: "<html><body>Just a moment...</body></html>", status: 200, probe: { title: "Just a moment..." } };
    const r = await readRenderedPage("https://walled.test/", { cdp: fake.port, waitUntil: "load", deps: deps() });
    expect(r).toMatchObject({ text: "", status: 403, extractor: "browser", finalUrl: "https://walled.test/" });
    expect(r.note).toMatch(/cloudflare challenge/);
    expect(r.note).toContain("webindex-tests browser open https://walled.test/");
    expect(ids()).toEqual([]);
  });

  it("keeps the origin's own error status on a challenge page", async () => {
    pages["https://dd.test/"] = { html: "<html></html>", status: 429, probe: { iframeSrcs: ["https://geo.captcha-delivery.com/x"] } };
    const r = await readRenderedPage("https://dd.test/", { cdp: fake.port, waitUntil: "load", deps: deps() });
    expect(r).toMatchObject({ text: "", status: 429 });
    expect(r.note).toMatch(/datadome challenge/);
  });

  it("leaves a document that is not a web page to the fetch, closing the tab", async () => {
    pages["https://x.test/report"] = { html: "<html><embed type=application/pdf></html>", status: 200, mime: "application/pdf" };
    fake.addTarget();
    await expect(readRenderedPage("https://x.test/report", { cdp: fake.port, waitUntil: "load", deps: deps() })).rejects.toThrow(
      "https://x.test/report is not a web page but application/pdf",
    );
    expect(ids()).toEqual(["T1"]);
    pages["https://x.test/xhtml"] = { html: ARTICLE, status: 200, mime: "application/xhtml+xml" };
    expect((await readRenderedPage("https://x.test/xhtml", { cdp: fake.port, waitUntil: "load", deps: deps() })).status).toBe(200);
  });

  it("closes the tab when the navigation fails, and rethrows", async () => {
    fake.addTarget();
    await expect(readRenderedPage("https://unreachable.test/", { cdp: fake.port, deps: deps() })).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
    expect(ids()).toEqual(["T1"]);
    expect(fake.requests).toContain("GET /json/close/T2");
  });

  it("reads nothing, at the address it went to, from a page that hands back no document", async () => {
    pages["https://odd.test/"] = { html: "", bare: true };
    const r = await readRenderedPage("https://odd.test/", { cdp: fake.port, waitUntil: "load", deps: deps() });
    expect(r).toMatchObject({ text: "", finalUrl: "https://odd.test/", status: 200, extractor: "browser" });
  });

  it("does not trip over a tab that closed itself", async () => {
    fake.handle("Page.navigate", (_p, sessionId) => {
      const id = script.sessions.get(sessionId as string);
      fake.targets.splice(
        fake.targets.findIndex((t) => t.id === id),
        1,
      );
      return { frameId: id, errorText: "net::ERR_ABORTED" };
    });
    await expect(readRenderedPage("https://gone.test/", { cdp: fake.port, deps: deps() })).rejects.toThrow(/ERR_ABORTED/);
    expect(fake.requests).toContain("GET /json/close/T1");
  });

  it("launches the dedicated browser when none is running", async () => {
    pages["https://spa.test/"] = { html: ARTICLE };
    fake.addTarget();
    const spawned = fakeSpawn({ port: fake.port });
    const r = await readRenderedPage("https://spa.test/", { waitUntil: "load", deps: deps({ spawn: spawned.spawn }) });
    expect(r.extractor).toBe("browser");
    expect(spawned.calls).toHaveLength(1);
    expect(readSession()).toBeNull();
    // No session names it, but it is the browser on our own profile: a fresh `browser close` shuts it.
    expect(await closeBrowser({ deps: deps() })).toEqual({ closed: true, launchedByUs: true });
    expect(fake.calls.map((c) => c.method)).toContain("Browser.close");
  });

  it("never reads in a browser it was only attached to: it launches the dedicated one, and the attached session stays", async () => {
    const attached = await FakeCdp.start();
    try {
      const session = { ...agentSession(), port: attached.port };
      writeSession(session);
      pages["https://spa.test/"] = { html: ARTICLE };
      fake.addTarget();
      const spawned = fakeSpawn({ port: fake.port });
      const r = await readRenderedPage("https://spa.test/", { waitUntil: "load", deps: deps({ spawn: spawned.spawn }) });
      expect(r.extractor).toBe("browser");
      expect(spawned.calls).toHaveLength(1);
      expect(attached.calls).toEqual([]);
      expect(attached.requests.filter((q) => !q.startsWith("GET /json/version"))).toEqual([]);
      expect(readSession()).toEqual(session);
    } finally {
      await attached.close();
    }
  });

  it("never reaches the browser once it has given up waiting for the lock", async () => {
    writeFileSync(join(home, "lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    await expect(readRenderedPage("https://spa.test/", { cdp: fake.port, timeoutMs: 100, deps: deps() })).rejects.toThrow(/did not finish within 100 ms/);
    rmSync(join(home, "lock"));
    await new Promise((r) => setTimeout(r, 150));
    expect(fake.requests).toEqual([]);
    pages["https://spa.test/"] = { html: ARTICLE };
    expect((await readRenderedPage("https://spa.test/", { cdp: fake.port, waitUntil: "load", deps: deps() })).extractor).toBe("browser");
  });

  it("gives its slot back when cancelled the moment it got one", async () => {
    let checks = 0;
    const signal = {
      get aborted() {
        return ++checks > 1;
      },
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal;
    await expect(readRenderedPage("https://spa.test/", { cdp: fake.port, signal, deps: deps() })).rejects.toThrow(/cancelled/);
    expect(fake.requests).toEqual([]);
    pages["https://spa.test/"] = { html: ARTICLE };
    expect((await readRenderedPage("https://spa.test/", { cdp: fake.port, waitUntil: "load", deps: deps() })).extractor).toBe("browser");
  });

  it("reads one page at a time by default: a second read waits for the first's tab to close", async () => {
    pages["https://a.test/"] = { html: ARTICLE };
    pages["https://b.test/"] = { html: ARTICLE };
    const held = gateNavigation();
    const one = readRenderedPage("https://a.test/", { cdp: fake.port, waitUntil: "load", deps: deps() });
    const two = readRenderedPage("https://b.test/", { cdp: fake.port, waitUntil: "load", deps: deps() });
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(created()).toBe(1);
    held[0]?.();
    await one;
    await vi.waitFor(() => expect(held).toHaveLength(2));
    held[1]?.();
    expect((await two).extractor).toBe("browser");
    expect(created()).toBe(2);
  });

  it("reads as many pages at once as BROWSER_CONCURRENCY allows", async () => {
    process.env[envName("BROWSER_CONCURRENCY")] = "2";
    pages["https://a.test/"] = { html: ARTICLE };
    pages["https://b.test/"] = { html: ARTICLE };
    pages["https://c.test/"] = { html: ARTICLE };
    const held = gateNavigation();
    const reads = ["a", "b", "c"].map((h) => readRenderedPage(`https://${h}.test/`, { cdp: fake.port, waitUntil: "load", deps: deps() }));
    await vi.waitFor(() => expect(held).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(held).toHaveLength(2);
    held[0]?.();
    await vi.waitFor(() => expect(held).toHaveLength(3));
    held[1]?.();
    held[2]?.();
    expect((await Promise.all(reads)).map((r) => r.extractor)).toEqual(["browser", "browser", "browser"]);
  });

  it("gives up after timeoutMs, still closes the tab, and frees its slot", async () => {
    pages["https://slow.test/"] = { html: ARTICLE };
    pages["https://next.test/"] = { html: ARTICLE };
    script.options.lifecycle = "never";
    fake.addTarget();
    await expect(readRenderedPage("https://slow.test/", { cdp: fake.port, timeoutMs: 150, deps: deps() })).rejects.toThrow(/did not finish within 150 ms/);
    await vi.waitFor(() => expect(ids()).toEqual(["T1"]));
    script.options.lifecycle = "after";
    expect((await readRenderedPage("https://next.test/", { cdp: fake.port, waitUntil: "load", deps: deps() })).extractor).toBe("browser");
  });

  it("winds down a read that ran out of time while the browser was still being reached", async () => {
    pages["https://spa.test/"] = { html: ARTICLE };
    fake.addTarget();
    let attached: () => void = () => {};
    fake.handle("Page.enable", () => new Promise((r) => (attached = () => r({})))); // the scratch tab's attach hangs
    await expect(readRenderedPage("https://spa.test/", { cdp: fake.port, timeoutMs: 100, deps: deps() })).rejects.toThrow(/did not finish within 100 ms/);
    attached();
    await vi.waitFor(() => expect(ids()).toEqual(["T1"]));
    expect(fake.calls.map((c) => c.method)).not.toContain("Page.navigate");
  });

  it("takes its default timeout from BROWSER_TIMEOUT_MS, at least 5 s", async () => {
    process.env[envName("BROWSER_TIMEOUT_MS")] = "10";
    pages["https://spa.test/"] = { html: ARTICLE };
    expect((await readRenderedPage("https://spa.test/", { cdp: fake.port, waitUntil: "load", deps: deps() })).extractor).toBe("browser");
  });

  it("is cancelled by its signal: before it starts, while it renders, and while it waits for a slot", async () => {
    const before = new AbortController();
    before.abort();
    await expect(readRenderedPage("https://spa.test/", { cdp: fake.port, signal: before.signal, deps: deps() })).rejects.toThrow(/cancelled/);
    expect(fake.calls).toHaveLength(0);

    pages["https://spa.test/"] = { html: ARTICLE };
    fake.addTarget();
    const held = gateNavigation();
    const during = new AbortController();
    const queued = new AbortController();
    const first = readRenderedPage("https://spa.test/", { cdp: fake.port, signal: during.signal, deps: deps() });
    const second = readRenderedPage("https://spa.test/", { cdp: fake.port, signal: queued.signal, deps: deps() });
    await vi.waitFor(() => expect(held).toHaveLength(1));
    queued.abort();
    await expect(second).rejects.toThrow(/cancelled/);
    during.abort();
    await expect(first).rejects.toThrow(/cancelled/);
    held[0]?.();
    await vi.waitFor(() => expect(ids()).toEqual(["T1"]));
    expect(created()).toBe(1);
  });
});
