import { brand, countFetch, env, envFlag, envInt } from "./brand.js";
import { decodeBody } from "./charset.js";
// `nearestHeading` moved to text.ts — it is a fact about markdown, not about
// HTTP — and is still exported from the package root, so no consumer sees it move.
import { buildMatcher, nearestHeading } from "./text.js";
import { extractPdf } from "./pdf.js";
import { extractDocument, docFormatForUrl, docFormatForContentType } from "./doc.js";
// Cyclic by design: firecrawl.ts is a CLIENT of this HTTP layer, and this layer
// is where the extraction seam lives. Safe because neither module calls into the
// other at module-evaluation time — only from inside function bodies.
import { scrapeViaFirecrawl } from "./firecrawl.js";

// ── Tunables ────────────────────────────────────────────────────────────────
//
// All of these were module-load constants before the extraction, which was
// safe only while the env prefix was a compile-time literal. In a vendored
// engine it is not: this module is imported before the consumer can call
// configure(), so a `const X = envInt("UA", …)` would freeze webindex's own
// default prefix and never see the consumer's at all.
//
// Hence functions. See the lazy rule in brand.ts — this is the concrete case
// it exists for. The cost is a call per use; the alternative is silently
// ignoring every tunable a user sets.

const DEFAULT_BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * A realistic desktop-browser User-Agent. Several keyless web endpoints (DDG,
 * Mojeek) serve 403 or empty to obvious bot UAs, so scrapers default to this.
 * Override with `<PREFIX>_UA`.
 */
export function browserUa(): string {
  return env("UA") || DEFAULT_BROWSER_UA;
}

/**
 * The polite, identifying User-Agent for well-behaved JSON/XML APIs (arXiv,
 * Crossref, OpenAlex, Europe PMC). Naming ourselves is what lets them
 * attribute and throttle us courteously instead of blocking outright — so it
 * names the consuming tool, not the shared engine underneath.
 */
export function contactUa(): string {
  const b = brand();
  return `${b.name}/${b.version ?? "1.x"} (+${b.contactUrl ?? `https://github.com/maxgfr/${b.name}`})`;
}

/**
 * The User-Agent an unlabelled request carries, per the brand's declared policy.
 *
 * Two defensible policies, and the choice belongs to the consuming tool rather
 * than to this layer. `browser` (the default) optimises for getting the page:
 * several keyless endpoints serve 403 or empty to anything that admits to being
 * a script. `contact` optimises for being a good citizen — it names the tool and
 * where to complain about it — and pays for that with the occasional refusal,
 * which `fetchAndExtract` answers by retrying once as a browser.
 */
export function defaultUa(): string {
  return brand().defaultUa === "contact" ? contactUa() : browserUa();
}

// Transient statuses worth one retry; a single throttled call would otherwise
// silently zero out a whole high-signal backend (Stack Overflow, GitHub, S2).
const RETRY_STATUS = new Set([429, 503, 502, 504]);

// Retry policy, tunable via env (keyless, no new CLI surface): attempts and the
// fixed backoff, clamped to sane bounds.
const maxAttempts = () => envInt("MAX_ATTEMPTS", 2, 1, 5);
const defaultRetryMs = () => envInt("RETRY_MS", 600, 0, 5000);

/**
 * Polite pause between successive result-page fetches to the same web engine
 * (multi-page pagination). Keyless engines block aggressive scraping, so pages
 * are fetched sequentially with a small gap. Tunable; 0 disables.
 */
export function pageDelayMs(): number {
  return envInt("PAGE_DELAY_MS", 350, 0, 5000);
}

/**
 * Polite pause between a rate-limited scholarly API's per-variant calls
 * (Crossref/OpenAlex/arXiv/Europe PMC), which the registry serialises rather
 * than firing concurrently to avoid tripping their anonymous quotas. Tunable;
 * 0 disables (tests set it to 0 to stay fast).
 */
export function politeDelayMs(): number {
  return envInt("POLITE_DELAY_MS", 400, 0, 5000);
}

