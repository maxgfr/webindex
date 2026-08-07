import { describe, expect, it } from "vitest";
import { createServer, type JsonRpcMessage } from "../src/mcp/server.js";
import { LATEST_PROTOCOL } from "../src/mcp/protocol.js";
import { testAdapter } from "./adapter.js";

// The engine owns the protocol; the skill owns the tools. These drive the
// server directly with a fake skill, so every assertion is about a decision
// this file makes rather than about what any particular skill happens to
// expose. The end-to-end MCP suites stay with each consumer.

async function call(msg: JsonRpcMessage, server = createServer(testAdapter())): Promise<JsonRpcMessage | undefined> {
  let out: JsonRpcMessage | undefined;
  await server.handle(msg, (m) => {
    out = m;
  });
  return out;
}

const rpc = (method: string, params?: Record<string, unknown>, id: string | number = 1): JsonRpcMessage => ({ jsonrpc: "2.0", id, method, params });

describe("initialize", () => {
  it("reports the skill's name and version, not the engine's", async () => {
    // A client shows the user which server it is talking to. "webindex" would
    // be a lie: they installed ultradoc.
    const r = await call(rpc("initialize", { protocolVersion: LATEST_PROTOCOL }));
    expect(r!.result).toMatchObject({ serverInfo: { name: "webindex-tests", version: "9.9.9" } });
  });

  it("declares all three primitives", async () => {
    const r = await call(rpc("initialize", {}));
    expect((r!.result as any).capabilities).toEqual({
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
    });
  });

  it("negotiates down to a version the client asked for", async () => {
    const r = await call(rpc("initialize", { protocolVersion: "2024-11-05" }));
    expect((r!.result as any).protocolVersion).toBe("2024-11-05");
  });
});

describe("notifications", () => {
  it("are acted on but never answered", async () => {
    const r = await call({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(r).toBeUndefined();
  });

  it("suppress the response to a cancelled request", async () => {
    // Per spec a cancelled request gets NO response at all.
    const server = createServer(testAdapter());
    await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }, () => {
      throw new Error("a notification must not be answered");
    });
    const out = await call(rpc("ping", {}, 7), server);
    expect(out).toBeUndefined();
  });

  it("cancelling an id that was never in flight does not affect other ids", async () => {
    const server = createServer(testAdapter());
    await server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "ghost" } }, () => {});
    expect(await call(rpc("ping", {}, 1), server)).toBeDefined();
  });
});

describe("tools/list", () => {
  it("advertises the adapter's tools", async () => {
    const r = await call(rpc("tools/list"));
    expect((r!.result as any).tools.map((t: any) => t.name)).toEqual(["probe_echo", "probe_big", "probe_fail", "probe_crash"]);
  });

  it("hides rich fields from a client that negotiated an older revision", async () => {
    // Advertising a field the negotiated revision does not define is a spec
    // violation, and older clients reject the whole declaration over it.
    const server = createServer(testAdapter());
    await call(rpc("initialize", { protocolVersion: "2024-11-05" }), server);
    const r = await call(rpc("tools/list"), server);
    const echo = (r!.result as any).tools[0];
    expect(echo.outputSchema).toBeUndefined();
    expect(echo.annotations).toBeUndefined();
  });

  it("includes them once the client is new enough", async () => {
    const server = createServer(testAdapter());
    await call(rpc("initialize", { protocolVersion: LATEST_PROTOCOL }), server);
    const r = await call(rpc("tools/list"), server);
    const echo = (r!.result as any).tools[0];
    expect(echo.outputSchema).toBeDefined();
    expect(echo.annotations).toEqual({ readOnlyHint: true });
  });
});

