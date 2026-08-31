import { decodeEntities, httpGet } from "./fetch.js";

// Feeds and sitemaps: the two machine-readable indexes a site publishes about
// itself.
//
// Neither existed anywhere in this engine or its consumers. Without them the
// only answer to "what else has this site published" is to search the web for it
// and hope — which is how a tool ends up citing a listicle about a project
// instead of the project's own changelog. A feed is the site telling you, in
// order, with dates.
//
// Both formats are XML, and this engine has no XML parser and will not grow one
// (zero dependencies). What it has instead is the observation that both formats
// are shallow and regular: a flat list of elements with a handful of known child
// tags. A regex reader is honest here in a way it would not be for arbitrary XML
// — and it fails to an empty list, never to a wrong one.

export interface FeedItem {
  title?: string;
  url?: string;
  /** As written by the feed. */
  published?: string;
  summary?: string;
  id?: string;
}

export interface Feed {
  title?: string;
  kind: "rss" | "atom";
  items: FeedItem[];
}

// HTML and Atom both permit unquoted attribute values. Keeping the tiny
// attribute reader here avoids treating a valid `<link href=/feed.xml>` as if
// the page advertised no feed, without pretending this module is an HTML/XML
// parser. Malformed attributes simply do not match.
function attributeValue(attrs: string, name: string): string | undefined {
  for (const match of attrs.matchAll(/([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    if (match[2] === undefined && match[3] === undefined && match[4] === undefined) continue;
    if (match[1]?.toLowerCase() === name.toLowerCase()) return match[2] ?? match[3] ?? match[4] ?? "";
  }
  return undefined;
}

function tagText(block: string, ...names: string[]): string | undefined {
  for (const name of names) {
    const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(block);
    if (!m) continue;
    const raw = m[1]!;
    // CDATA is common in feed titles and descriptions.
    const inner = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(raw)?.[1] ?? raw;
    const text = decodeEntities(inner.replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text;
  }
  return undefined;
}

/** Atom puts the URL in an attribute, RSS in element text. */
function itemUrl(block: string): string | undefined {
  const links = [...block.matchAll(/<link\b([^>]*)>/gi)].map((match) => match[1]!);
  const firstHref = links.map((attrs) => attributeValue(attrs, "href")).find(Boolean);
  if (firstHref) {
    // Prefer rel="alternate" (the human page) over rel="self"/"enclosure".
    const alts = links.filter((attrs) => {
      const rels = attributeValue(attrs, "rel")?.toLowerCase().split(/\s+/) ?? [];
      return !rels.some((rel) => ["self", "edit", "replies", "enclosure"].includes(rel));
    });
    for (const attrs of alts) {
      const href = attributeValue(attrs, "href");
      if (href) return decodeEntities(href).trim();
    }
    return decodeEntities(firstHref).trim();
  }
  return tagText(block, "link", "guid");
}

/**
 * Parse an RSS 2.0 or Atom feed.
 *
 * Returns an empty item list rather than throwing on anything unrecognised —
 * the caller asked "does this site publish a feed", and "no" is a valid answer
 * that must not look like a crash.
 */
export function parseFeed(xml: string): Feed | undefined {
  const isAtom = /<feed\b[^>]*xmlns\s*=\s*["'][^"']*www\.w3\.org\/2005\/Atom/i.test(xml) || /<entry\b/i.test(xml);
  const isRss = /<rss\b/i.test(xml) || /<channel\b/i.test(xml);
  if (!isAtom && !isRss) return undefined;

  const kind: Feed["kind"] = isAtom && !isRss ? "atom" : "rss";
  const itemRe = kind === "atom" ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi;

  const items: FeedItem[] = [];
  for (const m of xml.matchAll(itemRe)) {
    const block = m[0];
    const it: FeedItem = {};
    const title = tagText(block, "title");
    if (title) it.title = title;
    const url = itemUrl(block);
    if (url) it.url = url;
    const published = tagText(block, "pubDate", "published", "updated", "dc:date");
    if (published) it.published = published;
    const summary = tagText(block, "description", "summary");
    if (summary) it.summary = summary;
    const id = tagText(block, "guid", "id");
    if (id) it.id = id;
    if (it.title || it.url) items.push(it);
  }

  // The channel/feed title is the first <title> OUTSIDE any item, so cut the
  // items out before looking — otherwise a feed whose first entry precedes the
  // channel title would be named after that entry.
  const head = xml.replace(itemRe, "");
  const title = tagText(head, "title");
  return { kind, items, ...(title ? { title } : {}) };
}

/** Feed URLs a page advertises via `<link rel="alternate">`. */
export function discoverFeeds(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = m[1]!;
    const rels = attributeValue(attrs, "rel")?.toLowerCase().split(/\s+/) ?? [];
    if (!rels.includes("alternate")) continue;
    const type = attributeValue(attrs, "type")?.toLowerCase();
    if (type !== "application/rss+xml" && type !== "application/atom+xml") continue;
    const href = attributeValue(attrs, "href");
    if (!href) continue;
    try {
      const abs = new URL(decodeEntities(href).trim(), baseUrl).href;
      if (!out.includes(abs)) out.push(abs);
    } catch {
      /* an href we cannot resolve is not a feed we can fetch */
    }
  }
  return out;
}

export interface Sitemap {
  /** Page URLs, for a urlset. */
  urls: { loc: string; lastmod?: string }[];
  /** Nested sitemap URLs, for a sitemapindex — fetch these to go deeper. */
  sitemaps: string[];
}

/**
 * Parse a sitemap.xml, whether it is a `urlset` or a `sitemapindex`.
 *
 * The two are reported separately rather than followed automatically: a sitemap
 * index can name hundreds of children, and deciding how much of a site to
 * enumerate is the caller's budget to spend, not this function's.
 */
export function parseSitemap(xml: string): Sitemap {
  const out: Sitemap = { urls: [], sitemaps: [] };
  const isIndex = /<sitemapindex\b/i.test(xml);
  for (const m of xml.matchAll(/<(sitemap|url)\b[\s\S]*?<\/\1>/gi)) {
    const block = m[0];
    const loc = tagText(block, "loc");
    if (!loc) continue;
    if (isIndex || m[1]!.toLowerCase() === "sitemap") {
      out.sitemaps.push(loc);
    } else {
      const lastmod = tagText(block, "lastmod");
      out.urls.push({ loc, ...(lastmod ? { lastmod } : {}) });
    }
  }
  return out;
}

/**
 * Fetch and parse the sitemap(s) for an origin.
 *
 * Tries the ones robots.txt names first — a site that publishes its sitemap
 * location there means it — then falls back to `/sitemap.xml`. `max` bounds how
 * many documents are fetched, because a sitemap index is an invitation to
 * enumerate a site and that has to stay a budget the caller sets.
 */
export async function fetchSitemap(url: string, opts: { sitemaps?: string[]; max?: number } = {}): Promise<Sitemap> {
  const out: Sitemap = { urls: [], sitemaps: [] };
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return out;
  }
  const queue = [...(opts.sitemaps ?? []), `${origin}/sitemap.xml`];
  const seen = new Set<string>();
  let fetched = 0;
  const max = Math.max(1, opts.max ?? 3);

  while (queue.length && fetched < max) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    const r = await httpGet(next, { accept: "application/xml,text/xml,*/*", timeoutMs: 10000 });
    fetched++;
    if (!r.ok || !r.body.trim()) continue;
    const parsed = parseSitemap(r.body);
    out.urls.push(...parsed.urls);
    for (const s of parsed.sitemaps) {
      if (!out.sitemaps.includes(s)) out.sitemaps.push(s);
      queue.push(s);
    }
  }
  return out;
}

/** Fetch and parse a feed URL. */
export async function fetchFeed(url: string): Promise<Feed | undefined> {
  const r = await httpGet(url, { accept: "application/atom+xml,application/rss+xml,application/xml,*/*", timeoutMs: 10000 });
  if (!r.ok || !r.body.trim()) return undefined;
  return parseFeed(r.body);
}
