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
// every hop, and it is bounded in four independent ways because an unbounded
// crawl is the one operation here that can inconvenience somebody else's
// server.

import { envFlag, envInt, envName } from "./brand.js";
import { decodeEntities, type ExtractResult, fetchAndExtract, sleep } from "./fetch.js";
import { fetchSitemap, type Sitemap } from "./feed.js";
import { mapLimit } from "./pool.js";
import { dropElements, htmlAttributes, RAW_TEXT_ELEMENTS } from "./html.js";
import { fetchRobots, isAllowed, type Robots } from "./robots.js";
import { canonicalizeUrl } from "./url.js";

// ── Per-host politeness ─────────────────────────────────────────────────────

/** Next allowed departure time per host, in ms since the epoch. */
const nextFree = new Map<string, number>();
/** Until when a host asked us to stay away (Retry-After), in ms since the epoch. */
const holdUntil = new Map<string, number>();

/** Test seam. Never call this from product code — in-flight waiters would bunch up. */
export function resetHostSchedule(): void {
  nextFree.clear();
  holdUntil.clear();
}

// setTimeout holds at most 2^31-1 ms; a longer delay fires after 1 ms with a
// warning, so a site asking for a very long wait would get none at all.
const MAX_TIMER_MS = 2 ** 31 - 1;

async function sleepFor(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= MAX_TIMER_MS) await sleep(Math.min(left, MAX_TIMER_MS));
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

/**
 * The longest `Crawl-delay` a crawl will wait out (`<PREFIX>_MAX_CRAWL_DELAY_MS`,
 * default 60 s). A host that asks for more is not crawled, and a note says so:
 * `Crawl-delay: 3600` honoured literally stalls a walk for an hour per page,
 * and none of the ways of not honouring it is polite.
 */