describe("tools/call", () => {
  it("runs the tool and returns its text", async () => {
    const r = await call(rpc("tools/call", { name: "probe_echo", arguments: { text: "ab", times: 2 } }));
    expect((r!.result as any).content).toEqual([{ type: "text", text: "abab" }]);
  });

  it("rejects an unknown tool as a PROTOCOL error", async () => {
    // The client asked for something that does not exist. That is its bug, not
    // a tool failure — hiding it inside a readable result makes the model try
    // to reason around it.
    const r = await call(rpc("tools/call", { name: "nope", arguments: {} }));
    expect(r!.error).toMatchObject({ code: -32602 });
    expect((r!.error as any).message).toMatch(/unknown tool: nope/);
  });

  it("rejects arguments the declared schema forbids", async () => {
    const missing = await call(rpc("tools/call", { name: "probe_echo", arguments: {} }));
    expect(missing!.error).toMatchObject({ code: -32602 });
    const wrongType = await call(rpc("tools/call", { name: "probe_echo", arguments: { text: 42 } }));
    expect(wrongType!.error).toMatchObject({ code: -32602 });
  });

  it("returns a tool's own failure as a readable result, not a protocol error", async () => {
    // The tool RAN and could not finish. The caller can act on that, so it
    // comes back as text the model reads.
    const r = await call(rpc("tools/call", { name: "probe_fail", arguments: {} }));
    expect(r!.error).toBeUndefined();
    expect(r!.result).toMatchObject({ isError: true });
    expect((r!.result as any).content[0].text).toBe("the dossier is not there");
  });

  it("reports an unexpected throw as an internal error", async () => {
    // Not a ToolError: this is a bug in the tool, and dressing it up as a
    // result the model can work around would hide it.
    const r = await call(rpc("tools/call", { name: "probe_crash", arguments: {} }));
    expect(r!.error).toMatchObject({ code: -32603 });
  });

  it("caps an oversized response and says where the full artifact is", async () => {
    const server = createServer(testAdapter(), { maxResponseBytes: 500 });
    const r = await call(rpc("tools/call", { name: "probe_big", arguments: {} }), server);
    const text = (r!.result as any).content[0].text as string;
    expect(text.length).toBeLessThan(50_000);
    expect(text).toContain("/tmp/probe/BIG.md");
  });
});

describe("prompts", () => {
  it("lists what the adapter declares", async () => {
    const r = await call(rpc("prompts/list"));
    expect((r!.result as any).prompts.map((p: any) => p.name)).toEqual(["probe_prompt"]);
  });

  it("renders a prompt", async () => {
    const r = await call(rpc("prompts/get", { name: "probe_prompt", arguments: { topic: "caching" } }));
    expect((r!.result as any).messages[0].content.text).toBe("about caching");
  });

  it("treats an unknown prompt or a missing argument as a client error", async () => {
    expect((await call(rpc("prompts/get", { name: "nope" })))!.error).toMatchObject({ code: -32602 });
    expect((await call(rpc("prompts/get", { name: "probe_prompt", arguments: {} })))!.error).toMatchObject({ code: -32602 });
  });

  it("answers cleanly when the skill declares no prompts at all", async () => {
    const server = createServer(testAdapter({ prompts: undefined, getPrompt: undefined }));
    expect((await call(rpc("prompts/list"), server))!.result).toEqual({ prompts: [] });
    expect((await call(rpc("prompts/get", { name: "x" }), server))!.error).toMatchObject({ code: -32602 });
  });
});

describe("malformed input", () => {
  it("rejects a non-object message", async () => {
    for (const bad of [null, [], "string", 42]) {
      const r = await call(bad as unknown as JsonRpcMessage);
      expect(r!.error, JSON.stringify(bad)).toMatchObject({ code: -32600 });
    }
  });

  it("reports an unknown method", async () => {
    const r = await call(rpc("does/not/exist"));
    expect(r!.error).toMatchObject({ code: -32601 });
  });

  it("requires a uri for resources/read", async () => {
    const r = await call(rpc("resources/read", {}));
    expect(r!.error).toMatchObject({ code: -32602 });
  });
});
