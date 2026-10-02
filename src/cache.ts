import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, type Stats, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fetchAndExtract, looksLikePdfUrl, type ExtractorId } from "./fetch.js";
import { docFormatForUrl } from "./doc.js";
import { knownVideo } from "./video.js";
import { firecrawlBase, firecrawlIsExplicit, probeFirecrawl } from "./firecrawl.js";
import { canonicalizeUrl, domainOf, fnv1a64 } from "./url.js";
import { isNoWrite, writeFileAtomic } from "./no-write.js";
import { brand, countFetch, env, envInt, envName } from "./brand.js";
import { type BrowserFetchMode, browserFetchMode } from "./browser/mode.js";

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
  /**
   * Set on built-in text written while Firecrawl was up but failed on this page.
   * Lookups that predict Firecrawl read it too; otherwise every call for the
   * TTL paid for the same failed scrape plus a fresh download.
   */
  fallbackFrom?: "firecrawl";
}

// 24h default; override with `<PREFIX>_CACHE_TTL_MS` (0 = always stale → refetch).
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export function cacheDir(): string {
  // `<PREFIX>_CACHE_DIR` wins, then the brand's declared cacheDir, then a
  // per-brand directory under the OS temp dir. Namespacing by brand matters:
  // three skills sharing one engine must not share one cache, or a `--lang de`
  // run in one would be served the body another cached under a different
  // extraction stack.
  //
  // The default is per USER too, where the platform has uids, so two users of
  // one machine never share a cache. The name alone protects nothing: the uid
  // is public, so another user can still create the directory first — as a
  // symlink into your project for `cache clean` to sweep, or pre-filled with
  // entries for you to be served. What it holds is only used once it proves to
  // be yours (see openCacheDir). An explicit directory is taken as given: a
  // shared volume is a choice.
  return namedCacheDir() ?? join(tmpdir(), userScoped(brand().name), "cache");
}

/** The directory the operator or the brand named, if either did. */
const namedCacheDir = (): string | undefined => env("CACHE_DIR") ?? brand().cacheDir;

function userScoped(name: string): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return uid === undefined ? name : `${name}-${uid}`;
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
// A consent-stripped or full-page read is keyed apart as well (the optional
// `variant`): the built-in reader extracts different text for the same page
// under each, and whichever setting wrote the entry used to be served to both
// for the whole TTL. So is a Markdown read of any of them, which is a different
// document again. A plain text read adds nothing to the key, so its path is
// what it always was.
//
// Entries written under an older key simply miss and get overwritten — no
// migration needed.
export function cachePath(url: string, acceptLanguage = "", extractor: CacheNamespace = "native", variant: CacheVariant = ""): string {
  const canon = canonicalizeUrl(url);
  const domain = domainOf(url).replace(/[^a-z0-9.-]/gi, "_") || "url";
  const key = `${canon}\u0000${acceptLanguage}\u0000${extractor}${variant ? `\u0000${variant}` : ""}`;
  return join(cacheDir(), `${domain}-${fnv1a64(key).toString(16)}.json`);
}

// Only the built-in reader applies these: Firecrawl's markdown skips both, and a
// document has no banner to strip — so only the "native" namespace is split by
// them (see entryPaths), and one PDF entry serves every kind of request. The
// browser rung extracts with the built-in reader, so "browser" is split too.
//
// The output format splits it the same way, and for the same reason: the
// built-in reader writes the same page as text or as Markdown, while
// Firecrawl's Markdown and a document's text are one thing either way.
type CacheRead = "" | "consent" | "full";
type CacheVariant = CacheRead | "md" | `${Exclude<CacheRead, "">}-md`;
const TEXT_VARIANTS: readonly CacheVariant[] = ["", "consent", "full"];
const MARKDOWN_VARIANTS: readonly CacheVariant[] = ["md", "consent-md", "full-md"];
const PLAIN: readonly CacheVariant[] = [""];

function variantOf(opts: { stripConsent?: boolean; fullPage?: boolean; format?: "text" | "markdown" }): CacheVariant {
  // fullPage wins, as it does in fetchAndExtract: it turns the consent filter off.
  const read: CacheRead = opts.fullPage ? "full" : opts.stripConsent ? "consent" : "";
  if (opts.format !== "markdown") return read;
  return read ? `${read}-md` : "md";
}

