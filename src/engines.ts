import { env } from "./brand.js";
import { decodeEntities, httpGet, pageDelayMs, sleep } from "./fetch.js";
import { acceptLanguageHeader, baseLang, ddgRegion, resolveRegion } from "./locale.js";
import { canonicalizeUrl } from "./url.js";

// Keyless web engines: the HTML endpoints that answer without a key, a container
// or an account.
//
// What lives here is PROVIDER SHAPE — how DuckDuckGo lays out a result block,
// where Mojeek hides its snippet, which query parameter means "page 2". That
// knowledge rots on somebody else's schedule, so it deserves exactly one
// maintained copy rather than one per tool. The policy built on top (which
// engines to try, how many results to keep, how to phrase a note) stays with the
// caller.
//
// Every parser BLOCK-MATCHES from one result anchor to the next rather than
// zipping two parallel lists by index. The difference matters: when a row is
// skipped — an ad, the engine's own domain — an index-zip silently shifts every
// snippet onto the wrong result, and the output still looks plausible.

/** A keyless engine this module knows how to query. */
export type KeylessEngine = "ddg" | "ddglite" | "mojeek";
export const KEYLESS_ENGINES: KeylessEngine[] = ["ddg", "ddglite", "mojeek"];

export function isKeylessEngine(v: string): v is KeylessEngine {
  return (KEYLESS_ENGINES as string[]).includes(v);
}

/**
 * Which keyless engines the cascade may use: an explicit option wins, then
 * `<PREFIX>_ENGINES` (a comma-separated list, or `off`), then all of them.
 *
 * The env switch matters because these are the only rung that reaches the public
 * internet without being asked to. SearXNG and Firecrawl are localhost by
 * default, so "no stack running" already means "no network"; without
 * `<PREFIX>_ENGINES=off` a caller with no stack — a test suite, an air-gapped
 * run, a sandbox — would start scraping duckduckgo.com the moment it called
 * `search()`. Unknown names are ignored rather than throwing: a typo should cost
 * one engine, not the run.
 */
export function keylessEngines(opts: { engines?: KeylessEngine[] } = {}): KeylessEngine[] {
  if (opts.engines) return opts.engines;
  const raw = env("ENGINES");
  if (raw === undefined) return KEYLESS_ENGINES;
  if (raw.toLowerCase() === "off") return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(isKeylessEngine);
}

export interface EngineHit {
  url: string;
  title: string;
  snippet: string;
}

export interface EngineResult {
  hits: EngineHit[];
  /** Why it returned nothing, in words a caller can show. Never an exception. */
  note?: string;
  /** The engine refused for load reasons — worth trying again later, unlike a 404. */
  throttled?: boolean;
  /**
   * The engine turned the request away as automated traffic.
   *
   * Separate from `throttled` because it answers a different question for the
   * caller. `throttled` says "come back later"; `blocked` says "we learned
   * nothing about the web here" — and a caller that reports zero results
   * WITHOUT knowing this tells its user the web is empty when in fact nobody
   * was asked. Blocked implies throttled: it is worth retrying later too.
   */
  blocked?: boolean;
}

/** Tags out, entities decoded, whitespace collapsed. */
export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The real destination behind a DuckDuckGo redirector link, which rides in the
 * `uddg` query parameter. Without this every DDG result is cited as a
 * duckduckgo.com URL that resolves to the right page but names the wrong source.
 */
