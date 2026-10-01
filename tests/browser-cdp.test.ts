import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CdpClient, CdpError, type CdpSocket } from "../src/browser/cdp.js";
import { FakeCdp } from "./helpers/fake-cdp.js";

let fake: FakeCdp;
let client: CdpClient | undefined;

beforeEach(async () => {
  fake = await FakeCdp.start();
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  await fake.close();
});

const connect = async () => {
  client = await CdpClient.connect(fake.browserWsUrl);
  return client;
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("CdpClient.send", () => {
  it("resolves the result and logs the call", async () => {
    fake.handle("Browser.getVersion", () => ({ product: "Fake" }));
    const c = await connect();
    await expect(c.send("Browser.getVersion", { a: 1 })).resolves.toEqual({ product: "Fake" });
    expect(fake.calls).toEqual([{ method: "Browser.getVersion", params: { a: 1 }, sessionId: undefined }]);
  });

  it("correlates concurrent calls answered out of order", async () => {
    fake.handle("slow", async () => {
      await delay(60);
      return { n: "slow" };
    });
    fake.handle("fast", () => ({ n: "fast" }));
    const c = await connect();
    const order: string[] = [];
    const slow = c.send<{ n: string }>("slow").then((r) => {
      order.push(r.n);
      return r;
    });
    const fast = c.send<{ n: string }>("fast").then((r) => {
      order.push(r.n);
      return r;
    });
    expect(await Promise.all([slow, fast])).toEqual([{ n: "slow" }, { n: "fast" }]);
    expect(order).toEqual(["fast", "slow"]);
  });

  it("rejects with a CdpError carrying method, code and message", async () => {
    fake.handle("Page.boom", () => {
      throw { code: -32601, message: "not found" };
    });
    const c = await connect();
    const err: any = await c.send("Page.boom").catch((e) => e);
    expect(err).toBeInstanceOf(CdpError);
    expect(err).toMatchObject({ method: "Page.boom", code: -32601 });
    expect(err.message).toContain("not found");
  });

  it("passes the sessionId along", async () => {
    const c = await connect();
    await c.send("X.y", {}, { sessionId: "S1" });
    expect(fake.calls[0]?.sessionId).toBe("S1");
  });

  it("times out per call, naming the method", async () => {
    fake.handle("hang", () => new Promise(() => {}));
    const c = await connect();
    await expect(c.send("hang", {}, { timeoutMs: 40 })).rejects.toThrow(/timed out: hang/);
  });

  it("rejects pending calls when the socket closes, and refuses new ones", async () => {
    fake.handle("hang", () => new Promise(() => {}));
    const c = await connect();
    let closed = 0;
    c.onClose(() => closed++);
    const p = c.send("hang");
    await delay(20);
    fake.dropClients();
    await expect(p).rejects.toThrow(/closed.*hang/);
    expect(c.closed).toBe(true);
    expect(closed).toBe(1);
    await expect(c.send("again")).rejects.toThrow(/closed/);
    const late: string[] = [];
    c.onClose(() => late.push("now"));
    expect(late).toEqual(["now"]);
  });

  it("ignores malformed frames and unknown ids", async () => {
    fake.handle("ok", () => ({ fine: true }));
    const c = await connect();
    fake.sendRaw("not json");
    fake.sendRaw("null");
    fake.sendRaw(JSON.stringify({ id: 9999, result: {} }));
    fake.sendRaw(JSON.stringify({ nothing: true }));
    await expect(c.send("ok")).resolves.toEqual({ fine: true });
  });

  it("close() is idempotent", async () => {
    const c = await connect();
    await c.close();
    await c.close();
    expect(c.closed).toBe(true);
  });
});

describe("events", () => {
  it("routes by sessionId: root handlers see only root events, session handlers only theirs", async () => {
    const c = await connect();
    const root: unknown[] = [];
    const s1: unknown[] = [];
    const s2: unknown[] = [];
    c.on("Page.loadEventFired", (p) => root.push(p));
    const sess = c.session("S1");
    sess.on("Page.loadEventFired", (p) => s1.push(p));
    c.on("Page.loadEventFired", (p) => s2.push(p), "S2");
    fake.emit("Page.loadEventFired", { n: 1 });
    fake.emit("Page.loadEventFired", { n: 2 }, "S1");
    fake.emit("Page.loadEventFired", { n: 3 }, "S2");
    await delay(50);
    expect(root).toEqual([{ n: 1 }]);
    expect(s1).toEqual([{ n: 2 }]);
    expect(s2).toEqual([{ n: 3 }]);
  });

  it("off() stops delivery; a throwing handler does not break others", async () => {
    const c = await connect();
    const got: number[] = [];
    const h = () => got.push(1);
    c.on("E.e", () => {
      throw new Error("bad listener");
    });
    c.on("E.e", h);
    fake.emit("E.e");
    await delay(30);
    c.off("E.e", h);
    c.off("E.e", h);
    c.off("Unknown.event", h);
    fake.emit("E.e");
    await delay(30);
    expect(got).toEqual([1]);
  });

  it("once resolves on the first event passing the predicate", async () => {
    const c = await connect();
    const p = c.once("Net.done", { predicate: (x) => x.id === 2 });
    fake.emit("Net.done", { id: 1 });
    fake.emit("Net.done", { id: 2 });
    await expect(p).resolves.toEqual({ id: 2 });
  });

  it("once is session-scoped through session()", async () => {
    const c = await connect();
    const p = c.session("S1").once("A.b");
    fake.emit("A.b", { who: "root" });
    fake.emit("A.b", { who: "s1" }, "S1");
    await expect(p).resolves.toEqual({ who: "s1" });
  });

  it("once times out", async () => {
    const c = await connect();
    await expect(c.once("Never.happens", { timeoutMs: 30 })).rejects.toThrow(/Timed out waiting for CDP event Never.happens/);
  });

  it("once rejects when the socket closes, immediately if already closed", async () => {
    const c = await connect();
    const p = c.once("Never.happens");
    await delay(20);
    fake.dropClients();
    await expect(p).rejects.toThrow(/closed while waiting/);
    await expect(c.once("Again")).rejects.toThrow(/closed while waiting/);
  });

  it("session.send binds the sessionId and session.off detaches", async () => {
    const c = await connect();
    const sess = c.session("SX");
    await sess.send("Runtime.enable", { a: 1 }, { timeoutMs: 1000 });
    expect(fake.calls[0]).toMatchObject({ method: "Runtime.enable", sessionId: "SX" });
    const got: unknown[] = [];
    const h = (p: unknown) => got.push(p);
    sess.on("E.x", h);
    sess.off("E.x", h);
    fake.emit("E.x", {}, "SX");
    await delay(30);
    expect(got).toEqual([]);
    expect(sess.sessionId).toBe("SX");
  });
});

describe("transport injection", () => {
  it("uses the injected connector and survives a send that throws", async () => {
    const ee = new EventEmitter() as unknown as CdpSocket;
    (ee as any).send = () => {
      throw new Error("not open");
    };
    (ee as any).close = () => {};
    (ee as any).terminate = () => {};
    let seen: { url: string; timeoutMs: number } | undefined;
    const c = await CdpClient.connect("ws://x/y", {
      timeoutMs: 123,
      transport: async (url, o) => {
        seen = { url, timeoutMs: o.timeoutMs };
        return ee;
      },
    });
    expect(seen).toEqual({ url: "ws://x/y", timeoutMs: 123 });
    await expect(c.send("A.b")).rejects.toThrow("not open");
    (ee as unknown as EventEmitter).emit("error", new Error("boom"));
    (ee as unknown as EventEmitter).emit("close", { code: 1006, reason: "" });
    expect(c.closed).toBe(true);
  });
});
