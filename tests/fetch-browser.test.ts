import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envName } from "../src/brand.js";
import { readRenderedPage } from "../src/browser/read.js";
import { cachedFetchAndExtract, resetCacheMode, setCacheMode } from "../src/cache.js";
import { mcpPolicy, webindexAdapter } from "../src/cli.js";
import { type ExtractResult, fetchAndExtract } from "../src/fetch.js";
import { installFetchMock, routes } from "./fetchmock.js";

// The `browser` rung of fetchAndExtract, with the browser read stubbed: no Chrome here.
vi.mock("../src/browser/read.js", () => ({ readRenderedPage: vi.fn() }));
const read = vi.mocked(readRenderedPage);

const LONG = `<html><head><title>Good</title></head><body><article><h1>Good page</h1><p>${"A proper paragraph of real prose. ".repeat(12)}</p></article></body></html>`;
const SHORT = "<html><body><p>Loading…</p></body></html>";
const WALL = "<html><body><p>Please enable JavaScript to view this site.</p></body></html>";
const RENDERED = `Rendered text. ${"Hydrated by script. ".repeat(15)}`;

const rendered = (url: string, over: Partial<ExtractResult> = {}): ExtractResult => ({
  text: RENDERED,
  title: "Rendered",
  finalUrl: url,
  status: 200,
  extractor: "browser",
  ...over,
});