export interface HttpResult {
  ok: boolean;
  status: number;
  body: string;
  contentType: string;
  url: string; // final URL after redirects (for post-redirect exclude re-check)
  bytes?: Buffer; // raw body, only when opts.binary (for PDF extraction)
  error?: string;
  /** Cache validators, kept so a stale entry can be revalidated for free. */
  etag?: string;
  lastModified?: string;
  /** True on an explicit 429, or a 403 that carries an exhausted quota header. */
  rateLimited?: boolean;
  /** Retry-After, parsed and capped, when the server sent one. */
  retryAfterMs?: number;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * A rate-limit signal: an explicit 429, or a 403 whose remaining-quota header is
 * zero — which is how GitHub's unauthenticated APIs report throttling. Worth
 * separating from a plain 403, because one is "come back later" and the other is
 * "you may never read this", and a caller that retries the second burns the
 * quota it is waiting on.
 */
export function detectRateLimited(status: number, headers: Headers): boolean {
  if (status === 429) return true;
  return status === 403 && headers.get("x-ratelimit-remaining") === "0";
}

/**
 * Parse `Retry-After` — delta-seconds or an HTTP-date — into a millisecond
 * delay, clamped to `capMs`. Returns undefined when the header is absent or
 * unparseable, so a caller can tell "no hint" from "wait zero".
 */
export function parseRetryAfter(headers: Headers, capMs = 5000): number | undefined {
  const h = headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.min(Math.max(0, secs) * 1000, capMs);
  const when = Date.parse(h);
  if (Number.isFinite(when)) return Math.min(Math.max(0, when - Date.now()), capMs);
  return undefined;
}

// How long to wait before a retry: honor Retry-After (seconds or HTTP-date)
// clamped to 5s, else a small fixed backoff.
function retryDelayMs(headers: Headers): number {
  return parseRetryAfter(headers) ?? defaultRetryMs();
}

// Total attempts for a call: the caller's `retries` (extra tries on top of the
// first) when given, otherwise the env-wide policy. Clamped, because a typo in a
// retry count should cost one extra request, not a hundred.
function attemptsFor(retries: number | undefined): number {
  return retries === undefined ? maxAttempts() : Math.min(4, Math.max(0, Math.trunc(retries))) + 1;
}

/**
 * Read a Response body, keeping at most `max` bytes and cancelling the transfer
 * the moment the cap is crossed.
 *
 * This exists because `await res.arrayBuffer()` then `.subarray(0, max)` — what
 * this module used to do — caps the VALUE and not the DOWNLOAD: a 2 GB response
 * was fully allocated before being trimmed to 4 MB. A cap that only applies
 * after the bytes are already in memory is not a cap.
 *
 * Falls back to a one-shot read where no readable stream is exposed.
 */
export async function readCapped(res: Response, max: number): Promise<string> {
  return (await readCappedBytes(res, max)).toString("utf8");
}

/** Same streaming cap as `readCapped`, returning the raw bytes. */
export async function readCappedBytes(res: Response, max: number): Promise<Buffer> {
  const reader = res.body?.getReader?.();
  if (!reader) return Buffer.from(await res.arrayBuffer()).subarray(0, max);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const remaining = max - total;
    if (chunk.length >= remaining) {
      chunks.push(chunk.subarray(0, remaining));
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(chunk);
    total += chunk.length;
  }
  return Buffer.concat(chunks);
}

// Minimal HTTP GET on Node's built-in fetch (Node ≥18) — no dependencies.
// Times out, sends a UA, caps the body, never throws (errors come back as
// { ok:false }), and retries ONCE on a transient status or network error.
export async function httpGet(
  url: string,
  opts: {
    timeoutMs?: number;
    accept?: string;
    acceptLanguage?: string;
    maxBytes?: number;
    userAgent?: string;
    binary?: boolean;
    /** Extra request headers, lower-cased. The escape hatch for conditional GET
     *  (`if-none-match`, `if-modified-since`) and for an API that wants auth. */
    headers?: Record<string, string>;
    /** Extra attempts on a transient failure, overriding `<PREFIX>_MAX_ATTEMPTS`.
     *  Per-call because the right number is per-endpoint: a probe wants 0, a
     *  paper download off a flaky mirror wants 2. */
    retries?: number;
  } = {},
): Promise<HttpResult> {
  const attempts = attemptsFor(opts.retries);
  let last: HttpResult = { ok: false, status: 0, body: "", contentType: "", url };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
    try {
      const headers: Record<string, string> = { "user-agent": opts.userAgent ?? defaultUa(), accept: opts.accept ?? "*/*" };
      if (opts.acceptLanguage) headers["accept-language"] = opts.acceptLanguage;
      for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers,
      });
      const max = opts.maxBytes ?? 4 * 1024 * 1024;
      const meta = {
        contentType: res.headers.get("content-type") ?? "",
        url: res.url || url,
        etag: res.headers.get("etag") ?? undefined,
        lastModified: res.headers.get("last-modified") ?? undefined,
        rateLimited: detectRateLimited(res.status, res.headers),
        retryAfterMs: parseRetryAfter(res.headers),
      };

      // Refuse a body the server has already declared too big, before a single
      // byte of it is read. Not retried: the size will be the same next time.
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > max) {
        ctrl.abort();
        return { ok: false, status: res.status, body: "", ...meta, error: `response too large: ${declared} bytes > ${max} cap` };
      }

      // 304 carries no body by definition — reading it is not an error, and the
      // caller (the cache) wants the status, not an empty-body complaint.
      const bytes = res.status === 304 ? Buffer.alloc(0) : await readCappedBytes(res, max);
      countFetch(bytes.length, false);
      const result: HttpResult = {
        ok: res.ok,
        status: res.status,
        // Decoded per the response's own encoding, not assumed UTF-8. A
        // Windows-1252 page used to come back with every accented character
        // replaced by U+FFFD, and nothing anywhere noticed.
        body: opts.binary ? "" : decodeBody(bytes, meta.contentType),
        bytes: opts.binary ? bytes : undefined,
        ...meta,
      };
      if (RETRY_STATUS.has(res.status) && attempt < attempts - 1) {
        last = result;
        await sleep(retryDelayMs(res.headers));
        continue;
      }
      return result;
    } catch (e) {
      last = { ok: false, status: 0, body: "", contentType: "", url, error: (e as Error).message };
      if (attempt < attempts - 1) await sleep(defaultRetryMs());
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}

