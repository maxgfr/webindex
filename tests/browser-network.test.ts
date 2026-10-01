import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearNetworkLog, getNetworkEntry, listNetwork, NetworkRecorder, type NetworkRecorderOptions } from "../src/browser/network.js";
import { readNetwork } from "../src/browser/state.js";
import { FakePage } from "./helpers/fake-page.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "wi-net-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const T = "TARGET1";

function setup(opts: NetworkRecorderOptions = {}) {
  const page = new FakePage();
  const rec = new NetworkRecorder({ page, targetId: T }, { home, drainMs: 50, ...opts });
  return { page, rec };
}

/** The event sequence of one request. */
function request(
  page: FakePage,
  id: string,
  o: { url?: string; method?: string; type?: string; mime?: string; status?: number; postData?: string; finish?: boolean; len?: number } = {},
) {
  const url = o.url ?? `https://a.test/api/${id}`;
  page.emit("Network.requestWillBeSent", { requestId: id, type: o.type ?? "XHR", request: { url, method: o.method ?? "GET", postData: o.postData } });
  page.emit("Network.responseReceived", {
    requestId: id,
    type: o.type ?? "XHR",
    response: { url, status: o.status ?? 200, mimeType: o.mime ?? "application/json" },
  });
  if (o.finish !== false) page.emit("Network.loadingFinished", { requestId: id, encodedDataLength: o.len ?? 10 });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("NetworkRecorder", () => {
  it("enables Network and keeps a JSON XHR with its parsed body", async () => {
    const { page, rec } = setup();
    page.handle("Network.getResponseBody", () => ({ body: '{"a":1}', base64Encoded: false }));
    await rec.start();
    expect(page.methods()).toContain("Network.enable");
    request(page, "r1", { postData: "q=1" });
    const out = await rec.stop();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      n: 1,
      method: "GET",
      url: "https://a.test/api/r1",
      status: 200,
      mime: "application/json",
      resourceType: "XHR",
      requestBody: "q=1",
      json: { a: 1 },
    });
    expect(typeof out[0]?.at).toBe("string");
    expect(page.listenerCount()).toBe(0);
    expect(page.methods()).not.toContain("Network.disable");
  });

  it("drops HTML and images by default, keeps them with mime any", async () => {
    const a = setup();
    a.page.handle("Network.getResponseBody", () => ({ body: "<p>x</p>", base64Encoded: false }));
    await a.rec.start();
    request(a.page, "h", { mime: "text/html", type: "Document" });
    request(a.page, "i", { mime: "image/png", type: "Image" });
    expect(await a.rec.stop()).toEqual([]);

    const b = setup({ filter: { mime: "any" } });
    b.page.handle("Network.getResponseBody", () => ({ body: "<p>x</p>", base64Encoded: false }));
    await b.rec.start();
    request(b.page, "h", { mime: "text/html", type: "Document" });
    request(b.page, "i", { mime: "image/png", type: "Image" });
    const out = await b.rec.stop();
    expect(out).toHaveLength(2);
    expect(out[0]?.text).toBe("<p>x</p>");
    expect(out[0]?.json).toBeUndefined();
  });

  it("accepts the JSON mime variants and rejects other resource types", async () => {
    const { page, rec } = setup();
    page.handle("Network.getResponseBody", () => ({ body: "{}", base64Encoded: false }));
    await rec.start();
    for (const [i, mime] of ["application/ld+json", "text/json", "application/x-ndjson", "application/json; charset=utf-8"].entries())
      request(page, `m${i}`, { mime });
    request(page, "s", { type: "Stylesheet" });
    expect(await rec.stop()).toHaveLength(4);
  });

  it("decodes a base64 body", async () => {
    const { page, rec } = setup();
    page.handle("Network.getResponseBody", () => ({ body: Buffer.from('{"é":2}').toString("base64"), base64Encoded: true }));
    await rec.start();
    request(page, "r");
    expect((await rec.stop())[0]?.json).toEqual({ é: 2 });
  });

  it("keeps non-JSON text raw", async () => {
    const { page, rec } = setup();
    page.handle("Network.getResponseBody", () => ({ body: "not json", base64Encoded: false }));
    await rec.start();
    request(page, "r");
    const [e] = await rec.stop();
    expect(e?.text).toBe("not json");
    expect(e?.json).toBeUndefined();
  });

  it("flags an oversize body without storing it", async () => {
    const { page, rec } = setup({ maxBodyBytes: 20 });
    page.handle("Network.getResponseBody", (p) => ({ body: p.requestId === "big" ? JSON.stringify({ k: "x".repeat(100) }) : "{}", base64Encoded: false }));
    await rec.start();
    request(page, "big", { len: 5 }); // the wire size lies (compressed): caught after the fetch
    request(page, "huge", { len: 5000 }); // known up front: never fetched
    const out = await rec.stop();
    expect(out.map((e) => e.bodyTruncated)).toEqual([true, true]);
    const big = out.find((e) => e.url.endsWith("/big"));
    expect(big?.size).toBeGreaterThan(20);
    expect(big?.json).toBeUndefined();
    expect(out.find((e) => e.url.endsWith("/huge"))?.size).toBe(5000);
    expect(page.calls.filter((c) => c.method === "Network.getResponseBody")).toHaveLength(1);
  });

  it("records a getResponseBody failure as error, never throws", async () => {
    const { page, rec } = setup();
    page.handle("Network.getResponseBody", () => {
      throw new Error("No resource with given identifier found");
    });
    await rec.start();
    request(page, "r");
    const [e] = await rec.stop();
    expect(e?.error).toMatch(/No resource/);
    expect(e?.status).toBe(200);
  });

  it("applies the urlIncludes and methods filters", async () => {
    const { page, rec } = setup({ filter: { urlIncludes: "/search", methods: ["post"] } });
    page.handle("Network.getResponseBody", () => ({ body: "{}", base64Encoded: false }));
    await rec.start();
    request(page, "a", { url: "https://a.test/search?q=1", method: "POST" });
    request(page, "b", { url: "https://a.test/search?q=1", method: "GET" });
    request(page, "c", { url: "https://a.test/other", method: "POST" });
    const out = await rec.stop();
    expect(out.map((e) => e.url)).toEqual(["https://a.test/search?q=1"]);
  });

  it("filters on a custom mime", async () => {
    const { page, rec } = setup({ filter: { mime: "xml" } });
    page.handle("Network.getResponseBody", () => ({ body: "<a/>", base64Encoded: false }));
    await rec.start();
    request(page, "a", { mime: "application/xml" });
    request(page, "b");
    expect(await rec.stop()).toHaveLength(1);
  });

  it("drops a request that fails and one that never finishes", async () => {
    const { page, rec } = setup();
    page.handle("Network.getResponseBody", () => ({ body: "{}", base64Encoded: false }));
    await rec.start();
    request(page, "f", { finish: false });
    page.emit("Network.loadingFailed", { requestId: "f" });
    page.emit("Network.loadingFinished", { requestId: "f" });
    request(page, "never", { finish: false });
    page.emit("Network.loadingFinished", { requestId: "unknown" });
    expect(await rec.stop()).toEqual([]);
  });

  it("truncates the request body to 4 KiB and tolerates a missing request event", async () => {
    const { page, rec } = setup();
    page.handle("Network.getResponseBody", () => ({ body: "{}", base64Encoded: false }));
    await rec.start();
    request(page, "a", { postData: "x".repeat(5000) });
    page.emit("Network.responseReceived", { requestId: "late", response: { url: "https://a.test/l", status: 201, mimeType: "application/json" } });
    page.emit("Network.loadingFinished", { requestId: "late", encodedDataLength: 2 });
    const out = await rec.stop();
    expect(out[0]?.requestBody).toHaveLength(4096);
    expect(out[1]).toMatchObject({ method: "GET", resourceType: "Other", status: 201 });
  });

  it("keeps the newest maxEntries", async () => {
    const { page, rec } = setup({ maxEntries: 2 });
    page.handle("Network.getResponseBody", () => ({ body: "{}", base64Encoded: false }));
    await rec.start();
    for (const id of ["a", "b", "c"]) {
      request(page, id);
      await flush();
    }
    const out = await rec.stop();
    expect(out.map((e) => e.url.slice(-1))).toEqual(["b", "c"]);
    expect(rec.entries()).toEqual(out);
  });

  it("waits for in-flight body fetches on stop, within a bound", async () => {
    const { page, rec } = setup();
    let release!: () => void;
    page.handle("Network.getResponseBody", () => new Promise((r) => (release = () => r({ body: '{"slow":true}', base64Encoded: false }))));
    await rec.start();
    request(page, "r");
    await flush();
    const stopping = rec.stop();
    release();
    expect((await stopping)[0]?.json).toEqual({ slow: true });

    const b = setup({ drainMs: 20 });
    b.page.handle("Network.getResponseBody", () => new Promise(() => {}));
    await b.rec.start();
    request(b.page, "hang");
    expect(await b.rec.stop()).toEqual([]);
  });

  it("ignores events after stop", async () => {
    const { page, rec } = setup();
    page.handle("Network.getResponseBody", () => ({ body: "{}", base64Encoded: false }));
    await rec.start();
    await rec.stop();
    request(page, "late");
    expect(rec.entries()).toEqual([]);
  });

  it("persists to the log, numbering on from an earlier session, and does not when persist is false", async () => {
    const run = async (opts: NetworkRecorderOptions, ids: string[]) => {
      const { page, rec } = setup(opts);
      page.handle("Network.getResponseBody", () => ({ body: "{}", base64Encoded: false }));
      await rec.start();
      for (const id of ids) request(page, id);
      return rec.stop();
    };
    await run({}, ["a", "b"]);
    const second = await run({}, ["c"]);
    expect(second[0]?.n).toBe(3);
    expect((readNetwork(T, { home }) as { n: number }[]).map((e) => e.n)).toEqual([1, 2, 3]);
    await run({ persist: false }, ["d"]);
    expect(readNetwork(T, { home })).toHaveLength(3);
  });

  it("lists, gets and clears the log", async () => {
    const { page, rec } = setup();
    page.handle("Network.getResponseBody", () => ({ body: '{"v":1}', base64Encoded: false }));
    await rec.start();
    request(page, "a", { len: 7 });
    await rec.stop();
    expect(listNetwork(T, { home })).toEqual([{ n: 1, method: "GET", status: 200, url: "https://a.test/api/a", mime: "application/json", size: 7 }]);
    expect(getNetworkEntry(T, 1, { home })?.json).toEqual({ v: 1 });
    expect(getNetworkEntry(T, 9, { home })).toBeNull();
    clearNetworkLog(T, { home });
    expect(listNetwork(T, { home })).toEqual([]);
  });

  it("persists only what is new when restarted after a stop", async () => {
    const { page, rec } = setup();
    page.handle("Network.getResponseBody", () => ({ body: "{}", base64Encoded: false }));
    await rec.start();
    request(page, "a");
    await rec.stop();
    await rec.start();
    request(page, "b");
    await rec.stop();
    expect((readNetwork(T, { home }) as { url: string }[]).map((e) => e.url.slice(-1))).toEqual(["a", "b"]);
  });

  it("flushes what it recorded to the log and keeps recording", async () => {
    const { page, rec } = setup();
    page.handle("Network.getResponseBody", () => ({ body: "{}", base64Encoded: false }));
    await rec.start();
    request(page, "a");
    await flush();
    expect(rec.flush().map((e) => e.n)).toEqual([1]);
    expect(listNetwork(T, { home }).map((e) => e.n)).toEqual([1]);
    expect(rec.flush()).toEqual([]);
    request(page, "b");
    await flush();
    await rec.stop();
    expect(listNetwork(T, { home }).map((e) => e.n)).toEqual([1, 2]);
  });

  it("forgets the oldest of the requests that never finish, past a bound", async () => {
    const { page, rec } = setup();
    await rec.start();
    for (let i = 0; i < 1500; i++) request(page, `open${i}`, { finish: false });
    const held = rec as unknown as { requests: Map<string, unknown>; pending: Map<string, unknown> };
    expect(held.requests.size).toBeLessThanOrEqual(1000);
    expect(held.pending.size).toBeLessThanOrEqual(1000);
    expect(held.pending.has("open1499")).toBe(true);
    expect(held.pending.has("open0")).toBe(false);
    await rec.stop();
  });

  it("never records headers", async () => {
    const { page, rec } = setup();
    page.handle("Network.getResponseBody", () => ({ body: "{}", base64Encoded: false }));
    await rec.start();
    page.emit("Network.requestWillBeSent", {
      requestId: "h",
      type: "XHR",
      request: { url: "https://a.test/h", method: "GET", headers: { Authorization: "Bearer s", Cookie: "c=1" } },
    });
    page.emit("Network.responseReceived", {
      requestId: "h",
      type: "XHR",
      response: { url: "https://a.test/h", status: 200, mimeType: "application/json", headers: { "Set-Cookie": "x" } },
    });
    page.emit("Network.loadingFinished", { requestId: "h", encodedDataLength: 2 });
    expect(JSON.stringify(await rec.stop())).not.toMatch(/Bearer|c=1|Set-Cookie/i);
  });
});
