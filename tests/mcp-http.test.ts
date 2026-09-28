import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHttpServer, type RunningHttpServer } from "../src/mcp/http.js";
import { LATEST_PROTOCOL } from "../src/mcp/protocol.js";
import { testAdapter } from "./adapter.js";

// The HTTP transport is the one with security properties: it listens on a
// socket, so binding, origin checking and body limits are load-bearing rather
// than cosmetic. Driven with a fake skill, as the stdio suite is.

let running: RunningHttpServer;

beforeAll(async () => {
  running = await startHttpServer(testAdapter(), { port: 0 });
});
afterAll(async () => {
  await running?.close();
});

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(running.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const rpc = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, params });

// fetch()'s json() is `unknown`; these are JSON-RPC envelopes and every case
// asserts on a named field, so one helper beats a cast per line.
const json = async (res: Response): Promise<any> => res.json();

describe("binding", () => {
  it("refuses a non-loopback bind unless explicitly allowed", async () => {
    // This server fetches arbitrary URLs and reads local files, so an exposed
    // port is a fetch-anything primitive for whoever finds it. The refusal
    // names the flag rather than failing silently.
    await expect(startHttpServer(testAdapter(), { port: 0, bind: "0.0.0.0" })).rejects.toThrow(/refusing to bind/);
  });

  it("allows it when the caller says so", async () => {
    const s = await startHttpServer(testAdapter(), { port: 0, bind: "0.0.0.0", allowRemote: true });
    expect(s.port).toBeGreaterThan(0);
    await s.close();
  });

  it("names the consuming skill in the refusal, not the engine", async () => {
    // A user reads this message in their own tool's output.
    await expect(startHttpServer(testAdapter(), { port: 0, bind: "0.0.0.0" })).rejects.toThrow(/webindex-tests/);
  });
});

describe("JSON-RPC over POST", () => {
  it("serves initialize with the skill's identity", async () => {
    const body = await json(await post(rpc(1, "initialize", { protocolVersion: LATEST_PROTOCOL })));
    expect(body.result.serverInfo).toMatchObject({ name: "webindex-tests", version: "9.9.9" });
  });

  it("lists the adapter's tools", async () => {
    const body = await json(await post(rpc(1, "tools/list")));
    expect(body.result.tools.map((t: { name: string }) => t.name)).toContain("probe_echo");
  });

  it("runs a tool", async () => {
    const body = await json(await post(rpc(1, "tools/call", { name: "probe_echo", arguments: { text: "ok" } })));
    expect(body.result.content[0].text).toBe("ok");
  });

  it("handles a batch", async () => {
    const body = await json(await post([rpc(1, "ping"), rpc(2, "ping")]));
    expect(body).toHaveLength(2);
  });

  it("refuses a batch from a client on 2025-06-18 or later, which removed them", async () => {
    const res = await post([rpc(1, "ping")], { "mcp-protocol-version": "2025-06-18" });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it("answers an empty batch with an invalid-request error, not a 202", async () => {
    const res = await post([]);
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it("bounds how long a request may take to arrive, and nothing else", async () => {
    // A slow-trickled body held its connection forever with the timeout off.
    // Node's requestTimeout only covers receiving the request — a response that
    // takes minutes to compute is not cut by it — so switching it off bought
    // nothing but that.
    expect(running.server.requestTimeout).toBeGreaterThan(0);
  });

  it("answers a parse error rather than a 500", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(200);
    expect((await json(res)).error.code).toBe(-32700);
  });

  it("returns 202 with no body when the payload held only notifications", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("returns 202 for a POSTed response too, as the transport requires", async () => {
    const res = await post({ jsonrpc: "2.0", id: 10, result: {} });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });
});

describe("progress and cancellation over HTTP", () => {
  const progressing = () =>
    testAdapter({
      callTool: async (_name, _args, ctx) => {
        ctx!.progress(1, 2, "half");
        ctx!.progress(2, 2);
        return { text: "done" };
      },
    });
  const asking = { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "probe_echo", arguments: { text: "x" }, _meta: { progressToken: "p" } } };

  it("streams progress, then the answer, as SSE to a client that asked for progress and accepts a stream", async () => {
    const s = await startHttpServer(progressing(), { port: 0 });
    try {
      const res = await fetch(s.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(asking),
      });
      expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
      const events = (await res.text())
        .split("\n\n")
        .filter(Boolean)
        .map((e) =>
          JSON.parse(
            e
              .split("\n")
              .find((l) => l.startsWith("data: "))!
              .slice(6),
          ),
        );
      expect(events.map((e) => e.method ?? `reply ${e.id}`)).toEqual(["notifications/progress", "notifications/progress", "reply 5"]);
      expect(events[0].params).toEqual({ progressToken: "p", progress: 1, total: 2, message: "half" });
      expect(events[2].result.content[0].text).toBe("done");
    } finally {
      await s.close();
    }
  });

  it("opens no stream for a message that will never be answered", async () => {
    const s = await startHttpServer(progressing(), { port: 0 });
    try {
      const res = await fetch(s.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ ...asking, id: null }),
      });
      expect(res.status).toBe(202);
    } finally {
      await s.close();
    }
  });

  it("answers plain JSON, with no progress mixed in, to a client that accepts only JSON", async () => {
    const s = await startHttpServer(progressing(), { port: 0 });
    try {
      const res = await fetch(s.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(asking),
      });
      expect(res.headers.get("content-type")).toMatch(/^application\/json/);
      expect(await json(res)).toMatchObject({ id: 5, result: { content: [{ text: "done" }] } });
    } finally {
      await s.close();
    }
  });

  it("aborts the tool's signal when the client hangs up before the answer", async () => {
    // Stateless: a notifications/cancelled in another POST cannot name this
    // request, so the connection closing is the only cancel there is.
    let aborted!: () => void;
    const stopped = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const s = await startHttpServer(
      testAdapter({
        callTool: (_name, _args, ctx) =>
          new Promise((resolve) => {
            ctx!.signal.addEventListener("abort", () => {
              aborted();
              resolve({ text: "stopped" });
            });
          }),
      }),
      { port: 0 },
    );
    try {
      const ctrl = new AbortController();
      const pending = fetch(s.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rpc(1, "tools/call", { name: "probe_echo", arguments: { text: "x" } })),
        signal: ctrl.signal,
      }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 50));
      ctrl.abort();
      await pending;
      await Promise.race([stopped, new Promise((_, reject) => setTimeout(() => reject(new Error("the tool was never told")), 2000))]);
    } finally {
      await s.close();
    }
  });
});

