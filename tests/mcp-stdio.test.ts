import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runStdioServer } from "../src/mcp/stdio.js";
import { testAdapter } from "./adapter.js";

// The stdio transport frames JSON-RPC as newline-delimited JSON. These drive it
// through streams the test owns, with a fake skill, so every assertion is about
// framing and process hygiene rather than about any skill's tools.

async function run(lines: string[], opts: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
  const input = Readable.from(lines.map((l) => l + "\n"));
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  await runStdioServer(testAdapter(), { input, output, captureStdout: true, ...opts });
  return chunks
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const rpc = (id: number, method: string, params?: unknown) => JSON.stringify({ jsonrpc: "2.0", id, method, params });

describe("framing", () => {
  it("answers one request per line", async () => {
    const out = await run([rpc(1, "initialize", {}), rpc(2, "ping", {})]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: 1 });
    expect(out[1]).toMatchObject({ id: 2, result: {} });
  });

  it("answers a tool call with its text", async () => {
    const out = await run([rpc(1, "tools/call", { name: "probe_echo", arguments: { text: "hi" } })]);
    expect((out[0] as any).result.content[0].text).toBe("hi");
  });

  it("reports a parse error without dying, and keeps serving", async () => {
    // A client that emits one malformed line must not take the session down.
    const out = await run(["{not json", rpc(2, "ping", {})]);
    expect(out[0]).toMatchObject({ error: { code: -32700 } });
    expect(out[1]).toMatchObject({ id: 2, result: {} });
  });

  it("ignores blank lines", async () => {
    const out = await run(["", "   ", rpc(1, "ping", {})]);
    expect(out).toHaveLength(1);
  });

  it("writes nothing for a notification", async () => {
    const out = await run([JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })]);
    expect(out).toEqual([]);
  });
});

describe("concurrency", () => {
  it("does not serialise independent calls, and answers every one", async () => {
    // A slow tool must not block a fast one; ids let the client re-associate.
    const out = await run([1, 2, 3, 4, 5, 6].map((i) => rpc(i, "tools/call", { name: "probe_echo", arguments: { text: String(i) } })));
    expect(out).toHaveLength(6);
    expect(new Set(out.map((m) => (m as any).id))).toEqual(new Set([1, 2, 3, 4, 5, 6]));
  });

  it("keeps a batch under the same in-flight ceiling as single frames", async () => {
    // The batch array's length is the client's choice: running all of it at
    // once was a way around the 4-in-flight ceiling that single frames obey.
    let inFlight = 0;
    let peak = 0;
    const slow = testAdapter({
      async callTool(name, args) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { text: `${name}:${String(args.text)}` };
      },
    });
    const batch = JSON.stringify(
      Array.from({ length: 20 }, (_, i) => ({
        jsonrpc: "2.0",
        id: i + 1,
        method: "tools/call",
        params: { name: "probe_echo", arguments: { text: String(i) } },
      })),
    );
    const input = Readable.from([batch + "\n"]);
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    await runStdioServer(slow, { input, output, captureStdout: true });
    const frames = chunks.join("").split("\n").filter(Boolean);
    expect(frames).toHaveLength(1); // one array answers the whole batch
    const answers = JSON.parse(frames[0]!) as { id: number }[];
    expect(new Set(answers.map((a) => a.id))).toEqual(new Set(Array.from({ length: 20 }, (_, i) => i + 1)));
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("holds the ceiling across several batches at once, not per batch", async () => {
    // Bounding each batch on its own is not a ceiling: the in-flight set counts
    // a whole batch as one entry, so four batch frames of four handlers each
    // ran sixteen tool calls at once — four times the advertised limit, and
    // reachable by a client that simply frames its requests differently.
    let inFlight = 0;
    let peak = 0;
    const slow = testAdapter({
      async callTool(name, args) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return { text: `${name}:${String(args.text)}` };
      },
    });
    const batchFrame = (offset: number) =>
      JSON.stringify(
        Array.from({ length: 8 }, (_, i) => ({
          jsonrpc: "2.0",
          id: offset + i,
          method: "tools/call",
          params: { name: "probe_echo", arguments: { text: String(i) } },
        })),
      );
    const input = Readable.from([0, 100, 200, 300].map((o) => batchFrame(o) + "\n"));
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    });
    await runStdioServer(slow, { input, output, captureStdout: true });
    const frames = chunks.join("").split("\n").filter(Boolean);
    expect(frames).toHaveLength(4); // one array per batch, all answered
    expect(frames.flatMap((f) => JSON.parse(f) as unknown[])).toHaveLength(32);
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe("a busy server still listens", () => {
  // Four slow tool calls hold every slot. The read loop used to wait for one
  // of them before reading the next line, so a ping, and above all the
  // notifications/cancelled meant for those very calls, sat unread until a
  // call finished on its own.
  function harness() {
    const input = new PassThrough();
    const frames: Record<string, unknown>[] = [];
    let partial = "";
    const output = new Writable({
      write(chunk, _enc, cb) {
        partial += String(chunk);
        const lines = partial.split("\n");
        partial = lines.pop()!;
        for (const l of lines) if (l) frames.push(JSON.parse(l));
        cb();
      },
    });
    const releases: (() => void)[] = [];
    let started = 0;
    const adapter = testAdapter({
      async callTool(_name, args) {
        started++;
        await new Promise<void>((resolve) => releases.push(resolve));
        return { text: String(args.text) };
      },
    });
    const done = runStdioServer(adapter, { input, output, captureStdout: true });
    const send = (m: unknown) => input.write(JSON.stringify(m) + "\n");
    const tick = () => new Promise((r) => setTimeout(r, 20));
    return { input, frames, releases, started: () => started, done, send, tick };
  }
  const toolCall = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "probe_echo", arguments: { text: `t${id}` } } });

  it("answers a ping while every slot is held", async () => {
    const h = harness();
    for (const id of [1, 2, 3, 4]) h.send(toolCall(id));
    await h.tick();
    h.send({ jsonrpc: "2.0", id: 99, method: "ping" });
    await h.tick();
    expect(h.frames).toEqual([{ jsonrpc: "2.0", id: 99, result: {} }]);
    for (const r of h.releases.splice(0)) r();
    h.input.end();
    await h.done;
    expect(h.frames).toHaveLength(5);
  });

  it("drops a call cancelled while it waited for a slot, without running it", async () => {
    const h = harness();
    for (const id of [1, 2, 3, 4, 5]) h.send(toolCall(id));
    await h.tick();
    h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5 } });
    await h.tick();
    expect(h.started()).toBe(4);
    for (const r of h.releases.splice(0)) r();
    await h.tick();
    h.input.end();
    await h.done;
    expect(h.started()).toBe(4);
    expect(h.frames.map((f) => f.id).sort()).toEqual([1, 2, 3, 4]);
  });

  it("drops a running call cancelled while every slot was busy", async () => {
    const h = harness();
    for (const id of [1, 2, 3, 4]) h.send(toolCall(id));
    await h.tick();
    h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } });
    await h.tick();
    for (const r of h.releases.splice(0)) r();
    h.input.end();
    await h.done;
    expect(h.frames.map((f) => f.id).sort()).toEqual([1, 3, 4]);
  });
});

