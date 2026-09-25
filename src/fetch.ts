import { brand, countFetch, env, envFlag, envInt } from "./brand.js";
import { decodeBody } from "./charset.js";
import { decodeEntities } from "./entities.js";
import {
  BLOCK_TAGS,
  balancedRegions,
  CHROME_ELEMENTS,
  CHROME_ROLES,
  closeTagRe,
  dropElements,
  dropLandmarks,
  HIDDEN_ELEMENTS,
  htmlAttributes,
  INLINE_TAGS,
  LOOSE_TAG_RE,
  RAW_TEXT_ELEMENTS,
  type Region,
  TAG_RE,
  tagName,
} from "./html.js";
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
// How long one request may stay silent before it is abandoned, when the caller
// names no budget of its own. A timed-out attempt is not retried (see httpGet),
// so this is also the worst case a hung host costs.
const defaultTimeoutMs = () => envInt("TIMEOUT_MS", 20_000, 1000, 300_000);

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
  /** Retained response bytes, before character decoding. */
  bytesRead?: number;
  /** The body exceeded the cap; its retained prefix is incomplete. */
  truncated?: boolean;
  error?: string;
  /** Cache validators, kept so a stale entry can be revalidated for free. */
  etag?: string;
  lastModified?: string;
  /** True on an explicit 429, or a 403 that carries an exhausted quota header. */
  rateLimited?: boolean;
  /** Retry-After in ms, when the server sent one — its own number, not capped to what httpGet waits out. */
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

// The longest Retry-After a request waits out itself before trying again.
const RETRY_AFTER_CAP_MS = 5000;

// How long to wait before a retry: the server's Retry-After (seconds or
// HTTP-date), else a small fixed backoff. Undefined — do not retry — when the
// server asked for longer than the cap. Retrying after 5 s anyway knowingly
// sent the request it had been told not to send for an hour; the caller gets
// the real ask in `retryAfterMs` instead, for a queue (crawlSite) to honour.
function retryDelayMs(retryAfterMs: number | undefined): number | undefined {
  if (retryAfterMs === undefined) return defaultRetryMs();
  return retryAfterMs <= RETRY_AFTER_CAP_MS ? retryAfterMs : undefined;
}

// Total attempts for a call: the caller's `retries` (extra tries on top of the
// first) when given, otherwise the env-wide policy. Clamped, because a typo in a
// retry count should cost one extra request, not a hundred.
function attemptsFor(retries: number | undefined): number {
  return retries === undefined ? maxAttempts() : Math.min(4, Math.max(0, Math.trunc(retries))) + 1;
}

type NetworkError = { message?: unknown; code?: unknown; cause?: { message?: unknown; code?: unknown } };

/**
 * Why a request failed, as specifically as the runtime knows it.
 *
 * undici reports every network failure as "fetch failed" and keeps the reason —
 * a refused connection, an unknown host, a redirect loop — on `cause`. Reading
 * only `message` made a typo in a host name, a redirect loop and a dead server
 * indistinguishable, which is the one thing a caller needs to tell apart.
 */
function networkFailure(e: unknown): string {
  const err = e as NetworkError | undefined;
  const code = typeof err?.cause?.code === "string" ? err.cause.code : undefined;
  const detail = typeof err?.cause?.message === "string" && err.cause.message ? err.cause.message : code;
  if (!detail) return typeof err?.message === "string" ? err.message : String(e);
  return code && !detail.includes(code) ? `${code}: ${detail}` : detail;
}