// JSON request helper for the keyless search APIs. Returns parsed JSON or an
// error; never throws; retries once on a transient status / network error.
// `opts.headers` adds/overrides request headers (lower-cased) — the escape hatch
// for an endpoint that needs one this signature doesn't model, e.g. the optional
// `Authorization: Bearer` a Firecrawl Cloud base would want.
export async function httpJson(
  method: string,
  url: string,
  body?: unknown,
  opts: { timeoutMs?: number; accept?: string; acceptLanguage?: string; userAgent?: string; headers?: Record<string, string>; retries?: number } = {},
): Promise<{ ok: boolean; status: number; data: any; error?: string }> {
  const attempts = attemptsFor(opts.retries);
  let last: { ok: boolean; status: number; data: any; error?: string } = { ok: false, status: 0, data: undefined };
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: opts.accept ?? "application/json",
        "user-agent": opts.userAgent ?? defaultUa(),
      };
      if (opts.acceptLanguage) headers["accept-language"] = opts.acceptLanguage;
      for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
      const res = await fetch(url, {
        method,
        signal: ctrl.signal,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      countFetch(Buffer.byteLength(text), false);
      let data: any;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = text;
      }
      const result = { ok: res.ok, status: res.status, data };
      if (RETRY_STATUS.has(res.status) && attempt < attempts - 1) {
        last = result;
        await sleep(retryDelayMs(res.headers));
        continue;
      }
      return result;
    } catch (e) {
      last = { ok: false, status: 0, data: undefined, error: (e as Error).message };
      if (attempt < attempts - 1) await sleep(defaultRetryMs());
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&copy;": "©",
  // Typographic punctuation CMSes emit as named refs (WordPress "smart" text) —
  // otherwise a curly quote/apostrophe leaks into the report prose verbatim.
  "&lsquo;": "‘",
  "&rsquo;": "’",
  "&sbquo;": "‚",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&bdquo;": "„",
  "&bull;": "•",
  "&middot;": "·",
  "&laquo;": "«",
  "&raquo;": "»",
  "&deg;": "°",
  "&plusmn;": "±",
  "&times;": "×",
  "&divide;": "÷",
  "&frac12;": "½",
  "&frac14;": "¼",
  "&frac34;": "¾",
  "&sup2;": "²",
  "&sup3;": "³",
  "&micro;": "µ",
  "&trade;": "™",
  "&reg;": "®",
  "&sect;": "§",
  "&para;": "¶",
  "&dagger;": "†",
  "&Dagger;": "‡",
  "&prime;": "′",
  "&Prime;": "″",
  "&iexcl;": "¡",
  "&iquest;": "¿",
  "&cent;": "¢",
  "&pound;": "£",
  "&curren;": "¤",
  "&yen;": "¥",
  "&euro;": "€",
  // Latin-1 accented letters — pervasive in non-English titles/snippets.
  "&agrave;": "à",
  "&aacute;": "á",
  "&acirc;": "â",
  "&atilde;": "ã",
  "&auml;": "ä",
  "&aring;": "å",
  "&aelig;": "æ",
  "&ccedil;": "ç",
  "&egrave;": "è",
  "&eacute;": "é",
  "&ecirc;": "ê",
  "&euml;": "ë",
  "&igrave;": "ì",
  "&iacute;": "í",
  "&icirc;": "î",
  "&iuml;": "ï",
  "&ntilde;": "ñ",
  "&ograve;": "ò",
  "&oacute;": "ó",
  "&ocirc;": "ô",
  "&otilde;": "õ",
  "&ouml;": "ö",
  "&oslash;": "ø",
  "&ugrave;": "ù",
  "&uacute;": "ú",
  "&ucirc;": "û",
  "&uuml;": "ü",
  "&yacute;": "ý",
  "&yuml;": "ÿ",
  "&szlig;": "ß",
  "&Agrave;": "À",
  "&Aacute;": "Á",
  "&Acirc;": "Â",
  "&Auml;": "Ä",
  "&Aring;": "Å",
  "&AElig;": "Æ",
  "&Ccedil;": "Ç",
  "&Egrave;": "È",
  "&Eacute;": "É",
  "&Ecirc;": "Ê",
  "&Euml;": "Ë",
  "&Iacute;": "Í",
  "&Ntilde;": "Ñ",
  "&Oacute;": "Ó",
  "&Ouml;": "Ö",
  "&Oslash;": "Ø",
  "&Uacute;": "Ú",
  "&Uuml;": "Ü",
};

// The table above, keyed by bare name, for the single-pass decoder below.
const ENTITY_BY_NAME = new Map(Object.entries(ENTITIES).map(([k, v]) => [k.slice(1, -1), v]));
const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * Decode the common named entities plus decimal/hex numeric references, in ONE
 * non-rescanning pass.
 *
 * The pass count is the whole design. Decoding numeric refs and then walking the
 * named table with split/join re-reads its own output, so `&amp;lt;` — which is
 * how a document writes the literal text "&lt;" — becomes "&lt;" and then "<".
 * The page said one thing and the extract says another, which for a page
 * documenting markup is most of its content. One pass cannot do that: each
 * reference is replaced exactly once, from the original text.
 *
 * Names are matched case-SENSITIVELY, because case is meaningful here: `&dagger;`
 * is † and `&Dagger;` is ‡. An unknown name is left exactly as written rather
 * than guessed at or blanked.
 */
