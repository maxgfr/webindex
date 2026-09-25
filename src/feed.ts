import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { decodeBody } from "./charset.js";
import { decodeEntities, httpGet } from "./fetch.js";
import { closeTagRe, dropElements, htmlAttributes, INLINE_TAGS, LOOSE_TAG_RE, RAW_TEXT_ELEMENTS, TAG_RE, tagName } from "./html.js";

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
// tags. A small scanner is honest here in a way it would not be for arbitrary
// XML — and it fails to an empty list, never to a wrong one. JSON Feed needs no
// scanner at all.

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
  kind: "rss" | "atom" | "json";
  items: FeedItem[];
}

// ── Reading XML without an XML parser ───────────────────────────────────────

interface XmlElement {
  /** The opening tag's attribute text. */
  attrs: string;
  /** Everything between the opening and closing tags. */
  inner: string;
  /** Where the opening tag starts, and where the closing one ends. */
  from: number;
  to: number;
}

const OPENERS = new Map<string, RegExp>();
function openerRe(name: string): RegExp {
  let re = OPENERS.get(name);
  if (!re) OPENERS.set(name, (re = new RegExp(`<${name}(?=[\\s/>])`, "gi")));
  return re;
}

const withoutBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/**
 * `xml` with every CDATA section and comment blanked to spaces of the same
 * length, so offsets found in it index the original.
 *
 * Both hold text, never elements: a `<link rel="stylesheet">` or an SVG's
 * `<title>` inside a `content:encoded` CDATA is part of the article, and was
 * read as the entry's own link or title.
 */
