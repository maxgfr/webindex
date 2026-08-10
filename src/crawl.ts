// Being a good guest, and walking a site on purpose.
//
// Two things that belong together, because the second is the reason the first
// finally has to be enforced rather than merely parsed.
//
// The politeness half closes a gap that has been open since robots.txt landed:
// `Robots.crawlDelayMs` is read out of the file and NOTHING has ever applied
// it. Meanwhile src/pool.ts bounds concurrency globally, so ten URLs that
// happen to share a host all leave at once — which is exactly the shape that
// earns a 429, and the shape a `Crawl-delay` exists to prevent. A per-host
// token bucket makes the delay a property of the fetch rather than a number
// sitting in a struct.
//
// The walking half is the caller robots.txt has always been waiting for.
// SKILL.md draws the line: following one citation is not crawling, so `fetch`
// deliberately does not consult robots — but ENUMERATING a site is, and a
// caller that enumerates should ask. `crawlSite` is that caller, so it asks at
// every hop, and it is bounded in three independent ways because an unbounded
// crawl is the one operation here that can inconvenience somebody else's
// server.

import { envInt } from "./brand.js";
import { fetchAndExtract, sleep } from "./fetch.js";
import { fetchSitemap } from "./feed.js";
import { fetchRobots, isAllowed } from "./robots.js";
import { canonicalizeUrl } from "./url.js";

// ── Per-host politeness ─────────────────────────────────────────────────────

/** Next allowed departure time per host, in ms since the epoch. */
const nextFree = new Map<string, number>();

/** Test seam. Never call this from product code — in-flight waiters would bunch up. */
export function resetHostSchedule(): void {
  nextFree.clear();
}

/**
 * The floor between two requests to the SAME host, when robots.txt declares no
 * `Crawl-delay` of its own.
 *
 * Deliberately the same knob `httpGet` already used for its inter-request
 * pause, so a consumer that had tuned politeness keeps one number to tune.
 */
export function hostDelayMs(): number {
  return envInt("POLITE_DELAY_MS", 400, 0, 5000);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Wait until this host is willing to hear from us again, then claim the slot.
 *
 * The claim happens BEFORE the await returns, so two concurrent callers for one
 * host serialise instead of both reading the same free time and departing
 * together — which is the bug a naive "sleep if too soon" has, and the one that
 * makes a rate limiter look like it works right up until the pool widens.
 *
 * Different hosts never wait on each other: the whole point is to keep
 * concurrency high across a candidate list while staying single-file per site.
 */
export async function awaitHostSlot(url: string, delayMs: number = hostDelayMs(), now: number = Date.now()): Promise<number> {
  const host = hostOf(url);
  if (!host || delayMs <= 0) return 0;
  const free = nextFree.get(host) ?? 0;
  const waited = Math.max(0, free - now);
  nextFree.set(host, Math.max(free, now) + delayMs);
  if (waited > 0) await sleep(waited);
  return waited;
}

/**
 * Push a host's next departure out by `ms` — what a `Retry-After` means.
 *
 * `httpGet` already honours Retry-After for the request that received it; this
 * is how that answer applies to every OTHER request queued for the same host,
 * which is the difference between backing off and backing off once.
 */
export function backOffHost(url: string, ms: number, now: number = Date.now()): void {
  const host = hostOf(url);
  if (!host || ms <= 0) return;
  nextFree.set(host, Math.max(nextFree.get(host) ?? 0, now + ms));
}

// ── Walking a site ──────────────────────────────────────────────────────────

export interface CrawlOptions {
  /** Hard ceiling on pages fetched. Required in spirit; defaulted low on purpose. */
  maxPages?: number;
  /** How many links deep to follow. The seed is depth 0. */
  maxDepth?: number;
  /** Leave the seed's origin. Off by default — a crawl that wanders is not a site walk. */
  crossOrigin?: boolean;
  /** Seed the frontier from the site's sitemap as well as the seed page. Default true. */
  useSitemap?: boolean;
  /** Ignore robots.txt. For a site you own, and named so it cannot happen by accident. */
  ignoreRobots?: boolean;
  /** Per-host delay override. Otherwise robots' own Crawl-delay, else hostDelayMs(). */
  delayMs?: number;
  /** Called as each page lands, so a caller can stream rather than wait for the whole walk. */
  onPage?(page: CrawledPage): void;
}

export interface CrawledPage {
  url: string;
  depth: number;
  title?: string;
  text: string;
  extractor: string;
  /** Links found on this page, already absolute and canonicalised. */
  links: string[];
}

export interface CrawlResult {
  pages: CrawledPage[];
  /** URLs that were in scope but never fetched — the budget ran out. */
  pending: string[];
  /** URLs robots.txt refused. Reported rather than hidden: a silent skip reads as "not there". */
  disallowed: string[];
  notes: string[];
}

/** Absolute, canonical links out of a page's HTML. */
export function linksFrom(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*["']([^"'#]+)["']/gi)) {
    const raw = (m[1] as string).trim();
    // A mailto:, tel: or javascript: href is not a page. `new URL` would happily
    // accept the first two and hand back something no fetch can use.
    if (/^(mailto|tel|javascript|data):/i.test(raw)) continue;
    try {
      const abs = new URL(raw, baseUrl);
      if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
      abs.hash = "";
      const canon = canonicalizeUrl(abs.href);
      if (!seen.has(canon)) {
        seen.add(canon);
        out.push(abs.href);
      }
    } catch {
      /* a malformed href is not a link */
    }
  }
  return out;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.protocol === y.protocol && x.host === y.host;
  } catch {
    return false;
  }
}

