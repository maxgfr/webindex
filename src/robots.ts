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
// The parser is the classic prefix-match one: longest matching rule wins, Allow
// beats Disallow on an equal-length tie, wildcards `*` and `$` supported.

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
  /** True when the file could not be read at all (which means "allowed"). */
  absent: boolean;
}

const EMPTY: Robots = { rules: [], sitemaps: [], absent: true };

/**
 * Parse a robots.txt for one user-agent token.
 *
 * Group selection follows the spec's precedence: the most specific matching
 * `User-agent` wins, and `*` is the fallback. A file with no group for us and no
 * `*` group imposes nothing.
 */
export function parseRobots(body: string, userAgent: string): Robots {
  const ua = userAgent.toLowerCase();
  const groups = new Map<string, RobotsRule[]>();
  const delays = new Map<string, number>();
  const sitemaps: string[] = [];

  let current: string[] = [];
  // Consecutive User-agent lines share one group; the first rule line after
  // them closes the header and starts the body.
  let inHeader = false;

  for (const raw of body.split(/\r?\n/)) {
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
      current.push(value.toLowerCase());
      inHeader = true;
      for (const g of current) if (!groups.has(g)) groups.set(g, []);
      continue;
    }
    inHeader = false;
    if (!current.length) continue;
    if (field === "allow" || field === "disallow") {
      for (const g of current) groups.get(g)!.push({ allow: field === "allow", path: value });
    } else if (field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) for (const g of current) delays.set(g, n * 1000);
    }
  }

  // Most specific matching group: an exact-ish token match beats `*`.
  let chosen: string | undefined;
  for (const g of groups.keys()) {
    if (g === "*") continue;
    if (ua.includes(g) && (!chosen || g.length > chosen.length)) chosen = g;
  }
  chosen ??= groups.has("*") ? "*" : undefined;
  // A file with no group for us and no `*` group imposes nothing — but it is
  // still a file that was read, which is not the same as one that was missing.
  if (chosen === undefined) return { rules: [], sitemaps, absent: false };

  // Longest path first, so the winning rule is the first match; Allow wins an
  // equal-length tie, as the spec requires.
  const rules = [...groups.get(chosen)!].sort((a, b) => b.path.length - a.path.length || (a.allow === b.allow ? 0 : a.allow ? -1 : 1));
  const crawlDelayMs = delays.get(chosen);
  return { rules, sitemaps, absent: false, ...(crawlDelayMs !== undefined ? { crawlDelayMs } : {}) };
}

// A robots path is a prefix pattern: `*` matches any run, `$` anchors the end.
function ruleMatches(pattern: string, path: string): boolean {
  if (pattern === "") return false; // `Disallow:` with no value permits everything
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  if (!body.includes("*")) return anchored ? path === body : path.startsWith(body);
  const re = new RegExp(`^${body.split("*").map(escapeRe).join(".*")}${anchored ? "$" : ""}`);
  return re.test(path);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does this robots.txt permit fetching `url`?
 *
 * An absent or unparseable file means yes — that is what the spec says, and it
 * is also the only safe default for a tool that must not turn a network hiccup
 * into "this site is off limits".
 */
export function isAllowed(robots: Robots, url: string): boolean {
  if (robots.absent || !robots.rules.length) return true;
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return true;
  }
  for (const rule of robots.rules) if (ruleMatches(rule.path, path)) return rule.allow;
  return true;
}

const cache = new Map<string, Promise<Robots>>();

/** Test seam: forget every fetched robots.txt. */
export function resetRobotsCache(): void {
  cache.clear();
}

/**
 * Fetch and parse the robots.txt governing `url`, memoised per origin.
 *
 * Memoised because the alternative is one extra request per page fetched, which
 * is precisely the kind of load robots.txt exists to prevent. Disabled entirely
 * by `<PREFIX>_NO_ROBOTS`, for an operator who knows they are crawling their own
 * site.
 */
export async function fetchRobots(url: string): Promise<Robots> {
  if (envFlag("NO_ROBOTS")) return EMPTY;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return EMPTY;
  }
  let p = cache.get(origin);
  if (!p) {
    p = (async () => {
      const r = await httpGet(`${origin}/robots.txt`, { accept: "text/plain", timeoutMs: 5000, maxBytes: 512 * 1024 });
      // 4xx means no robots.txt, which means no restrictions. A 5xx arguably
      // means "unknown", but treating a flaky origin as forbidden would make
      // retrieval depend on somebody else's uptime.
      if (!r.ok || !r.body.trim()) return EMPTY;
      return parseRobots(r.body, env("ROBOTS_UA") ?? brand().name);
    })();
    cache.set(origin, p);
  }
  return p;
}
