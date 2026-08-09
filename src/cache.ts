import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchAndExtract, looksLikePdfUrl, type ExtractorId } from "./fetch.js";
import { docFormatForUrl } from "./doc.js";
import { firecrawlBase, firecrawlIsExplicit, probeFirecrawl } from "./firecrawl.js";
import { canonicalizeUrl, domainOf, fnv1a64 } from "./url.js";
import { isNoWrite } from "./no-write.js";
import { brand, env, envInt } from "./brand.js";

// Opt-in on-disk fetch cache (--cache). The in-process hydrate cache only spans
// ONE gather; the deep tier fans out N separate `gather` processes (one per
// sub-question) that re-fetch overlapping URLs. This cache spans processes: a
// URL fetched by sub-question 1 is served from disk to sub-question 2.
//
// Zero-dependency (node:fs only). Keyed by canonical URL, so tracking-param /
// case variants of the same page share an entry. Only SUCCESSFUL extractions
// are cached — a failed/empty fetch always re-tries. Entries expire by TTL and a
// corrupt/expired entry is ignored (and overwritten), never thrown.

type Extract = Awaited<ReturnType<typeof fetchAndExtract>>;
export interface CacheEntry extends Extract {
  cachedAt: number; // ms epoch when written (threaded by the caller so TTL is testable)
  // Cache validators from the response that produced this entry. Their whole
  // point is what happens when the TTL expires: without them a stale entry is
  // worthless and the page is downloaded again in full, and with them the
  // revalidation costs a request header and a 304 with no body at all.
  etag?: string;
  lastModified?: string;
}

// 24h default; override with `<PREFIX>_CACHE_TTL_MS` (0 = always stale → refetch).
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export function cacheDir(): string {
  // `<PREFIX>_CACHE_DIR` wins, then the brand's declared cacheDir, then a
  // per-brand directory under the OS temp dir. Namespacing by brand matters:
  // three skills sharing one engine must not share one cache, or a `--lang de`
  // run in one would be served the body another cached under a different
  // extraction stack.
  return env("CACHE_DIR") ?? brand().cacheDir ?? join(tmpdir(), brand().name, "cache");
}

// domain prefix (debuggability) + 64-bit hash of the canonical URL AND the
// Accept-Language the fetch will send. Locale is part of the key because many
// sites serve a different body per language: without it, a `--lang de` run would
// be served the English body an earlier `--lang en` run cached, silently breaking
// the skill's "search the audience's language" rule.
//
// The EXTRACTOR is part of the key because the same URL yields materially
// different text depending on who read it — the built-in regex reader vs
// Firecrawl's browser-rendered main-content markdown. Without it, bringing
// Firecrawl up would be a no-op for a whole TTL: every page an earlier native
// run cached would be served from disk and shadow the better extraction.
//
// Entries written under an older key simply miss and get overwritten — no
// migration needed.
export function cachePath(url: string, acceptLanguage = "", extractor: CacheNamespace = "native"): string {
  const canon = canonicalizeUrl(url);
  const domain = domainOf(url).replace(/[^a-z0-9.-]/gi, "_") || "url";
  return join(cacheDir(), `${domain}-${fnv1a64(`${canon}\u0000${acceptLanguage}\u0000${extractor}`).toString(16)}.json`);
}

// The cache-key namespace a fetch made RIGHT NOW would use: Firecrawl when one
// is configured AND answering (the probe is memoised per process, so this costs
// a single refused connection at worst), else the built-in reader. Resolved
// before the cache is consulted so the lookup and the write that follows it
// agree on the key — and so bringing Firecrawl up or down immediately switches
// namespace instead of being masked by yesterday's entries.
//
// PDFs are the exception and share one namespace. They go through the extractor
// ladder, whose winning rung depends on which tools happen to be installed and
// is only known AFTER extraction — a pre-fetch prediction cannot name it, so
// filing PDFs under the rung that won would miss the cache on every single run.
// The rung is still reported on the source itself; it just isn't part of the key.
// Office documents share one namespace for exactly the same reason, and are
// resolved the same way: the ladder in backends/doc/ladder.ts picks its rung
// from what is installed, which no pre-fetch prediction can name.
const PDF_CACHE_NS = "pdf" as const;
const DOC_CACHE_NS = "doc" as const;
type CacheNamespace = ExtractorId | typeof PDF_CACHE_NS | typeof DOC_CACHE_NS;