describe("batches", () => {
  it("answers an empty batch with one invalid-request error, as JSON-RPC says", async () => {
    const out = await run(["[]"]);
    expect(out).toEqual([{ jsonrpc: "2.0", id: null, error: expect.objectContaining({ code: -32600 }) }]);
  });

  it("answers a batch on a revision that still has them", async () => {
    const out = await run([rpc(1, "initialize", { protocolVersion: "2025-03-26" }), JSON.stringify([JSON.parse(rpc(2, "ping")), JSON.parse(rpc(3, "ping"))])]);
    expect(out[1]).toEqual([
      { jsonrpc: "2.0", id: 2, result: {} },
      { jsonrpc: "2.0", id: 3, result: {} },
    ]);
  });

  it("refuses a batch once the client negotiated 2025-06-18 or later, which removed them", async () => {
    const out = await run([rpc(1, "initialize", { protocolVersion: "2025-06-18" }), JSON.stringify([JSON.parse(rpc(2, "ping"))])]);
    expect(out[1]).toMatchObject({ id: null, error: { code: -32600, message: expect.stringMatching(/batch/) } });
  });
});

describe("stdout hygiene", () => {
  it("leaves process.stdout untouched when the caller supplies a stream", async () => {
    // The guard exists because a stray console.log inside a tool would corrupt
    // the frame stream. With captureStdout the test owns the stream instead.
    const before = process.stdout.write;
    await run([rpc(1, "ping", {})]);
    expect(process.stdout.write).toBe(before);
  });

  it("restores process.stdout after serving on it", async () => {
    // Without captureStdout the transport redirects stdout to stderr for the
    // duration, so nothing but frames can reach the client. It must put the
    // real writer back afterwards, or the host process is left broken.
    const original = process.stdout.write;
    const input = new PassThrough();
    const output = process.stdout;
    const done = runStdioServer(testAdapter(), { input, output });
    expect(process.stdout.write).not.toBe(original);
    input.end();
    await done;
    expect(process.stdout.write).toBe(original);
  });
});
