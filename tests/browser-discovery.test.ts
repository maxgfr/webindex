import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateTarget,
  assertLoopback,
  closeTarget,
  getVersion,
  isPortAlive,
  listPages,
  listTargets,
  newTarget,
  parseCdpEndpoint,
} from "../src/browser/discovery.js";
import { FakeCdp } from "./helpers/fake-cdp.js";

let fake: FakeCdp;
beforeEach(async () => {
  fake = await FakeCdp.start();
});
afterEach(async () => {
  await fake.close();
});

describe("DevTools endpoints", () => {
  it("getVersion reads /json/version", async () => {
    const v = await getVersion(fake.port);
    expect(v.Browser).toBe("FakeChrome/1.0");
    expect(v.webSocketDebuggerUrl).toBe(fake.browserWsUrl);
  });

  it("listTargets / listPages", async () => {
    fake.addTarget("https://a.test/");
    fake.addTarget("chrome-extension://x/bg.html", "bg", "service_worker");
    expect(await listTargets(fake.port)).toHaveLength(2);
    const pages = await listPages(fake.port);
    expect(pages.map((t) => t.url)).toEqual(["https://a.test/"]);
  });

  it("newTarget uses PUT with the url encoded, and returns the target", async () => {
    const t = await newTarget(fake.port, "https://a.test/?q=1&r=2");
    expect(fake.requests).toEqual([`PUT /json/new?${encodeURIComponent("https://a.test/?q=1&r=2")}`]);
    expect(t.url).toBe("https://a.test/?q=1&r=2");
    expect(t.webSocketDebuggerUrl).toContain(`/devtools/page/${t.id}`);
  });

  it("newTarget without a url opens about:blank", async () => {
    const t = await newTarget(fake.port);
    expect(fake.requests).toEqual(["PUT /json/new"]);
    expect(t.url).toBe("about:blank");
  });

  it("newTarget falls back to GET when PUT is refused with 405", async () => {
    fake.rejectPut = true;
    const t = await newTarget(fake.port, "https://b.test/");
    expect(fake.requests.map((r) => r.split(" ")[0])).toEqual(["PUT", "GET"]);
    expect(t.url).toBe("https://b.test/");
  });

  it("newTarget does not retry when the port is dead", async () => {
    const dead = await FakeCdp.start();
    const port = dead.port;
    await dead.close();
    await expect(newTarget(port, "https://c.test/")).rejects.toThrow();
  });

  it("closeTarget and activateTarget", async () => {
    const t = fake.addTarget("https://a.test/");
    await activateTarget(fake.port, t.id);
    await closeTarget(fake.port, t.id);
    expect(fake.requests).toEqual([`GET /json/activate/${t.id}`, `GET /json/close/${t.id}`]);
    expect(fake.targets).toHaveLength(0);
    await expect(closeTarget(fake.port, "nope")).rejects.toThrow(/HTTP 404/);
    await expect(activateTarget(fake.port, "nope")).rejects.toThrow(/HTTP 404/);
  });

  it("isPortAlive is true on a live endpoint, false on a closed port", async () => {
    expect(await isPortAlive(fake.port)).toBe(true);
    const dead = await FakeCdp.start();
    const port = dead.port;
    await dead.close();
    expect(await isPortAlive(port)).toBe(false);
    expect(await isPortAlive(fake.port, "example.com")).toBe(false);
  });

  it("refuses a non-loopback host before connecting", async () => {
    await expect(getVersion(fake.port, "192.168.1.2")).rejects.toThrow(/non-loopback/);
  });
});

describe("misbehaving servers", () => {
  const serve = async (handler: Parameters<typeof createServer>[1]) => {
    const server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return {
      port: (server.address() as AddressInfo).port,
      stop: () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    };
  };

  it("turns invalid JSON into a clear error", async () => {
    const s = await serve((_req, res) => res.end("<html>nope</html>"));
    await expect(getVersion(s.port)).rejects.toThrow(/did not return valid JSON/);
    await s.stop();
  });

  it("turns a non-2xx status into an error, and isPortAlive into false", async () => {
    const s = await serve((_req, res) => {
      res.statusCode = 500;
      res.end("x");
    });
    await expect(listTargets(s.port)).rejects.toThrow(/HTTP 500/);
    expect(await isPortAlive(s.port)).toBe(false);
    await s.stop();
  });

  it("times out on a server that never answers", async () => {
    const s = await serve(() => {});
    expect(await isPortAlive(s.port)).toBe(false);
    await s.stop();
  }, 10_000);
});

describe("loopback parsing", () => {
  const accepted: Array<[string, { host: string; port: number; wsUrl?: string }]> = [
    ["9222", { host: "127.0.0.1", port: 9222 }],
    [" 9222 ", { host: "127.0.0.1", port: 9222 }],
    ["127.0.0.1:9222", { host: "127.0.0.1", port: 9222 }],
    ["localhost:9333", { host: "localhost", port: 9333 }],
    ["http://localhost:9222", { host: "localhost", port: 9222 }],
    ["http://LOCALHOST:9222/", { host: "localhost", port: 9222 }],
    ["http://[::1]:9222", { host: "::1", port: 9222 }],
    ["ws://[::1]:9222/devtools/browser/x", { host: "::1", port: 9222, wsUrl: "ws://[::1]:9222/devtools/browser/x" }],
    ["ws://127.0.0.1:1234/devtools/browser/abc", { host: "127.0.0.1", port: 1234, wsUrl: "ws://127.0.0.1:1234/devtools/browser/abc" }],
  ];
  for (const [input, expected] of accepted) {
    it(`accepts ${input}`, () => expect(parseCdpEndpoint(input)).toEqual(expected));
  }

  const rejected: Array<[string, RegExp]> = [
    ["0.0.0.0:9222", /non-loopback/],
    ["192.168.1.2:9222", /non-loopback/],
    ["example.com:9222", /non-loopback/],
    ["localhost.evil.com:9222", /non-loopback/],
    ["http://127.0.0.1.evil.com:9222", /non-loopback/],
    ["ws://10.0.0.1:9222/devtools/browser/x", /non-loopback/],
    ["http://localhost", /no port/],
    ["0", /invalid port/],
    ["70000", /invalid port/],
    ["ftp://localhost:9222", /unsupported/],
    ["http://", /invalid/],
  ];
  for (const [input, re] of rejected) {
    it(`rejects ${input}`, () => expect(() => parseCdpEndpoint(input)).toThrow(re));
  }

  it("assertLoopback strips brackets and rejects the rest", () => {
    expect(assertLoopback("[::1]")).toBe("::1");
    expect(assertLoopback("localhost")).toBe("localhost");
    expect(() => assertLoopback("0.0.0.0")).toThrow(/non-loopback/);
  });
});