describe("protocol version per request", () => {
  it("takes the negotiated version from the header, since there is no session", async () => {
    // Stateless: two overlapping requests on different revisions must not read
    // each other's negotiated version.
    const res = await post(rpc(1, "tools/list"), { "mcp-protocol-version": "2024-11-05" });
    const echo = (await json(res)).result.tools.find((t: { name: string }) => t.name === "probe_echo");
    expect(echo.outputSchema).toBeUndefined();
    expect(echo.annotations).toBeUndefined();
  });
});

describe("origin checking", () => {
  it("rejects a cross-origin request by default", async () => {
    // DNS-rebinding protection: a page the user visits must not be able to
    // drive their local MCP server.
    const res = await post(rpc(1, "ping"), { origin: "https://evil.example.com" });
    expect(res.status).toBe(403);
  });

  it.each(["null", ""])("rejects opaque or empty Origin %j on preflight and tool calls", async (origin) => {
    const preflight = await fetch(running.url, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    const response = await post(rpc(1, "tools/call", { name: "probe_echo", arguments: { text: "private result" } }), { origin });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("accepts an origin the caller allowlisted", async () => {
    const s = await startHttpServer(testAdapter(), { port: 0, allowOrigin: ["https://app.example.com"] });
    const res = await fetch(s.url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example.com" },
      body: JSON.stringify(rpc(1, "ping")),
    });
    expect(res.status).toBe(200);
    await s.close();
  });
});

describe("bearer token", () => {
  // Opt-in, for a server others can reach: without it anyone who finds the
  // port has a fetch-anything proxy.
  it("answers only a request carrying the operator's token", async () => {
    const s = await startHttpServer(testAdapter(), { port: 0, bearerToken: "s3cret-token" });
    try {
      const call = (headers: Record<string, string>) =>
        fetch(s.url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(rpc(1, "ping")) });
      const none = await call({});
      expect(none.status).toBe(401);
      expect(none.headers.get("www-authenticate")).toMatch(/^Bearer/);
      expect((await call({ authorization: "Bearer wrong" })).status).toBe(401);
      expect((await call({ authorization: "Bearer s3cret-token-and-more" })).status).toBe(401);
      expect((await call({ authorization: "s3cret-token" })).status).toBe(401);
      const ok = await call({ authorization: "Bearer s3cret-token" });
      expect(ok.status).toBe(200);
      expect(await json(ok)).toMatchObject({ id: 1, result: {} });
    } finally {
      await s.close();
    }
  });

  it("still answers a CORS preflight, which a browser sends without credentials", async () => {
    const s = await startHttpServer(testAdapter(), { port: 0, bearerToken: "s3cret-token" });
    try {
      const pre = await fetch(s.url, { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" } });
      expect(pre.status).toBe(204);
    } finally {
      await s.close();
    }
  });
});

describe("routing", () => {
  it("404s a path that is not the MCP endpoint", async () => {
    expect((await fetch(running.url.replace("/mcp", "/nope"))).status).toBe(404);
  });
});
