import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Env names resolve through the brand, exactly as the engine resolves them.
import { envName } from "../src/brand.js";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cacheClean, cacheStats, cachedFetchAndExtract, cachePath } from "../src/cache.js";
import { installFetchMock } from "./fetchmock.js";

describe("cache writes", () => {
  const PAGE = { body: "<html><body><article><p>cached article body about token buckets and windows</p></article></body></html>" };
  const URL = "https://ex.test/page";

  it("leaves no temp file behind, and the entry it wrote reads back", async () => {
    // Body and metadata land by rename: a sibling process — the deep tier
    // shares one cache directory — never sees a half-written entry.
    installFetchMock(() => PAGE);
    const a = await cachedFetchAndExtract(URL, {}, true, 1000);
    const names = readdirSync(dir);
    expect(names.some((n) => n.endsWith(".tmp"))).toBe(false);
    expect(names.some((n) => n.endsWith(".json"))).toBe(true);
    expect(names.some((n) => n.endsWith(".body"))).toBe(true);
    const b = await cachedFetchAndExtract(URL, {}, true, 1500);
    expect(b.text).toBe(a.text);
    expect(b.cached).toBe(true);
  });

  it("recreates a cache directory removed mid-run", async () => {
    const spy = installFetchMock(() => PAGE);
    await cachedFetchAndExtract(URL, {}, true, 1000);
    rmSync(dir, { recursive: true, force: true });
    // Miss (the entry is gone) → fetch → write into a directory that no longer
    // exists. A memoised mkdir must notice rather than silently stop caching.
    await cachedFetchAndExtract(URL, {}, true, 2000);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(readdirSync(dir).some((n) => n.endsWith(".json"))).toBe(true);
    await cachedFetchAndExtract(URL, {}, true, 2500);
    expect(spy).toHaveBeenCalledTimes(2); // served from the rewritten entry
  });
});

let dir: string;
// tests/setup.ts pins <PREFIX>_CACHE_DIR to a per-run throwaway dir (the
// fetch cache is on by default now). These cases need their own dir per test,
// so they override it and RESTORE the setup value afterwards — deleting it would
// point every later test at the real cache.
const SETUP_CACHE_DIR = process.env[envName("CACHE_DIR")];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "us-cache-"));
  process.env[envName("CACHE_DIR")] = dir;
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (SETUP_CACHE_DIR === undefined) delete process.env[envName("CACHE_DIR")];
  else process.env[envName("CACHE_DIR")] = SETUP_CACHE_DIR;
  delete process.env[envName("CACHE_TTL_MS")];
  rmSync(dir, { recursive: true, force: true });
});

const PAGE = { body: "<html><body><article><p>cached article body about token buckets and windows</p></article></body></html>" };
const URL = "https://ex.test/page";

