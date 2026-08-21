import { brand, env, envName } from "./brand.js";
import { httpGet, pageDelayMs, sleep } from "./fetch.js";
import { searchViaFirecrawl } from "./firecrawl.js";
import { acceptLanguageHeader } from "./locale.js";
import { canonicalizeUrl } from "./url.js";
import { keylessEngines, searchViaKeyless, type KeylessEngine } from "./engines.js";

// Discovery: turning a question into candidate URLs.
//
// The engine already manages the SearXNG and Firecrawl containers, so it should
// be able to ask them something. Before this it could start a search engine and
// not query it.
//
// Deliberately NOT the shape a full research pipeline wants. This is a CASCADE
// — local stack, then the keyless engines, then Firecrawl, first rung with hits
// wins — and not a fan-out: querying five engines at once and fusing the pools
// is a ranking decision, and the caller owns ranking (./rank.js has the parts).
// There is still no backend registry and no scholarly-API layer here.

/** The docker stack publishes SearXNG here. */
export const SEARXNG_DEFAULT_BASE = "http://localhost:8888";

const PROBE_TIMEOUT_MS = 2000;
const QUERY_TIMEOUT_MS = 8000;

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  /** Which engine produced it. */
  via: "searxng" | "firecrawl" | KeylessEngine;
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
  /**
   * Which keyless engines the cascade may fall back to, in order. Defaults to
   * all of them; `[]` disables the keyless rung entirely, leaving the local
   * stack as the only discovery path.
   */
  engines?: KeylessEngine[];
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
 * Search: the local stack first, then the keyless engines, then Firecrawl.
 *
 * SearXNG leads because it is the cheapest and aggregates many upstreams at
 * once. The keyless engines come next because they need nothing installed at
 * all — an install with no Docker still discovers pages, which is the whole
 * reason they are here. Mojeek is in that group deliberately: it runs its own
 * crawler rather than reselling somebody else's index, so it answers when the
 * DuckDuckGo family has nothing.
 *
 * Firecrawl is last, not first: its own keyless `/search` delegates to SearXNG
 * anyway, so reaching for it early pays for a browser stack to arrive at the
 * same index.
 *
 * Never throws. When nothing answers, the result is empty hits plus notes saying
 * which piece was missing and how to start it — "no results" and "no search
 * engine running" are different facts, and a caller that cannot tell them apart
 * reports the wrong one.
 */
export async function search(query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const q = query.trim();
  if (!q) return { hits: [], notes: ["Empty query."] };

  const viaSearxng = await searchViaSearxng(q, opts);
  if (viaSearxng.hits.length) return viaSearxng;

  const notes = [...viaSearxng.notes];

  // The keyless rung. Each engine is tried in turn and the FIRST one with hits
  // wins — this is a fallback chain, not a fan-out: pooling several engines and
  // fusing them is a ranking decision, and ranking belongs to the caller.
  const keyless = keylessEngines(opts);
  let asked = 0;
  let blocked = 0;
  for (const engine of keyless) {
    const r = await searchViaKeyless(engine, q, { limit: opts.limit, pages: opts.pages, lang: opts.lang, region: opts.region });
    if (r.hits.length) {
      return { hits: r.hits.map((h) => ({ ...h, via: engine })), notes };
    }
    asked++;
    if (r.blocked) blocked++;
    // Only a throttle is worth reporting. "Returned no results" from every
    // engine in turn would bury the one note that matters under three that say
    // the same thing.
    if (r.throttled && r.note) notes.push(r.note);
  }

  // searchViaFirecrawl runs its own probe and reports why it could not, so
  // there is no second copy of that logic here.
  const fc = await searchViaFirecrawl(q, opts.limit ?? 10, opts);
  const hits: SearchHit[] = (fc.hits ?? []).map((h) => ({ url: h.url, title: h.title, snippet: h.description, via: "firecrawl" as const }));
  if (fc.why) notes.push(fc.why);
  if (!hits.length) {
    // The closing note is the sentence a caller shows its user, so it must not
    // say something the run did not establish. When every keyless engine turned
    // us away, NOTHING was learned about the web for this query — reporting that
    // as "no results" converts a refusal into a finding about the world, and the
    // caller has no way to tell the two apart afterwards.
    notes.push(
      asked > 0 && blocked === asked
        ? `Every keyless engine blocked this client (${keyless.join(", ")}) — nothing was searched, which is not the same as nothing being there. Try again later, or run \`${brand().cli} stack up\` for a local SearXNG.`
        : `No results from any engine. \`${brand().cli} stack up\` starts SearXNG and Firecrawl locally.`,
    );
  }
  return { hits, notes };
}