export function ddgRedirectTarget(href: string): string {
  const uddg = /[?&]uddg=([^&]+)/.exec(href);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]!);
    } catch {
      /* malformed encoding — fall through to the raw href */
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

/**
 * Why an engine refused, when the refusal is about load rather than the query.
 *
 * "Rate-limited" and "unreachable" are different facts: the first will work
 * again in a few minutes and the second will not, and a caller that reports the
 * wrong one sends its user down the wrong path. Repeated identically across six
 * backends before it lived here.
 */
export function throttleReason(status: number): { throttled: boolean; why: string } {
  if (status === 429 || status === 503) return { throttled: true, why: `rate-limited (HTTP ${status})` };
  // A 403 from a SEARCH engine is a bot policy, not a broken host. Both of these
  // endpoints answer it after a few dozen queries — DuckDuckGo with a stub
  // carrying an anonymised error code, Mojeek in words ("your network appears to
  // be sending automated queries"). Reporting it as unreachable states the wrong
  // fact, and the cascade then drops the note because it only keeps notes from
  // engines it considers throttled.
  if (status === 403) return { throttled: true, why: "blocked this client as automated traffic (HTTP 403)" };
  return { throttled: false, why: `unreachable (status ${status})` };
}

/**
 * Is this body a challenge page rather than a result page?
 *
 * The hard case, and the reason this cannot be done on status alone: BOTH of
 * these engines serve their challenge with a SUCCESS status. Captured
 * 2026-08-21 — DuckDuckGo answers 202 with an `anomaly-modal` ("Unfortunately,
 * bots use DuckDuckGo too"), Mojeek answers 200 with `<title>Captcha</title>`.
 * `res.ok` is true, the parser finds no result blocks, and without this the
 * engine reports "returned no results" — a refusal wearing the clothes of an
 * empty web.
 *
 * Deliberately narrow, and never the first word. It only fires on a body that is
 * BOTH short — a challenge page carries no results, so it is a fraction of a
 * result page — and carrying one of these engines' own challenge markers. And
 * `searchViaKeyless` only consults it once parsing has produced NOTHING, so a
 * page with results can never be called blocked however its markup reads.
 */
export function looksLikeChallenge(body: string): boolean {
  if (body.length > 40_000) return false;
  const head = body.slice(0, 4_000).toLowerCase();
  return (
    /<title>[^<]*captcha/.test(head) ||
    head.includes("anomaly-modal") ||
    head.includes("/anomaly.js") ||
    head.includes("captcha-wrap") ||
    head.includes("sending automated queries")
  );
}

// Shared block-parser: `anchorAttrs` matches the result anchor's attributes,
// `snippetRe` pulls the snippet out of everything between this anchor and the
// next, and `reject` drops the engine's own links.
function parseBlocks(body: string, limit: number, blockRe: RegExp, snippetRe: RegExp, reject: RegExp, resolveHref: (href: string) => string): EngineHit[] {
  const found: EngineHit[] = [];
  let m: RegExpExecArray | null;
  blockRe.lastIndex = 0;
  while ((m = blockRe.exec(body)) && found.length < limit) {
    const href0 = /\bhref="([^"]+)"/.exec(m[1]!);
    if (!href0) continue;
    const href = resolveHref(href0[1]!);
    if (!/^https?:\/\//.test(href) || reject.test(href)) continue;
    const snip = snippetRe.exec(m[3]!);
    snippetRe.lastIndex = 0;
    found.push({ url: href, title: stripTags(m[2]!) || href, snippet: snip ? stripTags(snip[1]!) : "" });
  }
  return found;
}