async function currentExtractor(opts: { firecrawl?: string }, url: string): Promise<CacheNamespace> {
  if (looksLikePdfUrl(url)) return PDF_CACHE_NS;
  if (docFormatForUrl(url)) return DOC_CACHE_NS;
  const base = firecrawlBase(opts);
  return base && (await probeFirecrawl(base, firecrawlIsExplicit(opts))) ? "firecrawl" : "native";
}

function ttlMs(): number {
  return envInt("CACHE_TTL_MS", DEFAULT_TTL_MS);
}

/** Is this entry still inside the TTL? */
export function isCacheFresh(entry: CacheEntry, now = Date.now()): boolean {
  return typeof entry.cachedAt === "number" && now - entry.cachedAt <= ttlMs();
}

/**
 * Conditional-request headers for a stale entry, so revalidating it costs a
 * request header and a 304 instead of the whole body again.
 *
 * Empty when the entry has no validators — the origin never sent any, so there
 * is nothing to ask about and the caller must re-fetch normally.
 */
export function revalidationHeaders(entry: Pick<CacheEntry, "etag" | "lastModified">): Record<string, string> {
  const h: Record<string, string> = {};
  if (entry.etag) h["if-none-match"] = entry.etag;
  if (entry.lastModified) h["if-modified-since"] = entry.lastModified;
  return h;
}

// Read a cache entry whatever its age. Freshness is the CALLER's decision now:
// a stale entry is no longer worthless, because its validators can turn the
// refetch into a 304. Still undefined for missing / corrupt / empty-text
// entries, which carry nothing worth revalidating.
function readCache(url: string, acceptLanguage = "", extractor: CacheNamespace = "native"): CacheEntry | undefined {
  const p = cachePath(url, acceptLanguage, extractor);
  if (!existsSync(p)) return undefined;
  try {
    const entry = JSON.parse(readFileSync(p, "utf8")) as CacheEntry;
    if (typeof entry.cachedAt !== "number") return undefined;
    if (!entry.text?.trim()) return undefined; // only successes are cached; ignore anything else
    return entry;
  } catch {
    return undefined; // corrupt entry — ignore, it will be overwritten on the next success
  }
}

/** Restamp an entry after a 304, keeping every stored field and the body. */
function touchCache(url: string, entry: CacheEntry, now: number, acceptLanguage = "", extractor: CacheNamespace = "native"): void {
  if (isNoWrite()) return;
  try {
    writeFileSync(cachePath(url, acceptLanguage, extractor), JSON.stringify({ ...entry, cachedAt: now }));
  } catch {
    /* a cache write must never break a run */
  }
}

function writeCache(url: string, res: Extract, now: number, acceptLanguage = "", extractor: CacheNamespace = "native"): void {
  // Under no-write the cache degrades to READ-only rather than being disabled:
  // a plan-phase run is still served by whatever an earlier normal run left
  // here, it just never leaves a trace of its own. Deliberately not routed
  // through writeArtifact — a cache entry is not an artifact anyone wants
  // streamed back to them.
  if (isNoWrite()) return;
  try {
    mkdirSync(cacheDir(), { recursive: true });
    const entry: CacheEntry = { ...res, cachedAt: now };
    writeFileSync(cachePath(url, acceptLanguage, extractor), JSON.stringify(entry));
  } catch {
    /* a cache write must never break a run */
  }
}