// tests/setup.ts resets every <PREFIX>_ variable after each case.
let dir: string;
beforeEach(() => {
  read.mockReset();
  read.mockImplementation(async (url) => rendered(url));
  dir = mkdtempSync(join(tmpdir(), "wi-fetch-browser-"));
  process.env[envName("CACHE_DIR")] = dir;
});
afterEach(() => {
  resetCacheMode();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("fetchAndExtract with browser: always", () => {
  it("reads the page in the browser, before Firecrawl and without fetching it", async () => {
    const spy = installFetchMock(routes([["x.test", { body: LONG }]]));
    const r = await fetchAndExtract("https://x.test/a", {
      browser: "always",
      firecrawl: "http://fc.test",
      format: "markdown",
      fullPage: true,
      keepHtml: true,
      timeoutMs: 5000,
    });
    expect(r).toMatchObject({ text: RENDERED, extractor: "browser" });
    expect(spy).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith("https://x.test/a", {
      format: "markdown",
      fullPage: true,
      stripConsent: undefined,
      keepHtml: true,
      signal: undefined,
      timeoutMs: 5000,
    });
  });

  it("falls through to the usual ladder with a note when the browser cannot be had", async () => {
    read.mockRejectedValue(new Error("no Chrome, Brave, Chromium or Edge found"));
    installFetchMock(routes([["x.test", { body: LONG }]]));
    const r = await fetchAndExtract("https://x.test/a", { browser: "always" });
    expect(r.extractor).toBeUndefined();
    expect(r.text).toContain("Good page");
    expect(r.note).toBe("The browser could not read https://x.test/a (no Chrome, Brave, Chromium or Edge found); read without it.");
  });

  it("does not take an error page the browser rendered for the page", async () => {
    installFetchMock(routes([["x.test", { body: LONG }]]));
    read.mockResolvedValue(rendered("https://x.test/a", { status: 404, text: `Page not found. ${"Try the search box. ".repeat(20)}` }));
    const r = await fetchAndExtract("https://x.test/a", { browser: "always" });
    expect(r.extractor).toBeUndefined();
    expect(r.text).toContain("Good page");
    expect(r.note).toBe("The browser got HTTP 404 for https://x.test/a; read without it.");
  });

  it("leaves a revalidation (a conditional GET) to the fetch", async () => {
    installFetchMock(routes([["x.test", { body: LONG }]]));
    await fetchAndExtract("https://x.test/a", { browser: "always", headers: { "if-none-match": '"v1"' } });
    expect(read).not.toHaveBeenCalled();
  });

  it("takes its mode from BROWSER_FETCH, which an explicit option overrides", async () => {
    installFetchMock(routes([["x.test", { body: LONG }]]));
    process.env[envName("BROWSER_FETCH")] = "always";
    expect((await fetchAndExtract("https://x.test/a")).extractor).toBe("browser");
    expect((await fetchAndExtract("https://x.test/a", { browser: "off" })).extractor).toBeUndefined();
    process.env[envName("BROWSER_FETCH")] = "sometimes";
    expect((await fetchAndExtract("https://x.test/a")).extractor).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("never runs for a public-only caller, a PDF or an office document", async () => {
    installFetchMock(
      routes([
        ["paper.pdf", { body: "%PDF-1.4 not really", contentType: "application/pdf" }],
        ["sheet.xlsx", { body: "nope", contentType: "application/octet-stream" }],
        ["x.test", { body: LONG }],
      ]),
    );
    await fetchAndExtract("https://x.test/a", { browser: "always", authorizeUrl: async () => true });
    await fetchAndExtract("https://x.test/paper.pdf", { browser: "always" });
    await fetchAndExtract("https://x.test/sheet.xlsx", { browser: "always" });
    expect(read).not.toHaveBeenCalled();
  });

  it("hands a PDF served under a page-like URL back to the document ladder", async () => {
    // Only the response says it is a PDF: the browser read refuses it, and the fetch reads it as one.
    read.mockRejectedValue(new Error("https://x.test/report is not a web page but application/pdf"));
    installFetchMock(routes([["x.test/report", { body: "%PDF-1.4 tiny", contentType: "application/pdf" }]]));
    const r = await fetchAndExtract("https://x.test/report", { browser: "always" });
    expect(r.documentType).toBe("pdf");
    expect(r.note).toMatch(
      /^The browser could not read https:\/\/x\.test\/report \(https:\/\/x\.test\/report is not a web page but application\/pdf\); read without it\./,
    );
  });
});

describe("fetchAndExtract with browser: fallback", () => {
  it("leaves a good page to the built-in reader", async () => {
    installFetchMock(routes([["x.test", { body: LONG }]]));
    const r = await fetchAndExtract("https://x.test/a", { browser: "fallback" });
    expect(r.extractor).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["a 403", { status: 403, body: "Forbidden" }, "got HTTP 403"],
    ["a JavaScript wall", { body: WALL }, "read a JavaScript-required shell"],
    ["almost no text", { body: SHORT }, "found almost no text"],
  ])("retries in the browser on %s and keeps its read", async (_what, res, why) => {
    installFetchMock(routes([["x.test", res]]));
    const r = await fetchAndExtract("https://x.test/a", { browser: "fallback" });
    expect(r).toMatchObject({ text: RENDERED, extractor: "browser", status: 200 });
    expect(r.note).toBe(`Read https://x.test/a in the browser: the built-in fetch ${why}.`);
  });

  it("retries a fetch that got no answer at all", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const r = await fetchAndExtract("https://x.test/a", { browser: "fallback" });
    expect(r).toMatchObject({ text: RENDERED, extractor: "browser" });
    expect(r.note).toBe("Read https://x.test/a in the browser: the built-in fetch got no answer.");
  });

  it("keeps a thin page as it is when the browser finds nothing either, adding no note", async () => {
    installFetchMock(routes([["x.test", { body: SHORT }]]));
    read.mockResolvedValue(rendered("https://x.test/a", { text: "  " }));
    const r = await fetchAndExtract("https://x.test/a", { browser: "fallback" });
    expect(r.text).toBe("Loading…");
    expect(r.note).toBeUndefined();
    read.mockRejectedValue("not an Error");
    expect((await fetchAndExtract("https://x.test/a", { browser: "fallback" })).note).toBe("The browser could not read https://x.test/a (not an Error).");
  });

  it("keeps the built-in refusal over an error page the browser rendered", async () => {
    installFetchMock(routes([["x.test", { status: 403, body: "Forbidden" }]]));
    read.mockResolvedValue(rendered("https://x.test/a", { status: 403, text: `Access denied. ${"You do not have permission. ".repeat(10)}` }));
    const r = await fetchAndExtract("https://x.test/a", { browser: "fallback" });
    expect(r).toMatchObject({ text: "", status: 403 });
    expect(r.extractor).toBeUndefined();
    expect(r.note).toBe("Could not fetch https://x.test/a (status 403). The browser got HTTP 403 for https://x.test/a.");
  });

  it("keeps the built-in result, notes merged, when the browser does no better", async () => {
    installFetchMock(routes([["x.test", { status: 403, body: "Forbidden" }]]));
    read.mockResolvedValue(rendered("https://x.test/a", { text: "", status: 403, note: "cloudflare challenge — solve it" }));
    const blocked = await fetchAndExtract("https://x.test/a", { browser: "fallback" });
    expect(blocked).toMatchObject({ text: "", status: 403 });
    expect(blocked.extractor).toBeUndefined();
    expect(blocked.note).toBe("Could not fetch https://x.test/a (status 403). The browser got HTTP 403 for https://x.test/a. cloudflare challenge — solve it");

    read.mockRejectedValue(new Error("launch failed"));
    const failed = await fetchAndExtract("https://x.test/a", { browser: "fallback" });
    expect(failed.note).toBe("Could not fetch https://x.test/a (status 403). The browser could not read https://x.test/a (launch failed).");
  });

  it("never retries a document, a non-text answer, a 304, a public-only caller or a cancelled fetch", async () => {
    installFetchMock(
      routes([
        ["blob", { body: "%PDF-1.4 tiny", contentType: "application/pdf" }],
        ["pic.png", { body: "png", contentType: "image/png" }],
        ["same", { status: 304, body: "" }],
        ["missing", { status: 404, body: "Not here" }],
        ["x.test", { status: 403, body: "Forbidden" }],
      ]),
    );
    await fetchAndExtract("https://x.test/blob", { browser: "fallback" });
    await fetchAndExtract("https://x.test/pic.png", { browser: "fallback" });
    await fetchAndExtract("https://x.test/same", { browser: "fallback", headers: { "if-none-match": '"v1"' } });
    await fetchAndExtract("https://x.test/missing", { browser: "fallback" });
    await fetchAndExtract("https://x.test/a", { browser: "fallback", authorizeUrl: async () => true });
    const ctl = new AbortController();
    ctl.abort();
    await fetchAndExtract("https://x.test/a", { browser: "fallback", signal: ctl.signal });
    expect(read).not.toHaveBeenCalled();
  });

  it("takes fallback from BROWSER_FETCH", async () => {
    process.env[envName("BROWSER_FETCH")] = "Fallback";
    installFetchMock(routes([["x.test", { body: SHORT }]]));
    expect((await fetchAndExtract("https://x.test/a")).extractor).toBe("browser");
  });
});

describe("cachedFetchAndExtract and the browser rung", () => {
  it("files an always-mode read under the browser namespace and serves it next time", async () => {
    const spy = installFetchMock(routes([["x.test", { body: LONG }]]));
    const first = await cachedFetchAndExtract("https://x.test/a", { browser: "always" }, true, 1000);
    expect(first.extractor).toBe("browser");
    const again = await cachedFetchAndExtract("https://x.test/a", { browser: "always" }, true, 2000);
    expect(again).toMatchObject({ text: RENDERED, extractor: "browser", cached: true });
    expect(read).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
    // The built-in namespace was never written: a plain read fetches.
    const plain = await cachedFetchAndExtract("https://x.test/a", {}, true, 3000);
    expect(plain.cached).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("predicts the browser from BROWSER_FETCH=always too", async () => {
    installFetchMock(routes([["x.test", { body: LONG }]]));
    process.env[envName("BROWSER_FETCH")] = "always";
    await cachedFetchAndExtract("https://x.test/a", {}, true, 1000);
    expect((await cachedFetchAndExtract("https://x.test/a", {}, true, 2000)).cached).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("serves a page the fallback had to render from the browser namespace, without fetching it again", async () => {
    const spy = installFetchMock(routes([["x.test", { body: SHORT }]]));
    const first = await cachedFetchAndExtract("https://x.test/a", { browser: "fallback" }, true, 1000);
    expect(first.extractor).toBe("browser");
    const again = await cachedFetchAndExtract("https://x.test/a", { browser: "fallback" }, true, 2000);
    expect(again).toMatchObject({ text: RENDERED, cached: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    // Without the fallback, the browser's copy is not what was asked for.
    expect((await cachedFetchAndExtract("https://x.test/a", {}, true, 3000)).cached).toBeUndefined();
  });

  it("prefers a newer built-in copy to an older rendered one", async () => {
    installFetchMock(routes([["x.test", { body: SHORT }]]));
    await cachedFetchAndExtract("https://x.test/a", { browser: "fallback" }, true, 1000);
    await cachedFetchAndExtract("https://x.test/a", {}, true, 2000);
    const again = await cachedFetchAndExtract("https://x.test/a", { browser: "fallback" }, true, 3000);
    expect(again).toMatchObject({ text: "Loading…", cached: true });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("never lets an error page the browser rendered replace a good cached read", async () => {
    process.env[envName("CACHE_TTL_MS")] = "1000";
    installFetchMock(routes([["x.test", { status: 503, body: "Down" }]]));
    await cachedFetchAndExtract("https://x.test/a", { browser: "always" }, true, 1000);
    read.mockResolvedValue(rendered("https://x.test/a", { status: 503, text: `Service unavailable. ${"Come back later. ".repeat(20)}` }));
    const stale = await cachedFetchAndExtract("https://x.test/a", { browser: "always" }, true, 5000);
    expect(stale).toMatchObject({ text: RENDERED, cached: true });
    expect(stale.note).toMatch(/served the cached copy/);
    read.mockImplementation(async (url) => rendered(url));
    const later = await cachedFetchAndExtract("https://x.test/a", { browser: "always" }, true, 5500);
    expect(later.text).toBe(RENDERED);
  });

  it("keeps a browser read per shape, like the built-in one", async () => {
    installFetchMock(routes([["x.test", { body: LONG }]]));
    read.mockImplementation(async (url, o) => rendered(url, { text: o?.format === "markdown" ? `# Markdown ${RENDERED}` : RENDERED }));
    await cachedFetchAndExtract("https://x.test/a", { browser: "always" }, true, 1000);
    const md = await cachedFetchAndExtract("https://x.test/a", { browser: "always", format: "markdown" }, true, 2000);
    expect(md.cached).toBeUndefined();
    expect(md.text).toMatch(/^# Markdown/);
    expect((await cachedFetchAndExtract("https://x.test/a", { browser: "always", format: "markdown" }, true, 3000)).cached).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("serves browser entries offline", async () => {
    installFetchMock(routes([["x.test", { body: LONG }]]));
    await cachedFetchAndExtract("https://x.test/a", { browser: "always" }, true, 1000);
    setCacheMode({ offline: true });
    expect(await cachedFetchAndExtract("https://x.test/a", {}, false, 2000)).toMatchObject({ text: RENDERED, cached: true });
  });
});

describe("the browser rung on an MCP server others can reach", () => {
  const bools = (...flags: string[]) => ({ command: "mcp", positional: [], values: {}, bools: new Set(flags) });

  it("is never taken by webindex_fetch, whatever BROWSER_FETCH says", async () => {
    installFetchMock(routes([["x.test", { body: LONG }]]));
    process.env[envName("BROWSER_FETCH")] = "always";
    // --allow-remote --allow-private: no public-only wall, so nothing else turns the rung off.
    const policy = mcpPolicy(bools("allow-remote", "allow-private"), true);
    expect(policy.publicOnly).toBe(false);
    const out = await webindexAdapter(policy).callTool("webindex_fetch", { url: "https://x.test/a" });
    expect(out.text).toContain("Good page");
    expect(read).not.toHaveBeenCalled();
  });

  it("is still taken on this machine's own server", async () => {
    installFetchMock(routes([["x.test", { body: LONG }]]));
    process.env[envName("BROWSER_FETCH")] = "always";
    await webindexAdapter(mcpPolicy(bools(), false)).callTool("webindex_fetch", { url: "https://x.test/a" });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
