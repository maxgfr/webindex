import { brand, env, envFlag } from "./brand.js";
import { httpGet } from "./fetch.js";

// robots.txt: asking whether a URL is ours to fetch.
//
// Nothing in this engine, or in anything built on it, consulted robots.txt
// before this. That is a real gap for a tool whose job is retrieving other
// people's pages at machine speed — politeness was a delay and a retry, which
// keeps you from hurting a site but says nothing about whether it asked to be
// left alone.
//
// Deliberately ADVISORY. `isAllowed` answers a question; it does not gate
// `fetchAndExtract`. A user fetching one URL they were handed is not crawling,
// and a tool that silently refused a page a human asked for would be worse than
// one that never checked. Callers that crawl should ask; callers that follow a
// citation need not.
//
// The parser follows RFC 9309: longest matching rule wins, Allow beats Disallow
// on an equal-length tie, wildcards `*` and `$` supported, paths compared after
// percent-encoding normalisation.

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface Robots {
  /** Rules for the group that best matches our agent, most specific first. */
  rules: RobotsRule[];
  /** `Crawl-delay` for our group, in ms, when one was declared. */
  crawlDelayMs?: number;
  /** Every `Sitemap:` line — they are file-level, not per-group. */
  sitemaps: string[];
  /** True when there was no file to read (a 4xx, or an empty one), which means "allowed". */
  absent: boolean;
  /** The status robots.txt answered with; 0 when no answer came. Absent when it was never requested. */
  status?: number;
  /**
   * The server errored (5xx, 429) or never answered. RFC 9309 §2.3.1.4: the
   * crawler MUST then assume complete disallow, so `rules` holds `Disallow: /`.
   */
  unreachable?: boolean;
}

const EMPTY: Robots = { rules: [], sitemaps: [], absent: true };

// A User-agent line names a product token: the letters, `_` and `-` before any
// `/version` or comment. RFC 9309 §2.2.1 matches it case-insensitively, and
// exactly — a substring of our name is somebody else's crawler.
function productToken(s: string): string | undefined {
  return /^[A-Za-z_-]+/.exec(s.trim())?.[0]?.toLowerCase();
}

/**
 * Parse a robots.txt for one user-agent token.
 *
 * Group selection follows the spec's precedence: the group naming our product
 * token wins, and `*` is the fallback. A file with no group for us and no `*`
 * group imposes nothing. A full User-Agent string is reduced to its product
 * token (`MyBot/2.1 (compatible; …)` is `mybot`), the same way the file's lines are.
 */
export function parseRobots(body: string, userAgent: string): Robots {
  const ua = productToken(userAgent) ?? userAgent.trim().toLowerCase();
  const groups = new Map<string, RobotsRule[]>();
  const delays = new Map<string, number>();
  const sitemaps: string[] = [];

  let current: string[] = [];
  // Consecutive User-agent lines share one group; the first rule line after
  // them closes the header and starts the body.
  let inHeader = false;

  // A bare CR is an end of line too (RFC 9309's EOL): an old Mac-style file
  // would otherwise be one User-agent line whose value swallowed every rule.
  for (const raw of body.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!inHeader) current = [];
      const token = value === "*" ? "*" : productToken(value);
      if (token) current.push(token);
      inHeader = true;
      for (const g of current) if (!groups.has(g)) groups.set(g, []);
      continue;
    }
    inHeader = false;
    if (!current.length) continue;
    if (field === "allow" || field === "disallow") {
      for (const g of current) groups.get(g)!.push({ allow: field === "allow", path: value });
    } else if (field === "crawl-delay") {
      // `Number("")` is 0: an empty value would silently remove the default floor.
      const n = value === "" ? Number.NaN : Number(value);
      if (Number.isFinite(n) && n >= 0) for (const g of current) delays.set(g, n * 1000);
    }
  }

  const chosen = groups.has(ua) ? ua : groups.has("*") ? "*" : undefined;
  // A file with no group for us and no `*` group imposes nothing — but it is
  // still a file that was read, which is not the same as one that was missing.
  if (chosen === undefined) return { rules: [], sitemaps, absent: false };

  // Longest path first, so the winning rule is the first match; Allow wins an
  // equal-length tie, as the spec requires. Length is measured on the
  // normalised pattern, the form that is actually compared.
  const rules = [...groups.get(chosen)!].sort((a, b) => matcherOf(b).length - matcherOf(a).length || (a.allow === b.allow ? 0 : a.allow ? -1 : 1));
  const crawlDelayMs = delays.get(chosen);
  return { rules, sitemaps, absent: false, ...(crawlDelayMs !== undefined ? { crawlDelayMs } : {}) };
}

