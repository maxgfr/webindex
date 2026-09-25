import { brand, env, envName } from "./brand.js";
import { httpGet, pageDelayMs, sleep } from "./fetch.js";
import { firecrawlBase, ProbeMemo, searchViaFirecrawl, type FirecrawlHit } from "./firecrawl.js";
import { acceptLanguageHeader, baseLang } from "./locale.js";
import { canonicalizeUrl } from "./url.js";
import { isKeylessEngine, KEYLESS_ENGINES, keylessEngines, searchViaKeyless, unknownEngines, type EngineResult, type KeylessEngine } from "./engines.js";

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
  /** Country code overriding the one `lang` implies, e.g. "ca"; "wt" asks for no region. */
  region?: string;
  /** Result pages to walk. SearXNG paginates with `&pageno=`. */
  pages?: number;
  /**
   * The whole search's budget in ms, every rung and page included. No rung or
   * page starts after it, and each request's own timeout is capped to what is
   * left, so the worst case is this plus one 2 s availability probe.
   */
  timeoutMs?: number;
  /**
   * Abandons the search: checked before each rung and page. A request already
   * in flight finishes first, within its own timeout.
   */
  signal?: AbortSignal;
  /**
   * Which keyless engines the cascade may fall back to, in order. Defaults to
   * all of them; `[]` disables the keyless rung entirely, leaving the local
   * stack as the only discovery path.
   */
  engines?: KeylessEngine[];
}

/** A rung of the cascade: SearXNG, one keyless engine, or Firecrawl. */
export type SearchRung = "searxng" | "firecrawl" | KeylessEngine;

/**
 * What one rung did. The first two are ANSWERS — the rung read a result page —
 * and only they say anything about the web:
 *
 * - `hits` / `empty`: it answered, with results or with none;
 * - `throttled`: it refused for load, and will work again later;
 * - `blocked`: it turned this client away as automated traffic;
 * - `unreachable`: nothing answered — not running, no connection, timed out;
 * - `error`: something answered, but not with results — an error status, an
 *   empty or unreadable page, a request the backend rejected;
 * - `disabled`: switched off; `not-tried`: the cascade stopped before it.
 */
export type RungOutcome = "hits" | "empty" | "throttled" | "blocked" | "unreachable" | "error" | "disabled" | "not-tried";