// Failures a second attempt a few hundred ms later cannot change: the name does
// not resolve, the redirect chain loops, the scheme or port is refused, the
// certificate is wrong. Retrying them doubled the cost for the same answer — a
// redirect loop was walked twice over, 42 requests to one server. Transient
// socket errors (ECONNRESET, UND_ERR_SOCKET…) are deliberately absent.
const PERMANENT_CODES = new Set([
  "ENOTFOUND",
  "ERR_INVALID_URL",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);
const PERMANENT_MESSAGE = /redirect count exceeded|scheme must be|unknown scheme|bad port|invalid url|failed to parse url/i;

function isPermanentFailure(e: unknown): boolean {
  const err = e as NetworkError | undefined;
  const code = err?.cause?.code ?? err?.code;
  if (typeof code === "string" && PERMANENT_CODES.has(code)) return true;
  return [err?.message, err?.cause?.message].some((m) => typeof m === "string" && PERMANENT_MESSAGE.test(m));
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

// Read one byte beyond the limit to distinguish an exact-sized body from an
// incomplete prefix. Only retained bytes are exposed in byte accounting.
async function readMeasuredBody(res: Response, max: number): Promise<{ bytes: Buffer; bytesRead: number; truncated: boolean }> {
  const read = await readCappedBytes(res, max + 1);
  const bytes = read.subarray(0, max);
  return { bytes, bytesRead: bytes.length, truncated: read.length > max };
}

/** The body cap for a text or JSON response. PDFs and office documents get their own, larger one. */
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** A response whose content-type names a PDF or an office document — a body only an extractor can read. */
function isBinaryDocument(contentType: string): boolean {
  return /application\/pdf/i.test(contentType) || docFormatForContentType(contentType) !== undefined;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

// A crawler's policy must run before each request, including redirect hops.
// Authorization failures are returned, not thrown into the network retry loop.
async function authorizedGet(
  url: string,
  init: RequestInit,
  authorize: (url: string) => Promise<boolean>,
): Promise<{ response: Response } | { failure: HttpResult }> {
  let target = url;
  const fail = (error: string): { failure: HttpResult } => ({ failure: { ok: false, status: 0, body: "", contentType: "", url: target, error } });
  const headers = { ...(init.headers as Record<string, string>) };
  for (let redirects = 0; ; redirects++) {
    try {
      if (!(await authorize(target))) return fail(`URL not authorized: ${target}`);
    } catch (e) {
      return fail(`URL authorization failed for ${target}: ${(e as Error).message}`);
    }
    const response = await fetch(target, { ...init, headers, redirect: "manual" });
    const location = response.headers.get("location");
    if (!REDIRECT_STATUS.has(response.status) || !location) return { response };
    await response.body?.cancel().catch(() => {});
    if (redirects >= 20) return fail("Too many redirects (maximum 20)");
    try {
      const next = new URL(location, target);
      if (!/^https?:$/.test(next.protocol)) return fail(`Unsupported redirect protocol: ${next.protocol}`);
      if (next.origin !== new URL(target).origin) {
        delete headers.authorization;
        delete headers.cookie;
        delete headers["proxy-authorization"];
      }
      target = next.href;
    } catch {
      return fail(`Invalid redirect URL from ${target}`);
    }
  }
}

// Minimal HTTP GET on Node's built-in fetch (Node ≥18) — no dependencies.
// Times out, sends a UA, caps the body, never throws (errors come back as
// { ok:false }), and retries ONCE on a transient status or network error.
export async function httpGet(
  url: string,
  opts: {
    /** Network budget per attempt, in ms. Default `<PREFIX>_TIMEOUT_MS` (20 s); a timed-out attempt is not retried. */
    timeoutMs?: number;
    accept?: string;
    acceptLanguage?: string;
    maxBytes?: number;
    /** Optional larger cap for a response identified as a document by MIME.
     *  An explicit maxBytes always wins. */
    maxDocumentBytes?: number;
    userAgent?: string;
    binary?: boolean;
    /** Approve the initial URL and every redirect before network access. */
    authorizeUrl?: (url: string) => Promise<boolean>;
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
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs();
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctrl = new AbortController();
    let t: ReturnType<typeof setTimeout> | undefined;
    let remainingMs = timeoutMs;
    let startedAt = 0;
    // Recorded rather than inferred from the rejection: an abort surfaces as
    // "This operation was aborted" (or a body-stream error), which names
    // neither a timeout nor how long was waited.
    let timedOut = false;
    const expire = () => {
      timedOut = true;
      ctrl.abort();
    };
    const pauseTimeout = () => {
      if (t === undefined) return;
      clearTimeout(t);
      t = undefined;
      remainingMs -= performance.now() - startedAt;
    };
    const resumeTimeout = () => {
      startedAt = performance.now();
      if (remainingMs <= 0) expire();
      else t = setTimeout(expire, remainingMs);
    };
    try {
      const headers: Record<string, string> = { "user-agent": opts.userAgent ?? defaultUa(), accept: opts.accept ?? "*/*" };
      if (opts.acceptLanguage) headers["accept-language"] = opts.acceptLanguage;
      for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
      const init: RequestInit = {
        signal: ctrl.signal,
        redirect: "follow",
        headers,
      };
      // Crawl-delay and robots checks are policy waits, not network time.
      // Keep one cumulative network budget across redirects, paused while each
      // destination is authorized and resumed for its fetch and response body.
      if (!opts.authorizeUrl) resumeTimeout();
      const requested = opts.authorizeUrl
        ? await authorizedGet(url, init, async (target) => {
            pauseTimeout();
            const allowed = await opts.authorizeUrl!(target);
            if (allowed) resumeTimeout();
            return allowed;
          })
        : { response: await fetch(url, init) };
      if ("failure" in requested) return requested.failure;
      const res = requested.response;
      const meta = {
        contentType: res.headers.get("content-type") ?? "",
        url: res.url || url,
        etag: res.headers.get("etag") ?? undefined,
        lastModified: res.headers.get("last-modified") ?? undefined,
        rateLimited: detectRateLimited(res.status, res.headers),
        retryAfterMs: parseRetryAfter(res.headers, Number.POSITIVE_INFINITY),
      };
      const max = opts.maxBytes ?? (isBinaryDocument(meta.contentType) ? opts.maxDocumentBytes : undefined) ?? DEFAULT_MAX_RESPONSE_BYTES;

      // Refuse a body the server has already declared too big, before a single
      // byte of it is read, when its prefix is useless: a document, or the
      // answer to a Range request (declared that large, the range was ignored
      // and the prefix is not the part asked for). Not retried: the size will
      // be the same next time. Any other text body reads its capped prefix
      // below, exactly as it does when the same bytes arrive chunked — whether
      // a long article is readable must not depend on a Content-Length.
      const declared = Number(res.headers.get("content-length"));
      const prefixUseless = opts.binary || isBinaryDocument(meta.contentType) || Object.keys(opts.headers ?? {}).some((k) => k.toLowerCase() === "range");
      if (Number.isFinite(declared) && declared > max && prefixUseless) {
        ctrl.abort();
        return { ok: false, status: res.status, body: "", bytesRead: 0, truncated: true, ...meta, error: `response too large: ${declared} bytes > ${max} cap` };
      }

      // 304 carries no body by definition — reading it is not an error, and the
      // caller (the cache) wants the status, not an empty-body complaint.
      const { bytes, bytesRead, truncated } =
        res.status === 304 ? { bytes: Buffer.alloc(0), bytesRead: 0, truncated: false } : await readMeasuredBody(res, max);
      countFetch(bytes.length, false);
      // The raw bytes are kept when the caller asked for them, and ALSO when
      // the origin says the body is a PDF or an office document that the URL
      // did not announce: they are already in memory, and handing them over is
      // what spares fetchAndExtract a second full download of the same file.
      //
      // Only complete documents are handed over implicitly. fetchAndExtract
      // allows 16 MB after MIME detection; a caller's explicit cap still wins,
      // and a prefix cut at that cap must never masquerade as a complete file.
      const keepBytes = opts.binary || (isBinaryDocument(meta.contentType) && !truncated);
      const result: HttpResult = {
        ok: res.ok,
        status: res.status,
        // Decoded per the response's own encoding, not assumed UTF-8. A
        // Windows-1252 page used to come back with every accented character
        // replaced by U+FFFD, and nothing anywhere noticed.
        body: opts.binary ? "" : decodeBody(bytes, meta.contentType),
        bytes: keepBytes ? bytes : undefined,
        bytesRead,
        truncated,
        ...meta,
      };
      const wait = RETRY_STATUS.has(res.status) && attempt < attempts - 1 ? retryDelayMs(meta.retryAfterMs) : undefined;
      if (wait !== undefined) {
        last = result;
        await sleep(wait);
        continue;
      }
      return result;
    } catch (e) {
      last = { ok: false, status: 0, body: "", contentType: "", url, error: timedOut ? `timed out after ${timeoutMs} ms` : networkFailure(e) };
      // A timeout has spent the whole budget the caller granted, and a host
      // silent for that long rarely answers a second time: retrying it made the
      // real worst case attempts × timeout, twice what the caller asked for.
      if (timedOut || isPermanentFailure(e)) break;
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
  opts: {
    timeoutMs?: number;
    accept?: string;
    acceptLanguage?: string;
    userAgent?: string;
    headers?: Record<string, string>;
    retries?: number;
    /** Response cap in bytes; over it the transfer is cancelled and the call fails. Default 4 MB. */
    maxBytes?: number;
  } = {},
): Promise<{ ok: boolean; status: number; data: any; error?: string; bytesRead?: number; truncated?: boolean }> {
  const attempts = attemptsFor(opts.retries);
  let last: { ok: boolean; status: number; data: any; error?: string } = { ok: false, status: 0, data: undefined };
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs();
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctrl = new AbortController();
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
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
      // Streamed under the same cap as httpGet, and cancelled at it. `res.text()`
      // buffered whatever the endpoint sent — Firecrawl, Qdrant, Ollama and the
      // Wayback API all come through here, and a runaway answer from any of
      // them was the one unbounded read left in this module.
      const max = opts.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
      // One byte past the cap, so a body of exactly `max` is answered rather
      // than refused: reading only `max` cannot tell "exactly the cap" from
      // "cut off at the cap", and refusing the former would be a cap of max-1.
      const { bytes, bytesRead, truncated } = await readMeasuredBody(res, max);
      countFetch(bytes.length, false);
      if (truncated) {
        ctrl.abort();
        return { ok: false, status: res.status, data: undefined, bytesRead, truncated, error: `response too large: over the ${max}-byte cap` };
      }
      const text = bytes.toString("utf8");
      let data: any;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = text;
      }
      const result = { ok: res.ok, status: res.status, data, bytesRead, truncated };
      const wait = RETRY_STATUS.has(res.status) && attempt < attempts - 1 ? retryDelayMs(parseRetryAfter(res.headers, Number.POSITIVE_INFINITY)) : undefined;
      if (wait !== undefined) {
        last = result;
        await sleep(wait);
        continue;
      }
      return result;
    } catch (e) {
      last = { ok: false, status: 0, data: undefined, error: timedOut ? `timed out after ${timeoutMs} ms` : networkFailure(e) };
      if (timedOut || isPermanentFailure(e)) break;
      if (attempt < attempts - 1) await sleep(defaultRetryMs());
    } finally {
      clearTimeout(t);
    }
  }
  return last;
}

// The decoder lives with the shared markup primitives; this is its public name.
export { decodeEntities };

// Formatting a title or snippet can carry — Crossref's <i>/<sub>/<scp>, a
// search backend's highlight <span>s and <a>s — and the MathML/JATS namespaces
// scholarly metadata nests inside it.
const INLINE_FORMAT: ReadonlySet<string> = new Set([...INLINE_TAGS, "br", "scp"]);
const INLINE_FORMAT_TAG = /<(\/?)([a-zA-Z][\w.-]*(?::[\w.-]+)?)(?=[\s/>])([^<>]*)>/g;

// Clean a backend-provided inline field (a title or one-line snippet) that may
// carry escaped or literal markup: decode entities FIRST (so escaped tags like
// `&lt;i&gt;` become real tags), THEN strip the tags, then collapse whitespace.
// Decode-then-strip handles both `R&amp;D` → `R&D` and `&lt;i&gt;P53&lt;/i&gt;`
// → `P53` (and literal `<i>P53</i>` → `P53`).
//
// Only formatting markup goes, and only where it IS markup: a tag with
// attributes, a <br>, a namespaced MathML/JATS tag, or one whose partner is
// in the same string. Everything else in angle brackets is text — `Vec<u8>`,
// `Promise<void>`, and MDN's own titles ("<a>: The Anchor element") all lost
// their subject when every `<…>` was stripped.
export function cleanInline(s: string): string {
  const text = decodeEntities(String(s));
  const opened = new Set<string>();
  const closed = new Set<string>();
  for (const m of text.matchAll(INLINE_FORMAT_TAG)) (m[1] ? closed : opened).add(m[2]!.toLowerCase());
  return text
    .replace(INLINE_FORMAT_TAG, (tag, slash: string, rawName: string, attrs: string) => {
      const name = rawName.toLowerCase();
      if (name.startsWith("mml:") || name.startsWith("jats:")) return "";
      if (!INLINE_FORMAT.has(name)) return tag;
      if (name === "br") return " ";
      const markup = attrs.trim().replace(/\/$/, "") !== "" || name === "wbr" || (slash ? opened : closed).has(name);
      return markup ? "" : tag;
    })
    .replace(/\s+/g, " ")
    .trim();
}

// Extract readable text from an HTML page. Zero-dep and intentionally simple:
// drop script/style/head/nav/footer, turn block tags into newlines, keep
// heading structure as markdown markers, decode common entities, collapse
// whitespace. Good enough to ground a report in a page's prose without a DOM.

// A placeholder line that carries a <pre> block past the whitespace cleanup:
// NUL, the block's index, NUL. No page text can forge one, because htmlToText
// first turns the page's own NULs into U+FFFD, as a browser does.
const NUL = "\u0000";
const PRE_SLOT = (i: number) => `\n${NUL}${i}${NUL}\n`;
function preSlotIndex(line: string): number | undefined {
  if (line.length < 3 || line[0] !== NUL || line[line.length - 1] !== NUL) return undefined;
  const i = Number(line.slice(1, -1));
  return Number.isInteger(i) ? i : undefined;
}

/**
 * Every `<pre>…</pre>` replaced by a placeholder line, its text kept aside
 * verbatim: indentation and blank lines are the meaning of a Python, YAML or
 * TOML sample, and the line cleanup would destroy both. Inner tags are syntax
 * highlighting (Prism, Pygments, GitHub's pl-* spans) and go without a trace.
 */
function setAsidePre(html: string, blocks: string[]): string {
  const open = /<pre(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
  const close = closeTagRe("pre");
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = open.exec(html))) {
    close.lastIndex = open.lastIndex;
    const c = close.exec(html);
    if (!c) break; // no </pre> anywhere after: the tag pass handles the rest
    const inner = html.slice(open.lastIndex, c.index);
    const text = decodeEntities(inner.replace(/<br\s*\/?>/gi, "\n").replace(LOOSE_TAG_RE, ""))
      .replace(/\r\n?/g, "\n")
      .replace(/^\n/, "") // the newline right after <pre> is not content, per the spec
      .trimEnd();
    blocks.push(text);
    out += html.slice(last, m.index) + PRE_SLOT(blocks.length - 1);
    last = open.lastIndex = c.index + c[0].length;
  }
  return last === 0 ? html : out + html.slice(last);
}

// A heading ends at its own close or at the next heading tag of ANY level —
// where a browser ends it too — so a stray </h3> after <h2> cannot drag the
// article into the heading line.
const HEADING_OPEN = /<h([1-6])(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
const HEADING_BOUNDARY = /<\/h[1-6]\s*>|<h[1-6](?=[\s/>])/gi;
// A permalink anchor whose whole text is a glyph (Sphinx's ¶ or #, or GitHub's
// icon-only anchor once its SVG is gone). Not part of the title.
const PERMALINK = /<a\b[^<>]*>\s*(?:(?:¶|#|§|🔗|&para;|&#182;|&#x[bB]6;|&sect;)\s*)?<\/a\s*>/gi;

/**
 * Each closed heading as ONE line, `## text`.
 *
 * Emitting the marker at the opening tag and letting the text follow put the
 * marker on a line of its own whenever a template pretty-printed the heading,
 * and `nearestHeading` — which needs `## text` — then lost the section title of
 * every excerpt below it. An unclosed heading is left to the tag pass.
 */
function flattenHeadings(html: string): string {
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  HEADING_OPEN.lastIndex = 0;
  while ((m = HEADING_OPEN.exec(html))) {
    HEADING_BOUNDARY.lastIndex = HEADING_OPEN.lastIndex;
    const b = HEADING_BOUNDARY.exec(html);
    if (!b) break; // no heading tag of any kind after this one
    if (b[0][1] !== "/") continue; // the next heading opens first: unclosed
    const text = html
      .slice(HEADING_OPEN.lastIndex, b.index)
      .replace(PERMALINK, "")
      .replace(TAG_RE, (tag) => (INLINE_TAGS.has(tagName(tag)) ? "" : " "))
      .replace(/\s+/g, " ")
      .trim();
    out += html.slice(last, m.index) + (text ? `\n${"#".repeat(Number(m[1]))} ${text}\n` : "\n");
    last = HEADING_OPEN.lastIndex = b.index + b[0].length;
  }
  return last === 0 ? html : out + html.slice(last);
}

export function htmlToText(html: string, opts: { fullPage?: boolean } = {}): string {
  // Whole-page callers need navigation and footer text even without a main region.
  const hidden = opts.fullPage ? HIDDEN_ELEMENTS : [...HIDDEN_ELEMENTS, ...CHROME_ELEMENTS];
  let s = dropElements(html.includes(NUL) ? html.split(NUL).join("\uFFFD") : html, hidden, RAW_TEXT_ELEMENTS);
  // The same chrome marked up as ARIA landmarks: a breadcrumb, a wiki's table
  // of contents, a docs theme's prev/next bar.
  if (!opts.fullPage) s = dropLandmarks(s, CHROME_ROLES);
  const pre: string[] = [];
  s = flattenHeadings(setAsidePre(s, pre));
  let prevEnd = -1;
  let prevClosed = false;
  s = s.replace(TAG_RE, (tag: string, at: number) => {
    const closing = tag[1] === "/";
    // Two elements back to back (`</a><a>`): a stylesheet almost always spaces
    // them apart — tag lists, nav links, breadcrumbs — so they keep a space.
    const adjacent = at === prevEnd && prevClosed && !closing;
    prevEnd = at + tag.length;
    prevClosed = closing;
    const name = tagName(tag);
    if (/^h[1-6]$/.test(name)) {
      return closing ? "\n" : "\n" + "#".repeat(Number(name[1])) + " ";
    }
    // Break on OPENING block tags too, not only closing ones. Unclosed `<li>` and
    // `<td>` are valid HTML and extremely common, and with closing tags alone a
    // whole list or table row collapses onto one line — which then reads as a
    // single sentence to anything scoring lines against a question. Headings
    // return above so their markdown markers are never doubled.
    if (BLOCK_TAGS.has(name) || name === "br" || name === "hr") return "\n";
    if (INLINE_TAGS.has(name)) return adjacent ? " " : "";
    return " ";
  });
  // Malformed attributes must not leave tag markup in the extracted prose.
  s = s.replace(LOOSE_TAG_RE, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  return s
    .split("\n")
    .map((l) => {
      const t = l.trim();
      const slot = preSlotIndex(t);
      return slot === undefined ? t : (pre[slot] ?? t);
    })
    .filter((l) => l.length > 0)
    .join("\n");
}

// Never where a page names itself: an icon's <svg><title> ("Search icon")
// was the title of every SPA shell whose <head> had none.
const NOT_TITLE: readonly string[] = ["script", "style", "template", "svg"];

/**
 * The text of the first `<name>` element in `html`, markup out, entities
 * decoded, whitespace collapsed. The close is searched once, forward from the
 * opener, so an unclosed one costs one pass rather than a lazy regex's pass
 * per opener.
 */
function firstElementText(html: string, name: string): string | undefined {
  const open = new RegExp(`<${name}(?=[\\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>`, "i").exec(html);
  if (!open) return undefined;
  const close = closeTagRe(name);
  close.lastIndex = open.index + open[0].length;
  const c = close.exec(html);
  if (!c) return undefined;
  const inner = html.slice(open.index + open[0].length, c.index).replace(TAG_RE, (tag) => (INLINE_TAGS.has(tagName(tag)) ? "" : " "));
  return decodeEntities(inner).replace(/\s+/g, " ").trim() || undefined;
}

// Best-effort page title from an HTML document: its `<title>`.
export function htmlTitle(html: string): string | undefined {
  return firstElementText(dropElements(html, NOT_TITLE), "title");
}

// The first `<meta>` content among `keys` (name or property, lower-case), by
// the order of `keys` rather than of the document.
function metaContent(html: string, keys: readonly string[]): string | undefined {
  const found = new Map<string, string>();
  for (const m of html.matchAll(/<meta(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = htmlAttributes(m[0]);
    const key = (attrs.get("property") ?? attrs.get("name"))?.toLowerCase();
    const value = attrs.get("content")?.trim();
    if (key && value && keys.includes(key) && !found.has(key)) found.set(key, decodeEntities(value).replace(/\s+/g, " ").trim());
  }
  return keys.map((k) => found.get(k)).find(Boolean);
}

/**
 * What to call a fetched page: its `<title>`, else what it tells social cards
 * (`og:title`), else its first `<h1>`. A title-less page — an SPA shell, a
 * generated doc — used to report none, although it names itself plainly.
 */
function pageTitle(html: string): string | undefined {
  const clean = dropElements(html, NOT_TITLE);
  return firstElementText(clean, "title") ?? metaContent(clean, ["og:title", "twitter:title"]) ?? firstElementText(clean, "h1");
}

// The URL a page declares for ITSELF — `<link rel="canonical">`, else the
// OpenGraph `og:url`. Only meaningful when the URL we fetched is not itself
// citable (an API endpoint, a redirector): the page names its own address, so
// we don't have to guess one. Extraction strips <head>, hence reading it here.
//
// Read up to the end of <head>, wherever that is, with scripts, styles and
// comments out of the way. A fixed window missed the canonical of every page
// that inlines a large critical stylesheet first, as Next and Gatsby do.
export function htmlCanonicalUrl(html: string): string | undefined {
  const clean = dropElements(html, ["script", "style", "template"]);
  const end = clean.search(/<\/head\s*>|<body(?=[\s/>])/i);
  const head = end < 0 ? clean : clean.slice(0, end);
  let og: string | undefined;
  for (const m of head.matchAll(/<(link|meta)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = htmlAttributes(m[0]);
    if (m[1]!.toLowerCase() === "link") {
      const href = attrs.get("href")?.trim();
      if (href && (attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")) return decodeEntities(href);
    } else if (og === undefined && attrs.get("property")?.toLowerCase() === "og:url") {
      og = attrs.get("content")?.trim() || undefined;
    }
  }
  return og && decodeEntities(og);
}

// A declared canonical made absolute against the address the page came from.
// A relative one ("/blog/post-slug") is legal and common, and was reported as
// written — which no citation check accepts. Anything that does not resolve
// to http(s) is not an address to cite.
function absoluteCanonical(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    const u = new URL(href, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

// Readability-lite: isolate the main content region of an HTML page so the
// blunt htmlToText strip isn't diluted by nav/sidebar/footer boilerplate.
// Dependency-free and CONSERVATIVE — when it can't confidently find a main
// region (or that region looks too small versus the whole page) it returns the
// input unchanged, so we never extract LESS than the previous behaviour. The
// strongest matching tier wins: <main> or role="main", then <article>, then
// common content containers.

// Length of the text a reader would see: tags out, whitespace collapsed.
const visibleLength = (h: string) =>
  h
    .replace(/<[^<>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim().length;

// The ARIA landmark for the main region. Sphinx/Read the Docs, MediaWiki,
// Discourse and many CMS themes mark it this way instead of with <main>.
const ROLE_MAIN = /\srole\s*=\s*["']?main(?=["'\s/>])/i;
// The element names that carry it on this page, so each can be balanced by name.
const ROLE_MAIN_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)(?=[\s/>])[^<>]*\srole\s*=\s*["']?main(?=["'\s/>])/g;

// Words in an id or class that mark a content container, and words that mark
// the chrome around one. `entry-content` and `main-outlet` are content;
// `main-nav` and `sidebar-content` are not, though a bare `\bmain\b` or
// `\bcontent\b` test matched both.
const CONTENT_WORDS = new Set(["content", "article", "post", "entry", "story", "main", "prose"]);
const CHROME_WORDS = new Set([
  "nav",
  "navbar",
  "navigation",
  "menu",
  "header",
  "footer",
  "sidebar",
  "breadcrumb",
  "breadcrumbs",
  "banner",
  "cookie",
  "consent",
  "comment",
  "comments",
  "related",
  "share",
  "social",
  "toolbar",
  "widget",
  "meta",
  "ad",
  "ads",
  "promo",
]);

function isContentContainer(open: string): boolean {
  const attrs = htmlAttributes(open);
  for (const token of `${attrs.get("id") ?? ""} ${attrs.get("class") ?? ""}`.toLowerCase().split(/\s+/)) {
    if (token === "markdown-body") return true;
    const words = token.split(/\W+/);
    if (words.some((w) => CONTENT_WORDS.has(w)) && !words.some((w) => CHROME_WORDS.has(w))) return true;
  }
  return false;
}

// What makes two candidates the same KIND of block: tag name and first class,
// digits ignored so WordPress's `post-123` and `post-456` agree.
function blockKind(open: string): string {
  const tag = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(open)?.[1]?.toLowerCase() ?? "";
  const firstClass = (htmlAttributes(open).get("class") ?? "").trim().split(/\s+/)[0]!;
  return `${tag} ${firstClass.replace(/\d+/g, "0")}`;
}

/**
 * The main content region of `html`, or `html` itself when none is found with
 * confidence.
 *
 * Candidates are found and measured on the page WITHOUT its comments, scripts,
 * styles, templates and SVGs, and a region is returned from that cleaned page.
 * Inline scripts count as characters but are not text: a sidebar holding a chat
 * widget's JSON outscored the article, and a `__NEXT_DATA__` blob outside
 * `<main>` inflated the page until the size gate refused the real region.
 */
export function extractMainHtml(html: string): string {
  const clean = dropElements(html, ["script", "style", "template", "svg"]);
  const roleMainTags = new Set(["main"]);
  for (const m of clean.matchAll(ROLE_MAIN_TAG)) roleMainTags.add(m[1]!.toLowerCase());
  // Strongest tier first; the first tier with a candidate decides.
  const tiers: { tags: string[]; isCandidate: (open: string) => boolean }[] = [
    { tags: [...roleMainTags], isCandidate: (open) => /^<main[\s/>]/i.test(open) || ROLE_MAIN.test(open) },
    { tags: ["article"], isCandidate: () => true },
    { tags: ["div", "section"], isCandidate: isContentContainer },
  ];
  for (const tier of tiers) {
    const regions = tier.tags.flatMap((tag) => balancedRegions(clean, tag, tier.isCandidate)).sort((a, b) => a.start - b.start);
    if (!regions.length) continue;
    // Only an outermost candidate can win — a nested one never has more text
    // than the candidate around it — so only those are measured. They are
    // disjoint, which keeps the measuring linear however deep the nesting goes.
    const outer: (Region & { len: number })[] = [];
    let reach = -1;
    for (const r of regions) {
      if (r.start < reach) continue;
      reach = r.end;
      outer.push({ ...r, len: visibleLength(clean.slice(r.start, r.end)) });
    }
    let best = outer[0]!;
    for (const r of outer) if (r.len > best.len) best = r;
    // Repeated siblings — the posts of a thread, the entries of a blog index —
    // are the content between them. Keeping only the longest dropped the rest
    // of the thread, very often the question itself. A story beside its
    // comments is two kinds of block and still keeps just the story.
    const kind = blockKind(best.open);
    const kept = outer.filter((r) => r === best || blockKind(r.open) === kind);
    const keptLen = kept.reduce((n, r) => n + r.len, 0);
    // Size gate: a tiny region (short absolutely AND a small share of the page)
    // is probably a wrong match — fall back to the full document. The whole
    // page is only measured when the region is short enough for it to matter.
    if (keptLen < 500 && keptLen < visibleLength(clean) * 0.3) return html;
    if (kept.length === 1) return clean.slice(best.start, best.end);
    return kept.map((r) => `<div>${clean.slice(r.start, r.end)}</div>`).join("\n");
  }
  return html;
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
  consentDropped?: number;
  title?: string;
  note?: string;
  finalUrl: string;
  status: number;
  extractor?: ExtractorId;
  /** Document type detected from the URL or response, independent of converter. */
  documentType?: "pdf" | "doc";
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
  /**
   * The raw HTML, only when the caller asked for it with `keepHtml` and only on
   * the built-in HTML path.
   *
   * Opt-in because it doubles what a page costs in memory, and almost every
   * caller wants the text and nothing else. The one that does not is a caller
   * following LINKS — `crawlSite` — and the alternative for it is a second
   * request for bytes this function already had in hand.
   */
  html?: string;
  // Carried up from the response so a cache can store them and revalidate later.
  // Absent on the Firecrawl path, which does its own fetching and reports no
  // origin validators — an entry written there simply re-downloads when stale.
  etag?: string;
  lastModified?: string;
  /** The response overran the byte cap, so `text` is a prefix of the page, not all of it. */
  truncated?: boolean;
  /** On a failed fetch: the origin throttled it (429, or a 403 with an exhausted quota). */
  rateLimited?: boolean;
  /**
   * On a failed fetch: how long the origin asked callers to wait (its
   * Retry-After, in ms), so a caller with a queue can back the whole host off
   * rather than learn the same answer once per URL.
   */
  retryAfterMs?: number;
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
    /** Check the initial URL and each redirect; disables remote extraction. */
    authorizeUrl?: (url: string) => Promise<boolean>;
    /** Network budget for the built-in fetch, in ms (see httpGet). Firecrawl keeps its own. */
    timeoutMs?: number;
    /**
     * Drop consent-banner lines from the extracted text.
     *
     * Opt-in, and applied to the BUILT-IN extractor's HTML only. Never to
     * Firecrawl markdown: main-content extraction has already removed the
     * banner, so all the heuristic could still do there is damage — on a page
     * documenting HTTP cookies it would eat the article.
     */
    stripConsent?: boolean;
    /** Keep all page text through the built-in reader, bypassing isolation and consent filtering. */
    fullPage?: boolean;
    /**
     * Carry the raw HTML up in `html`. For a caller that follows links out of
     * the page it just read; see ExtractResult.html for why it is opt-in.
     */
    keepHtml?: boolean;
  } = {},
): Promise<ExtractResult> {
  const wantsPdf = looksLikePdfUrl(url);
  // An office document skips the HTML Firecrawl path for the same reason a PDF
  // does (see looksLikePdfUrl above): handing it to Firecrawl first would
  // silently bypass the document ladder's preferred rung whenever a container
  // happens to be up. Firecrawl is still reachable — as rung 2, via callback.
  const wantsDoc = wantsPdf ? undefined : docFormatForUrl(url);
  let firecrawlNote: string | undefined;
  // Firecrawl's cleaned markdown cannot recover navigation or consent text.
  if (!wantsPdf && !wantsDoc && !opts.authorizeUrl && !opts.fullPage) {
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
  const fetchOpts = { ...base, maxDocumentBytes: PDF_FETCH_OPTS.maxBytes, headers: opts.headers, authorizeUrl: opts.authorizeUrl, timeoutMs: opts.timeoutMs };
  let res = await httpGet(url, fetchOpts);
  // A brand that identifies itself honestly gets refused by some hosts. Retry
  // once wearing a browser UA before giving up — but only for a brand that had
  // actually chosen the polite one, since retrying a browser UA with the same
  // browser UA is a wasted round-trip. A 304 is a success and never lands here.
  // A server that named a wait longer than httpGet would sleep through meant
  // it, whatever the UA; asking again at once would be ducking the limit.
  const toldToWait = (res.retryAfterMs ?? 0) > RETRY_AFTER_CAP_MS;
  if (!res.ok && !toldToWait && brand().defaultUa === "contact" && (res.status === 403 || res.status === 429)) {
    res = await httpGet(url, { ...fetchOpts, userAgent: browserUa(), acceptLanguage: opts.acceptLanguage ?? "en-US,en;q=0.9" });
  }
  // 304 is a SUCCESS with no body: the caller sent validators and the origin
  // confirmed nothing changed. Reported as-is so a cache can serve what it
  // already has; a caller that sent no validators can never see this.
  if (res.status === 304) {
    return { text: "", finalUrl: res.url, status: 304, etag: res.etag ?? opts.headers?.["if-none-match"], lastModified: res.lastModified };
  }
  if (!res.ok) {
    const wait = res.retryAfterMs !== undefined ? `, retry after ${Math.ceil(res.retryAfterMs / 1000)} s` : "";
    const why = res.status === 429 ? `rate-limited (HTTP 429${wait})` : `status ${res.status}${res.error ? ", " + res.error : ""}${wait}`;
    return {
      text: "",
      finalUrl: res.url,
      status: res.status,
      note: `Could not fetch ${url} (${why}).`,
      ...(res.rateLimited ? { rateLimited: true } : {}),
      ...(res.retryAfterMs !== undefined ? { retryAfterMs: res.retryAfterMs } : {}),
    };
  }
  // Only materialised when the origin actually sent one, so an entry written for
  // a validator-less server keeps exactly the shape it had before.
  const validators = res.etag || res.lastModified ? { etag: res.etag, lastModified: res.lastModified } : {};
  if (res.truncated && (wantsPdf || wantsDoc || isBinaryDocument(res.contentType))) {
    return { text: "", finalUrl: res.url, status: res.status, note: `Fetched ${url} but the document exceeds the response size cap.` };
  }
  if (wantsPdf || /application\/pdf/i.test(res.contentType)) {
    // httpGet keeps the raw bytes of anything the origin labelled a PDF, so a
    // content-type-only PDF (no .pdf in the URL) is not downloaded twice. The
    // refetch is only for a response that somehow arrived without them.
    const bytes =
      res.bytes ?? (await httpGet(url, { ...PDF_FETCH_OPTS, headers: opts.headers, authorizeUrl: opts.authorizeUrl, timeoutMs: opts.timeoutMs })).bytes;
    // The ladder tries pdf-inspector, then an already-running Firecrawl, then
    // pdftotext, then the built-in reader — and refuses rather than hand back
    // text no extractor could vouch for. Firecrawl is injected as a callback so
    // backends/pdf/ stays free of the client (and testable without a container).
    const got = bytes
      ? await extractPdf(bytes, {
          firecrawl: async () => {
            if (opts.authorizeUrl) return undefined;
            const fc = await scrapeViaFirecrawl(url, opts);
            return fc.data && (fc.data.statusCode ?? 200) < 400 ? fc.data.markdown : undefined;
          },
        })
      : { text: "", reason: "empty response body" };
    return {
      text: got.text,
      documentType: "pdf",
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
    // Same as the PDF path: the bytes of a content-type-only document are
    // already here; the refetch is the fallback, not the rule.
    const bytes =
      res.bytes ?? (await httpGet(url, { ...DOC_FETCH_OPTS, headers: opts.headers, authorizeUrl: opts.authorizeUrl, timeoutMs: opts.timeoutMs })).bytes;
    const got = bytes
      ? await extractDocument(bytes, docFmt, {
          firecrawl: async () => {
            if (opts.authorizeUrl) return undefined;
            const fc = await scrapeViaFirecrawl(url, opts);
            return fc.data && (fc.data.statusCode ?? 200) < 400 ? fc.data.markdown : undefined;
          },
        })
      : { text: "", reason: "empty response body" };
    // A format that is already plain text (CSV) keeps its raw body when no
    // converter is available: it was usable before this ladder existed, so
    // refusing it would be a regression rather than a fix.
    if (!got.text && docFmt.textFallback && bytes?.length) {
      return { text: decodeBody(bytes, res.contentType), documentType: "doc", finalUrl: res.url, status: res.status, note: firecrawlNote, ...validators };
    }
    return {
      text: got.text,
      documentType: "doc",
      finalUrl: res.url,
      status: res.status,
      extractor: got.via,
      note: got.text ? firecrawlNote : `Fetched ${url} but could not extract text — ${got.reason}.`,
      ...validators,
    };
  }
  const mime = res.contentType.split(";")[0]!.trim().toLowerCase();
  const ambiguousType = !mime || mime === "application/octet-stream";
  const isHtml =
    /^(?:text\/html|application\/xhtml\+xml)$/.test(mime) ||
    (ambiguousType && /^\s*<(?:!doctype\s+html\b|html\b|head\b|body\b|article\b|main\b|p\b|h[1-6]\b)/i.test(res.body));
  const stripped = isHtml ? htmlToText(opts.fullPage ? res.body : extractMainHtml(res.body), opts) : res.body;
  const consent = isHtml && opts.stripConsent && !opts.fullPage ? stripConsentBoilerplate(stripped) : { text: stripped, dropped: 0 };
  const title = isHtml ? pageTitle(res.body) : undefined;
  const canonical = isHtml ? absoluteCanonical(htmlCanonicalUrl(res.body), res.url) : undefined;
  const metaDescription = isHtml ? metaDescriptionOf(res.body) : undefined;
  // A prefix read at the byte cap is still worth having, but never silently: a
  // caller quoting the page must be able to tell it did not see the rest.
  const cut = res.truncated ? `Read only the first ${res.bytesRead} bytes of ${url} (the response size cap), so this text is a prefix.` : undefined;
  return {
    text: consent.text,
    consentDropped: consent.dropped,
    title,
    canonical,
    metaDescription,
    ...(opts.keepHtml && isHtml ? { html: res.body } : {}),
    finalUrl: res.url,
    status: res.status,
    note: [firecrawlNote, cut].filter(Boolean).join(" ") || undefined,
    ...(res.truncated ? { truncated: true } : {}),
    ...validators,
  };
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
  opts: { acceptLanguage?: string; firecrawl?: string; authorizeUrl?: (url: string) => Promise<boolean> } = {},
): Promise<{ text: string; title?: string; snapshotUrl: string; timestamp: string } | undefined> {
  if (opts.authorizeUrl || envFlag("NO_WAYBACK")) return undefined;
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
// only the search snippet instead. A genuine article ABOUT cookies or CAPTCHAs
// is long, so the length gate never trips it.
//
// Short is not enough, though, and neither is one loose phrase. "Access denied"
// is the title of every database-error help page, and "verify you are on Node
// 18" is an install step: a phrase alone flagged them, and rescueViaWayback
// threw the good archived page away. So a pattern is STRONG — worded as only
// the wall itself words it — or weak, and a page is flagged on a strong one
// plus either a second signal or almost nothing else on the page.
const JUNK_PATTERNS: [RegExp, string, "strong" | "weak"][] = [
  [/\b(accept|manage)\s+(all\s+)?cookies\b/i, "cookie/consent wall", "strong"],
  [/\bwe use cookies\b/i, "cookie/consent wall", "strong"],
  [/\bcookie (policy|settings|consent|preferences)\b/i, "cookie/consent wall", "weak"],
  [/\b(accept|reject|allow|decline) all\b/i, "cookie/consent wall", "weak"],
  [/\b(please )?enable javascript\b/i, "JavaScript-required shell", "strong"],
  [/\bjavascript is (disabled|required|not enabled)\b/i, "JavaScript-required shell", "strong"],
  [
    /\bverify(ing)? (that )?(you are|you're) (a )?(human|not a (ro)?bot)\b|\bare you a (human|robot)\b|\bhuman verification\b/i,
    "anti-bot interstitial",
    "strong",
  ],
  [/\battention required\b.*cloudflare|\bunusual traffic from your (computer )?network\b|\bchecking your browser\b/i, "anti-bot interstitial", "strong"],
  // Akamai's and Cloudflare's denials carry an incident reference; without one
  // the phrase is as likely a permission-error article.
  [/\baccess denied\b[\s\S]{0,300}?(\breference #|\bray id\b|\bpermission to access\b)/i, "anti-bot interstitial", "strong"],
  [/\baccess denied\b|\benable cookies\b/i, "anti-bot interstitial", "weak"],
  // FR / DE (the locale layer targets non-EN markets)
  [/\bnous utilisons des cookies\b|\baccepter (tous )?les cookies\b|\bactiver javascript\b/i, "cookie/consent wall (fr)", "strong"],
  [/\bwir verwenden cookies\b|\bcookies akzeptieren\b|\bjavascript aktivieren\b/i, "cookie/consent wall (de)", "strong"],
];
export function looksLikeJunkExtraction(text: string): string | undefined {
  const t = text.trim();
  if (t.length >= 2000) return undefined; // a real article is long — never flag it
  const head = t.slice(0, 800);
  const hits = JUNK_PATTERNS.filter(([re]) => re.test(head));
  const strong = hits.find(([, , kind]) => kind === "strong");
  if (!strong) return undefined;
  if (hits.length >= 2) return strong[1];
  // A strong phrase alone decides only on a page with nothing else to it:
  // fewer than three lines of prose that no pattern accounts for.
  const prose = t.split("\n").filter((l) => l.trim().length >= 60 && !JUNK_PATTERNS.some(([re]) => re.test(l))).length;
  return prose < 3 ? strong[1] : undefined;
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
  // FR / DE: the locale layer targets those markets, and their consent
  // managers (Didomi, Usercentrics, OneTrust) speak the local language.
  /\bconsentement\b/i,
  /\brgpd\b/i,
  /\beinwilligung\b/i,
  /\bdsgvo\b/i,
];

// A short line needs a consent action or notice too — merely mentioning
// cookies must not erase an article's prose, headings or list items. Topic
// words (cookie, consent, GDPR, CCPA) are deliberately absent: they already
// count as the hit, and an article ABOUT the GDPR names it in short lines.
const CONSENT_ACTIONS = [
  /\b(?:accept|reject|decline|agree|allow|manage|preferences|settings|choices)\b/i,
  /\b(?:opt[ -]out|we use cookies|this (?:site|website) uses cookies|by continuing)\b/i,
  /\b(?:learn more|privacy policy|cookie policy)\b/i,
];

// The banner speaking about ITSELF: first person using or storing cookies, or
// the "by clicking / by continuing" clause. An article about cookies is written
// in the third person ("a site must obtain consent"), which is what lets a long
// line be judged at all. The gap is bounded so the scan stays linear on a line
// full of "we".
const BANNER_VOICE =
  /\b(?:we|us|our)\b[^.]{0,60}?\b(?:cookies?|partners|consent|tracking)\b|\bby (?:clicking|continuing|using|browsing)\b|\bthis (?:site|website) uses cookies\b|\bnous (?:utilisons|et nos partenaires)\b|\ben cliquant sur\b|\bwir (?:verwenden|nutzen|setzen|und unsere partner)\b|\bmit (?:dem )?klick auf\b/i;

// FR / DE button labels, matched as the WHOLE line. Only multi-word labels: a
// bare "Einstellungen" or "Accepter" is just as likely a heading in the article.
const BUTTON_LABEL =
  /^(?:tout (?:accepter|refuser)|(?:accepter|refuser) tout|accepter et (?:fermer|continuer)|continuer sans accepter|(?:param[ée]trer|g[ée]rer|personnaliser|accepter|refuser) (?:les|mes) cookies|alle (?:cookies )?(?:akzeptieren|ablehnen)|nur (?:notwendige|essenzielle)(?: cookies)?|cookie-einstellungen|einstellungen verwalten|akzeptieren und schlie(?:ß|ss)en)$/i;

// A line this short is a button or a label, not a sentence anyone would cite.
const BUTTON_LENGTH = 40;
// Banner voice is only trusted this far: a paragraph longer than a banner's own
// notice is more likely prose that happens to use "we".
const NOTICE_LENGTH = 400;

/**
 * Drop consent-banner lines from extracted text, and say how many went.
 *
 * Deliberately conservative, because this must never quietly delete the
 * paragraph someone wanted to cite. A line goes when it is:
 *
 * - a known FR/DE button label, the whole line;
 * - button-length and either names two consent topics ("Accept all cookies")
 *   or names one next to a consent action ("Cookie settings");
 * - a notice in the banner's own voice ("We use cookies…", "By clicking…")
 *   that names a consent topic.
 *
 * Counting topic words alone is not enough on a longer line: an article about
 * the GDPR names two of them per sentence, and a recipe says "allow the cookies
 * to cool".
 */
export function stripConsentBoilerplate(text: string): { text: string; dropped: number } {
  let dropped = 0;
  const kept = text.split("\n").filter((line) => {
    const t = line.trim();
    const hits = CONSENT_PATTERNS.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);
    const isBanner =
      BUTTON_LABEL.test(t) ||
      (hits >= 1 && t.length <= BUTTON_LENGTH && (hits >= 2 || CONSENT_ACTIONS.some((re) => re.test(t)))) ||
      (hits >= 1 && t.length < NOTICE_LENGTH && BANNER_VOICE.test(t));
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
  let og: string | undefined;
  for (const match of html.matchAll(/<meta\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const attrs = htmlAttributes(match[0]);
    const value = attrs.get("content")?.replace(/\s+/g, " ").trim();
    if (!value) continue;
    if (attrs.get("name")?.toLowerCase() === "description") return decodeEntities(value);
    if (attrs.get("property")?.toLowerCase() === "og:description" && og === undefined) og = decodeEntities(value);
  }
  return og;
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