/** The variants that hold the same format as `variant`: the fallback a hole may take, never the other shape. */
const sameFormat = (variant: CacheVariant): readonly CacheVariant[] => (MARKDOWN_VARIANTS.includes(variant) ? MARKDOWN_VARIANTS : TEXT_VARIANTS);

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
// A video's transcript rung is only known after the ladder has run, exactly as
// a PDF's is, so every transcript shares one namespace too.
const VIDEO_CACHE_NS = "video" as const;
type CacheNamespace = ExtractorId | typeof PDF_CACHE_NS | typeof DOC_CACHE_NS | typeof VIDEO_CACHE_NS;

async function currentExtractor(opts: { firecrawl?: string; fullPage?: boolean; browser?: BrowserFetchMode }, url: string): Promise<CacheNamespace> {
  if (looksLikePdfUrl(url)) return PDF_CACHE_NS;
  if (knownVideo(url)) return VIDEO_CACHE_NS;
  if (docFormatForUrl(url)) return DOC_CACHE_NS;
  // Every web page goes to the browser then, full-page reads included.
  if (browserFetchMode(opts.browser) === "always") return "browser";
  // A full-page read never goes to Firecrawl, so it must never be served Firecrawl's text.
  if (opts.fullPage) return "native";
  const base = firecrawlBase(opts);
  return base && (await probeFirecrawl(base, firecrawlIsExplicit(opts))) ? "firecrawl" : "native";
}

// Older entries for extensionless documents were filed under the converter.
// Keep reading those alongside the format namespaces so upgrading keeps both
// online and offline caches usable.
const DOCUMENT_NAMESPACES: CacheNamespace[] = [PDF_CACHE_NS, DOC_CACHE_NS, VIDEO_CACHE_NS, "pdf-inspector", "pdftotext", "anydoc", "ocr"];
const WRITTEN_NAMESPACES: CacheNamespace[] = ["native", "firecrawl", "browser", ...DOCUMENT_NAMESPACES];
/** The namespaces whose entries differ by read mode and format (see variantOf). */
const splitByVariant = (ns: CacheNamespace): boolean => ns === "native" || ns === "browser";

function namespaceFor(result: Extract, predicted: CacheNamespace): CacheNamespace {
  // A video host's page read as a page (no video on it) is a page: filed where
  // pages are, with its format and read mode, not under the video namespace.
  if (predicted === VIDEO_CACHE_NS && result.documentType !== "video") return result.extractor ?? "native";
  return (
    result.documentType ??
    (predicted === PDF_CACHE_NS || predicted === DOC_CACHE_NS || predicted === VIDEO_CACHE_NS ? predicted : (result.extractor ?? "native"))
  );
}

/**
 * The stored entry for a URL under ANY namespace, newest first.
 *
 * Offline cannot ask `currentExtractor` which namespace to look in — that
 * question is answered by probing Firecrawl, which needs the network the caller
 * just said not to use. And rejecting a page the cache demonstrably holds over
 * which extractor produced it would defeat the point of the switch. So offline
 * looks everywhere and serves the freshest thing it finds.
 */
function readAnyNamespace(
  url: string,
  acceptLanguage: string,
  namespaces = WRITTEN_NAMESPACES,
  variants: readonly CacheVariant[] = PLAIN,
): CacheEntry | undefined {
  let best: CacheEntry | undefined;
  for (const ns of namespaces) {
    for (const variant of splitByVariant(ns) ? variants : PLAIN) {
      const hit = readCache(url, acceptLanguage, ns, variant);
      if (hit && (!best || hit.cachedAt > best.cachedAt)) best = hit;
    }
  }
  return best;
}

/**
 * The requested read of the page if the cache has one, else any read of it in
 * the same format — better than a hole. Not the other format: text handed to a
 * caller that asked for Markdown is the shape mismatch `format` exists to end.
 */
function readAnyCopy(url: string, acceptLanguage: string, variant: CacheVariant): CacheEntry | undefined {
  return readAnyNamespace(url, acceptLanguage, WRITTEN_NAMESPACES, [variant]) ?? readAnyNamespace(url, acceptLanguage, WRITTEN_NAMESPACES, sameFormat(variant));
}