describe("cachedFetchAndExtract (--cache)", () => {
  it("serves a fresh hit from disk without a second fetch", async () => {
    const spy = installFetchMock(() => PAGE);
    const a = await cachedFetchAndExtract(URL, {}, true, 1000);
    const b = await cachedFetchAndExtract(URL, {}, true, 1500); // within TTL
    expect(a.text).toContain("token buckets");
    expect(b.text).toBe(a.text);
    expect(spy).toHaveBeenCalledTimes(1); // second call served from disk
  });

  it("does not serve one locale's body to another (the key includes Accept-Language)", async () => {
    // Regression: cachePath used to key on the URL alone, so a `--lang de` run
    // could be handed the English body an earlier `--lang en` run had cached —
    // silently breaking the "search the audience's language" contract.
    const spy = installFetchMock(() => PAGE);
    await cachedFetchAndExtract(URL, { acceptLanguage: "en-US,en;q=0.9" }, true, 1000);
    await cachedFetchAndExtract(URL, { acceptLanguage: "de-DE,de;q=0.9" }, true, 1000);
    expect(spy).toHaveBeenCalledTimes(2); // different locale ⇒ a real fetch, not a hit
    // …and the same locale still hits.
    await cachedFetchAndExtract(URL, { acceptLanguage: "de-DE,de;q=0.9" }, true, 1200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("keys a cache path by URL AND locale AND extractor", () => {
    expect(cachePath(URL)).not.toBe(cachePath(URL, "de"));
    expect(cachePath(URL, "de")).toBe(cachePath(URL, "de"));
    // Without the extractor in the key, bringing Firecrawl up would be a no-op
    // for a whole TTL: every natively-extracted entry would shadow it.
    expect(cachePath(URL, "de")).not.toBe(cachePath(URL, "de", "firecrawl"));
    expect(cachePath(URL, "de", "native")).toBe(cachePath(URL, "de"));
  });

  it("does not serve a natively-extracted body to a Firecrawl-enabled run", async () => {
    const FIRECRAWL_MD = JSON.stringify({
      success: true,
      data: { markdown: "# Cached\n\nfirecrawl markdown about token buckets", metadata: { title: "Cached", statusCode: 200 } },
    });
    const base = "http://fc-cache.test";
    const spy = installFetchMock((url) => {
      if (url.includes("/scrape")) return { body: FIRECRAWL_MD, contentType: "application/json" };
      if (url === `${base}/`) return { status: 200, body: "{}" };
      return PAGE;
    });
    // 1. a run with Firecrawl OFF caches the built-in extraction…
    await cachedFetchAndExtract(URL, { firecrawl: "off" }, true, 1000);
    expect(spy).toHaveBeenCalledTimes(1);
    // 2. …which the same run still hits.
    const nativeHit = await cachedFetchAndExtract(URL, { firecrawl: "off" }, true, 1100);
    expect(nativeHit.cached).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    // 3. Bringing Firecrawl up must NOT be shadowed by that entry.
    const fc = await cachedFetchAndExtract(URL, { firecrawl: base }, true, 1200);
    expect(fc.cached).toBeUndefined();
    expect(fc.extractor).toBe("firecrawl");
    expect(fc.text).toContain("firecrawl markdown");
    // 4. …and the Firecrawl body is cached under its own key.
    const fcHit = await cachedFetchAndExtract(URL, { firecrawl: base }, true, 1300);
    expect(fcHit.cached).toBe(true);
    expect(fcHit.text).toContain("firecrawl markdown");
  });

  it("marks a disk hit as cached so a run can report its freshness", async () => {
    installFetchMock(() => PAGE);
    const miss = await cachedFetchAndExtract(URL, {}, true, 1000);
    const hit = await cachedFetchAndExtract(URL, {}, true, 1500);
    expect(miss.cached).toBeUndefined();
    expect(hit.cached).toBe(true);
  });

  it("refetches once the entry is past its TTL", async () => {
    process.env[envName("CACHE_TTL_MS")] = "1000";
    const spy = installFetchMock(() => PAGE);
    await cachedFetchAndExtract(URL, {}, true, 1000);
    await cachedFetchAndExtract(URL, {}, true, 2001); // 1001ms later > 1000 TTL → stale
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("ignores a corrupt cache entry and refetches without throwing", async () => {
    writeFileSync(cachePath(URL), "{ not json");
    const spy = installFetchMock(() => PAGE);
    const r = await cachedFetchAndExtract(URL, {}, true, 1000);
    expect(r.text).toContain("token buckets");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed/empty fetch (always refetches)", async () => {
    const spy = installFetchMock(() => ({ status: 404, body: "gone" }));
    await cachedFetchAndExtract(URL, {}, true, 1000);
    await cachedFetchAndExtract(URL, {}, true, 1100);
    expect(spy).toHaveBeenCalledTimes(2); // nothing to serve → refetch
  });

  it("is a no-op passthrough when disabled (default)", async () => {
    const spy = installFetchMock(() => PAGE);
    await cachedFetchAndExtract(URL, {}, false, 1000);
    await cachedFetchAndExtract(URL, {}, false, 1000);
    expect(spy).toHaveBeenCalledTimes(2); // no disk cache consulted
  });
});

describe("revalidating a stale entry instead of re-downloading it", () => {
  const VALIDATED = { ...PAGE, headers: { etag: '"v1"', "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT" } };

  it("turns a stale hit into a 304 and keeps the stored body", async () => {
    process.env[envName("CACHE_TTL_MS")] = "1000";
    let seenIfNoneMatch: string | undefined;
    const spy = installFetchMock((_url, init) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      seenIfNoneMatch = h["if-none-match"];
      // Second call arrives with validators — answer "unchanged", no body.
      return seenIfNoneMatch ? { status: 304, body: "" } : VALIDATED;
    });

    const first = await cachedFetchAndExtract(URL, {}, true, 1000);
    expect(first.text).toContain("token buckets");

    const revalidated = await cachedFetchAndExtract(URL, {}, true, 2001); // past the TTL
    expect(seenIfNoneMatch).toBe('"v1"');
    expect(spy).toHaveBeenCalledTimes(2);
    // Served from disk despite being stale — the origin said nothing changed.
    expect(revalidated.cached).toBe(true);
    expect(revalidated.text).toBe(first.text);

    // …and the 304 restamped it, so the next call inside the TTL costs nothing.
    await cachedFetchAndExtract(URL, {}, true, 2500);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("takes the new body when the origin says it changed", async () => {
    process.env[envName("CACHE_TTL_MS")] = "1000";
    let calls = 0;
    const spy = installFetchMock(() => {
      calls++;
      return calls === 1 ? VALIDATED : { ...VALIDATED, body: "<html><body><article><p>rewritten prose about leaky buckets</p></article></body></html>" };
    });

    await cachedFetchAndExtract(URL, {}, true, 1000);
    const fresh = await cachedFetchAndExtract(URL, {}, true, 2001);

    // One revalidation request, not a 304-then-refetch pair: the conditional GET
    // already carried the new body.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(fresh.cached).toBeUndefined();
    expect(fresh.text).toContain("leaky buckets");

    // The replacement was stored, so the next call inside the TTL is a hit.
    const hit = await cachedFetchAndExtract(URL, {}, true, 2100);
    expect(hit.cached).toBe(true);
    expect(hit.text).toContain("leaky buckets");
  });

  it("re-downloads normally when the origin sent no validators", async () => {
    process.env[envName("CACHE_TTL_MS")] = "1000";
    const spy = installFetchMock((_url, init) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      // Nothing to revalidate with, so nothing conditional may be sent.
      expect(h["if-none-match"]).toBeUndefined();
      expect(h["if-modified-since"]).toBeUndefined();
      return PAGE;
    });
    await cachedFetchAndExtract(URL, {}, true, 1000);
    await cachedFetchAndExtract(URL, {}, true, 2001);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("cache introspection and eviction", () => {
  it("reports entries, freshness and size", async () => {
    process.env[envName("CACHE_TTL_MS")] = "1000";
    installFetchMock(() => PAGE);
    await cachedFetchAndExtract("https://a.test/1", {}, true, 1000);
    await cachedFetchAndExtract("https://b.test/2", {}, true, 1000);

    const fresh = cacheStats(1500);
    expect(fresh.entries).toBe(2);
    expect(fresh.fresh).toBe(2);
    expect(fresh.stale).toBe(0);
    expect(fresh.bytes).toBeGreaterThan(0);
    expect(fresh.oldest).toBe(new Date(1000).toISOString());

    const later = cacheStats(5000);
    expect(later.fresh).toBe(0);
    expect(later.stale).toBe(2);
  });

  it("evicts stale entries, or everything on demand", async () => {
    process.env[envName("CACHE_TTL_MS")] = "1000";
    installFetchMock(() => PAGE);
    await cachedFetchAndExtract("https://a.test/1", {}, true, 1000);
    await cachedFetchAndExtract("https://b.test/2", {}, true, 4000);

    // At t=4500 only the first is stale.
    expect(cacheClean(false, 4500)).toBe(1);
    expect(cacheStats(4500).entries).toBe(1);

    expect(cacheClean(true, 4500)).toBe(1);
    expect(cacheStats(4500).entries).toBe(0);
  });

  it("reports an empty cache rather than failing when the directory is absent", () => {
    rmSync(dir, { recursive: true, force: true });
    const s = cacheStats(1000);
    expect(s.entries).toBe(0);
    expect(cacheClean(true, 1000)).toBe(0);
  });
});
