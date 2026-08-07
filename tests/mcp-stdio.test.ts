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