/** One page of `html.duckduckgo.com/html/`. */
export function parseDdgHtml(body: string, limit = 50): EngineHit[] {
  return parseBlocks(
    body,
    limit,
    /<a\b([^>]*\bresult__a\b[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bresult__a\b|$)/gi,
    /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i,
    /duckduckgo\.com/,
    ddgRedirectTarget,
  );
}

/** One page of `lite.duckduckgo.com/lite/` — a flat table, simpler and steadier. */
export function parseDdgLite(body: string, limit = 50): EngineHit[] {
  return parseBlocks(
    body,
    limit,
    /<a\b([^>]*\bresult-link\b[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bresult-link\b|$)/gi,
    /class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i,
    /duckduckgo\.com/,
    ddgRedirectTarget,
  );
}

/** One page of `mojeek.com/search` — direct hrefs, no redirector. */
export function parseMojeek(body: string, limit = 50): EngineHit[] {
  return parseBlocks(
    body,
    limit,
    /<a\b([^>]*\bclass="[^"]*\btitle\b[^"]*"[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bclass="[^"]*\btitle\b|$)/gi,
    /<p\b[^>]*\bclass="[^"]*\bs\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
    /mojeek\.com/,
    (h) => (h.startsWith("//") ? `https:${h}` : h),
  );
}

interface EngineSpec {
  label: string;
  /** Build the URL for page `p` (0-based). `locale` is undefined when the caller asked for no particular one. */
  url: (query: string, p: number, kl: string, locale?: { lang: string; region: string }) => string;
  parse: (body: string, limit: number) => EngineHit[];
}

/**
 * Mojeek's own way of saying "answer in this language, from this region".
 *
 * The DuckDuckGo family takes one `kl` pair; Mojeek takes four parameters and
 * calls them something else, which is how it came to be the one engine in this
 * module that ignored the locale entirely.
 *
 * PREFERENCES (`lb`/`rb` with their boosts) rather than the restrictions Mojeek
 * also offers (`lr`, `reg`). A preference an endpoint ignores costs nothing; a
 * restriction that lands wrong returns an empty page, which is precisely the
 * shape of failure this file exists to stop reporting as an empty web. The boost
 * weights are the ones Mojeek's own documentation recommends.
 */
function mojeekLocaleParams(locale?: { lang: string; region: string }): string {
  if (!locale) return "";
  return `&lb=${encodeURIComponent(locale.lang)}&lbb=100&rb=${encodeURIComponent(locale.region)}&rbb=10`;
}

const SPECS: Record<KeylessEngine, EngineSpec> = {
  // `s` is a 0-based result offset, ~30 per page.
  ddg: {
    label: "DuckDuckGo",
    url: (q, p, kl) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=${encodeURIComponent(kl)}${p > 0 ? `&s=${p * 30}` : ""}`,
    parse: parseDdgHtml,
  },
  ddglite: {
    label: "DuckDuckGo Lite",
    url: (q, p, kl) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}&kl=${encodeURIComponent(kl)}${p > 0 ? `&s=${p * 30}` : ""}`,
    parse: parseDdgLite,
  },
  // Mojeek's `s` is the 1-BASED index of the first result, 10 per page — so
  // page 2 starts at 11, not 10. Its own crawler and index, which is why it is
  // worth asking at all: it surfaces pages the DDG family does not have.
  mojeek: {
    label: "Mojeek",
    url: (q, p, _kl, locale) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}${p > 0 ? `&s=${p * 10 + 1}` : ""}${mojeekLocaleParams(locale)}`,
    parse: parseMojeek,
  },
};

/**
 * Ask one keyless engine, walking `pages` result pages.
 *
 * Pagination stops as soon as a page adds no NEW canonical URL. An engine that
 * ignores the offset parameter and re-serves page one would otherwise be walked
 * to the requested depth, paying a request per page for the same ten results.
 */
export async function searchViaKeyless(
  engine: KeylessEngine,
  query: string,
  opts: { limit?: number; pages?: number; lang?: string; region?: string; timeoutMs?: number } = {},
): Promise<EngineResult> {
  const spec = SPECS[engine];
  const q = query.trim();
  if (!q) return { hits: [], note: "Empty query." };

  const pages = Math.max(1, opts.pages ?? 1);
  const limit = Math.max(1, opts.limit ?? 10);
  const kl = ddgRegion(opts.lang, opts.region);
  const acceptLanguage = acceptLanguageHeader(opts.lang, opts.region);
  // Only pass a locale on when the caller actually asked for one. `ddgRegion`
  // has a default to fall back on; a search-time preference does not need one,
  // and inventing "us-en" for a caller who said nothing would bias every
  // unlocalised query toward American pages.
  const locale = opts.lang || opts.region ? { lang: baseLang(opts.lang), region: resolveRegion(opts.lang, opts.region).toUpperCase() } : undefined;

  const seen = new Set<string>();
  const hits: EngineHit[] = [];

  for (let p = 0; p < pages && hits.length < limit; p++) {
    const r = await httpGet(spec.url(q, p, kl, locale), { accept: "text/html", acceptLanguage, timeoutMs: opts.timeoutMs ?? 12000 });
    if (!r.ok || !r.body) {
      // A later page failing is not a failure — page one's results stand.
      if (p > 0) break;
      const { throttled, why } = throttleReason(r.status);
      return { hits: [], note: `${spec.label} ${why}.`, throttled, ...(r.status === 403 ? { blocked: true } : {}) };
    }
    const before = hits.length;
    const parsed = spec.parse(r.body, limit * 2);

    // A success status is not the same as an answer: both endpoints serve their
    // anti-bot challenge with a 2xx, so a challenge can only be told from a
    // result page by its body.
    //
    // RESULTS DECIDE, and they decide first. The markers below are read only
    // when nothing parsed, so a page that yielded hits can never be reported as
    // blocked no matter what else its markup contains. That ordering is the
    // whole safety property: the markers are somebody else's HTML and could
    // appear on a working page tomorrow, and calling a page full of results
    // "blocked" would throw away answers we actually got — a worse bug than the
    // one this detects.
    if (parsed.length === 0 && looksLikeChallenge(r.body)) {
      if (p > 0) break;
      return {
        hits: [],
        note: `${spec.label} served an anti-bot challenge (HTTP ${r.status}) instead of results — blocked, not empty.`,
        throttled: true,
        blocked: true,
      };
    }

    for (const f of parsed) {
      const key = canonicalizeUrl(f.url);
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(f);
      if (hits.length >= limit) break;
    }
    if (hits.length === before) break;
    if (p < pages - 1 && pageDelayMs()) await sleep(pageDelayMs());
  }

  return hits.length ? { hits } : { hits: [], note: `${spec.label} returned no results.` };
}