// ── Matching ────────────────────────────────────────────────────────────────

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
const HEX2 = /^[0-9A-Fa-f]{2}$/;

/**
 * One canonical spelling of a path, applied to rules and URLs alike.
 *
 * WHATWG's `pathname` percent-encodes non-ASCII but leaves `~` alone, while a
 * robots.txt may write either form: `Disallow: /café` never matched
 * /caf%C3%A9, nor `/%7Ejoe` /~joe. So an escape of an unreserved character is
 * decoded, every other escape has its hex upper-cased, and whatever a URL could
 * not carry unescaped — non-ASCII, controls, space, `"<>\`{}|\\^` — is encoded
 * as UTF-8. `*` and `$` pass through, so a rule keeps its wildcards.
 */
function normalisePath(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "%" && HEX2.test(s.slice(i + 1, i + 3))) {
      const hex = s.slice(i + 1, i + 3);
      const ch = String.fromCharCode(Number.parseInt(hex, 16));
      out += UNRESERVED.test(ch) ? ch : `%${hex.toUpperCase()}`;
      i += 2;
      continue;
    }
    const code = c.charCodeAt(0);
    if (code > 0x20 && code < 0x7f && !'"<>`{}|\\^'.includes(c)) {
      out += c;
      continue;
    }
    // One code point, which may be a surrogate pair. A lone surrogate cannot
    // be encoded, and is what the URL parser would have made of it anyway.
    const cp = s.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    try {
      out += encodeURIComponent(ch);
    } catch {
      out += "%EF%BF%BD";
    }
    i += ch.length - 1;
  }
  return out;
}

interface Matcher {
  /** The literal runs between `*`s. */
  parts: string[];
  /** A trailing `$`: the pattern must reach the end of the path. */
  anchored: boolean;
  /** The normalised pattern's length — what "longest match" measures. */
  length: number;
}

// Compiled once per rule, and kept off the rule itself so a Robots stays the
// plain data a caller may build, compare or serialise.
const matchers = new WeakMap<RobotsRule, Matcher>();

function matcherOf(rule: RobotsRule): Matcher {
  let m = matchers.get(rule);
  if (!m) {
    const pattern = normalisePath(rule.path);
    const anchored = pattern.endsWith("$");
    m = { parts: (anchored ? pattern.slice(0, -1) : pattern).split("*"), anchored, length: pattern.length };
    matchers.set(rule, m);
  }
  return m;
}

/**
 * Does a compiled pattern match `path`?
 *
 * Linear, with no backtracking. A pattern used to become a RegExp — `.*` per
 * `*` — and `/*a*a*a*a*a$` against a long run of `a`s backtracked O(L^k): one
 * call took seconds, with both inputs chosen by the site being crawled. Here
 * each literal run is placed at its leftmost occurrence after the previous one,
 * which is optimal for `*`-only globs: an earlier placement never rules out a
 * match a later one would allow. Only an anchored final run is pinned to the
 * end. Each run is searched once, so the cost is bounded by path × pattern.
 */
function matches(m: Matcher, path: string): boolean {
  const { parts, anchored } = m;
  const first = parts[0]!;
  if (!path.startsWith(first)) return false;
  if (parts.length === 1) return !anchored || path.length === first.length;
  let pos = first.length;
  const last = parts.length - 1;
  for (let i = 1; i < last; i++) {
    const at = path.indexOf(parts[i]!, pos);
    if (at < 0) return false;
    pos = at + parts[i]!.length;
  }
  const tail = parts[last]!;
  return anchored ? path.length - tail.length >= pos && path.endsWith(tail) : path.indexOf(tail, pos) >= 0;
}

/**
 * Does this robots.txt permit fetching `url`?
 *
 * An absent file means yes — that is what the spec says. An unreachable one
 * means no, which is also what the spec says: its rules are `Disallow: /`.
 */
export function isAllowed(robots: Robots, url: string): boolean {
  if (!robots.rules.length) return true;
  let path: string;
  try {
    const u = new URL(url);
    path = normalisePath(u.pathname + u.search);
  } catch {
    return true;
  }
  for (const rule of robots.rules) {
    // `Disallow:` with no value permits everything.
    if (rule.path !== "" && matches(matcherOf(rule), path)) return rule.allow;
  }
  return true;
}

