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

describe("routing", () => {
  it("404s a path that is not the MCP endpoint", async () => {
    expect((await fetch(running.url.replace("/mcp", "/nope"))).status).toBe(404);
  });
});