export interface RungReport {
  rung: SearchRung;
  outcome: RungOutcome;
  /** How many hits it returned, when it returned any. */
  hits?: number;
  /** Its note, when it had one. */
  note?: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /** What degraded, in words a caller can show a user. Never an exception. */
  notes: string[];
  /**
   * What each rung did, in cascade order: the facts behind `notes`, for a
   * caller that must tell "blocked" from "empty" without reading English.
   */
  rungs?: RungReport[];
  /**
   * True when at least one rung ANSWERED (outcome `hits` or `empty`). False
   * means nothing was searched — every rung was off, refused or failed — and
   * an empty `hits` is then no finding about the web.
   */
  searched?: boolean;
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

const probeCache = new ProbeMemo();

/** Test seam: forget memoised probe verdicts. */
export function resetSearxngProbeCache(): void {
  probeCache.clear();
}

/**
 * Is a SearXNG instance answering at `base`? A single `GET {base}/healthz` with
 * a hard 2s ceiling.
 *
 * What counts as an answer depends on who chose the base, as for Firecrawl's
 * probe. On the localhost DEFAULT it must be SearXNG's own `OK`: 8888 is also
 * Jupyter's default port, and taking a notebook server for SearXNG made doctor
 * report it "answering" and every search blame SearXNG's JSON setting. A base
 * the caller NAMED is a statement about what lives there, so ANY HTTP response
 * counts — a proxy in front of it may not route /healthz.
 *
 * Memoised per base: "up" for the process, "down" for 30 s, so an absent
 * instance costs one refused connection per burst of calls while a long-lived
 * MCP server still finds one started later.
 *
 * Deliberately bypasses httpGet, whose retry-with-backoff would turn a 2s
 * ceiling into roughly 4.6s on a blackholed host. A probe wants a single shot.
 */
export function probeSearxng(base: string, explicit = false): Promise<boolean> {
  return probeCache.get(`${base}|${explicit}`, async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/healthz`, { signal: ctrl.signal });
      const body = await res.text().catch(() => ""); // drain so the socket is released
      return explicit || (res.ok && /^\s*ok\s*$/i.test(body));
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  });
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
  if (!base) return rungResult("searxng", "disabled", [], [`SearXNG disabled (--searxng off / ${envName("SEARXNG")}=off).`]);

  if (!(await probeSearxng(base, searxngIsExplicit(opts)))) {
    return rungResult(
      "searxng",
      "unreachable",
      [],
      [
        searxngIsExplicit(opts)
          ? `SearXNG not reachable at ${base}.`
          : `SearXNG not running at ${base} — start it with \`${brand().cli} searxng up\` for local, keyless discovery.`,
      ],
    );
  }

  const pages = Math.max(1, opts.pages ?? 1);
  const limit = Math.max(1, opts.limit ?? 10);
  const acceptLanguage = acceptLanguageHeader(opts.lang, opts.region);
  const language = searxngLanguage(opts);
  const root = `${base}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1` + (language ? `&language=${encodeURIComponent(language)}` : "");

  const notes: string[] = [];
  const seen = new Set<string>();
  const hits: SearchHit[] = [];

  // SearXNG answers 200 with an EMPTY result list when its own upstreams have
  // throttled it, reporting them in `unresponsive_engines` rather than failing.
  // Without reading that field a rate-limited instance is indistinguishable
  // from a query that genuinely has no hits, and the caller reports "nothing
  // found" for something that will work again in a few minutes.
  const suspended = new Map<string, string>();
  // Why page one produced no result list. A later page failing is not a
  // failure: the pages before it stand.
  let failed: RungOutcome | undefined;

  const deadline = budgetDeadline(opts);
  for (let p = 0; p < pages && hits.length < limit; p++) {
    if (p > 0 && halted(opts, deadline)) break;
    const r = await httpGet(root + (p > 0 ? `&pageno=${p + 1}` : ""), {
      accept: "application/json",
      acceptLanguage,
      timeoutMs: Math.max(1, Math.min(QUERY_TIMEOUT_MS, deadline - Date.now())),
      // No retry: the cascade's next rung is the retry.
      retries: 0,
    });
    if (!r.ok) {
      if (p === 0) {
        failed = r.status === 429 || r.status === 503 ? "throttled" : r.status === 0 ? "unreachable" : "error";
        notes.push(
          failed === "throttled"
            ? `SearXNG rate-limited (HTTP ${r.status}).`
            : failed === "unreachable"
              ? `SearXNG unreachable (${r.error || "no response"}).`
              : // SearXNG answers a format it does not serve with flask.abort(403),
                // and the probe has just shown the instance is up: this is the
                // most common misconfiguration, not an outage.
                r.status === 403
                ? "SearXNG refused format=json (HTTP 403) — add `json` to `search.formats` in its settings.yml."
                : `SearXNG failed the query (HTTP ${r.status}).`,
        );
      }
      break;
    }
    let data: { results?: unknown[]; unresponsive_engines?: unknown[] };
    try {
      data = JSON.parse(r.body);
    } catch {
      if (p === 0) {
        failed = "error";
        notes.push("SearXNG returned a non-JSON body — is `format: json` enabled on that instance?");
      }
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
  // An empty list from throttled upstreams is a refusal, not an answer.
  const outcome: RungOutcome = hits.length ? "hits" : (failed ?? (suspended.size ? "throttled" : "empty"));
  return rungResult("searxng", outcome, hits, notes);
}

// SearXNG's `language`: the only locale knob it has, so an explicit region
// rides on it ("fr" + "ca" → "fr-CA"; `wt` names no country). A region alone
// does not pick a language for the caller.
function searxngLanguage(opts: SearchOptions): string | undefined {
  if (!opts.lang) return undefined;
  const region = opts.region?.trim().toLowerCase();
  if (!region) return opts.lang;
  return region === "wt" ? baseLang(opts.lang) : `${baseLang(opts.lang)}-${region.toUpperCase()}`;
}

// When the caller's overall budget runs out, as a Date.now() instant.
function budgetDeadline(opts: SearchOptions): number {
  return opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? Date.now() + opts.timeoutMs : Number.POSITIVE_INFINITY;
}

// Why no further rung or page may start, if none may. Checked between them
// because a request in flight cannot be recalled — httpGet takes no signal —
// so the budget ALSO caps each request's own timeout.
function halted(opts: SearchOptions, deadline: number): string | undefined {
  if (opts.signal?.aborted) return "the search was cancelled";
  return Date.now() >= deadline ? `the ${opts.timeoutMs} ms budget ran out` : undefined;
}

// A one-rung SearchResult: the hits and notes, plus the report that says the same in data.
function rungResult(rung: SearchRung, outcome: RungOutcome, hits: SearchHit[], notes: string[]): SearchResult {
  return { hits, notes, rungs: [report(rung, outcome, hits.length, notes.join(" "))], searched: answered(outcome) };
}

function report(rung: SearchRung, outcome: RungOutcome, hits = 0, note?: string): RungReport {
  return { rung, outcome, ...(hits ? { hits } : {}), ...(note ? { note } : {}) };
}

const answered = (outcome: RungOutcome) => outcome === "hits" || outcome === "empty";

// What a keyless engine's result says in the cascade's vocabulary.
function keylessOutcome(r: EngineResult): RungOutcome {
  if (r.hits.length) return "hits";
  if (r.answered) return "empty";
  if (r.blocked) return "blocked";
  if (r.throttled) return "throttled";
  return r.status ? "error" : "unreachable";
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

  const deadline = budgetDeadline(opts);
  // What each rung may still spend: undefined when the caller set no budget.
  const left = () => (deadline === Number.POSITIVE_INFINITY ? undefined : Math.max(1, deadline - Date.now()));
  const keyless = keylessEngines(opts);
  const order: SearchRung[] = ["searxng", ...keyless, "firecrawl"];
  // A rung the cascade never reached, reported as such: a caller reading
  // `rungs` sees where it ended, not just what the winner said.
  const untried = (rung: SearchRung): RungReport =>
    report(rung, (rung === "searxng" && !searxngBase(opts)) || (rung === "firecrawl" && !firecrawlBase(opts)) ? "disabled" : "not-tried");

  const notes: string[] = [];
  const rungs: RungReport[] = [];
  let hits: SearchHit[] = [];
  for (let i = 0; i < order.length; i++) {
    const rung = order[i]!;
    if (hits.length) {
      rungs.push(untried(rung));
      continue;
    }
    const stop = halted(opts, deadline);
    if (stop) {
      const rest = order.slice(i).map(untried);
      const skipped = rest.filter((r) => r.outcome === "not-tried").map((r) => r.rung);
      if (skipped.length) notes.push(`Stopped before ${skipped.join(", ")}: ${stop}.`);
      rungs.push(...rest);
      break;
    }

    if (rung === "searxng") {
      const r = await searchViaSearxng(q, { ...opts, timeoutMs: left() });
      hits = r.hits;
      notes.push(...r.notes);
      rungs.push(...(r.rungs ?? []));
      // The keyless rung. Each engine is tried in turn and the FIRST one with
      // hits wins — this is a fallback chain, not a fan-out: pooling several
      // engines and fusing them is a ranking decision, and ranking belongs to
      // the caller.
      const unknown = unknownEngines(opts);
      if (unknown.length) {
        notes.push(`${envName("ENGINES")} names no engine this knows: ${unknown.join(", ")} (expected ${KEYLESS_ENGINES.join(", ")}) — ignored.`);
      }
    } else if (rung === "firecrawl") {
      // searchViaFirecrawl runs its own probe and reports why it could not, so
      // there is no second copy of that logic here.
      const fc = await searchViaFirecrawl(q, limitOf(opts), { firecrawl: opts.firecrawl, lang: opts.lang, region: opts.region, budgetMs: left() });
      hits = firecrawlHits(fc.hits ?? [], limitOf(opts));
      if (fc.why) notes.push(fc.why);
      rungs.push(report("firecrawl", firecrawlOutcome(fc), hits.length, fc.why));
    } else {
      const r = await searchViaKeyless(rung, q, {
        limit: opts.limit,
        pages: opts.pages,
        lang: opts.lang,
        region: opts.region,
        budgetMs: left(),
        signal: opts.signal,
      });
      hits = r.hits.map((h) => ({ ...h, via: rung }));
      rungs.push(report(rung, keylessOutcome(r), r.hits.length, r.note));
      // Every failure is worth reporting; only "returned no results" is not.
      // That one repeated by every engine in turn would bury the note that
      // matters under three that say the same thing.
      if (!r.answered && r.note) notes.push(r.note);
    }
  }
  if (!hits.length) notes.push(closingNote(rungs));
  return { hits, notes, rungs, searched: rungs.some((r) => answered(r.outcome)) };
}

const limitOf = (opts: SearchOptions) => Math.max(1, opts.limit ?? 10);

// Firecrawl's hits, held to the rules every other rung keeps: canonical dedupe,
// then the limit.
function firecrawlHits(found: FirecrawlHit[], limit: number): SearchHit[] {
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const h of found) {
    const key = canonicalizeUrl(h.url);
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ url: h.url, title: h.title, snippet: h.description, via: "firecrawl" });
    if (hits.length >= limit) break;
  }
  return hits;
}
function firecrawlOutcome(fc: { hits?: unknown[]; status?: number }): RungOutcome {
  if (fc.hits) return fc.hits.length ? "hits" : "empty";
  if (fc.status === undefined) return "disabled";
  if (fc.status === 0) return "unreachable";
  return fc.status === 429 || fc.status === 503 ? "throttled" : "error";
}