export function maxCrawlDelayMs(): number {
  return envInt("MAX_CRAWL_DELAY_MS", 60_000, 0, MAX_TIMER_MS);
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
 * A back-off (backOffHost) holds every departure, with or without a delay, and
 * is checked again after each sleep: a slot claimed before the server said
 * "not now" must not go out inside the window it asked for.
 *
 * Different hosts never wait on each other: the whole point is to keep
 * concurrency high across a candidate list while staying single-file per site.
 */
export async function awaitHostSlot(url: string, delayMs: number = hostDelayMs(), now: number = Date.now()): Promise<number> {
  const host = hostOf(url);
  if (!host) return 0;
  const spaced = delayMs > 0;
  let waited = 0;
  let t = now;
  for (;;) {
    const hold = holdUntil.get(host) ?? 0;
    const free = spaced ? Math.max(nextFree.get(host) ?? 0, hold) : hold;
    const wait = Math.max(0, free - t);
    if (spaced) nextFree.set(host, Math.max(free, t) + delayMs);
    if (wait === 0) return waited;
    await sleepFor(wait);
    waited += wait;
    t = Date.now();
    if ((holdUntil.get(host) ?? 0) <= t) return waited;
  }
}

/**
 * Hold a host's departures for `ms` — what a `Retry-After` means.
 *
 * `httpGet` already honours Retry-After for the request that received it; this
 * is how that answer applies to every OTHER request queued for the same host,
 * which is the difference between backing off and backing off once.
 */
export function backOffHost(url: string, ms: number, now: number = Date.now()): void {
  const host = hostOf(url);
  if (!host || !(ms > 0)) return;
  holdUntil.set(host, Math.max(holdUntil.get(host) ?? 0, now + ms));
}

// ── Walking a site ──────────────────────────────────────────────────────────

export interface CrawlOptions {
  /**
   * Ceiling on pages RETURNED. Required in spirit; defaulted low on purpose.
   *
   * A URL that yields no readable text costs a request but no slot, so the walk
   * goes on to the next URL rather than hand back a fraction of the asked-for
   * pages — up to `maxRequests`, which is what keeps a site answering 404s from
   * being asked for every URL its sitemap lists.
   */
  maxPages?: number;
  /**
   * Ceiling on page REQUESTS, failed ones included (default 3 × maxPages).
   * robots.txt and sitemap reads are not counted here: they are bounded on
   * their own, one per origin and a few documents.
   */
  maxRequests?: number;
  /** How many links deep to follow. The seed is depth 0. */
  maxDepth?: number;
  /**
   * Leave the crawl's origin. Off by default — a crawl that wanders is not a
   * site walk. The origin is the seed's, or wherever the seed's own redirect
   * lands (http→https, apex→www): that is the site the caller named.
   */
  crossOrigin?: boolean;
  /**
   * Seed the frontier from the site's sitemap as well as the seed page. Default
   * true. For a seed below the root (`/docs/`, or `/docs`), only the sitemap's
   * entries under that path are taken, after the seed's own links.
   */
  useSitemap?: boolean;
  /** Only follow URLs whose path starts with this (`/docs/`): links and sitemap entries alike. The seed itself is always read. */
  prefix?: string;
  /** Ignore robots.txt. For a site you own, and named so it cannot happen by accident. */
  ignoreRobots?: boolean;
  /** Per-host delay override. Otherwise robots' own Crawl-delay, else hostDelayMs(). */
  delayMs?: number;
  /**
   * Called as each page lands, so a caller can stream rather than wait for the
   * whole walk. Fires in frontier order — the same order as `pages` — however
   * the fetches interleaved.
   */
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

// The opening tags that carry a page's links, and the one that says what they
// are relative to. Quote-aware, and linear for the reason TAG_RE in html.ts is:
// an unquoted run stops at `<` as well as `>`, so each opener is one short look.
// `<a\b[^>]*?\bhref…` rescanned to the end of the page from every `<a` start
// on a page of unclosed ones — 400 KB of `<a x` took ten seconds of CPU.
const LINK_TAG_RE = /<(a|area|base)(?=[\s/>])[^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/gi;

// Anchors that are not on the page: inside a script's strings, a style, an
// inert <template>. Comments go in the same pass (see dropElements).
const INERT_ELEMENTS = ["script", "style", "template"];

/**
 * Absolute, canonical links out of a page's HTML: `<a href>` and `<area href>`,
 * resolved against the page's `<base href>` when it has one.
 *
 * Attributes are read by exact name, quoted or not — `href=/about` is valid
 * HTML that minifiers emit everywhere, and a `data-href` is not an `href`.
 */
export function linksFrom(html: string, baseUrl: string): string[] {
  let base = baseUrl;
  let sawBase = false;
  const hrefs: string[] = [];
  for (const m of dropElements(html, INERT_ELEMENTS, RAW_TEXT_ELEMENTS).matchAll(LINK_TAG_RE)) {
    const href = htmlAttributes(m[0]).get("href");
    if (href === undefined) continue;
    const raw = decodeEntities(href).trim();
    if (m[1]!.toLowerCase() !== "base") {
      hrefs.push(raw);
      continue;
    }
    // The first <base href> sets the document's base, wherever it sits
    // relative to the links, and is itself resolved against the page's URL.
    if (sawBase) continue;
    sawBase = true;
    try {
      base = new URL(raw, baseUrl).href;
    } catch {
      /* a base we cannot resolve leaves the page's own URL in charge */
    }
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of hrefs) {
    if (!raw || raw.startsWith("#")) continue;
    // A mailto:, tel: or javascript: href is not a page. `new URL` would happily
    // accept the first two and hand back something no fetch can use.
    if (/^(mailto|tel|javascript|data):/i.test(raw)) continue;
    try {
      const abs = new URL(raw, base);
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

/** The same site under another spelling: `http:` upgraded to `https:`, or with or without `www.`. */
function sameSite(url: string, origin: string): boolean {
  try {
    const a = new URL(url);
    const b = new URL(origin);
    const bare = (host: string) => host.replace(/^www\./, "");
    const scheme = a.protocol === b.protocol || (b.protocol === "http:" && a.protocol === "https:");
    return scheme && a.port === b.port && bare(a.hostname) === bare(b.hostname);
  } catch {
    return false;
  }
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/**
 * The part of a site a seed names: `/docs/` for `/docs/`, `/docs` or
 * `/docs/intro.html`; `/` for the root. A last segment without an extension
 * reads as a directory, since that is how a section is usually linked.
 */
function sectionOf(url: string): string {
  const path = pathOf(url) || "/";
  const cut = path.lastIndexOf("/");
  const last = path.slice(cut + 1);
  return last && !last.includes(".") ? `${path}/` : path.slice(0, cut + 1);
}

// Links a crawl never spends a request on: images, media, fonts, archives,
// executables, stylesheets and scripts are not pages, and at best cost a
// request to learn so. PDFs and office documents are documents, and stay.
const NOT_A_PAGE_RE =
  /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg|tiff?|heic|mp3|m4a|aac|ogg|oga|opus|wav|flac|mp4|m4v|mov|avi|wmv|mkv|webm|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|rar|tar|dmg|iso|exe|msi|apk|deb|rpm|css|js|mjs|map)$/i;

/**
 * How many pages a crawl keeps in flight at once (`<PREFIX>_CRAWL_CONCURRENCY`,
 * default 4, 1–16). Per-host politeness still serialises DEPARTURES to one
 * host through `awaitHostSlot`; this only lets the responses overlap.
 */
export function crawlConcurrency(): number {
  return envInt("CRAWL_CONCURRENCY", 4, 1, 16);
}

interface Frontier {
  url: string;
  depth: number;
}

/** A whole number from a caller's option, or the default when it is absent or not a number. */
function whole(n: number | undefined, fallback: number, min: number): number {
  return n !== undefined && Number.isFinite(n) ? Math.max(min, Math.floor(n)) : fallback;
}

const seconds = (ms: number) => `${ms / 1000} s`;

/**
 * Walk a site from a seed, breadth-first.
 *
 * Bounded four independent ways — pages, requests, depth, and origin — because
 * any one of them alone leaves a hole: a depth limit still admits a
 * combinatorial frontier, a page limit alone will spend the whole budget on a
 * paginated archive and keeps asking while every answer fails, and none of
 * them stops a link out to an unrelated host.
 *
 * robots.txt is consulted at EVERY hop, not once for the seed, and per ORIGIN
 * when the walk crosses one. That is the difference between this and `fetch`,
 * and it is deliberate: `fetch` follows a URL the caller was handed, which is
 * not crawling; this enumerates, which is. A refused URL is reported in
 * `disallowed` rather than dropped, because a silent skip is indistinguishable
 * from a page that does not exist. A robots.txt that errors stops the walk
 * before it starts (RFC 9309 §2.3.1.4), and so does a Crawl-delay over
 * `maxCrawlDelayMs()`.
 *
 * Breadth-first, so a shallow budget returns the pages nearest the seed — the
 * ones a reader would have reached first — rather than one deep spur. Each
 * depth is fetched as one wave with `crawlConcurrency()` pages in flight, and
 * `pages` keeps frontier order regardless of which answer came back first.
 */
export async function crawlSite(seed: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const maxPages = whole(opts.maxPages, 20, 1);
  const maxDepth = whole(opts.maxDepth, 2, 0);
  const maxRequests = whole(opts.maxRequests, maxPages * 3, 1);
  const delayOverride = opts.delayMs !== undefined && Number.isFinite(opts.delayMs) ? Math.max(0, opts.delayMs) : undefined;
  const prefix = opts.prefix ? pathOf(`http://x${opts.prefix.startsWith("/") ? "" : "/"}${opts.prefix}`) || undefined : undefined;
  const width = crawlConcurrency();
  const notes: string[] = [];
  const disallowed: string[] = [];
  const pages: CrawledPage[] = [];

  // The crawl's origin, and the part of it the seed names. The origin moves
  // once, when the seed answers from somewhere else: that is where the site
  // lives. A section follows the seed's redirect too (/docs → /docs/), but a
  // root seed stays the whole site wherever `/` sends it (/en/, /home).
  const seedOrigin = originOf(seed);
  if (!seedOrigin) return { pages, pending: [], disallowed, notes: [`${seed} is not a URL.`] };
  let origin = seedOrigin;
  let section = sectionOf(seed);
  const inScope = (url: string) => opts.crossOrigin === true || sameOrigin(url, origin);

  // robots.txt is read PER ORIGIN, memoised in fetchRobots: a cross-origin walk
  // used to apply the seed's file to every other host and never read theirs.
  // Its own redirects may stay within its site (http→https, apex↔www, which is
  // how most sites answer) but not leave it — and the authorizer never asks
  // robots.txt whether it may fetch itself. One per origin, so the memo, which
  // is kept per authorizer, is shared by every page of that origin.
  const NONE: Robots = { rules: [], sitemaps: [], absent: true };
  const robotsPolicy = new Map<string, (url: string) => Promise<boolean>>();
  const robotsFor = (url: string): Promise<Robots> => {
    if (opts.ignoreRobots) return Promise.resolve(NONE);
    const home = originOf(url) ?? "";
    let authorize = robotsPolicy.get(home);
    if (!authorize) {
      authorize = async (target: string) => {
        if (sameSite(target, home) || inScope(target)) return true;
        notes.push(`${target}: destination is outside the crawl origin.`);
        return false;
      };
      robotsPolicy.set(home, authorize);
    }
    return fetchRobots(url, { authorizeUrl: authorize });
  };

  const ceiling = maxCrawlDelayMs();
  const tooSlow = new Set<string>();
  // A Crawl-delay past the ceiling is refused rather than slept through: an
  // hour between two requests is not a crawl, and quietly honouring less than
  // the site asked for is not polite.
  const refusesDelay = (url: string, r: Robots): boolean => {
    if (delayOverride !== undefined || r.crawlDelayMs === undefined || r.crawlDelayMs <= ceiling) return false;
    const home = originOf(url) ?? url;
    if (!tooSlow.has(home)) {
      tooSlow.add(home);
      notes.push(
        `${home} asks for a Crawl-delay of ${seconds(r.crawlDelayMs)} between requests — over the ${seconds(ceiling)} this crawl will wait ` +
          `(${envName("MAX_CRAWL_DELAY_MS")}), so none of its pages were fetched.`,
      );
    }
    return true;
  };
  const delayFor = (r: Robots) => delayOverride ?? r.crawlDelayMs ?? hostDelayMs();
  const unreachable = (home: string, r: Robots) =>
    `robots.txt at ${home} ${r.status ? `answered HTTP ${r.status}` : "did not answer"} — RFC 9309 says to assume nothing may be crawled, so nothing was.`;

  const robots = await robotsFor(seed);
  if (!opts.ignoreRobots && robots.unreachable) return { pages, pending: [seed], disallowed, notes: [...notes, unreachable(seedOrigin, robots)] };
  if (refusesDelay(seed, robots)) return { pages, pending: [seed], disallowed, notes };

  // This runs before the initial request and before each redirect, so a
  // permitted URL cannot redirect the crawler outside its origin or into a
  // robots-refused page. Delays apply to the destination host as well. The
  // seed's own redirects may leave the origin: they are what settles it.
  const authorizeHop = async (url: string, seedHop: boolean): Promise<boolean> => {
    if (!seedHop && !inScope(url)) {
      notes.push(`${url}: destination is outside the crawl origin.`);
      return false;
    }
    const r = await robotsFor(url);
    if (!opts.ignoreRobots && !isAllowed(r, url)) {
      if (!disallowed.includes(url)) disallowed.push(url);
      return false;
    }
    if (refusesDelay(url, r)) return false;
    await awaitHostSlot(url, delayFor(r));
    return true;
  };
  const authorizeUrl = (url: string) => authorizeHop(url, false);
  const authorizeSeed = (url: string) => authorizeHop(url, true);

  // The sitemap is fetched while the seed is, so a redirect of its own that
  // leaves the seed's literal origin waits for the seed to settle the crawl's.
  let settleSeed!: () => void;
  const seedSettled = new Promise<void>((resolve) => {
    settleSeed = resolve;
  });
  const authorizeSitemap = async (url: string): Promise<boolean> => {
    if (!sameOrigin(url, seedOrigin)) await seedSettled;
    return authorizeUrl(url);
  };
  let rerooted = false;
  const settle = (got: ExtractResult): void => {
    // Status 0 is a refusal or no answer at all, which settles nothing.
    if (got.status > 0) {
      if (section !== "/") section = sectionOf(got.finalUrl);
      const moved = originOf(got.finalUrl);
      if (moved && moved !== origin) {
        origin = moved;
        rerooted = true;
        notes.push(`the seed redirected to ${got.finalUrl}${opts.crossOrigin ? "" : `, so the walk stays on ${moved}`}.`);
      }
    }
    settleSeed();
  };

  const seen = new Set<string>([canonicalizeUrl(seed)]);
  // Canonical URLs of the pages actually read, wherever they were asked for:
  // two links that redirect to one page, or a seed that redirects to a page
  // it links to, would otherwise list it twice.
  const read = new Set<string>();
  let skippedFiles = 0;
  const admit = (url: string, depth: number, into: Frontier[]): boolean => {
    const canon = canonicalizeUrl(url);
    if (seen.has(canon)) return false;
    if (!inScope(url)) return false;
    const path = pathOf(url);
    if (prefix && !path.startsWith(prefix)) return false;
    seen.add(canon);
    if (NOT_A_PAGE_RE.test(path)) {
      skippedFiles++;
      return false;
    }
    into.push({ url, depth });
    return true;
  };

  // The sitemap is the site's own statement of what it wants found, so it is a
  // better frontier than whatever the seed page happens to link to — and it
  // costs one request, which overlaps the seed fetch below. Seeded at depth 1
  // so `maxDepth: 0` still means "the seed page only", and, for a root seed,
  // ahead of the seed's own links so the site's order wins over the page's.
  // For a seed below the root the page's links go first, and only the
  // sitemap's entries in that section are taken: the whole site's list would
  // otherwise spend the budget the caller aimed at /docs/ on the shop. A
  // one-page budget has no room for anything it lists.
  const wantSitemap = opts.useSitemap !== false && maxDepth > 0 && maxPages > 1;
  let sitemap: Promise<Sitemap> | undefined = wantSitemap ? fetchSitemap(seed, { sitemaps: robots.sitemaps, authorizeUrl: authorizeSitemap }) : undefined;
  let sitemapAgain = false;
  let requests = 0;
  let failed = 0;

  const takeSitemap = async (into: Frontier[]): Promise<void> => {
    const sm = await sitemap!;
    sitemap = undefined;
    for (const n of sm.notes ?? []) notes.push(n);
    const scope = prefix ?? (section === "/" ? undefined : section);
    // Only as many entries as the request ceiling could still reach: a 50,000-
    // URL sitemap is not a frontier for a 10-page crawl.
    const room = maxRequests - requests;
    let added = 0;
    let outside = 0;
    let beyond = 0;
    for (const entry of sm.urls) {
      if (scope && !pathOf(entry.loc).startsWith(scope)) outside++;
      else if (added >= room) beyond++;
      else if (admit(entry.loc, 1, into)) added++;
    }
    if (added || outside || beyond) {
      notes.push(
        `seeded ${added} URL(s) from the sitemap` +
          (beyond ? `; ${beyond} more are past this crawl's request ceiling` : "") +
          (outside ? `; ${outside} outside ${scope} were left out` : "") +
          ".",
      );
    }
    // The seed moved to another origin, and the sitemap read for the old one
    // gave nothing there: read the new origin's own, once.
    if (!added && rerooted && !sitemapAgain) {
      sitemapAgain = true;
      const home = origin;
      sitemap = robotsFor(home).then((r) => fetchSitemap(home, { sitemaps: r.sitemaps, authorizeUrl }));
    }
  };

  type Fetched = { page: CrawledPage } | { note: string; duplicate?: boolean };
  const seedItem: Frontier = { url: seed, depth: 0 };
  const fetchOne = async (item: Frontier): Promise<Fetched> => {
    const isSeed = item === seedItem;
    const got = await fetchAndExtract(item.url, {
      keepHtml: item.depth < maxDepth,
      authorizeUrl: isSeed ? authorizeSeed : authorizeUrl,
      // A short Retry-After is waited out and retried inside httpGet; the rest
      // of this host's queue must wait with it, not go out meanwhile.
      onBackOff: (url, ms) => backOffHost(url, ms),
    });
    // Capped at a minute: honoured literally, one "come back in an hour" would stall the walk silently for that hour.
    if (got.retryAfterMs) backOffHost(got.finalUrl, Math.min(got.retryAfterMs, 60_000));
    if (isSeed) settle(got);
    if (!got.text) return { note: `${item.url}: ${got.note ?? "nothing readable"}` };
    return {
      page: {
        url: got.finalUrl,
        depth: item.depth,
        ...(got.title ? { title: got.title } : {}),
        text: got.text,
        extractor: got.extractor ?? "native",
        links: got.html ? linksFrom(got.html, got.finalUrl) : [],
      },
    };
  };

  // Breadth-first in WAVES: one depth at a time, `width` pages of it in flight,
  // results kept in frontier order so two runs over one site list the same
  // pages in the same order whatever the network did.
  let wave: Frontier[] = [seedItem];
  for (;;) {
    // The frontier ran dry while a sitemap is still to come (the second read,
    // for a seed that moved): it is the only frontier left.
    if (!wave.length && sitemap) await takeSitemap(wave);
    if (!wave.length || pages.length >= maxPages || requests >= maxRequests) break;
    // Read only as far into the wave as the budget can reach. A URL the budget
    // will never get to must not cost its host a robots.txt request, and must
    // be reported as pending rather than judged — asking about a page we were
    // never going to fetch would both contact a host for nothing and turn
    // "we ran out of budget" into "you may not read this".
    //
    // Refused URLs do not spend a slot, so the cursor keeps advancing until the
    // batch is actually full: that is what the sequential loop did when it
    // checked robots at dequeue time. A failed fetch spends a request, and
    // requests are bounded too.
    const room = Math.min(maxPages - pages.length, maxRequests - requests);
    const batch: Frontier[] = [];
    let cursor = 0;
    while (cursor < wave.length && batch.length < room) {
      const slice = wave.slice(cursor, cursor + (room - batch.length));
      const files = await Promise.all(slice.map((it) => robotsFor(it.url)));
      slice.forEach((item, i) => {
        if (!opts.ignoreRobots && !isAllowed(files[i]!, item.url)) disallowed.push(item.url);
        else batch.push(item);
      });
      cursor += slice.length;
    }
    requests += batch.length;

    // What is left of the wave goes back to the front of the next one: it is
    // still nearer the seed than anything this batch finds, and it is what the
    // caller sees as pending if the budget ends here.
    const leftover = wave.slice(cursor);

    // `onPage` fires in FRONTIER order, not arrival order, even though the
    // fetches overlap: a caller that numbers what it streams must get the same
    // numbering on two runs over one site, and arrival order is whatever the
    // network did that morning. Each page is handed over as soon as everything
    // ahead of it has been, so this still streams rather than waiting for the
    // wave — it just refuses to reorder it. A page already read under another
    // URL is dropped here, in that same order, so which copy counts is stable.
    const settled = new Array<Fetched | undefined>(batch.length);
    let streamed = 0;
    const streamReady = (): void => {
      while (streamed < settled.length && settled[streamed] !== undefined) {
        const i = streamed++;
        const done = settled[i]!;
        if (!("page" in done)) continue;
        const canon = canonicalizeUrl(done.page.url);
        if (read.has(canon)) {
          settled[i] = { note: `${batch[i]!.url} redirected to ${done.page.url}, already read.`, duplicate: true };
          continue;
        }
        read.add(canon);
        seen.add(canon);
        opts.onPage?.(done.page);
      }
    };
    await mapLimit(batch, width, async (item, i) => {
      settled[i] = await fetchOne(item);
      streamReady();
    });
    // The seed was refused by robots, or never reached: nothing moved it.
    settleSeed();

    const parents: CrawledPage[] = [];
    for (const r of settled as Fetched[]) {
      if ("note" in r) {
        notes.push(r.note);
        if (!r.duplicate) failed++;
        continue;
      }
      pages.push(r.page);
      if (r.page.depth < maxDepth) parents.push(r.page);
    }
    const next: Frontier[] = [];
    const rootSeed = section === "/";
    if (sitemap && rootSeed) await takeSitemap(next);
    for (const page of parents) for (const link of page.links) admit(link, page.depth + 1, next);
    if (sitemap && !rootSeed) await takeSitemap(next);
    wave = [...leftover, ...next];
  }

  // Say what was left rather than implying the site was exhausted. A budget
  // that ran out and a site that ended look identical from the outside.
  const pending = wave.map((q) => q.url);
  const queued = pending.length ? ` with ${pending.length} URL(s) still queued` : "";
  if (pages.length < maxPages && requests >= maxRequests)
    notes.push(`stopped after ${requests} page requests, ${failed} of them failed — the ceiling for a ${maxPages}-page budget${queued}.`);
  else if (pending.length) notes.push(`stopped at the ${maxPages}-page budget${queued}.`);
  if (skippedFiles) notes.push(`skipped ${skippedFiles} link(s) to images, media, fonts or archives without fetching them.`);

  // What governed the walk goes first: it is read against everything below it.
  const policy: string[] = [];
  if (opts.ignoreRobots) policy.push("robots.txt was not consulted (ignoreRobots) — only correct on a site you own.");
  else if (envFlag("NO_ROBOTS")) policy.push(`robots.txt was not consulted (${envName("NO_ROBOTS")}) — only correct on a site you own.`);
  else {
    const home = await robotsFor(origin);
    if (home.unreachable) policy.push(unreachable(origin, home));
    else if (home.absent) policy.push(`no robots.txt${home.status ? ` (HTTP ${home.status})` : ""} — nothing was refused, but nothing was granted either.`);
    if (home.crawlDelayMs && delayOverride === undefined && home.crawlDelayMs <= ceiling)
      policy.push(`honouring the declared Crawl-delay of ${home.crawlDelayMs}ms.`);
  }

  return { pages, pending, disallowed, notes: [...policy, ...notes] };
}
