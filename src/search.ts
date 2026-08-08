import { brand, env, envName } from "./brand.js";
import { httpGet, pageDelayMs, sleep } from "./fetch.js";
import { searchViaFirecrawl } from "./firecrawl.js";
import { acceptLanguageHeader } from "./locale.js";
import { canonicalizeUrl } from "./url.js";

// Discovery: turning a question into candidate URLs.
//
// The engine already manages the SearXNG and Firecrawl containers, so it should
// be able to ask them something. Before this it could start a search engine and
// not query it.
//
// Deliberately NOT the shape a full research pipeline wants. There is no
// backend registry, no fan-out across twenty engines, no RRF fusion and no
// ranking — a tool that needs those builds them on top. What this offers is the
// primitive underneath: ask the local, keyless stack for candidate URLs, and
// say honestly when it could not.

/** The docker stack publishes SearXNG here. */
export const SEARXNG_DEFAULT_BASE = "http://localhost:8888";

const PROBE_TIMEOUT_MS = 2000;
const QUERY_TIMEOUT_MS = 8000;

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  /** Which engine produced it. */
  via: "searxng" | "firecrawl";
}

export interface SearchOptions {
  /** Base URL, or "off" to disable. Defaults to `<PREFIX>_SEARXNG` then localhost. */
  searxng?: string;
  /** Base URL, or "off" to disable. */
  firecrawl?: string;
  /** How many hits to aim for. */
  limit?: number;
  /** BCP-47 language tag, e.g. "fr-FR". */
  lang?: string;
  region?: string;
  /** Result pages to walk. SearXNG paginates with `&pageno=`. */
  pages?: number;
}

export interface SearchResult {
  hits: SearchHit[];
  /** What degraded, in words a caller can show a user. Never an exception. */
  notes: string[];
}

/**
 * Resolve the SearXNG base: an explicit option wins, else `<PREFIX>_SEARXNG`,
 * else the localhost default. The literal `off` from either source disables it.
 */
export function searxngBase(opts: SearchOptions = {}): string | null {
  const raw = (opts.searxng ?? env("SEARXNG") ?? SEARXNG_DEFAULT_BASE).trim();
  if (!raw || raw.toLowerCase() === "off") return null;
  return raw.replace(/\/+$/, "");
}

/** True when the base came from the caller rather than the default. */
export function searxngIsExplicit(opts: SearchOptions = {}): boolean {
  return !!(opts.searxng ?? env("SEARXNG"));
}

const probeCache = new Map<string, Promise<boolean>>();

/** Test seam: forget memoised probe verdicts. */
export function resetSearxngProbeCache(): void {
  probeCache.clear();
}

/**
 * Is a SearXNG instance answering at `base`? A single `GET {base}/healthz` with
 * a hard 2s ceiling; ANY HTTP response counts as up, because a 404 from a proxy
 * in front of it still proves something is listening. Memoised per base, so the
 * whole cost of an absent instance is one refused connection per process.
 *
 * Deliberately bypasses httpGet, whose retry-with-backoff would turn a 2s
 * ceiling into roughly 4.6s on a blackholed host. A probe wants a single shot.
 */
