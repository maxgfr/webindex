import { describe, expect, it } from "vitest";
import { armSettle, settle, WaitTimeoutError, waitFor } from "../src/browser/wait.js";
import { fakeClock, FakePage } from "./helpers/fake-page.js";

/** A page whose Runtime.evaluate answers from a mutable state, by what the expression asks. */
function scriptedPage(state: { text?: string; url?: string; ready?: string; selector?: boolean; blocking?: boolean | (() => boolean) } = {}) {
  const p = new FakePage();
  p.handle("Runtime.evaluate", (params) => {
    const e = String(params.expression);
    if (e.includes("document.cookie")) {
      const blocking = typeof state.blocking === "function" ? state.blocking() : state.blocking;
      return { result: { value: { url: "u", title: blocking ? "Just a moment..." : "Shop", text: "x".repeat(2000), status: blocking ? 503 : 200 } } };
    }
    if (e.includes("innerText")) return { result: { value: (state.text ?? "").includes(JSON.parse(e.match(/includes\((".*")\)/)?.[1] ?? '""')) } };
    if (e.includes("querySelector")) return { result: { value: state.selector ?? false } };
    if (e.includes("location.href")) return { result: { value: state.url ?? "https://a.test/" } };
    if (e.includes("readyState")) return { result: { value: state.ready === "complete" } };
    return { result: { value: undefined } };
  });
  return p;
}