export function decodeEntities(s: string): string {
  return s.replace(ENTITY_RE, (m, ref: string) => {
    if (ref[0] === "#") {
      const n = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      try {
        return Number.isFinite(n) ? String.fromCodePoint(n) : " ";
      } catch {
        return " "; // out of range — a space beats throwing on one bad codepoint
      }
    }
    return ENTITY_BY_NAME.get(ref) ?? m;
  });
}

// Clean a backend-provided inline field (a title or one-line snippet) that may
// carry escaped or literal markup: decode entities FIRST (so escaped tags like
// `&lt;i&gt;` become real tags), THEN strip the tags, then collapse whitespace.
// Decode-then-strip handles both `R&amp;D` → `R&D` and `&lt;i&gt;P53&lt;/i&gt;`
// → `P53` (and literal `<i>P53</i>` → `P53`).
export function cleanInline(s: string): string {
  return decodeEntities(String(s))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Extract readable text from an HTML page. Zero-dep and intentionally simple:
// drop script/style/head/nav/footer, turn block tags into newlines, keep
// heading structure as markdown markers, decode common entities, collapse
// whitespace. Good enough to ground a report in a page's prose without a DOM.
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<(script|style|noscript|head|nav|footer|svg|template)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<h([1-6])(?:\s[^>]*)?>/gi, (_m, n) => "\n" + "#".repeat(Number(n)) + " ");
  s = s.replace(/<\/(p|div|section|article|li|tr|td|th|ul|ol|h[1-6]|pre|blockquote|br)>/gi, "\n");
  // Break on OPENING block tags too, not only closing ones. Unclosed `<li>` and
  // `<td>` are valid HTML and extremely common, and with closing tags alone a
  // whole list or table row collapses onto one line — which then reads as a
  // single sentence to anything scoring lines against a question. Headings are
  // excluded because the rule above already turned them into markdown markers;
  // matching them here as well would double every one of them.
  s = s.replace(/<(p|div|section|article|li|tr|td|th|ul|ol|pre|blockquote|table)\b[^>]*>/gi, "\n");
  s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

// Best-effort page title from an HTML document.
export function htmlTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return undefined;
  const t = decodeEntities(m[1]!.replace(/\s+/g, " ").trim());
  return t || undefined;
}