/**
 * Walk a site from a seed, breadth-first.
 *
 * Bounded three independent ways — pages, depth, and origin — because any one
 * of them alone leaves a hole: a depth limit still admits a combinatorial
 * frontier, a page limit alone will spend the whole budget on a paginated
 * archive, and neither stops a link out to an unrelated host.
 *
 * robots.txt is consulted at EVERY hop, not once for the seed. That is the
 * difference between this and `fetch`, and it is deliberate: `fetch` follows a
 * URL the caller was handed, which is not crawling; this enumerates, which is.
 * A refused URL is reported in `disallowed` rather than dropped, because a
 * silent skip is indistinguishable from a page that does not exist.
 *
 * Breadth-first, so a shallow budget returns the pages nearest the seed — the
 * ones a reader would have reached first — rather than one deep spur.
 */
export async function crawlSite(seed: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const maxPages = Math.max(1, opts.maxPages ?? 20);
  const maxDepth = Math.max(0, opts.maxDepth ?? 2);
  const notes: string[] = [];
  const disallowed: string[] = [];
  const pages: CrawledPage[] = [];

  let robots = { rules: [], sitemaps: [], absent: true } as Awaited<ReturnType<typeof fetchRobots>>;
  if (!opts.ignoreRobots) {
    robots = await fetchRobots(seed);
    if (robots.absent) notes.push("no robots.txt — nothing was refused, but nothing was granted either.");
  } else {
    notes.push("robots.txt was not consulted (ignoreRobots) — only correct on a site you own.");
  }
  const delay = opts.delayMs ?? robots.crawlDelayMs ?? hostDelayMs();
  if (robots.crawlDelayMs && opts.delayMs === undefined) notes.push(`honouring the declared Crawl-delay of ${robots.crawlDelayMs}ms.`);

  const seen = new Set<string>([canonicalizeUrl(seed)]);
  const queue: { url: string; depth: number }[] = [{ url: seed, depth: 0 }];

  // The sitemap is the site's own statement of what it wants found, so it is a
  // better frontier than whatever the seed page happens to link to — and it
  // costs one request. Seeded at depth 1 so `maxDepth: 0` still means "the seed
  // page only".
  if (opts.useSitemap !== false && maxDepth > 0) {
    const sm = await fetchSitemap(seed, { sitemaps: robots.sitemaps });
    let added = 0;
    for (const entry of sm.urls) {
      const canon = canonicalizeUrl(entry.loc);
      if (seen.has(canon)) continue;
      if (!opts.crossOrigin && !sameOrigin(entry.loc, seed)) continue;
      seen.add(canon);
      queue.push({ url: entry.loc, depth: 1 });
      added++;
    }
    if (added) notes.push(`seeded ${added} URL(s) from the sitemap.`);
  }

  while (queue.length && pages.length < maxPages) {
    const next = queue.shift();
    if (!next) break;

    if (!opts.ignoreRobots && !isAllowed(robots, next.url)) {
      disallowed.push(next.url);
      continue;
    }

    await awaitHostSlot(next.url, delay);
    const r = await fetchAndExtract(next.url, { keepHtml: next.depth < maxDepth });
    if (!r.text) {
      notes.push(`${next.url}: ${r.note ?? "nothing readable"}`);
      continue;
    }

    const links = r.html ? linksFrom(r.html, next.url) : [];
    const page: CrawledPage = {
      url: next.url,
      depth: next.depth,
      ...(r.title ? { title: r.title } : {}),
      text: r.text,
      extractor: r.extractor ?? "native",
      links,
    };
    pages.push(page);
    opts.onPage?.(page);

    if (next.depth >= maxDepth) continue;
    for (const link of links) {
      const canon = canonicalizeUrl(link);
      if (seen.has(canon)) continue;
      if (!opts.crossOrigin && !sameOrigin(link, seed)) continue;
      seen.add(canon);
      queue.push({ url: link, depth: next.depth + 1 });
    }
  }

  // Say what was left rather than implying the site was exhausted. A budget
  // that ran out and a site that ended look identical from the outside.
  if (queue.length) notes.push(`stopped at the ${maxPages}-page budget with ${queue.length} URL(s) still queued.`);

  return { pages, pending: queue.map((q) => q.url), disallowed, notes };
}