describe("waitFor", () => {
  it("resolves at once when the condition already holds", async () => {
    const clock = fakeClock();
    const p = scriptedPage({ text: "Order shipped" });
    const r = await waitFor({ page: p }, { text: "shipped" }, { deps: clock });
    expect(r.waitedMs).toBe(0);
  });

  it("reports which condition matched", async () => {
    const conds = [
      [{ text: "a" }, "text"],
      [{ gone: "zzz" }, "gone"],
      [{ selector: "a" }, "selector"],
      [{ url: "a.test" }, "url"],
      [{ load: true }, "load"],
      [{ ms: 10 }, "ms"],
    ] as const;
    for (const [cond, name] of conds) {
      const p = scriptedPage({ text: "a", selector: true, ready: "complete" });
      expect((await waitFor({ page: p }, cond, { deps: fakeClock() })).matched, name).toBe(name);
    }
    expect((await waitFor({ page: scriptedPage() }, { clear: true }, { deps: fakeClock() })).matched).toBe("clear");
    expect((await waitFor({ page: new FakePage() }, { idle: true }, { deps: fakeClock() })).matched).toBe("idle");
  });

  it("polls every 250 ms until the text appears", async () => {
    const state = { text: "" };
    const clock = fakeClock((t) => {
      if (t >= 1750) state.text = "Done!";
    });
    const p = scriptedPage(state);
    const r = await waitFor({ page: p }, { text: "Done!" }, { deps: clock });
    expect(r.waitedMs).toBe(750);
    expect(p.calls.filter((c) => c.method === "Runtime.evaluate")).toHaveLength(4);
  });

  it("waits for a text to go away", async () => {
    const state = { text: "Loading..." };
    const clock = fakeClock((t) => {
      if (t >= 1500) state.text = "";
    });
    await waitFor({ page: scriptedPage(state) }, { gone: "Loading..." }, { deps: clock });
    expect(state.text).toBe("");
  });

  it("waits for a selector to match a rendered element", async () => {
    const state = { selector: false };
    const clock = fakeClock((t) => {
      if (t >= 1250) state.selector = true;
    });
    const p = scriptedPage(state);
    await waitFor({ page: p }, { selector: "#result .row" }, { deps: clock });
    const expr = String(p.calls[0]?.params.expression);
    expect(expr).toContain("#result .row");
    expect(expr).toContain("getClientRects");
  });

  it("matches the url as substring, glob or regex", async () => {
    const urls = {
      substring: ["checkout", true],
      "substring miss": ["cart", false],
      glob: ["https://a.test/*/done", true],
      "glob miss": ["https://a.test/*/nope", false],
      regex: ["/\\/order\\/\\d+\\/done$/", true],
      "regex flags": ["/ORDER/i", true],
      "regex miss": ["/^https:\\/\\/b\\./", false],
    } as const;
    for (const [name, [pattern, hit]] of Object.entries(urls)) {
      const state = { url: "https://a.test/order/12/done" };
      const clock = fakeClock();
      const p = scriptedPage({ url: name.startsWith("substring") ? "https://a.test/checkout" : state.url });
      const run = waitFor({ page: p }, { url: pattern }, { deps: clock, timeoutMs: 600 });
      if (hit) await expect(run, name).resolves.toBeDefined();
      else await expect(run, name).rejects.toBeInstanceOf(WaitTimeoutError);
    }
  });

  it("treats an invalid regex as a plain substring", async () => {
    const p = scriptedPage({ url: "https://a.test/x" });
    await expect(waitFor({ page: p }, { url: "/(/" }, { deps: fakeClock(), timeoutMs: 300 })).rejects.toBeInstanceOf(WaitTimeoutError);
  });

  it("waits for the document to be loaded", async () => {
    const state = { ready: "loading" };
    const clock = fakeClock((t) => {
      if (t >= 1500) state.ready = "complete";
    });
    await waitFor({ page: scriptedPage(state) }, { load: true }, { deps: clock });
    expect(state.ready).toBe("complete");
  });

  it("sleeps for { ms }", async () => {
    const clock = fakeClock();
    const r = await waitFor({ page: scriptedPage() }, { ms: 1200 }, { deps: clock });
    expect(r.waitedMs).toBe(1200);
    // a pure sleep is not cut short by the default timeout
    const long = await waitFor({ page: scriptedPage() }, { ms: 60_000 }, { deps: fakeClock() });
    expect(long.waitedMs).toBe(60_000);
  });

  it("times out with an error naming the condition and the elapsed time", async () => {
    const clock = fakeClock();
    const err = await waitFor({ page: scriptedPage() }, { text: "never" }, { deps: clock, timeoutMs: 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(WaitTimeoutError);
    expect(err.name).toBe("WaitTimeoutError");
    expect(err.message).toContain('{"text":"never"}');
    expect(err.message).toMatch(/1000 ms/);
    expect(err.elapsedMs).toBe(1000);
  });

  it("uses 30 s as the default timeout", async () => {
    const err = await waitFor({ page: scriptedPage() }, { text: "never" }, { deps: fakeClock() }).catch((e) => e);
    expect(err.elapsedMs).toBe(30_000);
  });

  it("keeps polling through evaluation errors (a navigation destroys the context)", async () => {
    const p = new FakePage();
    let n = 0;
    p.handle("Runtime.evaluate", () => {
      if (++n < 3) throw new Error("Execution context was destroyed");
      return { result: { value: true } };
    });
    await waitFor({ page: p }, { selector: "a" }, { deps: fakeClock() });
    expect(n).toBe(3);
  });

  it("rejects a malformed condition", async () => {
    await expect(waitFor({ page: scriptedPage() }, {} as never, { deps: fakeClock() })).rejects.toThrow(/condition/);
    await expect(waitFor({ page: scriptedPage() }, { text: "a", gone: "b" } as never, { deps: fakeClock() })).rejects.toThrow(/condition/);
  });
});

describe("waitFor { clear }", () => {
  it("needs two consecutive polls without a blocking challenge", async () => {
    const seq = [true, true, false, true, false, false];
    let i = 0;
    const p = scriptedPage({ blocking: () => seq[Math.min(i++, seq.length - 1)] as boolean });
    const r = await waitFor({ page: p }, { clear: true }, { deps: fakeClock() });
    expect(i).toBe(6);
    expect(r.waitedMs).toBe(1250);
  });

  it("counts a non blocking widget as clear", async () => {
    const p = new FakePage();
    p.handle("Runtime.evaluate", () => ({ result: { value: { url: "u", title: "Login", text: "x".repeat(2000), status: 200, selectors: [".g-recaptcha"] } } }));
    await waitFor({ page: p }, { clear: true }, { deps: fakeClock() });
  });

  it("defaults to 300 s", async () => {
    const err = await waitFor({ page: scriptedPage({ blocking: true }) }, { clear: true }, { deps: fakeClock() }).catch((e) => e);
    expect(err).toBeInstanceOf(WaitTimeoutError);
    expect(err.elapsedMs).toBe(300_000);
    expect(err.message).toContain('{"clear":true}');
  });
});

describe("waitFor { idle }", () => {
  it("enables Network and resolves after 500 ms with no request in flight", async () => {
    const p = new FakePage();
    const clock = fakeClock((t) => {
      if (t === 1250) p.emit("Network.requestWillBeSent", { requestId: "1" });
      if (t === 1750) p.emit("Network.loadingFinished", { requestId: "1" });
    });
    p.emit("Network.requestWillBeSent", { requestId: "0" }); // before the wait: not seen
    const r = await waitFor({ page: p }, { idle: true }, { deps: clock });
    expect(p.methods()).toContain("Network.enable");
    expect(r.waitedMs).toBeGreaterThanOrEqual(1000);
    expect(r.waitedMs).toBeLessThanOrEqual(1500);
    expect(p.listenerCount()).toBe(0);
  });

  it("counts failed requests as finished, and times out when one never ends", async () => {
    const p = new FakePage();
    const clock = fakeClock((t) => {
      if (t === 1250) p.emit("Network.requestWillBeSent", { requestId: "a" });
      if (t === 1500) p.emit("Network.loadingFailed", { requestId: "a" });
    });
    await waitFor({ page: p }, { idle: true }, { deps: clock });
    const stuck = new FakePage();
    const c2 = fakeClock((t) => {
      if (t === 1250) stuck.emit("Network.requestWillBeSent", { requestId: "z" });
    });
    await expect(waitFor({ page: stuck }, { idle: true }, { deps: c2, timeoutMs: 5000 })).rejects.toBeInstanceOf(WaitTimeoutError);
    expect(stuck.listenerCount()).toBe(0);
  });
});

describe("settle", () => {
  const treePage = () => {
    const p = new FakePage();
    p.handle("Page.getFrameTree", () => ({ frameTree: { frame: { id: "main", loaderId: "L1", url: "https://a.test/" } } }));
    return p;
  };

  it("returns quickly when nothing happens: no navigation, quiet network", async () => {
    const p = treePage();
    const clock = fakeClock();
    const r = await settle({ page: p }, { deps: clock });
    expect(r.navigated).toBe(false);
    expect(r.waitedMs).toBeGreaterThanOrEqual(300);
    expect(r.waitedMs).toBeLessThan(700);
    expect(p.methods()).toContain("Network.enable");
    expect(p.listenerCount()).toBe(0);
  });

  it("follows a navigation to its load event", async () => {
    const p = treePage();
    const clock = fakeClock((t) => {
      if (t === 1050) p.emit("Page.frameStartedLoading", { frameId: "main" });
      if (t === 2000) p.emit("Page.lifecycleEvent", { frameId: "main", loaderId: "L2", name: "load" });
    });
    const r = await settle({ page: p }, { deps: clock });
    expect(r.navigated).toBe(true);
    expect(r.waitedMs).toBeGreaterThanOrEqual(1000 + 300);
  });

  it("ignores child frames and non-load lifecycle events", async () => {
    const p = treePage();
    const clock = fakeClock((t) => {
      if (t === 1050) p.emit("Page.frameStartedLoading", { frameId: "ad" });
      if (t === 1100) p.emit("Page.frameNavigated", { frame: { id: "ad", parentId: "main" } });
    });
    expect((await settle({ page: p }, { deps: clock })).navigated).toBe(false);
  });

  it("notices a main frame navigation reported by frameNavigated alone", async () => {
    const p = treePage();
    const clock = fakeClock((t) => {
      if (t === 1050) p.emit("Page.frameNavigated", { frame: { id: "main" } });
      if (t === 1100) p.emit("Page.lifecycleEvent", { frameId: "main", name: "load" });
    });
    expect((await settle({ page: p }, { deps: clock })).navigated).toBe(true);
  });

  it("does not see a navigation that starts after the 150 ms window", async () => {
    const p = treePage();
    const clock = fakeClock((t) => {
      if (t === 1250) p.emit("Page.frameStartedLoading", { frameId: "main" });
    });
    expect((await settle({ page: p }, { deps: clock })).navigated).toBe(false);
  });

  it("allows up to 2 requests in flight, and waits while there are more", async () => {
    const p = treePage();
    const clock = fakeClock((t) => {
      if (t === 1050) for (const id of ["a", "b"]) p.emit("Network.requestWillBeSent", { requestId: id });
      if (t === 1100) p.emit("Network.requestWillBeSent", { requestId: "c" });
      if (t === 2500) p.emit("Network.loadingFinished", { requestId: "c" });
    });
    const r = await settle({ page: p }, { deps: clock });
    expect(r.waitedMs).toBeGreaterThanOrEqual(1500 + 300);
  });

  it("never throws on timeout and reports what it waited", async () => {
    const p = treePage();
    const clock = fakeClock((t) => {
      if (t === 1050) for (const id of ["a", "b", "c"]) p.emit("Network.requestWillBeSent", { requestId: id });
    });
    const r = await settle({ page: p }, { deps: clock, timeoutMs: 2000 });
    expect(r).toEqual({ navigated: false, waitedMs: 2000 });
    const nav = treePage();
    const c2 = fakeClock((t) => {
      if (t === 1050) nav.emit("Page.frameStartedLoading", { frameId: "main" });
    });
    expect(await settle({ page: nav }, { deps: c2, timeoutMs: 1000 })).toEqual({ navigated: true, waitedMs: 1000 });
  });

  it("copes with a page that cannot answer getFrameTree or Network.enable", async () => {
    const p = new FakePage();
    p.handle("Page.getFrameTree", () => {
      throw new Error("closed");
    });
    p.handle("Network.enable", () => {
      throw new Error("closed");
    });
    const r = await settle({ page: p }, { deps: fakeClock() });
    expect(r.navigated).toBe(false);
  });
});

describe("armSettle", () => {
  const treePage = (loaderId = () => "L1") => {
    const p = new FakePage();
    p.handle("Page.getFrameTree", () => ({ frameTree: { frame: { id: "main", loaderId: loaderId(), url: "https://a.test/" } } }));
    return p;
  };

  it("registers its listeners before it resolves, so the action's own events are seen", async () => {
    const p = treePage();
    const armed = await armSettle({ page: p }, { deps: fakeClock((t) => t === 1100 && p.emit("Page.lifecycleEvent", { frameId: "main", name: "load" })) });
    expect(p.listenerCount()).toBeGreaterThan(0);
    expect(p.methods()).toContain("Network.enable");
    // the action: its navigation starts and a request goes out, all before done() is called
    p.emit("Page.frameStartedLoading", { frameId: "main" });
    p.emit("Network.requestWillBeSent", { requestId: "r" });
    p.emit("Network.loadingFinished", { requestId: "r" });
    const r = await armed.done();
    expect(r.navigated).toBe(true);
    expect(p.listenerCount()).toBe(0);
  });

  it("keeps events that arrive before the main frame id is known", async () => {
    const p = new FakePage();
    let release!: () => void;
    p.handle("Page.getFrameTree", () => new Promise((r) => (release = () => r({ frameTree: { frame: { id: "main", loaderId: "L1" } } }))));
    const arming = armSettle({ page: p }, { deps: fakeClock((t) => t === 1100 && p.emit("Page.lifecycleEvent", { frameId: "main", name: "load" })) });
    await new Promise((r) => setTimeout(r, 0));
    p.emit("Page.frameStartedLoading", { frameId: "main" });
    release();
    expect((await (await arming).done()).navigated).toBe(true);
  });

  it("sees a navigation already under way: another loader, or a document still loading", async () => {
    let loader = "L1";
    const p = treePage(() => loader);
    p.handle("Runtime.evaluate", () => ({ result: { value: "complete" } }));
    const armed = await armSettle({ page: p }, { deps: fakeClock() });
    loader = "L2"; // the new document committed, its events went unheard
    expect((await armed.done()).navigated).toBe(true);

    let state = "loading";
    const q = treePage();
    q.handle("Runtime.evaluate", () => ({ result: { value: state } }));
    const clock = fakeClock((t) => {
      if (t >= 1400) state = "complete";
    });
    const r = await (await armSettle({ page: q }, { deps: clock })).done();
    expect(r.navigated).toBe(true);
    expect(r.waitedMs).toBeGreaterThanOrEqual(400 + 300);
  });

  it("is not fooled by a settled document", async () => {
    const p = treePage();
    p.handle("Runtime.evaluate", () => ({ result: { value: "complete" } }));
    expect((await (await armSettle({ page: p }, { deps: fakeClock() })).done()).navigated).toBe(false);
  });

  it("stops waiting for a navigation that stops loading without a load event (download, 204)", async () => {
    const p = treePage();
    const clock = fakeClock((t) => {
      if (t === 1050) p.emit("Page.frameStartedLoading", { frameId: "main" });
      if (t === 1500) p.emit("Page.frameStoppedLoading", { frameId: "main" });
    });
    const r = await settle({ page: p }, { deps: clock, timeoutMs: 20_000 });
    expect(r.navigated).toBe(true);
    expect(r.waitedMs).toBeLessThan(1000);
  });

  it("can be awaited once, and still releases its listeners if never awaited again", async () => {
    const p = treePage();
    const armed = await armSettle({ page: p }, { deps: fakeClock() });
    await armed.done();
    await expect(armed.done()).rejects.toThrow(/already/);
    expect(p.listenerCount()).toBe(0);
  });
});