function ttlMs(): number {
  // The brand's declared TTL is the default, because how long a page stays fresh
  // is a product decision: a tool that re-runs the same question all day wants a
  // week, a search tool wants a day. `<PREFIX>_CACHE_TTL_HOURS` is accepted
  // alongside `_MS` — hours is the unit consumers' users already have exported,
  // and breaking those variables to adopt this module would be a poor trade.
  //
  // Hours are read as a float, not through envInt: truncating first turned
  // `0.5` into a TTL of 0 — always stale — and `1.5` into one hour.
  const fallback = brand().cacheTtlMs ?? DEFAULT_TTL_MS;
  const hours = env("CACHE_TTL_HOURS");
  if (hours !== undefined) {
    const h = Number(hours);
    return Number.isFinite(h) ? Math.round(Math.max(0, h) * 3600_000) : fallback;
  }
  return envInt("CACHE_TTL_MS", fallback);
}

/** How the cache behaves for this run. Both default to off. */
export interface CacheMode {
  /** Ignore any stored entry and re-fetch. The fresh result is still written. */
  refresh: boolean;
  /**
   * Never touch the network. Serve what is on disk however stale, and return an
   * honest note on a genuine miss rather than an empty page — a hole the caller
   * cannot distinguish from "this URL has nothing on it" is worse than a refusal.
   */
  offline: boolean;
}

let mode: CacheMode = { refresh: false, offline: false };

/** Declare `--refresh` / `--offline` for this process. */
export function setCacheMode(next: Partial<CacheMode>): void {
  mode = { ...mode, ...next };
}

/** What the two switches are set to right now. */
export function cacheMode(): CacheMode {
  return { ...mode };
}

/** Test seam: back to plain caching. */
export function resetCacheMode(): void {
  mode = { refresh: false, offline: false };
}

/**
 * Is this entry still inside the TTL?
 *
 * Strictly less-than, so a TTL of 0 means what it is documented to mean: always
 * stale, always refetch. With `<=` it instead meant "fresh for the millisecond
 * it was written in", which is indistinguishable from working until two calls
 * land in the same tick — and then the entry is served and the refetch the
 * operator asked for silently does not happen.
 */