function markupOnly(xml: string): string {
  if (!xml.includes("<![CDATA[") && !xml.includes("<!--")) return xml;
  const re = /<!\[CDATA\[|<!--/g;
  let out = "";
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const close = xml.indexOf(m[0] === "<!--" ? "-->" : "]]>", m.index + m[0].length);
    // Unterminated: everything after it is text.
    const end = close < 0 ? xml.length : close + 3;
    out += xml.slice(pos, m.index) + " ".repeat(end - m.index);
    pos = re.lastIndex = end;
  }
  return out + xml.slice(pos);
}

/**
 * Every `<name …>…</name>` element in `xml`, in document order.
 *
 * Found with a forward search rather than a lazy regex: `<item[\s\S]*?</item>`
 * re-scanned to the end of the input from every unclosed opener, which is
 * quadratic on a hostile feed. Here each close is searched once, forward from
 * its opener, and a search that fails ends the scan — no later opener could
 * find a close either. A self-closing element has no content.
 */
function elements(xml: string, name: string, limit = Number.POSITIVE_INFINITY): XmlElement[] {
  const scan = markupOnly(xml);
  const open = openerRe(name);
  const close = closeTagRe(name);
  const out: XmlElement[] = [];
  open.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (out.length < limit && (m = open.exec(scan))) {
    const tagEnd = scan.indexOf(">", open.lastIndex);
    if (tagEnd < 0) break;
    const attrs = xml.slice(open.lastIndex, tagEnd);
    if (attrs.endsWith("/")) {
      out.push({ attrs: attrs.slice(0, -1), inner: "", from: m.index, to: tagEnd + 1 });
      open.lastIndex = tagEnd + 1;
      continue;
    }
    close.lastIndex = tagEnd + 1;
    const c = close.exec(scan);
    if (!c) break;
    out.push({ attrs, inner: xml.slice(tagEnd + 1, c.index), from: m.index, to: c.index + c[0].length });
    open.lastIndex = c.index + c[0].length;
  }
  return out;
}

const OPEN_TAGS = new Map<string, RegExp>();
/**
 * Every `<name …>` opening tag outside CDATA and comments, as a whole tag
 * string for htmlAttributes. For elements read only for their attributes —
 * `<link>`, which HTML never closes and Atom closes itself. Quote-aware and
 * linear, the shape of TAG_RE.
 */
function openTags(html: string, name: string): string[] {
  let re = OPEN_TAGS.get(name);
  if (!re) OPEN_TAGS.set(name, (re = new RegExp(`<${name}(?=[\\s/>])[^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>`, "gi")));
  return [...markupOnly(html).matchAll(re)].map((m) => m[0]);
}

/**
 * The text an element holds, as XML defines it: every CDATA section literally,
 * comments dropped, entities decoded everywhere else.
 *
 * Each section is replaced in place. Taking only the first one lost the text
 * around it (`<![CDATA[Mixed ]]> tail` read "Mixed"), and cut short a value
 * that carries `]]>` the only way XML allows — split across two sections.
 */
function xmlText(raw: string): string {
  const re = /<!\[CDATA\[|<!--/g;
  let out = "";
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const cdata = m[0] !== "<!--";
    const close = raw.indexOf(cdata ? "]]>" : "-->", m.index + m[0].length);
    if (close < 0) break;
    out += decodeEntities(raw.slice(pos, m.index)) + (cdata ? raw.slice(m.index + 9, close) : "");
    pos = re.lastIndex = close + 3;
  }
  return out + decodeEntities(raw.slice(pos));
}

/** Readable text of an HTML fragment: markup out, entities decoded, whitespace collapsed. */
function fragmentText(html: string): string {
  const stripped = dropElements(html, ["script", "style"], RAW_TEXT_ELEMENTS)
    .replace(TAG_RE, (tag) => (INLINE_TAGS.has(tagName(tag)) ? "" : " "))
    .replace(LOOSE_TAG_RE, " ");
  return decodeEntities(stripped).replace(/\s+/g, " ").trim();
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/** An element's value as plain text: dates, ids, URLs. */
function tagText(block: string, ...names: string[]): string | undefined {
  for (const name of names) {
    const el = elements(block, name, 1)[0];
    const text = el && collapse(xmlText(el.inner));
    if (text) return text;
  }
  return undefined;
}

/**
 * An element's value as the words a reader would see.
 *
 * RSS descriptions and Atom `type="html"` carry HTML escaped as `&lt;p&gt;`,
 * so the XML is decoded FIRST and the HTML read after. Stripping tags before
 * decoding found none, and then printed `<p>Hello <b>world</b></p>`. Atom's
 * `type="text"` — its default — is text: its angle brackets are content.
 */
function proseText(block: string, atom: boolean, ...names: string[]): string | undefined {
  for (const name of names) {
    const el = elements(block, name, 1)[0];
    if (!el) continue;
    const type = htmlAttributes(el.attrs).get("type")?.toLowerCase() ?? (atom ? "text" : "html");
    // `xhtml` is markup inline, not escaped: its entities are decoded once, by
    // the HTML reader, or `&lt;b&gt;` in its prose would turn into a tag.
    const text =
      type === "xhtml" ? fragmentText(el.inner) : type === "text" || type === "text/plain" ? collapse(xmlText(el.inner)) : fragmentText(xmlText(el.inner));
    if (text) return text;
  }
  return undefined;
}

// A summary, not the article. Only a fallback from full content is clipped.
const SUMMARY_MAX = 500;
function clip(s: string | undefined): string | undefined {
  return s && s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX).trimEnd()}…` : s;
}

function resolveUrl(href: string, base: string | undefined): string {
  if (!base) return href;
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

/** The element a document opens with, past a BOM, declarations, comments and a doctype. */
function rootElement(xml: string): string | undefined {
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (i < xml.length && /\s/.test(xml[i]!)) i++;
    if (xml.startsWith("<?", i)) {
      const end = xml.indexOf("?>", i + 2);
      if (end < 0) return undefined;
      i = end + 2;
    } else if (xml.startsWith("<!--", i)) {
      const end = xml.indexOf("-->", i + 4);
      if (end < 0) return undefined;
      i = end + 3;
    } else if (xml.startsWith("<!", i)) {
      // A doctype, possibly with an internal subset in brackets.
      let end = xml.indexOf(">", i);
      const subset = xml.indexOf("[", i);
      if (subset >= 0 && subset < end) {
        const closed = xml.indexOf("]", subset);
        end = closed < 0 ? -1 : xml.indexOf(">", closed);
      }
      if (end < 0) return undefined;
      if (/^<!doctype\s+html\b/i.test(xml.slice(i, end))) return "html";
      i = end + 1;
    } else {
      return /^<([A-Za-z_][\w.:-]*)/.exec(xml.slice(i, i + 256))?.[1]?.toLowerCase();
    }
  }
}

// ── Feeds ───────────────────────────────────────────────────────────────────

// Rels that name something other than the entry's own page.
const NOT_THE_PAGE = new Set(["self", "edit", "replies", "enclosure", "via", "related", "license"]);

/**
 * An entry's page. Atom puts it in `<link href>`, RSS in `<link>` text, and
 * both fall back as the spec allows.
 *
 * RFC 4287: a link with no `rel` IS `rel="alternate"`, and alternate is the
 * entry's page. Taking the first link that was not self/edit got a
 * `rel="related"` written before it. Only when no alternate exists is another
 * link better than nothing.
 */
function itemUrl(block: string, base: string | undefined): string | undefined {
  const links = openTags(block, "link").map(htmlAttributes);
  const hrefOf = (attrs: Map<string, string>) => {
    const href = attrs.get("href");
    return href ? decodeEntities(href).trim() : undefined;
  };
  const rels = (attrs: Map<string, string>) => attrs.get("rel")?.toLowerCase().split(/\s+/) ?? [];
  const pick =
    links.find((a) => hrefOf(a) && (rels(a).length === 0 || rels(a).includes("alternate"))) ??
    links.find((a) => hrefOf(a) && !rels(a).some((r) => NOT_THE_PAGE.has(r))) ??
    links.find((a) => hrefOf(a));
  const href = pick && hrefOf(pick);
  if (href) return resolveUrl(href, base);

  const text = tagText(block, "link");
  if (text) return resolveUrl(text, base);
  // RSS's guid is a permalink unless it says otherwise — and then it is only an
  // id (`post-123`), which is no URL at all.
  const guid = elements(block, "guid", 1)[0];
  if (!guid || htmlAttributes(guid.attrs).get("ispermalink")?.toLowerCase() === "false") return undefined;
  const value = collapse(xmlText(guid.inner));
  return /^https?:\/\//i.test(value) ? value : undefined;
}

/** The xml:base an element declares, resolved against the one above it. */
function xmlBase(attrs: string, above: string | undefined): string | undefined {
  const declared = htmlAttributes(attrs).get("xml:base");
  return declared ? resolveUrl(decodeEntities(declared).trim(), above) : above;
}

/**
 * Parse an RSS 2.0, RSS 1.0 (RDF), Atom or JSON Feed document.
 *
 * Returns undefined for anything that is not one — judged by the element the
 * document opens with, not by a `<channel` anywhere in it: a page using a
 * `<channel-nav>` element is still a page, and must fall through to discovery.
 * A feed with no entries is an empty list rather than a throw — "no" is a
 * valid answer that must not look like a crash.
 *
 * `baseUrl` is where the feed was fetched from. Relative links — and Atom's
 * `xml:base` — resolve against it; without it they are returned as written.
 */
export function parseFeed(xml: string, baseUrl?: string): Feed | undefined {
  if (withoutBom(xml).trimStart().startsWith("{")) return parseJsonFeed(xml, baseUrl);
  const root = rootElement(xml);
  if (!root) return undefined;
  const kind: Feed["kind"] | undefined = root === "rss" || /(^|:)rdf$/.test(root) ? "rss" : /(^|:)feed$/.test(root) ? "atom" : undefined;
  if (!kind) return undefined;
  const atom = kind === "atom";

  // Atom's xml:base, on the feed and on each entry, re-roots relative links.
  const rootTag = atom ? openTags(xml, root)[0] : undefined;
  const feedBase = rootTag ? xmlBase(rootTag, baseUrl) : baseUrl;

  const blocks = elements(xml, atom ? "entry" : "item");
  const items: FeedItem[] = [];
  for (const block of blocks) {
    const inner = block.inner;
    const it: FeedItem = {};
    const title = proseText(inner, atom, "title");
    if (title) it.title = title;
    const url = itemUrl(inner, atom ? xmlBase(block.attrs, feedBase) : feedBase);
    if (url) it.url = url;
    const published = tagText(inner, "pubDate", "published", "updated", "dc:date");
    if (published) it.published = published;
    const summary = proseText(inner, atom, "description", "summary") ?? clip(proseText(inner, atom, "content", "content:encoded"));
    if (summary) it.summary = summary;
    const id = tagText(inner, "guid", "id");
    if (id) it.id = id;
    if (it.title || it.url) items.push(it);
  }

  // The channel/feed title is the first <title> OUTSIDE any item, so cut the
  // items out before looking — otherwise a feed whose first entry precedes the
  // channel title would be named after that entry.
  let head = "";
  let last = 0;
  for (const b of blocks) {
    head += xml.slice(last, b.from);
    last = b.to;
  }
  head += xml.slice(last);
  const title = proseText(head, atom, "title");
  return { kind, items, ...(title ? { title } : {}) };
}

/** JSON Feed (jsonfeed.org, 1.0 and 1.1): JSON.parse does all the work. */
function parseJsonFeed(text: string, baseUrl: string | undefined): Feed | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(withoutBom(text));
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return undefined;
  const feed = doc as Record<string, unknown>;
  if (typeof feed.version !== "string" || !feed.version.startsWith("https://jsonfeed.org/version/")) return undefined;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

  const items: FeedItem[] = [];
  for (const raw of Array.isArray(feed.items) ? feed.items : []) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const it: FeedItem = {};
    const id = typeof entry.id === "number" ? String(entry.id) : str(entry.id);
    if (id) it.id = id;
    const url = str(entry.url) ?? str(entry.external_url);
    if (url) it.url = resolveUrl(url, baseUrl);
    const title = str(entry.title);
    if (title) it.title = title;
    const published = str(entry.date_published) ?? str(entry.date_modified);
    if (published) it.published = published;
    const html = str(entry.content_html);
    const summary = str(entry.summary) ?? clip(str(entry.content_text) ?? (html ? fragmentText(html) : undefined));
    if (summary) it.summary = summary;
    if (it.title || it.url) items.push(it);
  }
  const title = str(feed.title);
  return { kind: "json", items, ...(title ? { title } : {}) };
}

const FEED_TYPES = new Set(["application/rss+xml", "application/atom+xml", "application/feed+json"]);

/**
 * Feed URLs a page advertises via `<link rel="alternate">`.
 *
 * A bare `application/json` alternate is not taken: that is how WordPress
 * advertises its REST API, and JSON Feed's own discovery type is `feed+json`.
 */
export function discoverFeeds(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const tag of openTags(html, "link")) {
    const attrs = htmlAttributes(tag);
    const rels = attrs.get("rel")?.toLowerCase().split(/\s+/) ?? [];
    if (!rels.includes("alternate")) continue;
    // `application/rss+xml; charset=utf-8` is the same type.
    const type = attrs.get("type")?.split(";")[0]?.trim().toLowerCase();
    if (!type || !FEED_TYPES.has(type)) continue;
    const href = attrs.get("href");
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

// ── Sitemaps ────────────────────────────────────────────────────────────────

export interface Sitemap {
  /** Page URLs, for a urlset. */
  urls: { loc: string; lastmod?: string }[];
  /** Nested sitemap URLs, for a sitemapindex — fetch these to go deeper. */
  sitemaps: string[];
  /** fetchSitemap: the nested sitemaps its document budget did not reach. Raise `max` to read them. */
  unfetched?: string[];
  /** fetchSitemap: why a document was not read, or not read whole. */
  notes?: string[];
}

/**
 * Parse a sitemap, whether it is a `urlset`, a `sitemapindex`, or the
 * protocol's plain-text form (one URL per line).
 *
 * The two are reported separately rather than followed automatically: a sitemap
 * index can name hundreds of children, and deciding how much of a site to
 * enumerate is the caller's budget to spend, not this function's.
 */
export function parseSitemap(xml: string): Sitemap {
  const out: Sitemap = { urls: [], sitemaps: [] };
  const body = withoutBom(xml);
  if (!body.trimStart().startsWith("<")) {
    for (const line of body.split(/\r\n|\r|\n/)) {
      const loc = line.trim();
      if (/^https?:\/\/\S+$/i.test(loc)) out.urls.push({ loc });
    }
    return out;
  }
  const isIndex = /<sitemapindex(?=[\s/>])/i.test(body);
  for (const el of elements(body, "sitemap")) {
    const loc = tagText(el.inner, "loc");
    if (loc) out.sitemaps.push(loc);
  }
  if (isIndex) return out;
  for (const el of elements(body, "url")) {
    const loc = tagText(el.inner, "loc");
    if (!loc) continue;
    const lastmod = tagText(el.inner, "lastmod");
    out.urls.push({ loc, ...(lastmod ? { lastmod } : {}) });
  }
  return out;
}

// The protocol's own ceiling for one sitemap, uncompressed (sitemaps.org).
// The generic 4 MB text cap refused a valid 5 MB sitemap outright.
const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;
const gunzipAsync = promisify(gunzip);

/** One sitemap document as text: gunzipped when it is gzip, decoded by its own declarations. */
async function readSitemapDocument(url: string, authorize: ((url: string) => Promise<boolean>) | undefined): Promise<{ text?: string; note?: string }> {
  // A URL the caller's own policy refused is the caller's to report (a crawl
  // lists it as disallowed); a note here would only say it twice.
  let refused = false;
  const authorizeUrl =
    authorize &&
    (async (u: string) => {
      const ok = await authorize(u);
      if (!ok) refused = true;
      return ok;
    });
  const r = await httpGet(url, {
    accept: "application/xml,text/xml,text/plain,*/*",
    timeoutMs: 10000,
    binary: true,
    maxBytes: SITEMAP_MAX_BYTES,
    authorizeUrl,
  });
  if (!r.ok) {
    if (r.truncated) return { note: `${url} is larger than the 50 MB a sitemap may be; not read.` };
    // A missing sitemap is the common case, and not worth a note.
    if (refused || r.status === 404 || r.status === 410) return {};
    return { note: `could not read ${url} (${r.status ? `status ${r.status}` : (r.error ?? "no answer")}).` };
  }
  let bytes = r.bytes ?? Buffer.alloc(0);
  // A `.xml.gz` served as application/x-gzip — how large sites and the files
  // robots.txt names usually arrive. Sniffed, not trusted to the header: a
  // server that gzips transparently has already been undone by fetch.
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (gzipped) {
    // A prefix of a gzip stream does not inflate, so a cut one is refused whole.
    if (r.truncated) return { note: `${url} is larger than the 50 MB a sitemap may be; not read.` };
    try {
      // Capped on the way out too: 50 MB of gzip can inflate a thousandfold.
      bytes = await gunzipAsync(bytes, { maxOutputLength: SITEMAP_MAX_BYTES });
    } catch (e) {
      const tooBig = (e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" || e instanceof RangeError;
      return { note: tooBig ? `${url} decompresses past the 50 MB a sitemap may be; not read.` : `${url} is not valid gzip; not read.` };
    }
  }
  return {
    text: decodeBody(bytes, gzipped ? "application/xml" : r.contentType),
    ...(r.truncated ? { note: `read only the first 50 MB of ${url}, the most a sitemap may be.` } : {}),
  };
}

/**
 * Fetch and parse the sitemap(s) for an origin.
 *
 * Reads the ones robots.txt names — a site that publishes its sitemap location
 * there means it — and their children, breadth-first. `/sitemap.xml` is only a
 * guess, so it is tried only when robots.txt named none or the named ones gave
 * nothing: fetched ahead of the index's children, it spent the budget on a
 * usually-404 request.
 *
 * `max` bounds how many documents are fetched (default 3), because a sitemap
 * index is an invitation to enumerate a site and that has to stay a budget the
 * caller sets. The children it did not reach come back in `unfetched`.
 */
export async function fetchSitemap(
  url: string,
  opts: { sitemaps?: string[]; max?: number; authorizeUrl?: (url: string) => Promise<boolean> } = {},
): Promise<Sitemap> {
  const out: Sitemap = { urls: [], sitemaps: [] };
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return out;
  }
  const fallback = `${origin}/sitemap.xml`;
  const named = opts.sitemaps ?? [];
  const queue = named.length ? [...named] : [fallback];
  let guessed = !named.length;
  const seen = new Set<string>();
  const children = new Set<string>();
  const notes: string[] = [];
  let fetched = 0;
  const max = opts.max !== undefined && Number.isFinite(opts.max) ? Math.max(1, Math.floor(opts.max)) : 3;

  for (;;) {
    if (!queue.length && !guessed && !out.urls.length && !out.sitemaps.length) {
      guessed = true;
      queue.push(fallback);
    }
    if (!queue.length || fetched >= max) break;
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    fetched++;
    const doc = await readSitemapDocument(next, opts.authorizeUrl);
    if (doc.note) notes.push(doc.note);
    if (!doc.text?.trim()) continue;
    const parsed = parseSitemap(doc.text);
    for (const u of parsed.urls) out.urls.push(u);
    for (const s of parsed.sitemaps) {
      if (children.has(s)) continue;
      children.add(s);
      out.sitemaps.push(s);
      queue.push(s);
    }
  }
  out.unfetched = [...new Set(queue.filter((s) => !seen.has(s) && s !== fallback))];
  if (notes.length) out.notes = notes;
  return out;
}

/** Fetch and parse a feed URL, resolving its links against where it was served from. */
export async function fetchFeed(url: string): Promise<Feed | undefined> {
  const r = await httpGet(url, { accept: "application/atom+xml,application/rss+xml,application/feed+json,application/xml,*/*", timeoutMs: 10000 });
  if (!r.ok || !r.body.trim()) return undefined;
  return parseFeed(r.body, r.url);
}
