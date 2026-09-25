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

// Tags that style a run of text without breaking it. The engines wrap every
// matched term in one (<b> on DuckDuckGo, <strong> on Mojeek), often mid-word or
// right before punctuation, so replacing them with a space like any other tag
// turned "azure-dns.<strong>com</strong>" into "azure-dns. com".
const INLINE_TAG = /<\/?(?:a|abbr|b|bdi|bdo|cite|code|em|i|kbd|mark|q|s|samp|small|span|strong|sub|sup|time|u|var|wbr)\b[^<>]*>/gi;

/** Tags out, entities decoded, whitespace collapsed. Inline markup vanishes; a block or `<br>` leaves a space. */
export function stripTags(s: string): string {
  return decodeEntities(s.replace(INLINE_TAG, "").replace(/<[^<>]*>/g, " "))
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

// One attribute of an opening tag, entity-decoded, in any of the three
// spellings HTML allows. DuckDuckGo Lite quotes its classes with SINGLE quotes
// (`class='result-snippet'`), and a double-quote-only pattern read every Lite
// snippet as missing. Decoding matters as much: an href is HTML, so `&amp;` in
// it is a plain `&`, and taken raw a second query parameter becomes `amp;t`.
const attrPattern = (name: string) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'<>=\`]+))`, "i");
const HREF_ATTR = attrPattern("href");
const CLASS_ATTR = attrPattern("class");
const NAME_ATTR = attrPattern("name");
const TYPE_ATTR = attrPattern("type");
const VALUE_ATTR = attrPattern("value");

function attr(attrs: string, re: RegExp): string | undefined {
  const m = re.exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : undefined;
}

// A class TOKEN, not a substring: `\btitle\b` also matched `sub-title`.
function hasClass(attrs: string, cls: string): boolean {
  return (attr(attrs, CLASS_ATTR) ?? "").split(/\s+/).includes(cls);
}

function hostIs(url: string, domain: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

// An opening `<a …>`. The attribute scan stops at the next `<` as well as at
// `>`: allowed to cross a `<`, it ran from EVERY `<a` of a broken body — a
// captive portal, a page of unclosed anchors — to the end of it, which is
// O(n²) (48 KB took 4.8 s). Bounded by the gap to the next tag, one pass over
// the body is linear. None of these engines puts a raw `<` in an attribute.
const OPEN_A = /<a\b([^<>]*)>/gi;

interface BlockShape {
  /** The class that marks a result's title anchor. */
  anchor: string;
  /** The element that carries the snippet, somewhere in the result's block. */
  snippet: { open: RegExp; close: RegExp; cls: string };
  /** The destination behind an href, or undefined when the link is the engine's own. */
  resolve: (href: string) => string | undefined;
}

const element = (tag: string, cls: string) => ({ open: new RegExp(`<${tag}\\b([^<>]*)>`, "gi"), close: new RegExp(`</${tag}\\s*>`, "i"), cls });

// Shared block-parser. One pass finds the result anchors; each result's block
// then runs from its anchor to the next one, and holds its title (up to the
// anchor's `</a>`) and its snippet. Every stretch of the body is read once.
function parseBlocks(body: string, limit: number, shape: BlockShape): EngineHit[] {
  const anchors: { start: number; end: number; attrs: string }[] = [];
  for (const m of body.matchAll(OPEN_A)) {
    if (hasClass(m[1]!, shape.anchor)) anchors.push({ start: m.index!, end: m.index! + m[0].length, attrs: m[1]! });
  }
  const found: EngineHit[] = [];
  for (let i = 0; i < anchors.length && found.length < limit; i++) {
    const a = anchors[i]!;
    const block = body.slice(a.end, anchors[i + 1]?.start ?? body.length);
    const close = /<\/a\s*>/i.exec(block);
    const href = attr(a.attrs, HREF_ATTR);
    if (!close || !href) continue;
    const url = shape.resolve(href);
    if (!url) continue;
    const rest = block.slice(close.index + close[0].length);
    found.push({ url, title: stripTags(block.slice(0, close.index)) || url, snippet: elementText(rest, shape.snippet) });
  }
  return found;
}

// The text of the first element carrying the class, up to its closing tag.
function elementText(html: string, el: BlockShape["snippet"]): string {
  for (const m of html.matchAll(el.open)) {
    if (!hasClass(m[1]!, el.cls)) continue;
    const inner = html.slice(m.index! + m[0].length);
    const end = el.close.exec(inner);
    return end ? stripTags(inner.slice(0, end.index)) : "";
  }
  return "";
}

// Where a DuckDuckGo result points. A destination unwrapped from the `uddg`
// redirector IS the result, whatever its host: a query about DuckDuckGo's
// privacy policy should find duckduckgo.com/privacy, and a Wayback snapshot of
// duckduckgo.com is a snapshot. What still points at duckduckgo.com WITHOUT
// that unwrap is DDG's own — an ad's `y.js` click-through, a navigation link.
// Testing the whole string for "duckduckgo.com" dropped all of these.
function ddgDestination(href: string): string | undefined {
  const url = ddgRedirectTarget(href);
  if (!/^https?:\/\//i.test(url)) return undefined;
  const unwrapped = url !== (href.startsWith("//") ? `https:${href}` : href);
  return unwrapped || !hostIs(url, "duckduckgo.com") ? url : undefined;
}

/** One page of `html.duckduckgo.com/html/`. */
export function parseDdgHtml(body: string, limit = 50): EngineHit[] {
  return parseBlocks(body, limit, { anchor: "result__a", snippet: element("a", "result__snippet"), resolve: ddgDestination });
}

/** One page of `lite.duckduckgo.com/lite/` — a flat table, simpler and steadier. */
export function parseDdgLite(body: string, limit = 50): EngineHit[] {
  return parseBlocks(body, limit, { anchor: "result-link", snippet: element("td", "result-snippet"), resolve: ddgDestination });
}

/** One page of `mojeek.com/search` — direct hrefs, no redirector. */
export function parseMojeek(body: string, limit = 50): EngineHit[] {
  return parseBlocks(body, limit, {
    anchor: "title",
    snippet: element("p", "s"),
    // Mojeek links its results directly, so its own links are the ones on its
    // own host. Its blog, or a page ABOUT Mojeek, is a result like any other.
    resolve: (h) => {
      const url = h.startsWith("//") ? `https:${h}` : h;
      return /^https?:\/\//i.test(url) && !/^https?:\/\/(?:www\.)?mojeek\.com(?:[:/?#]|$)/i.test(url) ? url : undefined;
    },
  });
}

const OPEN_FORM = /<form\b[^<>]*>/gi;
const INPUT = /<input\b([^<>]*)>/gi;

/**
 * The fields DuckDuckGo's own "Next" form would submit, or undefined when the
 * page has none — which is what its last page looks like.
 *
 * DDG pages by a result offset `s`, alongside a `dc` counter and a `vqd`
 * session token, and the only source that knows all three is the page itself.
 * Captured first pages of both endpoints carry 10 results and a form posting
 * `s=10, dc=11`; the fixed "30 a page" this replaced asked for `s=30` and
 * skipped results 11 to 30. A later page also carries a "Previous" form, so the
 * form is chosen by its submit button, not by position.
 */
function ddgNextForm(body: string): Record<string, string> | undefined {
  const forms = [...body.matchAll(OPEN_FORM)];
  for (let i = 0; i < forms.length; i++) {
    const chunk = body.slice(forms[i]!.index! + forms[i]![0].length, forms[i + 1]?.index ?? body.length);
    const end = chunk.search(/<\/form\s*>/i);
    const fields: Record<string, string> = {};
    let next = false;
    for (const m of (end < 0 ? chunk : chunk.slice(0, end)).matchAll(INPUT)) {
      const value = attr(m[1]!, VALUE_ATTR) ?? "";
      if (attr(m[1]!, TYPE_ATTR)?.toLowerCase() === "submit") next ||= /^\s*next\b/i.test(value);
      else {
        const name = attr(m[1]!, NAME_ATTR);
        if (name) fields[name] = value;
      }
    }
    if (next) return fields;
  }
  return undefined;
}

// The next DuckDuckGo page, as the page itself describes it. Sent as a GET: the
// form posts, but the same page links the identical query string as a
// `<a rel="next" href="/lite/?…">`, and httpGet is the polite, capped client.
// Our own query and region win over the form's echo of them.
function ddgNext(endpoint: string): EngineSpec["next"] {
  return (body, q, kl, p) => {
    const form = ddgNextForm(body);
    if (!form) return null;
    // `s` is the field the next page cannot do without. Only a form that lacks
    // it falls back to arithmetic — 10 results a page, as both endpoints serve.
    return `${endpoint}?${new URLSearchParams({ ...form, q, kl, s: form.s || String((p + 1) * 10) })}`;
  };
}

interface EngineSpec {
  label: string;
  /** Build the URL for page `p` (0-based). `locale` is undefined when the caller asked for no particular one. */
  url: (query: string, p: number, kl: string, locale?: { lang: string; region: string }) => string;
  parse: (body: string, limit: number) => EngineHit[];
  /**
   * The URL of the page after page `p`, as that page names it, or null when it
   * names none — the last page. Absent for an engine whose offset arithmetic
   * holds, which then gets `url(p + 1)`.
   */
  next?: (body: string, query: string, kl: string, p: number) => string | null;
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
  const lang = `&lb=${encodeURIComponent(locale.lang)}&lbb=100`;
  // `--region wt` asks for no region, so there is no country to boost.
  return locale.region === "WT" ? lang : `${lang}&rb=${encodeURIComponent(locale.region)}&rbb=10`;
}

const SPECS: Record<KeylessEngine, EngineSpec> = {
  // Page one only: every later page is the one the previous page's own Next
  // form names (see ddgNextForm).
  ddg: {
    label: "DuckDuckGo",
    url: (q, _p, kl) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=${encodeURIComponent(kl)}`,
    parse: parseDdgHtml,
    next: ddgNext("https://html.duckduckgo.com/html/"),
  },
  ddglite: {
    label: "DuckDuckGo Lite",
    url: (q, _p, kl) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}&kl=${encodeURIComponent(kl)}`,
    parse: parseDdgLite,
    next: ddgNext("https://lite.duckduckgo.com/lite/"),
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
 * Pagination stops at a page that names no next page, and as soon as a page
 * adds no NEW canonical URL. An engine that ignores the offset parameter and
 * re-serves page one would otherwise be walked to the requested depth, paying a
 * request per page for the same ten results.
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
  // Only pass a locale on when the caller actually asked for one. `ddgRegion`
  // has a default to fall back on; a search-time preference does not need one,
  // and inventing "us-en" for a caller who said nothing would bias every
  // unlocalised query toward American pages. `wt-wt` is DuckDuckGo's own
  // "All Regions".
  const localised = !!(opts.lang || opts.region);
  const kl = localised ? ddgRegion(opts.lang, opts.region) : "wt-wt";
  const acceptLanguage = acceptLanguageHeader(opts.lang, opts.region);
  const locale = localised ? { lang: baseLang(opts.lang), region: resolveRegion(opts.lang, opts.region).toUpperCase() } : undefined;

  const seen = new Set<string>();
  const hits: EngineHit[] = [];

  let url = spec.url(q, 0, kl, locale);
  for (let p = 0; p < pages && hits.length < limit; p++) {
    const r = await httpGet(url, { accept: "text/html", acceptLanguage, timeoutMs: opts.timeoutMs ?? 12000 });
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
    if (hits.length === before || p + 1 >= pages || hits.length >= limit) break;
    // A page that names no next page was the last one: stopping here is exact,
    // and a request cheaper than waiting for a page that adds nothing new.
    const next = spec.next ? spec.next(r.body, q, kl, p) : spec.url(q, p + 1, kl, locale);
    if (!next) break;
    url = next;
    if (pageDelayMs()) await sleep(pageDelayMs());
  }

  return hits.length ? { hits } : { hits: [], note: `${spec.label} returned no results.` };
}