// ── Fetching ────────────────────────────────────────────────────────────────

// RFC 9309 §2.4: do not use a cached copy for more than 24 hours. A failure is
// kept only long enough that a crawl does not re-ask on every page; a server
// that recovers is read again within minutes, even by a long-running MCP server.
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const UNREACHABLE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  robots: Promise<Robots>;
  /** In flight until it resolves, which is reused by everyone who asks meanwhile. */
  expires: number;
}

const cache = new Map<string, CacheEntry>();
type UrlAuthorizer = (url: string) => Promise<boolean>;
let guardedCaches = new WeakMap<UrlAuthorizer, Map<string, CacheEntry>>();

/** Test seam: forget every fetched robots.txt. */
export function resetRobotsCache(): void {
  cache.clear();
  guardedCaches = new WeakMap();
}

/** Read and classify one origin's robots.txt, by what RFC 9309 says each outcome means. */
async function readRobots(origin: string, authorize: UrlAuthorizer | undefined): Promise<Robots> {
  // A redirect our own policy refused is not the server failing: the spec lets
  // a crawler that will not follow a redirect treat the file as unavailable.
  let refused = false;
  const authorizeUrl =
    authorize &&
    (async (u: string) => {
      const ok = await authorize(u);
      if (!ok) refused = true;
      return ok;
    });
  const r = await httpGet(`${origin}/robots.txt`, { accept: "text/plain", timeoutMs: 5000, maxBytes: 512 * 1024, authorizeUrl });
  if (r.ok) {
    // RFC 9309 §2.5 asks for at least the first 500 KiB of a larger file. The
    // last line of that prefix was cut at the cap, and half a rule — `/pri`
    // for `/private-archive` — is a different rule.
    const body = r.truncated ? r.body.slice(0, Math.max(r.body.lastIndexOf("\n"), r.body.lastIndexOf("\r")) + 1) : r.body;
    if (!body.trim()) return { ...EMPTY, status: r.status };
    return { ...parseRobots(body, env("ROBOTS_UA") ?? brand().name), status: r.status };
  }
  // 4xx: there is no file, so there are no restrictions. A 5xx, a 429 or no
  // answer at all is the server failing, not the file missing, and a crawler
  // MUST then assume complete disallow — this is the enumerating caller's
  // answer, and treating an erroring origin as permission is what the RFC
  // forbids. `fetch` never asks, so a citation still does not depend on it.
  if (!refused && (r.status === 0 || r.status === 429 || r.status >= 500)) {
    return { rules: [{ allow: false, path: "/" }], sitemaps: [], absent: false, status: r.status, unreachable: true };
  }
  return { ...EMPTY, status: r.status };
}

/**
 * Fetch and parse the robots.txt governing `url`, memoised per origin.
 *
 * Memoised because the alternative is one extra request per page fetched, which
 * is precisely the kind of load robots.txt exists to prevent — for a day at
 * most, and for a few minutes when the file was unreachable. Disabled entirely
 * by `<PREFIX>_NO_ROBOTS`, for an operator who knows they are crawling their
 * own site.
 */
export async function fetchRobots(url: string, opts: { authorizeUrl?: UrlAuthorizer } = {}): Promise<Robots> {
  if (envFlag("NO_ROBOTS")) return EMPTY;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return EMPTY;
  }
  // Policy-bearing reads must not reuse results fetched under a different
  // policy. Weak keys keep per-crawl caches collectible after the walk ends.
  let scopedCache = cache;
  if (opts.authorizeUrl) {
    const existing = guardedCaches.get(opts.authorizeUrl);
    scopedCache = existing ?? new Map();
    if (!existing) guardedCaches.set(opts.authorizeUrl, scopedCache);
  }
  const hit = scopedCache.get(origin);
  if (hit && hit.expires > Date.now()) return hit.robots;
  const entry: CacheEntry = { robots: readRobots(origin, opts.authorizeUrl), expires: Number.POSITIVE_INFINITY };
  scopedCache.set(origin, entry);
  const robots = await entry.robots;
  entry.expires = Date.now() + (robots.unreachable ? UNREACHABLE_TTL_MS : ROBOTS_TTL_MS);
  return robots;
}
