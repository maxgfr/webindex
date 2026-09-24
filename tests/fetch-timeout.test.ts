import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, afterEach, vi } from "vitest";
// Env names resolve through the brand, exactly as the engine resolves them.
import { envName } from "../src/brand.js";
import { cachedFetchAndExtract } from "../src/cache.js";
import { fetchAndExtract, httpGet, httpJson } from "../src/fetch.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// Both HTTP entry points arm an AbortController before every attempt, so a host
// that accepts the connection and then says nothing costs a bounded wait rather
// than hanging the run. Nothing else in the suite exercises that path: every
// other test's mock answers immediately.
//
// The stub resolves only when the signal fires, which is the shape of a real
// blackholed host — and means these tests would hang, not fail, if the abort
// were ever dropped.
function installHangingFetch() {
  const spy = vi.fn((_input: unknown, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("request timeouts", () => {
  it("gives up on a host that never answers, and reports it instead of throwing", async () => {
    installHangingFetch();
    vi.stubEnv(envName("MAX_ATTEMPTS"), "1");
    const r = await httpGet("https://blackhole.test/x", { timeoutMs: 5 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toBeTruthy();
  });

  it("takes its default from <PREFIX>_TIMEOUT_MS when the caller names none", async () => {
    vi.useFakeTimers();
    installHangingFetch();
    vi.stubEnv(envName("TIMEOUT_MS"), "1500");
    const pending = httpGet("https://blackhole.test/x");
    const json = httpJson("GET", "https://blackhole.test/j");
    await vi.advanceTimersByTimeAsync(1500);
    expect((await pending).error).toBe("timed out after 1500 ms");
    expect((await json).error).toBe("timed out after 1500 ms");
  });

  it("carries a caller's timeout through fetchAndExtract and the cache", async () => {
    installHangingFetch();
    expect((await fetchAndExtract("https://blackhole.test/page", { timeoutMs: 5 })).note).toMatch(/timed out after 5 ms/);
    expect((await cachedFetchAndExtract("https://blackhole.test/page", { timeoutMs: 5 }, true)).note).toMatch(/timed out after 5 ms/);
  });

  it("does the same for a JSON endpoint", async () => {
    installHangingFetch();
    vi.stubEnv(envName("MAX_ATTEMPTS"), "1");
    const r = await httpJson("POST", "https://blackhole.test/v2/scrape", { url: "https://x.test" }, { timeoutMs: 5 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toBeTruthy();
  });
});

// undici reports every network failure as "fetch failed" and keeps the reason
// on `cause`. These stubs throw exactly that shape.
function failingFetch(cause: Error & { code?: string }) {
  const spy = vi.fn(async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}
const withCode = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});

describe("network failure reporting", () => {
  it("names the cause undici hides behind 'fetch failed'", async () => {
    failingFetch(withCode("connect ECONNREFUSED 127.0.0.1:9", "ECONNREFUSED"));
    expect((await httpGet("https://refused.test/x", { retries: 0 })).error).toBe("connect ECONNREFUSED 127.0.0.1:9");
    failingFetch(withCode("", "ECONNRESET"));
    expect((await httpGet("https://reset.test/x", { retries: 0 })).error).toBe("ECONNRESET");
    failingFetch(withCode("socket hang up", "UND_ERR_SOCKET"));
    expect((await httpJson("GET", "https://reset.test/j", undefined, { retries: 0 })).error).toBe("UND_ERR_SOCKET: socket hang up");
  });

  it("says a timeout was a timeout, and how long it waited", async () => {
    installHangingFetch();
    vi.stubEnv(envName("MAX_ATTEMPTS"), "1");
    expect((await httpGet("https://blackhole.test/x", { timeoutMs: 5 })).error).toBe("timed out after 5 ms");
    expect((await httpJson("GET", "https://blackhole.test/j", undefined, { timeoutMs: 5 })).error).toBe("timed out after 5 ms");
  });

  it.each([
    ["a redirect loop", withCode("redirect count exceeded")],
    ["an unknown host", withCode("getaddrinfo ENOTFOUND nowhere.invalid", "ENOTFOUND")],
    ["a redirect to another scheme", withCode("URL scheme must be a HTTP(S) scheme")],
    ["a blocked port", withCode("bad port")],
    ["an expired certificate", withCode("certificate has expired", "CERT_HAS_EXPIRED")],
  ])("does not retry %s, which fails the same way every time", async (_label, cause) => {
    const spy = failingFetch(cause);
    const r = await httpGet("https://permanent.test/x", { retries: 2 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain(cause.message);
    expect(spy).toHaveBeenCalledTimes(1);
    const json = failingFetch(cause);
    await httpJson("GET", "https://permanent.test/j", undefined, { retries: 2 });
    expect(json).toHaveBeenCalledTimes(1);
  });

  it("does not spend a second full timeout on a host that never answered the first", async () => {
    // attempts × timeout was the real worst case: a blackholed host cost 40 s
    // for a documented 20 s budget.
    const spy = installHangingFetch();
    const r = await httpGet("https://blackhole.test/x", { timeoutMs: 5, retries: 2 });
    expect(r.error).toMatch(/timed out/);
    expect(spy).toHaveBeenCalledTimes(1);
    const json = installHangingFetch();
    await httpJson("GET", "https://blackhole.test/j", undefined, { timeoutMs: 5, retries: 2 });
    expect(json).toHaveBeenCalledTimes(1);
  });

  it("still retries a transient failure", async () => {
    const spy = failingFetch(withCode("read ECONNRESET", "ECONNRESET"));
    await httpGet("https://flaky.test/x", { retries: 1 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("walks a real redirect loop once, not once per attempt", async () => {
    // Against real undici rather than a stub, so the shape of `cause` is the
    // runtime's own and not this suite's guess at it.
    let hits = 0;
    const server = createServer((req, res) => {
      hits++;
      res.writeHead(302, { location: req.url === "/a" ? "/b" : "/a" }).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const r = await httpGet(`http://127.0.0.1:${port}/a`, { retries: 1 });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/redirect/i);
      expect(hits).toBe(21);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
