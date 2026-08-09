import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Brand, configure, envName } from "../src/brand.js";
import { cacheClean, cachePath, cacheStats, cachedFetchAndExtract, resetCacheMode, setCacheMode } from "../src/cache.js";
import { resetHaveCache, sh } from "../src/exec.js";
import { apiBase, canonicalRepoRef, resetCanonicalRepoCache } from "../src/forge.js";
import { decodeEntities, fetchAndExtract, htmlToText, httpGet } from "../src/fetch.js";
import { repoCacheRoot, resolveRepo, sameCommit } from "../src/repo.js";
import { excerptWindows } from "../src/text.js";
import { installFetchMock } from "./fetchmock.js";
import { testCacheDir } from "./setup.js";

// The capabilities that let the consumers' forks go.
//
// Three skills vendor this engine, and each kept private copies of code the
// engine already owned — not out of neglect but because the engine's version was
// missing something specific: a directory it could not be told about, a mode it
// did not have, a signature that did not fit, a seam it did not expose. Each
// copy carried that reason in writing, in a ratchet file that fails the build
// when a reason expires.
//
// This suite pins the reasons that were retired. Every case below is the answer
// to one deleted ratchet entry, so a regression here does not just break a
// feature — it re-forks a file in three repositories.

// Reconfigure on top of the throwaway test brand from setup.ts, keeping its
// prefix and cache dir so a case can never read or write a real one.
function reconfigure(extra: Partial<Brand>): void {
  configure({ name: "webindex-tests", envPrefix: "WEBINDEX_TEST", cli: "webindex-tests", cacheDir: testCacheDir, ...extra });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetHaveCache();
  resetCanonicalRepoCache();
  resetCacheMode();
});

describe("a consumer's own clone directory (Brand.repoDir)", () => {
  it("keys clones where the consuming tool already keeps them", () => {
    reconfigure({ repoDir: "/var/tmp/some-consumer/repos" });
    expect(repoCacheRoot()).toBe("/var/tmp/some-consumer/repos");
  });

  it("still lets the user override it, because that is their directory to choose", () => {
    reconfigure({ repoDir: "/var/tmp/some-consumer/repos" });
    process.env[envName("REPO_DIR")] = "/var/tmp/user-said-so";
    expect(repoCacheRoot()).toBe("/var/tmp/user-said-so");
  });
});