export function isCacheFresh(entry: CacheEntry, now = Date.now()): boolean {
  return typeof entry.cachedAt === "number" && now - entry.cachedAt < ttlMs();
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

// An entry is TWO files: the metadata as JSON, and the extracted text beside it
// as raw bytes.
//
// The split is not tidiness. A single JSON blob means every read parses the
// whole page out of a string literal and every write escapes it back into one —
// for a multi-megabyte document that is two full passes and a second copy in
// memory, paid on a code path whose entire purpose is to be cheaper than the
// network. The text is also the one field nothing ever inspects without wanting
// all of it, so it gains nothing from living in the structured half.
function entryPaths(url: string, acceptLanguage: string, extractor: CacheNamespace, variant: CacheVariant): { meta: string; body: string } {
  const meta = cachePath(url, acceptLanguage, extractor, splitByVariant(extractor) ? variant : "");
  return { meta, body: meta.replace(/\.json$/, ".body") };
}

// Read a cache entry whatever its age. Freshness is the CALLER's decision now:
// a stale entry is no longer worthless, because its validators can turn the
// refetch into a 304. Still undefined for missing / corrupt / empty-text
// entries, which carry nothing worth revalidating.
function readCache(url: string, acceptLanguage = "", extractor: CacheNamespace = "native", variant: CacheVariant = ""): CacheEntry | undefined {
  if (!entryDir(false)) return undefined;
  const { meta, body } = entryPaths(url, acceptLanguage, extractor, variant);
  if (!existsSync(meta)) return undefined;
  try {
    const entry = JSON.parse(readFileSync(meta, "utf8")) as CacheEntry;
    if (typeof entry.cachedAt !== "number") return undefined;
    // Entries written before the body moved out still carry `text` inline.
    // Reading both shapes means upgrading the engine does not silently discard a
    // warm cache directory — the entry is rewritten in the new shape on its next
    // touch or refresh.
    const text = existsSync(body) ? readFileSync(body, "utf8") : entry.text;
    if (!text?.trim()) return undefined; // only successes are cached; ignore anything else
    return { ...entry, text };
  } catch {
    return undefined; // corrupt entry — ignore, it will be overwritten on the next success
  }
}

function writeCache(url: string, res: Extract, now: number, acceptLanguage = "", extractor: CacheNamespace = "native", variant: CacheVariant = ""): void {
  // Under no-write the cache degrades to READ-only rather than being disabled:
  // a plan-phase run is still served by whatever an earlier normal run left
  // here, it just never leaves a trace of its own. Deliberately not routed
  // through writeArtifact — a cache entry is not an artifact anyone wants
  // streamed back to them.
  if (isNoWrite()) return;
  const { meta, body } = entryPaths(url, acceptLanguage, extractor, variant);
  // The note is not stored: it describes the run that fetched the page (a
  // Firecrawl fallback, say), and replaying it on every hit for a day misreports
  // a run that did no such thing. What it said about the content is kept as a
  // field (`truncated`) and restated when the entry is served.
  const { text, note: _note, ...rest } = res as CacheEntry;
  const write = () => {
    if (!entryDir(true)) return; // refused: the run goes on uncached
    // Body first: a reader that catches the pair mid-write sees either the old
    // metadata (pointing at a body that is at worst the new one for the same
    // URL) or no metadata at all. The reverse order can publish metadata for a
    // body that is not there yet. Each file lands by rename, so a reader — the
    // deep tier's sibling processes share this directory — never sees a
    // half-written body either.
    writeFileAtomic(body, text ?? "");
    writeFileAtomic(meta, JSON.stringify({ ...rest, cachedAt: now }));
  };
  try {
    write();
  } catch {
    // The directory may have been removed under us (`cache clean`, a tmp
    // sweeper): forget that it existed and try once more before giving up.
    ensured.delete(cacheDir());
    try {
      write();
    } catch {
      /* a cache write must never break a run */
    }
  }
}

// mkdir once per directory per process, not once per entry written. The set
// is invalidated on a failed write, which is how a directory removed mid-run
// gets recreated.
const ensured = new Set<string>();
function ensureDir(dir: string): void {
  if (ensured.has(dir)) return;
  mkdirSync(dir, { recursive: true });
  ensured.add(dir);
}

/**
 * The cache directory, when this run may read or write it: `dir` when it may,
 * `refused` saying why it may not, neither when the default one does not exist
 * yet (and `create` was not asked for).
 *
 * A named directory is used as given. The default one is used only once it
 * proves to be the caller's: `<tmp>/<brand>-<uid>` and `cache` inside it must
 * each be a real directory — no symbolic link — that belongs to the caller and
 * that no other user may write. Whoever can write either one can plant an entry
 * at the path cachePath computes, and it is served as the page. Nobody else can
 * move a directory of ours out of the sticky temp dir, or write inside one of
 * ours once it is private, so what is checked here stays true.
 *
 * Created one level at a time, 0700 whatever the umask (mkdir only ever takes
 * bits away from the mode it is given), and never through a link: `mkdir -p`
 * follows a planted `<brand>-<uid>` symlink and makes `cache` wherever it
 * points. One of the caller's own that others may only READ — what an earlier
 * engine made with the umask's mode — is made private rather than refused:
 * every page cached in it was readable by every user of the machine.
 *
 * Checked on every use rather than once per process: a tmp sweeper can remove
 * the directory under a long-lived MCP server, and whoever creates it next
 * must not inherit the verdict.
 */
function openCacheDir(create: boolean): { dir?: string; refused?: string } {
  const dir = cacheDir();
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (namedCacheDir() !== undefined || uid === undefined) {
    if (create) ensureDir(dir);
    return { dir };
  }
  if (create) mkdirSync(dirname(dirname(dir)), { recursive: true }); // the temp dir itself
  for (const p of [dirname(dir), dir]) {
    if (create) mkdirPrivate(p);
    let st: Stats;
    try {
      st = lstatSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; // nothing cached yet
      return { refused: `${p} cannot be inspected (${(e as Error).message})` };
    }
    if (st.isSymbolicLink()) return { refused: `${p} is a symbolic link` };
    if (!st.isDirectory()) return { refused: `${p} is not a directory` };
    if (st.uid !== uid) return { refused: `${p} belongs to another user` };
    if (st.mode & 0o022) return { refused: `${p} is writable by other users` };
    if (st.mode & 0o077 && !isNoWrite()) {
      try {
        chmodSync(p, 0o700);
      } catch {
        /* still writable by nobody else, so still usable */
      }
    }
  }
  return { dir };
}

/** mkdir, private, and never through whatever already has the name. */
function mkdirPrivate(p: string): void {
  try {
    mkdirSync(p, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}

// Each refusal is announced once per process, as an unknown ladder rung is:
// a run that asked for the cache and silently got none would read as a cache
// that never fills.
const announced = new Set<string>();

/** The directory entries are read from and written to, announcing a refusal. */
function entryDir(create: boolean): string | undefined {
  const { dir, refused } = openCacheDir(create);
  if (refused && !announced.has(refused)) {
    announced.add(refused);
    process.emitWarning(`the fetch cache is not used: ${refused}. Remove it, or set ${envName("CACHE_DIR")} to a directory only you can write.`);
  }
  return dir;
}

/**
 * Restamp an entry after a 304, keeping every stored field and the body.
 *
 * Deliberately a full re-write rather than a metadata-only patch: an entry read
 * from the old single-blob shape has no body file yet, and touching only the
 * metadata would strand it with neither an inline text nor a sidecar.
 */
function touchCache(url: string, entry: CacheEntry, now: number, acceptLanguage = "", extractor: CacheNamespace = "native", variant: CacheVariant = ""): void {
  writeCache(url, entry, now, acceptLanguage, extractor, variant);
}

// fetchAndExtract with an optional on-disk cache in front. `enabled` false ⇒
// byte-identical to calling fetchAndExtract directly (no disk I/O). `now` is the
// current epoch ms, threaded in by the caller so this stays testable/pure w.r.t.
// the clock.
export async function cachedFetchAndExtract(
  url: string,
  opts: {
    acceptLanguage?: string;
    firecrawl?: string;
    stripConsent?: boolean;
    fullPage?: boolean;
    /** "markdown" reads an HTML page as CommonMark; cached apart from its text (see fetchAndExtract). */
    format?: "text" | "markdown";
    timeoutMs?: number;
    signal?: AbortSignal;
    /** The browser rung (see fetchAndExtract); its reads are cached under their own namespace. */
    browser?: BrowserFetchMode;
  } = {},
  enabled = false,
  now = Date.now(),
): Promise<Extract & { cached?: boolean }> {
  const { refresh, offline } = mode;
  // `offline` turns the cache on for READING even when the caller did not ask
  // for it: "don't use the network" and "don't use the cache" together leave
  // nothing at all, which is never what an operator meant.
  if (!enabled && !offline) return fetchAndExtract(url, opts);
  const lang = opts.acceptLanguage ?? "";
  const variant = variantOf(opts);
  const served = (entry: CacheEntry, note?: string): Extract & { cached?: boolean } => {
    countFetch(Buffer.byteLength(entry.text), true);
    // A note stored by an older engine is dropped for the reason writeCache
    // no longer stores one.
    const { note: _stored, ...rest } = entry;
    const about = note ?? (entry.truncated ? `The cached text of ${url} is a prefix: the page overran the response size cap.` : undefined);
    return { ...rest, cached: true, ...(about ? { note: about } : {}) };
  };

  if (offline) {
    const stored = readAnyCopy(url, lang, variant);
    if (stored) return served(stored);
    const { refused } = openCacheDir(false);
    if (refused) return { text: "", finalUrl: url, status: 0, note: `Offline: the cache is not used — ${refused}.` };
    return { text: "", finalUrl: url, status: 0, note: `Offline: ${url} is not in the cache (drop --offline, or warm it with a normal run).` };
  }

  const ns = await currentExtractor(opts, url);
  // Cache successes only, filed under the extractor that ACTUALLY produced the
  // text — a Firecrawl run that fell back to the built-in reader for one page
  // must not leave that page sitting in Firecrawl's namespace. PDFs keep the
  // shared namespace resolved above, for the reason documented there. The
  // fallback is marked, so the next lookup — still predicting Firecrawl — can
  // find it instead of paying for the same failed scrape again.
  const store = (result: Extract): void => {
    const target = namespaceFor(result, ns);
    const entry = ns === "firecrawl" && target === "native" ? { ...result, fallbackFrom: "firecrawl" as const } : result;
    writeCache(url, entry, now, lang, target, variant);
  };
  // --refresh does not read, but it still writes: the point is to replace what
  // is there, not to stop caching for the run.
  const hit = refresh ? undefined : lookup(url, lang, ns, variant, browserFetchMode(opts.browser) === "fallback");
  if (hit && isCacheFresh(hit, now)) return served(hit);

  // Stale but revalidatable: ask the origin whether anything changed. A 304
  // answers with headers and no body, which is the entire point — the previous
  // behaviour re-downloaded the full page every time the TTL rolled over, even
  // for a document that had not moved in a year.
  let res: Extract | undefined;
  const revalidate = hit ? revalidationHeaders(hit) : {};
  if (hit && Object.keys(revalidate).length) {
    const probe = await fetchAndExtract(url, { ...opts, headers: revalidate });
    if (probe.status === 304) {
      // A 304 may carry fresh validators (RFC 9110). Restamping the old ones
      // made the next revalidation miss and download the whole page again.
      const renewed: CacheEntry = { ...hit, etag: probe.etag ?? hit.etag, lastModified: probe.lastModified ?? hit.lastModified };
      touchCache(url, renewed, now, lang, namespaceFor(hit, ns), variant);
      return served(renewed);
    }
    // Changed (or the origin ignored the validators) — the body we just pulled
    // IS the fresh one, so use it rather than paying for a second request.
    if (probe.text?.trim()) {
      store(probe);
      return probe;
    }
    // Only an unconditional refetch can do better after a 412 (the validators
    // themselves were refused) or a 2xx with nothing readable. A 5xx, a 429, a
    // 404 or a timeout would come back the same, and asking again doubled the
    // load on a struggling origin and the wait before the stale copy below.
    if (probe.status !== 412 && !(probe.status >= 200 && probe.status < 300)) res = probe;
  }

  res ??= await fetchAndExtract(url, opts);
  if (res.text?.trim()) {
    store(res);
    return res;
  }
  // The origin gave us nothing. A stale copy of the page beats a hole in the
  // output: the caller can see from the note exactly how old what it is reading
  // is, which it cannot do with an empty string. Looked up across namespaces
  // because the copy we hold may have been written by the other extractor, and
  // it is still this page's text.
  const stale = hit ?? readAnyCopy(url, lang, variant);
  if (stale) return served(stale, `${url} returned ${res.status || "no response"}; served the cached copy from ${new Date(stale.cachedAt).toISOString()}.`);
  return res;
}

// The entry a lookup made now may serve: its own namespace (or a document's),
// and — when Firecrawl is predicted — the built-in text of a page Firecrawl
// failed on, which is still the best this page has. With the browser as a
// fallback, a page that needed it was filed under "browser", which is only
// ever written for such a page (or by `always`): that copy is as good.
function lookup(url: string, acceptLanguage: string, ns: CacheNamespace, variant: CacheVariant, browserFallback = false): CacheEntry | undefined {
  const best = lookupOwn(url, acceptLanguage, ns, variant);
  const rendered = browserFallback ? readCache(url, acceptLanguage, "browser", variant) : undefined;
  return rendered && (!best || rendered.cachedAt > best.cachedAt) ? rendered : best;
}

function lookupOwn(url: string, acceptLanguage: string, ns: CacheNamespace, variant: CacheVariant): CacheEntry | undefined {
  const best = readAnyNamespace(url, acceptLanguage, [...new Set([ns, ...DOCUMENT_NAMESPACES])], [variant]);
  // ...and found there again, in its own variant.
  if (ns === VIDEO_CACHE_NS && !best) return readCache(url, acceptLanguage, "native", variant);
  if (ns !== "firecrawl") return best;
  const fallback = readCache(url, acceptLanguage, "native", variant);
  return fallback?.fallbackFrom === "firecrawl" && (!best || fallback.cachedAt > best.cachedAt) ? fallback : best;
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
  /**
   * Why the default directory is not used, when it is not: it is a symbolic
   * link, belongs to another user, or other users may write it. The cache then
   * reads and writes nothing, and every fetch goes to the network.
   */
  refused?: string;
}

// The only files stats and eviction ever look at: the names this module writes
// — `<domain>-<hex>.json`, its `.body`, and the `<either>.<pid>.<n>.tmp` a
// writer killed mid-write leaves behind. The directory is whatever
// `<PREFIX>_CACHE_DIR` says, and one typo there must not make a cleanup
// reach for somebody's package.json. Parsed by hand rather than by one
// pattern, which keeps the check linear on any name.
type OwnFile = { kind: "json" | "body" | "tmp"; stem: string };
const WRITER_TMP = /\.\d+\.\d+\.tmp$/;

function ownFile(name: string): OwnFile | undefined {
  const tmp = WRITER_TMP.exec(name);
  const base = tmp ? name.slice(0, tmp.index) : name;
  const ext = base.endsWith(".json") ? "json" : base.endsWith(".body") ? "body" : undefined;
  if (!ext) return undefined;
  const stem = base.slice(0, -5);
  const dash = stem.lastIndexOf("-");
  if (dash < 1 || !/^[0-9a-f]{1,16}$/.test(stem.slice(dash + 1)) || !/^[\w.-]+$/.test(stem.slice(0, dash))) return undefined;
  return { kind: tmp ? "tmp" : ext, stem };
}

// …and a `.json` of that shape counts as an entry only when it parses into one.
// Anything else — unreadable, or valid JSON of some other shape — is left alone:
// a name that merely looks like ours is not proof that we wrote it.
function readEntryMeta(abs: string): CacheEntry | undefined {
  try {
    const entry = JSON.parse(readFileSync(abs, "utf8")) as CacheEntry | null;
    return entry && typeof entry.cachedAt === "number" && typeof entry.finalUrl === "string" ? entry : undefined;
  } catch {
    return undefined;
  }
}

// A writer lands the body, then the metadata, each by rename. Between the two,
// the body is an "orphan" and its temp file is live, so a stale-only clean waits
// this long before calling either abandoned.
const ORPHAN_GRACE_MS = 10 * 60 * 1000;

function sizeOf(abs: string): number {
  try {
    return statSync(abs).size;
  } catch {
    return 0; // vanished between readdir and stat
  }
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
  const { refused } = openCacheDir(false);
  if (refused) return { ...out, refused };
  if (!existsSync(dir)) return out;
  let oldest = Number.POSITIVE_INFINITY;
  let newest = 0;
  for (const name of readdirSync(dir)) {
    const own = ownFile(name);
    if (!own) continue;
    const abs = join(dir, name);
    // Size is summed over metadata, bodies and leftover temp files alike.
    // Counting only the `.json` half would report a few kilobytes for a
    // directory holding hundreds of megabytes of page text — a disk-usage
    // number that is not disk usage.
    if (own.kind !== "json") {
      out.bytes += sizeOf(abs);
      continue;
    }
    const entry = readEntryMeta(abs);
    if (!entry) continue;
    out.bytes += sizeOf(abs);
    out.entries++;
    if (isCacheFresh(entry, now)) out.fresh++;
    else out.stale++;
    if (entry.cachedAt < oldest) oldest = entry.cachedAt;
    if (entry.cachedAt > newest) newest = entry.cachedAt;
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
 * bound and kept bodies for pages nobody would look at again. The same sweep
 * takes this module's own debris — a body whose metadata never landed, a
 * killed writer's temp file — immediately with `all`, and once it is old
 * enough to be abandoned otherwise. Nothing it did not write is touched.
 */
export function cacheClean(all = false, now = Date.now()): number {
  const dir = cacheDir();
  if (isNoWrite() || !openCacheDir(false).dir || !existsSync(dir)) return 0;
  const names = readdirSync(dir);
  const present = new Set(names);
  const remove = (name: string): boolean => {
    try {
      rmSync(join(dir, name), { force: true });
      return true;
    } catch {
      return false; // a failed unlink is not a failed run
    }
  };
  const abandoned = (name: string): boolean => {
    try {
      return all || now - statSync(join(dir, name)).mtimeMs > ORPHAN_GRACE_MS;
    } catch {
      return false;
    }
  };
  let removed = 0;
  for (const name of names) {
    const own = ownFile(name);
    if (!own) continue;
    if (own.kind === "json") {
      const entry = readEntryMeta(join(dir, name));
      if (!entry || (!all && isCacheFresh(entry, now)) || !remove(name)) continue;
      // The body is half the entry; leaving it behind is exactly the unbounded
      // growth this function exists to stop, and it would be the larger half.
      remove(`${own.stem}.body`);
      removed++;
    } else if (own.kind === "body" ? !present.has(`${own.stem}.json`) && abandoned(name) : abandoned(name)) {
      remove(name);
    }
  }
  return removed;
}