/**
 * The sentence a caller shows its user when the cascade found nothing, so it
 * must not say something the run did not establish. Three different facts:
 * nothing was switched on; nothing ANSWERED (offline, blocked, throttled, a
 * 5xx — nothing was learned about the web, and reporting that as "no results"
 * converts a refusal into a finding about the world); or something answered
 * and found nothing.
 */
function closingNote(rungs: RungReport[]): string {
  const cli = brand().cli;
  if (rungs.every((r) => r.outcome === "disabled")) {
    return `No search backend was enabled — SearXNG and Firecrawl are off and no keyless engine is selected, so nothing was searched. Set ${envName("ENGINES")} to a list of ${KEYLESS_ENGINES.join(", ")}, or run \`${cli} stack up\`.`;
  }
  if (rungs.some((r) => answered(r.outcome))) return `No results from any engine. \`${cli} stack up\` starts SearXNG and Firecrawl locally.`;
  const keyless = rungs.filter((r) => isKeylessEngine(r.rung));
  if (keyless.length && keyless.every((r) => r.outcome === "blocked")) {
    return `Every keyless engine blocked this client (${keyless.map((r) => r.rung).join(", ")}) — nothing was searched, which is not the same as nothing being there. Try again later, or run \`${cli} stack up\` for a local SearXNG.`;
  }
  return `No engine answered (${rungs
    .filter((r) => r.outcome !== "disabled")
    .map((r) => `${r.rung} ${r.outcome}`)
    .join(", ")}) — nothing was searched, which is not the same as nothing being there. Try again later, or run \`${cli} stack up\` for a local SearXNG.`;
}