describe("a consumer's own freshness policy (Brand.cacheTtlMs)", () => {
  const URL = "https://ttl.test/page";
  const PAGE = { body: "<html><body><article><p>a body worth keeping for a week</p></article></body></html>" };
  let dir: string;
  const SETUP_CACHE_DIR = process.env[envName("CACHE_DIR")];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wi-ttl-"));
    // The env var, not just the brand: `<PREFIX>_CACHE_DIR` OUTRANKS
    // `brand().cacheDir` (a user's override must win), and setup.ts sets it to a
    // dir shared by the whole run — so without this the second case reads the
    // first one's entry and the TTL under test never gets a chance to expire.
    process.env[envName("CACHE_DIR")] = dir;
  });
  afterEach(() => {
    if (SETUP_CACHE_DIR === undefined) delete process.env[envName("CACHE_DIR")];
    else process.env[envName("CACHE_DIR")] = SETUP_CACHE_DIR;
    delete process.env[envName("CACHE_TTL_HOURS")];
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a page fresh for the week the brand asked for, not the engine's day", async () => {
    reconfigure({ cacheDir: dir, cacheTtlMs: 168 * 3600_000 });
    const spy = installFetchMock(() => PAGE);
    const DAY = 24 * 3600_000;
    await cachedFetchAndExtract(URL, {}, true, 0);
    // Two days later. Under the engine's own 24h default this is a refetch.
    const later = await cachedFetchAndExtract(URL, {}, true, 2 * DAY);
    expect(later.cached).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("accepts the TTL in HOURS, the unit consumers' users already have exported", async () => {
    reconfigure({ cacheDir: dir, cacheTtlMs: 168 * 3600_000 });
    process.env[envName("CACHE_TTL_HOURS")] = "1";
    const spy = installFetchMock(() => PAGE);
    await cachedFetchAndExtract(URL, {}, true, 0);
    await cachedFetchAndExtract(URL, {}, true, 2 * 3600_000); // two hours later
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("the traffic counter (Brand.onFetch)", () => {
  const URL = "https://count.test/page";
  const PAGE = { body: "<html><body><article><p>bytes worth counting in an angle</p></article></body></html>" };
  let dir: string;
  const SETUP_CACHE_DIR = process.env[envName("CACHE_DIR")];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wi-count-"));
    process.env[envName("CACHE_DIR")] = dir;
  });
  afterEach(() => {
    if (SETUP_CACHE_DIR === undefined) delete process.env[envName("CACHE_DIR")];
    else process.env[envName("CACHE_DIR")] = SETUP_CACHE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports network bytes and cache hits separately", async () => {
    const seen: { bytes: number; cached: boolean }[] = [];
    reconfigure({ cacheDir: dir, onFetch: (bytes, cached) => seen.push({ bytes, cached }) });
    installFetchMock(() => PAGE);

    await cachedFetchAndExtract(URL, {}, true, 1000);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cached).toBe(false);
    expect(seen[0]!.bytes).toBe(Buffer.byteLength(PAGE.body));

    await cachedFetchAndExtract(URL, {}, true, 1500);
    expect(seen).toHaveLength(2);
    // A hit still costs the caller nothing on the wire, which is exactly what a
    // counter that only saw `httpGet` could never say.
    expect(seen[1]!.cached).toBe(true);
  });

  it("never lets a broken counter fail a fetch", async () => {
    reconfigure({
      onFetch: () => {
        throw new Error("instrumentation exploded");
      },
    });
    installFetchMock(() => ({ body: "ok", contentType: "text/plain" }));
    await expect(httpGet("https://count.test/plain")).resolves.toMatchObject({ ok: true, body: "ok" });
  });
});

describe("identifying honestly (Brand.defaultUa)", () => {
  const uaOf = (init?: RequestInit) => String((init?.headers as Record<string, string> | undefined)?.["user-agent"] ?? "");

  it("sends the polite contact UA when the brand asked for it", async () => {
    reconfigure({ defaultUa: "contact", contactUrl: "https://example.test/tool" });
    let seen = "";
    installFetchMock((_url, init) => {
      seen = uaOf(init);
      return { body: "ok", contentType: "text/plain" };
    });
    await httpGet("https://ua.test/x");
    expect(seen).toContain("webindex-tests/");
    expect(seen).toContain("example.test/tool");
  });

  it("still sends a browser UA by default, because keyless endpoints refuse bots", async () => {
    let seen = "";
    installFetchMock((_url, init) => {
      seen = uaOf(init);
      return { body: "ok", contentType: "text/plain" };
    });
    await httpGet("https://ua.test/x");
    expect(seen).toContain("Mozilla/5.0");
  });

  it("retries once as a browser when the polite UA is refused", async () => {
    reconfigure({ defaultUa: "contact" });
    const uas: string[] = [];
    installFetchMock((_url, init) => {
      uas.push(uaOf(init));
      return uas.length === 1 ? { status: 403, body: "no bots" } : { body: "<html><body><article><p>the real page after all</p></article></body></html>" };
    });
    const res = await fetchAndExtract("https://ua.test/blocked");
    expect(res.text).toContain("the real page");
    expect(uas[0]).toContain("webindex-tests/");
    expect(uas[1]).toContain("Mozilla/5.0");
  });

  it("does not retry a browser UA with the same browser UA", async () => {
    let calls = 0;
    installFetchMock(() => {
      calls++;
      return { status: 403, body: "no" };
    });
    await fetchAndExtract("https://ua.test/blocked-too");
    // One attempt. 403 is not in the transient set, so there is no retry either.
    expect(calls).toBe(1);
  });
});

describe("a consumer's own command timeout", () => {
  afterEach(() => {
    delete process.env[envName("SH_TIMEOUT_MS")];
  });

  it("kills a command at the brand-configured ceiling instead of the engine's minute", () => {
    process.env[envName("SH_TIMEOUT_MS")] = "1000";
    const r = sh(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
    // Killed by the timeout rather than exiting cleanly. 60s of hardcoded
    // default would have made this case take a minute.
    expect(r.ok).toBe(false);
  });
});

describe("comparing a commit against its own abbreviation", () => {
  const FULL = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

  it("matches a full SHA against the 7-character prefix git prints", () => {
    expect(sameCommit(FULL, FULL.slice(0, 7))).toBe(true);
    expect(sameCommit(FULL.slice(0, 12), FULL)).toBe(true);
  });

  it("refuses a prefix too short to mean anything", () => {
    // Without this guard, a stored "1" would re-validate against every commit
    // whose SHA happens to start with it — a check that always passes.
    expect(sameCommit(FULL, "1a2b3c")).toBe(false);
    expect(sameCommit(FULL, "1")).toBe(false);
  });

  it("still refuses two different commits, and a missing one", () => {
    expect(sameCommit(FULL, `f${FULL.slice(1)}`)).toBe(false);
    expect(sameCommit(FULL, undefined)).toBe(false);
  });
});

describe("asking a forge about a host, before there is a ref", () => {
  it("takes a bare host string", () => {
    expect(apiBase("github.com")).toBe("https://api.github.com");
    expect(apiBase("github.mycorp.test")).toBe("https://github.mycorp.test/api/v3");
  });

  it("answers the same for a host and for a ref on that host", () => {
    const ref = resolveRepo("github.com/expressjs/express");
    expect(apiBase("github.com")).toBe(apiBase(ref));
  });
});

describe("resolving a renamed repository into its parts", () => {
  it("returns owner and repo, not a slug the caller has to split", async () => {
    installFetchMock(() => ({ body: JSON.stringify({ full_name: "calcom/cal.diy" }), contentType: "application/json" }));
    const ref = resolveRepo("github.com/calcom/cal.com");
    expect(await canonicalRepoRef(ref)).toEqual({ owner: "calcom", repo: "cal.diy" });
  });

  it("resolves once per repository, however many searches ask", async () => {
    const spy = installFetchMock(() => ({ body: JSON.stringify({ full_name: "a/b-renamed" }), contentType: "application/json" }));
    const ref = resolveRepo("github.com/a/b");
    await canonicalRepoRef(ref);
    await canonicalRepoRef(ref);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("falls back to what the caller had when the lookup fails", async () => {
    installFetchMock(() => ({ status: 500, body: "boom" }));
    const ref = resolveRepo("github.com/a/b");
    expect(await canonicalRepoRef(ref)).toEqual({ owner: "a", repo: "b" });
  });
});

describe("the cache stores a body beside its metadata, not inside it", () => {
  const URL = "https://split.test/page";
  let dir: string;
  const SETUP_CACHE_DIR = process.env[envName("CACHE_DIR")];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wi-split-"));
    process.env[envName("CACHE_DIR")] = dir;
  });
  afterEach(() => {
    if (SETUP_CACHE_DIR === undefined) delete process.env[envName("CACHE_DIR")];
    else process.env[envName("CACHE_DIR")] = SETUP_CACHE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const PAGE = { body: "<html><body><article><p>a page whose text does not belong in a JSON string</p></article></body></html>" };

  it("writes the text as raw bytes, and the metadata without it", async () => {
    installFetchMock(() => PAGE);
    await cachedFetchAndExtract(URL, {}, true, 1000);

    const meta = cachePath(URL, "", "native");
    const body = meta.replace(/\.json$/, ".body");
    expect(existsSync(body)).toBe(true);
    expect(readFileSync(body, "utf8")).toContain("does not belong in a JSON string");
    // The metadata half stays small and structured: the page text is not in it,
    // so reading it never parses a megabyte out of a string literal.
    expect(JSON.parse(readFileSync(meta, "utf8")).text).toBeUndefined();
  });

  it("still reads an entry written before the body moved out", async () => {
    // The single-blob shape a previous engine version wrote. Upgrading must not
    // silently throw away a warm cache directory.
    const meta = cachePath(URL, "", "native");
    writeFileSync(meta, JSON.stringify({ text: "legacy inline body", finalUrl: URL, status: 200, cachedAt: 1000 }));
    const spy = installFetchMock(() => PAGE);
    const hit = await cachedFetchAndExtract(URL, {}, true, 1100);
    expect(hit.cached).toBe(true);
    expect(hit.text).toBe("legacy inline body");
    expect(spy).not.toHaveBeenCalled();
  });

  it("counts the body toward the cache's size, and evicts it with the entry", async () => {
    installFetchMock(() => PAGE);
    await cachedFetchAndExtract(URL, {}, true, 1000);
    const stats = cacheStats(1000);
    expect(stats.entries).toBe(1);
    // Reporting only the metadata's size would describe a directory holding
    // hundreds of megabytes of page text as a few kilobytes.
    expect(stats.bytes).toBeGreaterThan(Buffer.byteLength(PAGE.body));

    expect(cacheClean(true, 1000)).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("--refresh and --offline", () => {
  const URL = "https://mode.test/page";
  const PAGE = { body: "<html><body><article><p>the page as the origin has it today</p></article></body></html>" };
  let dir: string;
  const SETUP_CACHE_DIR = process.env[envName("CACHE_DIR")];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wi-mode-"));
    process.env[envName("CACHE_DIR")] = dir;
  });
  afterEach(() => {
    if (SETUP_CACHE_DIR === undefined) delete process.env[envName("CACHE_DIR")];
    else process.env[envName("CACHE_DIR")] = SETUP_CACHE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("refresh ignores a fresh entry — and still writes the new one", async () => {
    const spy = installFetchMock(() => PAGE);
    await cachedFetchAndExtract(URL, {}, true, 1000);
    setCacheMode({ refresh: true });
    const again = await cachedFetchAndExtract(URL, {}, true, 1100);
    expect(again.cached).toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2);

    // The point of --refresh is to REPLACE the entry, not to stop caching.
    setCacheMode({ refresh: false });
    expect((await cachedFetchAndExtract(URL, {}, true, 1200)).cached).toBe(true);
  });

  it("offline serves a stale copy rather than touching the network", async () => {
    installFetchMock(() => PAGE);
    await cachedFetchAndExtract(URL, {}, true, 1000);

    const spy = installFetchMock(() => {
      throw new Error("offline must not fetch");
    });
    setCacheMode({ offline: true });
    // A week later: long past any TTL, and served anyway. Stale is the whole
    // point of the switch.
    const hit = await cachedFetchAndExtract(URL, {}, true, 1000 + 7 * 24 * 3600_000);
    expect(hit.cached).toBe(true);
    expect(hit.text).toContain("as the origin has it today");
    expect(spy).not.toHaveBeenCalled();
  });

  it("offline says so on a miss instead of handing back an empty page", async () => {
    const spy = installFetchMock(() => PAGE);
    setCacheMode({ offline: true });
    const miss = await cachedFetchAndExtract("https://mode.test/never-seen", {}, true, 1000);
    expect(miss.text).toBe("");
    expect(miss.note).toMatch(/offline/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("offline reads the cache even when the caller did not enable it", async () => {
    installFetchMock(() => PAGE);
    await cachedFetchAndExtract(URL, {}, true, 1000);
    setCacheMode({ offline: true });
    // "no network" and "no cache" together leave nothing at all, which is never
    // what an operator meant by --offline.
    expect((await cachedFetchAndExtract(URL, {}, false, 1100)).cached).toBe(true);
  });

  it("serves the stale copy with a dated note when the origin goes down", async () => {
    installFetchMock(() => PAGE);
    await cachedFetchAndExtract(URL, {}, true, 1000);
    installFetchMock(() => ({ status: 503, body: "down" }));
    const served = await cachedFetchAndExtract(URL, {}, true, 1000 + 7 * 24 * 3600_000);
    expect(served.cached).toBe(true);
    expect(served.text).toContain("as the origin has it today");
    expect(served.note).toMatch(/503.*served the cached copy from 1970-/);
  });
});

describe("what a page says about itself, and what it shouts", () => {
  const HTML = [
    "<html><head>",
    '<meta name="description" content="The page&#39;s own one-line summary.">',
    "</head><body><article>",
    "<p>We use cookies and similar tracking technologies.</p>",
    "<p>Accept all cookies</p>",
    "<p>Token buckets refill at a fixed rate, which is what makes them smooth.</p>",
    "</article></body></html>",
  ].join("");

  it("carries the meta description, which extraction would otherwise drop with <head>", async () => {
    installFetchMock(() => ({ body: HTML }));
    const res = await fetchAndExtract("https://meta.test/page");
    expect(res.metaDescription).toBe("The page's own one-line summary.");
  });

  it("leaves consent lines alone unless asked", async () => {
    installFetchMock(() => ({ body: HTML }));
    const res = await fetchAndExtract("https://meta.test/page");
    expect(res.text).toMatch(/Accept all cookies/);
  });

  it("drops them on request, keeping the prose", async () => {
    installFetchMock(() => ({ body: HTML }));
    const res = await fetchAndExtract("https://meta.test/page", { stripConsent: true });
    expect(res.text).not.toMatch(/Accept all cookies/);
    expect(res.text).toContain("Token buckets refill");
  });

  it("never applies the heuristic to Firecrawl markdown", async () => {
    // On a page DOCUMENTING cookies, "cookies" appears in every short line —
    // and Firecrawl has already removed the banner, so all the guard could do
    // here is eat the article.
    const md = "# HTTP cookies\n\nSet-Cookie sets a cookie.\n\nA cookie is sent back on every request.";
    const base = "http://fc-consent.test";
    installFetchMock((url) => {
      if (url.includes("/scrape"))
        return { body: JSON.stringify({ success: true, data: { markdown: md, metadata: { statusCode: 200 } } }), contentType: "application/json" };
      if (url === `${base}/`) return { status: 200, body: "{}" };
      return { body: HTML };
    });
    const res = await fetchAndExtract("https://meta.test/cookies", { firecrawl: base, stripConsent: true });
    expect(res.extractor).toBe("firecrawl");
    expect(res.text).toBe(md);
  });
});

describe("retries chosen per call, not per process", () => {
  it("gives a flaky endpoint the extra attempts the caller asked for", async () => {
    let calls = 0;
    installFetchMock(() => {
      calls++;
      return calls < 3 ? { status: 503, body: "" } : { body: "finally", contentType: "text/plain" };
    });
    const res = await httpGet("https://flaky.test/x", { retries: 2 });
    expect(res.body).toBe("finally");
    expect(calls).toBe(3);
  });

  it("lets a probe insist on exactly one shot", async () => {
    let calls = 0;
    installFetchMock(() => {
      calls++;
      return { status: 503, body: "" };
    });
    await httpGet("https://flaky.test/probe", { retries: 0 });
    expect(calls).toBe(1);
  });
});

describe("excerptWindows", () => {
  const DOC = [
    "# Rate limiting",
    "Some introduction that mentions nothing in particular.",
    "",
    "## Token buckets",
    "A token bucket refills at a fixed rate.",
    "The bucket has a maximum capacity.",
    "",
    "## Générateurs",
    "Le générateur produit des jetons.",
  ];

  it("scores through the matcher, so accents and plurals still match", () => {
    // A raw `line.includes("generateur")` finds nothing here. That is the whole
    // difference between the two copies this replaced.
    const [w] = excerptWindows(DOC.join("\n"), "generateur", { perDoc: 1 });
    expect(w!.score).toBeGreaterThan(0);
    expect(w!.snippet).toContain("Le générateur produit");
  });

  it("attaches the section an excerpt sits under", () => {
    const [w] = excerptWindows(DOC.join("\n"), "token bucket refill", { perDoc: 1, after: 3 });
    expect(w!.heading).toBe("Token buckets");
  });

  it("scores a line by its BEST single question, not by the union", () => {
    // Two unrelated questions. The bucket line answers one of them completely
    // and the other not at all; averaging them would bury it.
    const wins = excerptWindows(DOC.join("\n"), ["token bucket capacity", "kubernetes ingress"], { perDoc: 1, after: 2 });
    expect(wins[0]!.snippet).toMatch(/bucket/);
  });

  it("refuses to emit two windows that overlap", () => {
    // Both bucket lines are hits and sit two lines apart, so their ±windows
    // overlap heavily. Bucketing line numbers lets both through when they
    // straddle a boundary; overlap rejection does not.
    const wins = excerptWindows(DOC.join("\n"), "bucket", { perDoc: 2 });
    expect(wins).toHaveLength(1);
  });

  it("hands back the top of the page at score 0 when nothing matches", () => {
    const [w] = excerptWindows(DOC.join("\n"), "quantum entanglement");
    // Not an empty array: a caller with a pinned URL still needs something to
    // show, and the zero is what tells it this is boilerplate.
    expect(w!.score).toBe(0);
    expect(w!.start).toBe(0);
  });

  it("treats an empty question as no question rather than throwing", () => {
    expect(excerptWindows(DOC.join("\n"), "")[0]!.score).toBe(0);
    expect(excerptWindows("", "anything")).toEqual([]);
  });
});

describe("decoding entities exactly once", () => {
  it("keeps an escaped entity escaped", () => {
    // `&amp;lt;` is how a document writes the literal text "&lt;" — which, on a
    // page documenting markup, is most of its content. Decoding numeric refs and
    // then walking a named table with split/join re-reads its own output and
    // turns it into "<": the page said one thing and the extract says another.
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeEntities("&amp;amp;")).toBe("&amp;");
    expect(decodeEntities("&#38;lt;")).toBe("&lt;");
  });

  it("still decodes the ordinary cases, and respects case", () => {
    expect(decodeEntities("a &amp; b &mdash; c")).toBe("a & b — c");
    expect(decodeEntities("&#x2014;&#8212;")).toBe("——");
    // † and ‡ are different characters behind names that differ only in case.
    expect(decodeEntities("&dagger;&Dagger;")).toBe("†‡");
  });

  it("leaves an unknown name exactly as written", () => {
    expect(decodeEntities("&notanentity; &foo;")).toBe("&notanentity; &foo;");
  });
});

describe("block structure survives extraction", () => {
  it("puts unclosed list items and table cells on their own lines", () => {
    // Both are valid HTML and both are everywhere. Breaking only on CLOSING tags
    // collapses a whole list or table row onto one line, which then reads as a
    // single sentence to anything scoring lines against a question — and a
    // per-line excerpt window either takes all of it or none of it.
    expect(htmlToText("<ul><li>alpha<li>beta<li>gamma</ul>").split("\n")).toEqual(["alpha", "beta", "gamma"]);
    expect(htmlToText("<table><tr><td>one<td>two</tr></table>").split("\n")).toEqual(["one", "two"]);
  });

  it("does not double a heading that the markdown rule already handled", () => {
    expect(htmlToText("<h2>Title</h2><p>body</p>")).toBe("## Title\nbody");
  });
});

describe("a TTL of zero means always stale", () => {
  const URL = "https://ttl0.test/page";
  const PAGE = { body: "<html><body><article><p>refetch me every single time</p></article></body></html>" };
  let dir: string;
  const SETUP_CACHE_DIR = process.env[envName("CACHE_DIR")];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wi-ttl0-"));
    process.env[envName("CACHE_DIR")] = dir;
    process.env[envName("CACHE_TTL_MS")] = "0";
  });
  afterEach(() => {
    if (SETUP_CACHE_DIR === undefined) delete process.env[envName("CACHE_DIR")];
    else process.env[envName("CACHE_DIR")] = SETUP_CACHE_DIR;
    delete process.env[envName("CACHE_TTL_MS")];
    rmSync(dir, { recursive: true, force: true });
  });

  it("refetches even when both calls land in the same millisecond", async () => {
    // The documented contract of `<PREFIX>_CACHE_TTL_MS=0`. With a `<=` window
    // it held only until two calls shared a tick — and then the entry was served
    // and the refetch the operator asked for silently did not happen.
    const spy = installFetchMock(() => PAGE);
    await cachedFetchAndExtract(URL, {}, true, 1000);
    await cachedFetchAndExtract(URL, {}, true, 1000);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