// The URL a page declares for ITSELF — `<link rel="canonical">`, else the
// OpenGraph `og:url`. Only meaningful when the URL we fetched is not itself
// citable (an API endpoint, a redirector): the page names its own address, so
// we don't have to guess one. Extraction strips <head>, hence reading it here.
export function htmlCanonicalUrl(html: string): string | undefined {
  const head = html.slice(0, 60_000); // <head> is at the top; don't scan a megabyte of body
  const canonical = /<link\b[^>]*\brel=["']?canonical["']?[^>]*>/i.exec(head)?.[0];
  const og = /<meta\b[^>]*\bproperty=["']?og:url["']?[^>]*>/i.exec(head)?.[0];
  for (const tag of [canonical, og]) {
    const href = tag && /\b(?:href|content)=["']([^"']+)["']/i.exec(tag)?.[1];
    if (href?.trim()) return decodeEntities(href.trim());
  }
  return undefined;
}

// Readability-lite: isolate the main content region of an HTML page so the
// blunt htmlToText strip isn't diluted by nav/sidebar/footer boilerplate.
// Dependency-free and CONSERVATIVE — when it can't confidently find a main
// region (or that region looks too small versus the whole page) it returns the
// input unchanged, so we never extract LESS than the previous behaviour. The
// strongest matching tier wins: <main>/<article> first, then common content
// containers. (Regex can't track nested tags; the size gate below catches a
// container truncated at its first nested close tag and falls back.)
// Given the index just past a `<tag …>` opening, return the inner HTML up to
// that tag's MATCHING close, counting nested same-name opens so a nested block
// doesn't close the container early. Returns null when the tag never closes.
// Regex alone can't balance nested tags — this is why the previous lazy
// `([\s\S]*?)</tag>` truncated a content div at its first nested `</div>`.
function sliceToMatchingClose(html: string, start: number, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b|</${tag}\\s*>`, "gi");
  re.lastIndex = start;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[0]![1] === "/") {
      if (--depth === 0) return html.slice(start, m.index);
    } else {
      depth++;
    }
  }
  return null;
}

export function extractMainHtml(html: string): string {
  const visible = (h: string) =>
    h
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim().length;
  // Opening-tag matchers, strongest tier first. Each captured group 1 is the
  // container tag name; the body is recovered by balanced scan (not a lazy
  // regex) so a nested block never truncates the extraction.
  const tiers: RegExp[] = [
    /<(main)\b[^>]*>/gi,
    /<(article)\b[^>]*>/gi,
    /<(div|section)\b[^>]*\b(?:id|class)="[^"]*\b(?:content|article|post|entry|story|markdown-body|main|prose)\b[^"]*"[^>]*>/gi,
  ];
  let candidates: string[] = [];
  for (const re of tiers) {
    const found: string[] = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const inner = sliceToMatchingClose(html, re.lastIndex, m[1]!.toLowerCase());
      if (inner !== null) found.push(inner);
    }
    if (found.length) {
      candidates = found; // use the strongest tier that matched
      break;
    }
  }
  if (!candidates.length) return html;
  let best = candidates[0]!;
  let bestLen = visible(best);
  for (const c of candidates.slice(1)) {
    const len = visible(c);
    if (len > bestLen) {
      best = c;
      bestLen = len;
    }
  }
  // Size gate: a tiny region (short absolutely AND a small share of the page) is
  // probably a truncated/wrong match — fall back to the full document.
  const fullLen = visible(html);
  if (bestLen < 500 && bestLen < fullLen * 0.3) return html;
  return best;
}

export const PDF_URL_RE = /\.pdf($|[?#])/i;

// A `/pdf/<id>` route that serves a PDF with no extension. arXiv's canonical
// PDF URL — `arxiv.org/pdf/2502.19732`, versioned `…v4` — is the case that
// matters: it is the most common PDF a `research` run ever fetches, and an
// extension test misses every one of them.
const PDF_ROUTE_RE = /\/pdf\/[^/?#]+($|[?#])/i;
// …unless the last segment names a format that is plainly not a PDF, so a
// documentation page living under /pdf/ is not mistaken for one.
const NON_PDF_TAIL_RE = /\.(html?|php|aspx?|jsp|json|xml|txt|md|csv)($|[?#])/i;

/**
 * Is this URL a PDF, judged before the fetch?
 *
 * It decides two things that both matter: whether to request BYTES (an
 * extension-less PDF fetched as text costs a second round-trip once the
 * content-type gives it away), and whether the documented extractor ladder
 * runs in its documented order. `fetchAndExtract` hands a non-PDF to Firecrawl
 * FIRST, so a misjudged PDF silently skips `pdf-inspector` — the ladder's
 * preferred rung — whenever a Firecrawl container happens to be up.
 */
export function looksLikePdfUrl(url: string): boolean {
  if (PDF_URL_RE.test(url)) return true;
  return PDF_ROUTE_RE.test(url) && !NON_PDF_TAIL_RE.test(url);
}
const PDF_FETCH_OPTS = { accept: "application/pdf,*/*", binary: true, maxBytes: 16 * 1024 * 1024 } as const;
// Office documents are binary too, and for the same reason need the raw bytes:
// the default text fetch decodes them as UTF-8, which is lossy and irreversible.
// Same 16 MB ceiling as PDFs — a deck or a spreadsheet is comparable in size.
const DOC_FETCH_OPTS = { accept: "*/*", binary: true, maxBytes: 16 * 1024 * 1024 } as const;

// Which extractor produced a page's text. `undefined` (absent) means the
// built-in regex reader — the historical behaviour and still the fallback for
// every failure path. Part of the on-disk cache key, so a body cleaned by one
// extractor is never served to a run configured for the other (see src/cache.ts).
//
// `pdf-inspector` and `pdftotext` are PDF-only rungs (see backends/pdf/ladder.ts);
// `anydoc` reads office documents (backends/doc/ladder.ts) and PDFs. They are
// reported so a dossier can say which tool read a paper, but PDFs and office
// documents each share a single cache namespace — see the note on
// currentExtractor in src/cache.ts.
export type ExtractorId = "native" | "firecrawl" | "pdf-inspector" | "pdftotext" | "anydoc" | "ocr";

export interface ExtractResult {
  text: string;
  title?: string;
  note?: string;
  finalUrl: string;
  status: number;
  extractor?: ExtractorId;
  canonical?: string; // the url the page declares for itself (rel=canonical / og:url)
  /**
   * The page's own one-line summary (`<meta name=description>`, else
   * `og:description`).
   *
   * Worth carrying because extraction drops `<head>` entirely, so a caller that
   * finds nothing in the body matching its question has no second-best left —
   * and citing a nav bar is worse than citing the summary the page wrote about
   * itself. Only ever set on the HTML path.
   */
  metaDescription?: string;
  // Carried up from the response so a cache can store them and revalidate later.
  // Absent on the Firecrawl path, which does its own fetching and reports no
  // origin validators — an entry written there simply re-downloads when stale.
  etag?: string;
  lastModified?: string;
}

// Fetch a URL and return its readable text + a title. HTML goes to Firecrawl
// first when a self-hosted instance is up (a real browser + main-content
// markdown, so JS-rendered pages and nav/cookie chrome stop costing us text) and
// falls back to the built-in narrow-then-strip reader on ANY failure. PDFs skip
// Firecrawl and go straight to the text-layer extractor. Returns a `note`
// instead of throwing when the page can't be fetched or a PDF yields no text.
//
// Note policy: a MISSING Firecrawl is silent — the localhost default not being
// up is the normal case and a per-URL note about it would drown the dossier.
// A Firecrawl that is up and still fails, or one the user asked for explicitly
// and did not get, does emit a note (the caller decides which).
export async function fetchAndExtract(
  url: string,
  opts: {
    acceptLanguage?: string;
    firecrawl?: string;
    /** Extra request headers for the built-in path — how the cache sends
     *  `if-none-match` / `if-modified-since`. Firecrawl does its own fetching and
     *  ignores these, which is why a revalidating caller skips it. */
    headers?: Record<string, string>;
    /**
     * Drop consent-banner lines from the extracted text.
     *
     * Opt-in, and applied to the BUILT-IN extractor's HTML only. Never to
     * Firecrawl markdown: main-content extraction has already removed the
     * banner, so all the heuristic could still do there is damage — on a page
     * documenting HTTP cookies it would eat the article.
     */
    stripConsent?: boolean;
  } = {},
): Promise<ExtractResult> {
  const wantsPdf = looksLikePdfUrl(url);
  // An office document skips the HTML Firecrawl path for the same reason a PDF
  // does (see looksLikePdfUrl above): handing it to Firecrawl first would
  // silently bypass the document ladder's preferred rung whenever a container
  // happens to be up. Firecrawl is still reachable — as rung 2, via callback.
  const wantsDoc = wantsPdf ? undefined : docFormatForUrl(url);
  let firecrawlNote: string | undefined;
  if (!wantsPdf && !wantsDoc) {
    const fc = await scrapeViaFirecrawl(url, opts);
    // Firecrawl reports success even for an error page, handing back the
    // origin's 404/403 body as markdown. Accept only a 2xx/3xx: anything else
    // has to fall through to the built-in path so the caller sees the real
    // status and the dead-link (Wayback) rescue still fires.
    if (fc.data && (fc.data.statusCode ?? 200) < 400) {
      return {
        text: fc.data.markdown,
        title: fc.data.title,
        finalUrl: fc.data.sourceURL || url,
        status: fc.data.statusCode ?? 200,
        extractor: "firecrawl",
      };
    }
    firecrawlNote = fc.data ? `Firecrawl got HTTP ${fc.data.statusCode} for ${url} — fell back to the built-in extractor.` : fc.why;
  }
  const base = wantsPdf ? PDF_FETCH_OPTS : wantsDoc ? DOC_FETCH_OPTS : { accept: "text/html,text/plain,*/*", acceptLanguage: opts.acceptLanguage };
  const fetchOpts = opts.headers ? { ...base, headers: opts.headers } : base;
  let res = await httpGet(url, fetchOpts);
  // A brand that identifies itself honestly gets refused by some hosts. Retry
  // once wearing a browser UA before giving up — but only for a brand that had
  // actually chosen the polite one, since retrying a browser UA with the same
  // browser UA is a wasted round-trip. A 304 is a success and never lands here.
  if (!res.ok && brand().defaultUa === "contact" && (res.status === 403 || res.status === 429)) {
    res = await httpGet(url, { ...fetchOpts, userAgent: browserUa(), acceptLanguage: opts.acceptLanguage ?? "en-US,en;q=0.9" });
  }
  // 304 is a SUCCESS with no body: the caller sent validators and the origin
  // confirmed nothing changed. Reported as-is so a cache can serve what it
  // already has; a caller that sent no validators can never see this.
  if (res.status === 304) {
    return { text: "", finalUrl: res.url, status: 304, etag: res.etag ?? opts.headers?.["if-none-match"], lastModified: res.lastModified };
  }
  if (!res.ok) {
    const why = res.status === 429 ? "rate-limited (HTTP 429)" : `status ${res.status}${res.error ? ", " + res.error : ""}`;
    return { text: "", finalUrl: res.url, status: res.status, note: `Could not fetch ${url} (${why}).` };
  }
  // Only materialised when the origin actually sent one, so an entry written for
  // a validator-less server keeps exactly the shape it had before.
  const validators = res.etag || res.lastModified ? { etag: res.etag, lastModified: res.lastModified } : {};
  if (wantsPdf || /application\/pdf/i.test(res.contentType)) {
    // A content-type-only PDF (no .pdf in the URL) was fetched as text — refetch
    // the raw bytes so the extractor sees an intact binary.
    const bytes = res.bytes ?? (await httpGet(url, PDF_FETCH_OPTS)).bytes;
    // The ladder tries pdf-inspector, then an already-running Firecrawl, then
    // pdftotext, then the built-in reader — and refuses rather than hand back
    // text no extractor could vouch for. Firecrawl is injected as a callback so
    // backends/pdf/ stays free of the client (and testable without a container).
    const got = bytes
      ? await extractPdf(bytes, {
          firecrawl: async () => {
            const fc = await scrapeViaFirecrawl(url, opts);
            return fc.data && (fc.data.statusCode ?? 200) < 400 ? fc.data.markdown : undefined;
          },
        })
      : { text: "", reason: "empty response body" };
    return {
      text: got.text,
      finalUrl: res.url,
      status: res.status,
      // `native` keeps reporting as absent, which is what the cache key and every
      // existing dossier already assume.
      extractor: got.via && got.via !== "native" ? got.via : undefined,
      note: got.text ? firecrawlNote : `Fetched ${url} but could not extract text — ${got.reason}.`,
      ...validators,
    };
  }
  // An office document, either because the URL said so or because only the
  // content-type did. Everything here exists to stop the fall-through below
  // treating a ZIP as prose: a .docx is not HTML, so `res.body` used to become
  // the source text — kilobytes of U+FFFD, cited, with no note saying so.
  const docFmt = wantsDoc ?? docFormatForContentType(res.contentType);
  if (docFmt) {
    // Same re-fetch as the PDF path: a content-type-only document was fetched as
    // text, so the bytes must be pulled again intact.
    const bytes = res.bytes ?? (await httpGet(url, DOC_FETCH_OPTS)).bytes;
    const got = bytes
      ? await extractDocument(bytes, docFmt, {
          firecrawl: async () => {
            const fc = await scrapeViaFirecrawl(url, opts);
            return fc.data && (fc.data.statusCode ?? 200) < 400 ? fc.data.markdown : undefined;
          },
        })
      : { text: "", reason: "empty response body" };
    // A format that is already plain text (CSV) keeps its raw body when no
    // converter is available: it was usable before this ladder existed, so
    // refusing it would be a regression rather than a fix.
    if (!got.text && docFmt.textFallback && bytes?.length) {
      return { text: bytes.toString("utf8"), finalUrl: res.url, status: res.status, note: firecrawlNote, ...validators };
    }
    return {
      text: got.text,
      finalUrl: res.url,
      status: res.status,
      extractor: got.via,
      note: got.text ? firecrawlNote : `Fetched ${url} but could not extract text — ${got.reason}.`,
      ...validators,
    };
  }
  const isHtml = /html/i.test(res.contentType) || /^\s*</.test(res.body);
  const stripped = isHtml ? htmlToText(extractMainHtml(res.body)) : res.body;
  const text = isHtml && opts.stripConsent ? stripConsentBoilerplate(stripped).text : stripped;
  const title = isHtml ? htmlTitle(res.body) : undefined;
  const canonical = isHtml ? htmlCanonicalUrl(res.body) : undefined;
  const metaDescription = isHtml ? metaDescriptionOf(res.body) : undefined;
  return { text, title, canonical, metaDescription, finalUrl: res.url, status: res.status, note: firecrawlNote, ...validators };
}

// Statuses where the origin is gone/blocked and a live re-fetch will never
// work, so an archived copy is worth trying (410 Gone, 451 legal, 403 blocked).
export const DEAD_LINK_STATUS = new Set([404, 410, 451, 403]);

// Best-effort dead-link rescue via the Wayback Machine's keyless availability
// API: ask for the closest snapshot of `url`, and if one exists, fetch + extract
// it. Returns the recovered text + the snapshot's timestamp/url, or undefined
// when there is no usable snapshot. The ORIGINAL url stays the source's url;
// callers record the snapshot in meta + a note. Disable with `<PREFIX>_NO_WAYBACK`.
export async function rescueViaWayback(
  url: string,
  opts: { acceptLanguage?: string; firecrawl?: string } = {},
): Promise<{ text: string; title?: string; snapshotUrl: string; timestamp: string } | undefined> {
  if (envFlag("NO_WAYBACK")) return undefined;
  const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
  const r = await httpJson("GET", api, undefined, { timeoutMs: 10000, userAgent: contactUa() });
  const snap = r.ok ? r.data?.archived_snapshots?.closest : undefined;
  if (snap?.available !== true || typeof snap.url !== "string") return undefined;
  const got = await fetchAndExtract(snap.url, opts);
  if (!got.text?.trim() || looksLikeJunkExtraction(got.text)) return undefined;
  return { text: got.text, title: got.title, snapshotUrl: snap.url, timestamp: String(snap.timestamp ?? "") };
}

// Consent walls, "enable JavaScript" shells and anti-bot interstitials extract
// to a short block of boilerplate that would otherwise pass as a source's full
// text. Flag such an extraction (returning a short reason) so the gatherer keeps
// only the search snippet instead. BOTH conditions are required — a genuine
// article ABOUT cookies or CAPTCHAs is long, so the length gate never trips it.
const JUNK_PATTERNS: [RegExp, string][] = [
  [/\b(accept|manage)\s+(all\s+)?cookies\b/i, "cookie/consent wall"],
  [/\bwe use cookies\b/i, "cookie/consent wall"],
  [/\bcookie (policy|settings|consent|preferences)\b/i, "cookie/consent wall"],
  [/\b(please )?enable javascript\b/i, "JavaScript-required shell"],
  [/\bjavascript is (disabled|required|not enabled)\b/i, "JavaScript-required shell"],
  [/\bverify (you are|you're|you are a)\b|\bare you a human\b|\bhuman verification\b/i, "anti-bot interstitial"],
  [/\baccess denied\b|\battention required\b.*cloudflare|\bunusual traffic\b|\bare you a robot\b/i, "anti-bot interstitial"],
  [/\benable cookies\b|\bchecking your browser\b/i, "anti-bot interstitial"],
  // FR / DE (the locale layer targets non-EN markets)
  [/\bnous utilisons des cookies\b|\baccepter (tous )?les cookies\b|\bactiver javascript\b/i, "cookie/consent wall (fr)"],
  [/\bwir verwenden cookies\b|\bcookies akzeptieren\b|\bjavascript aktivieren\b/i, "cookie/consent wall (de)"],
];
export function looksLikeJunkExtraction(text: string): string | undefined {
  const t = text.trim();
  if (t.length >= 2000) return undefined; // a real article is long — never flag it
  const head = t.slice(0, 800);
  for (const [re, reason] of JUNK_PATTERNS) if (re.test(head)) return reason;
  return undefined;
}

// Consent boilerplate that SURVIVES htmlToText — it lives in body <div>/<dialog>
// rather than <nav>/<footer>, so the tag-based stripper keeps it, and on a
// low-keyword page it is exactly what gets picked as the excerpt.
//
// The sibling of looksLikeJunkExtraction, not a rival: that one asks "is this
// whole extraction a wall?" and refuses the page; this one asks "which LINES of
// an otherwise good page are banner?" and drops those. A long article with a
// cookie strip down one side needs the second, and the first will never fire on
// it.
const CONSENT_PATTERNS = [
  /\bcookies?\b/i,
  /\bconsent\b/i,
  /\bgdpr\b/i,
  /\bccpa\b/i,
  /accept all\b/i,
  /reject all\b/i,
  /manage (?:preferences|choices|cookies|settings)/i,
  /privacy (?:policy|preferences|choices)/i,
  /tracking technolog/i,
  /advertising partners/i,
  /legitimate interest/i,
];

/**
 * Drop consent-banner lines from extracted text, and say how many went.
 *
 * Deliberately conservative: a line goes only on two distinct pattern hits, or
 * on one hit when the line is short enough to be a button ("Accept all
 * cookies"). Prose that mentions cookies once inside a real sentence stays —
 * this must never quietly delete the paragraph someone wanted to cite.
 */
export function stripConsentBoilerplate(text: string): { text: string; dropped: number } {
  let dropped = 0;
  const kept = text.split("\n").filter((line) => {
    const hits = CONSENT_PATTERNS.reduce((n, re) => n + (re.test(line) ? 1 : 0), 0);
    const isBanner = hits >= 2 || (hits === 1 && line.trim().length < 120);
    if (isBanner) dropped++;
    return !isBanner;
  });
  return { text: kept.join("\n"), dropped };
}

/**
 * The page's `<meta name=description>`, falling back to `og:description`.
 *
 * Read from raw HTML because htmlToText drops `<head>` entirely. Worth having as
 * a last-resort summary for a page whose body has nothing matching the question
 * — better than citing a nav bar.
 */
export function metaDescriptionOf(html: string): string | undefined {
  const m =
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i.exec(html) ||
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["']/i.exec(html) ||
    /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i.exec(html);
  const d = m?.[1]?.replace(/\s+/g, " ").trim();
  return d ? decodeEntities(d) : undefined;
}

// Query-focused, multi-sentence snippet (the lead a caller shows beside a
// DOSSIER.md). Splits the page text into sentences, scores each by how many of
// the question's keywords it covers, and stitches together the top few (in
// document order) under their nearest heading — so the agent reads the most
// on-point passage rather than a single best line. Falls back to the opening
// sentences when nothing matches.
export function focusedSnippet(text: string, question: string, opts: { maxChars?: number; maxSentences?: number } = {}): string {
  const maxChars = opts.maxChars ?? 360;
  const maxSentences = opts.maxSentences ?? 3;
  const lines = text.split("\n");
  const matcher = buildMatcher(question);
  const sentences: { text: string; line: number; score: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#{1,6}\s/.test(line)) continue; // headings handled separately
    for (const raw of line.split(/(?<=[.!?])\s+/)) {
      const t = raw.trim();
      if (t.length < 20) continue; // skip nav crumbs / fragments
      sentences.push({ text: t, line: i, score: matcher.matchLine(t).size });
    }
  }
  if (!sentences.length) return lines.slice(0, 4).join(" ").slice(0, maxChars).trim();
  const hits = sentences.filter((s) => s.score > 0);
  const chosen = (hits.length ? hits : sentences)
    .map((s, idx) => ({ s, idx }))
    .sort((a, b) => b.s.score - a.s.score || a.idx - b.idx)
    .slice(0, maxSentences)
    .sort((a, b) => a.idx - b.idx)
    .map((x) => x.s);
  const heading = nearestHeading(lines, chosen[0]!.line);
  let out = chosen.map((s) => s.text).join(" ");
  if (heading && !out.startsWith(heading)) out = `${heading} — ${out}`;
  return out.slice(0, maxChars).trim();
}

// Back-compat alias — a short query-focused excerpt. Kept so existing callers
// (gather hydration, dossier digest, generic backend) are unchanged.
export function bestExcerpt(text: string, question: string, maxChars = 360): string {
  return focusedSnippet(text, question, { maxChars, maxSentences: 2 });
}

// Cap an extract's length according to depth, so standard runs stay readable
// and deep runs keep everything. Always keeps whole lines.
export function capExtract(text: string, depth: "summary" | "standard" | "deep"): string {
  const cap = depth === "deep" ? Infinity : depth === "standard" ? 8000 : 4000;
  if (text.length <= cap) return text;
  const slice = text.slice(0, cap);
  const lastNl = slice.lastIndexOf("\n");
  return (lastNl > cap * 0.6 ? slice.slice(0, lastNl) : slice) + "\n\n… [truncated]";
}