export function probeSearxng(base: string): Promise<boolean> {
  let p = probeCache.get(base);
  if (!p) {
    p = (async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/healthz`, { signal: ctrl.signal });
        await res.text().catch(() => ""); // drain so the socket is released
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(t);
      }
    })();
    probeCache.set(base, p);
  }
  return p;
}

/**
 * Query a SearXNG instance's keyless JSON API.
 *
 * Most PUBLIC instances disable `format=json`, which is exactly why the stack
 * ships a local one. Returns candidates — title, snippet, URL — never page
 * text: hydrating a hit is `fetchAndExtract`'s job.
 */
export async function searchViaSearxng(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const base = searxngBase(opts);
  if (!base) return { hits: [], notes: [`SearXNG disabled (${envName("SEARXNG")}=off).`] };

  if (!(await probeSearxng(base))) {
    return {
      hits: [],
      notes: [
        searxngIsExplicit(opts)
          ? `SearXNG not reachable at ${base}.`
          : `SearXNG not running at ${base} — start it with \`${brand().cli} searxng up\` for local, keyless discovery.`,
      ],
    };
  }

  const pages = Math.max(1, opts.pages ?? 1);
  const limit = Math.max(1, opts.limit ?? 10);
  const acceptLanguage = acceptLanguageHeader(opts.lang, opts.region);
  const root = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1` + (opts.lang ? `&language=${encodeURIComponent(opts.lang)}` : "");

  const notes: string[] = [];
  const seen = new Set<string>();
  const hits: SearchHit[] = [];

  // SearXNG answers 200 with an EMPTY result list when its own upstreams have
  // throttled it, reporting them in `unresponsive_engines` rather than failing.
  // Without reading that field a rate-limited instance is indistinguishable
  // from a query that genuinely has no hits, and the caller reports "nothing
  // found" for something that will work again in a few minutes.
  const suspended = new Map<string, string>();

  for (let p = 0; p < pages && hits.length < limit; p++) {
    const r = await httpGet(root + (p > 0 ? `&pageno=${p + 1}` : ""), { accept: "application/json", acceptLanguage, timeoutMs: QUERY_TIMEOUT_MS });
    if (!r.ok) {
      if (p === 0) notes.push(r.status === 429 || r.status === 503 ? `SearXNG rate-limited (HTTP ${r.status}).` : `SearXNG unreachable (status ${r.status}).`);
      break;
    }
    let data: { results?: unknown[]; unresponsive_engines?: unknown[] };
    try {
      data = JSON.parse(r.body);
    } catch {
      if (p === 0) notes.push("SearXNG returned a non-JSON body — is `format: json` enabled on that instance?");
      break;
    }
    for (const e of data.unresponsive_engines ?? []) {
      const pair = Array.isArray(e) ? e : [];
      if (typeof pair[0] === "string") suspended.set(pair[0], typeof pair[1] === "string" ? pair[1] : "unavailable");
    }
    const before = hits.length;
    for (const raw of data.results ?? []) {
      const it = raw as { url?: unknown; title?: unknown; content?: unknown };
      if (typeof it.url !== "string") continue;
      const key = canonicalizeUrl(it.url);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        url: it.url,
        title: typeof it.title === "string" && it.title.trim() ? it.title.trim() : it.url,
        snippet: typeof it.content === "string" ? it.content.trim() : "",
        via: "searxng",
      });
      if (hits.length >= limit) break;
    }
    if (hits.length === before) break; // a page that added nothing new ends it
    if (p < pages - 1 && pageDelayMs()) await sleep(pageDelayMs());
  }

  if (suspended.size) {
    notes.push(`SearXNG upstreams throttled: ${[...suspended].map(([e, why]) => `${e} (${why})`).join(", ")} — fewer results than usual, not an empty web.`);
  }
  if (!hits.length && !notes.length) notes.push("SearXNG returned no results.");
  return { hits, notes };
}

/**
 * Search the local stack: SearXNG first, Firecrawl as the fallback.
 *
 * SearXNG leads because it is the cheaper of the two and Firecrawl's own
 * keyless `/search` delegates to it anyway — going straight to Firecrawl would
 * pay for a browser stack to reach the same index.
 *
 * Never throws. When nothing is reachable the result is empty hits plus notes
 * saying which piece was missing and how to start it, because "no results" and
 * "no search engine running" are different facts and a caller that cannot tell
 * them apart will report the wrong one.
 */
export async function search(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const q = query.trim();
  if (!q) return { hits: [], notes: ["Empty query."] };

  const viaSearxng = await searchViaSearxng(q, opts);
  if (viaSearxng.hits.length) return viaSearxng;

  // searchViaFirecrawl runs its own probe and reports why it could not, so
  // there is no second copy of that logic here.
  const fc = await searchViaFirecrawl(q, opts.limit ?? 10, opts);
  const hits: SearchHit[] = (fc.hits ?? []).map((h) => ({ url: h.url, title: h.title, snippet: h.description, via: "firecrawl" as const }));
  const notes = [...viaSearxng.notes, ...(fc.why ? [fc.why] : [])];
  if (!hits.length) notes.push(`No results from the local stack. \`${brand().cli} stack up\` starts SearXNG and Firecrawl together.`);
  return { hits, notes };
}