// fetchAndExtract with an optional on-disk cache in front. `enabled` false ⇒
// byte-identical to calling fetchAndExtract directly (no disk I/O). `now` is the
// current epoch ms, threaded in by the caller so this stays testable/pure w.r.t.
// the clock.
export async function cachedFetchAndExtract(
  url: string,
  opts: { acceptLanguage?: string; firecrawl?: string } = {},
  enabled = false,
  now = Date.now(),
): Promise<Extract & { cached?: boolean }> {
  if (!enabled) return fetchAndExtract(url, opts);
  const lang = opts.acceptLanguage ?? "";
  const ns = await currentExtractor(opts, url);
  const hit = readCache(url, lang, ns);
  if (hit && isCacheFresh(hit, now)) return { ...hit, cached: true };

  // Stale but revalidatable: ask the origin whether anything changed. A 304
  // answers with headers and no body, which is the entire point — the previous
  // behaviour re-downloaded the full page every time the TTL rolled over, even
  // for a document that had not moved in a year.
  const revalidate = hit ? revalidationHeaders(hit) : {};
  if (hit && Object.keys(revalidate).length) {
    const probe = await fetchAndExtract(url, { ...opts, headers: revalidate });
    if (probe.status === 304) {
      touchCache(url, hit, now, lang, ns);
      return { ...hit, cached: true };
    }
    // Changed (or the origin ignored the validators) — the body we just pulled
    // IS the fresh one, so use it rather than paying for a second request.
    if (probe.text?.trim()) {
      writeCache(url, probe, now, lang, ns === PDF_CACHE_NS || ns === DOC_CACHE_NS ? ns : (probe.extractor ?? "native"));
      return probe;
    }
  }

  const res = await fetchAndExtract(url, opts);
  // Cache successes only, filed under the extractor that ACTUALLY produced the
  // text — a Firecrawl run that fell back to the built-in reader for one page
  // must not leave that page sitting in Firecrawl's namespace. PDFs keep the
  // shared namespace resolved above, for the reason documented there.
  if (res.text?.trim()) writeCache(url, res, now, lang, ns === PDF_CACHE_NS || ns === DOC_CACHE_NS ? ns : (res.extractor ?? "native"));
  return res;
}

export interface CacheStats {
  dir: string;
  entries: number;
  bytes: number;
  fresh: number;
  stale: number;
  ttlMs: number;
  oldest?: string; // ISO
  newest?: string; // ISO
}

/**
 * What is on disk right now: how many entries, how much space, how many are
 * still fresh.
 *
 * A cache nobody can inspect is a cache nobody trusts — "is this stale answer
 * coming from disk?" was previously only answerable by deleting the directory
 * and watching whether the run got slower.
 */
export function cacheStats(now = Date.now()): CacheStats {
  const dir = cacheDir();
  const out: CacheStats = { dir, entries: 0, bytes: 0, fresh: 0, stale: 0, ttlMs: ttlMs() };
  if (!existsSync(dir)) return out;
  let oldest = Number.POSITIVE_INFINITY;
  let newest = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const abs = join(dir, name);
    try {
      out.bytes += statSync(abs).size;
      const entry = JSON.parse(readFileSync(abs, "utf8")) as CacheEntry;
      if (typeof entry.cachedAt !== "number") continue;
      out.entries++;
      if (isCacheFresh(entry, now)) out.fresh++;
      else out.stale++;
      if (entry.cachedAt < oldest) oldest = entry.cachedAt;
      if (entry.cachedAt > newest) newest = entry.cachedAt;
    } catch {
      /* not one of ours, or half-written — never a reason to fail */
    }
  }
  if (out.entries) {
    out.oldest = new Date(oldest).toISOString();
    out.newest = new Date(newest).toISOString();
  }
  return out;
}

/**
 * Drop stale entries, or every entry with `all`. Returns how many went.
 *
 * Nothing else ever removes anything: before this, the only eviction was the TTL
 * deciding not to READ an entry, so a long-lived cache directory grew without
 * bound and kept bodies for pages nobody would look at again.
 */
export function cacheClean(all = false, now = Date.now()): number {
  const dir = cacheDir();
  if (!existsSync(dir) || isNoWrite()) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const abs = join(dir, name);
    let drop = all;
    if (!drop) {
      try {
        const entry = JSON.parse(readFileSync(abs, "utf8")) as CacheEntry;
        drop = !isCacheFresh(entry, now);
      } catch {
        drop = true; // unreadable entries are worth dropping either way
      }
    }
    if (!drop) continue;
    try {
      rmSync(abs, { force: true });
      removed++;
    } catch {
      /* a failed unlink is not a failed run */
    }
  }
  return removed;
}
