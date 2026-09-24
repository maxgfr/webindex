import { decodeEntities } from "./entities.js";
import { htmlCanonicalUrl, htmlTitle } from "./fetch.js";
import { closeTagRe, dropElements, htmlAttributes } from "./html.js";

// Structured metadata a page publishes about itself: JSON-LD, OpenGraph, and the
// standard `<meta>` tags.
//
// The engine already read `og:url` — for canonicalisation, and then threw the
// rest away. Everything a citation actually wants is sitting in the same few
// tags: who wrote it, when it was published, what kind of thing it is. Guessing
// a publication date out of body text is unreliable and slow; reading
// `article:published_time` is neither.
//
// Zero-dependency, so JSON-LD is parsed with JSON.parse and OpenGraph with a
// tag scan. No HTML parser, no schema validation — this reports what the page
// claims, and the caller decides whether to believe it.

export interface PageMetadata {
  title?: string;
  description?: string;
  /** `og:type`, or JSON-LD `@type`. */
  type?: string;
  siteName?: string;
  /** ISO-ish date strings, exactly as the page wrote them. */
  publishedAt?: string;
  modifiedAt?: string;
  authors: string[];
  imageUrl?: string;
  canonicalUrl?: string;
  /** Every JSON-LD block that parsed, untouched — for a caller that wants more. */
  jsonLd: unknown[];
}

// One opening tag, a quoted `>` inside it included, and the same linear shape
// as the scans in html.ts.
const openTag = (name: string) => new RegExp(`<${name}(?=[\\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>`, "gi");

/**
 * Parse one JSON-LD block, forgiving what lenient consumers forgive.
 *
 * A strict parse first. Failing that, one retry after undoing the usual
 * damage: a `//<![CDATA[` wrapper from an XHTML-era template, a raw newline
 * inside a string (a CMS pasting a multi-line description in verbatim — JSON
 * forbids it, and it is the commonest break), a trailing comma.
 */
function parseJsonLd(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    /* retry below */
  }
  const lenient = raw
    .replace(/^\s*(?:\/\*\s*<!\[CDATA\[\s*\*\/|\/\/\s*<!\[CDATA\[|<!\[CDATA\[)/, "")
    .replace(/(?:\/\*\s*\]\]>\s*\*\/|\/\/\s*\]\]>|\]\]>)\s*$/, "")
    .replace(/\s+/g, " ")
    .replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(lenient);
  } catch {
    return undefined;
  }
}

// A @graph wrapper is the common shape from CMS plugins, and some emit an array
// of them; flatten both so a caller does not have to know which generator
// produced the page.
function flattenJsonLd(v: unknown, out: unknown[]): void {
  if (Array.isArray(v)) for (const x of v) flattenJsonLd(x, out);
  else if (v && typeof v === "object" && Array.isArray((v as { "@graph"?: unknown })["@graph"])) {
    for (const x of (v as { "@graph": unknown[] })["@graph"]) out.push(x);
  } else out.push(v);
}

/**
 * Every `<script type="application/ld+json">` block that parses.
 *
 * A block that does not parse, even leniently, is skipped rather than thrown:
 * malformed JSON-LD is common and must never cost the caller the rest of the
 * page. The type may be unquoted or carry a charset parameter.
 *
 * One forward pass: each script's close is searched from its opener, and a
 * script that never closes ends the scan, since nothing after it can close
 * either. A lazy `[\s\S]*?</script>` per opener re-read the rest of the page
 * from every unclosed one.
 */
export function extractJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const open = openTag("script");
  const close = closeTagRe("script");
  let m: RegExpExecArray | null;
  while ((m = open.exec(html))) {
    close.lastIndex = open.lastIndex;
    const c = close.exec(html);
    if (!c) break;
    const type = (htmlAttributes(m[0]).get("type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type === "application/ld+json") {
      const raw = html
        .slice(open.lastIndex, c.index)
        .replace(/^\s*<!--/, "")
        .replace(/-->\s*$/, "")
        .trim();
      const parsed = raw ? parseJsonLd(raw) : undefined;
      if (parsed !== undefined) flattenJsonLd(parsed, out);
    }
    open.lastIndex = c.index + c[0].length;
  }
  return out;
}

/**
 * Every `<meta>` name/property and its content, in document order.
 *
 * Tags and attributes are read quote-aware — a description reading "a -> b"
 * keeps its arrow — and by whole attribute name, so `data-content` is not
 * `content`. Comments and scripts are skipped: a commented-out old description
 * or a template string in a bundle is not what the page says.
 */
function metaEntries(html: string): [string, string][] {
  const out: [string, string][] = [];
  for (const m of dropElements(html, ["script", "style", "template"]).matchAll(openTag("meta"))) {
    const attrs = htmlAttributes(m[0]);
    const key = (attrs.get("property") ?? attrs.get("name") ?? attrs.get("itemprop"))?.trim().toLowerCase();
    const content = attrs.has("content") ? decodeEntities(attrs.get("content")!).trim() : "";
    if (key && content) out.push([key, content]);
  }
  return out;
}

/** Every `<meta>` name/property and its content, lower-cased keys; the first of a repeated key wins. */
export function extractMetaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, content] of metaEntries(html)) if (!out.has(key)) out.set(key, content);
  return out;
}

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => !!v && typeof v === "object" && !Array.isArray(v);

// Types that describe the site around a page rather than the page: a header
// template's Organization, the WebSite search box, the breadcrumb trail, an
// author's Person card, a logo's ImageObject. Most templates emit them first.
const CHROME_TYPES = new Set([
  "Organization",
  "Corporation",
  "NewsMediaOrganization",
  "WebSite",
  "BreadcrumbList",
  "ListItem",
  "SiteNavigationElement",
  "WPHeader",
  "WPFooter",
  "WPSideBar",
  "WPAdBlock",
  "Person",
  "ImageObject",
  "SearchAction",
  "ContactPoint",
  "PostalAddress",
]);
// The page itself, as distinct from the thing it presents. Second choice for
// the primary entity, and where the primary's missing fields are looked up —
// Yoast puts the URL and description there, not on the Article.
const PAGE_TYPES = new Set([
  "WebPage",
  "ItemPage",
  "AboutPage",
  "CollectionPage",
  "ContactPage",
  "ProfilePage",
  "SearchResultsPage",
  "CheckoutPage",
  "QAPage",
  "FAQPage",
  "MedicalWebPage",
]);

// "https://schema.org/NewsArticle" and "schema:NewsArticle" are NewsArticle.
const typesOf = (n: Node): string[] => allStrings(n["@type"]).map((t) => t.slice(Math.max(t.lastIndexOf("/"), t.lastIndexOf(":")) + 1));

/** 3 for the thing a page presents (an article, a product, a recipe…), 2 for the page, 1 untyped, 0 site chrome. */
function rank(n: Node): number {
  const types = typesOf(n);
  if (!types.length) return 1;
  if (types.some((t) => !CHROME_TYPES.has(t) && !PAGE_TYPES.has(t))) return 3;
  return types.some((t) => PAGE_TYPES.has(t)) ? 2 : 0;
}

/**
 * Every node that declares an `@id`, by that id, so a reference such as Yoast's
 * `"author": {"@id": "…#/person/1"}` can be followed to the node that names
 * it. The first definition wins; a bare reference never overwrites one.
 */
function indexById(nodes: unknown[]): Map<string, Node> {
  const byId = new Map<string, Node>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > 6) return; // a reference is never buried deeper; hostile nesting is
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    if (!isNode(v)) return;
    const id = v["@id"];
    if (typeof id === "string" && Object.keys(v).length > 1 && !byId.has(id)) byId.set(id, v);
    for (const x of Object.values(v)) if (typeof x === "object") visit(x, depth + 1);
  };
  visit(nodes, 0);
  return byId;
}

function allStrings(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.flatMap(allStrings);
  return [];
}

function firstString(v: unknown): string | undefined {
  return allStrings(v)[0];
}

/**
 * What a page says about itself, merged from JSON-LD and its meta tags.
 *
 * JSON-LD wins on conflict: OpenGraph is written for social-preview cards and is
 * routinely stale or templated, while JSON-LD is what the site feeds search
 * engines and tends to be generated from the real record. But only the JSON-LD
 * that describes THIS page: the primary entity is the first node presenting
 * something (an Article, a Product, a Recipe…), else the page node, and only
 * then site chrome. Taking every field from whichever node came first reported
 * a news story as the newspaper's Organization block, titled with its name.
 *
 * The canonical URL is the page's own `<link rel="canonical">`, then `og:url`,
 * then the JSON-LD `url` — never an `@id`, which is an identifier such as
 * "…/post-slug/#article", not an address. With `baseUrl` (the address the page
 * was fetched from), relative canonical and image URLs are resolved against it.
 */
export function pageMetadata(html: string, opts: { baseUrl?: string } = {}): PageMetadata {
  const entries = metaEntries(html);
  const meta = new Map<string, string>();
  for (const [key, content] of entries) if (!meta.has(key)) meta.set(key, content);
  const jsonLd = extractJsonLd(html);
  const out: PageMetadata = { authors: [], jsonLd };

  const set = <K extends keyof PageMetadata>(k: K, v: PageMetadata[K] | undefined) => {
    if (v !== undefined && out[k] === undefined) out[k] = v;
  };

  const nodes = jsonLd.filter(isNode);
  const byId = indexById(jsonLd);
  // A bare reference reads as the node it points at.
  const deref = (v: unknown): unknown => {
    if (!isNode(v) || typeof v["@id"] !== "string" || "name" in v || "url" in v) return v;
    return byId.get(v["@id"]) ?? v;
  };
  const names = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.flatMap(names);
    const d = deref(v);
    return isNode(d) ? allStrings(d.name) : allStrings(d);
  };
  const image = (v: unknown): string | undefined => {
    if (Array.isArray(v)) return v.map(image).find(Boolean);
    const d = deref(v);
    return isNode(d) ? (firstString(d.url) ?? firstString(d.contentUrl)) : firstString(d);
  };

  // Site chrome never stands in for the page, even alone: an article page whose
  // only JSON-LD is the header's Organization block is still the article, and
  // its OpenGraph tags say so.
  let primary: Node | undefined;
  for (const n of nodes) if (rank(n) > (primary ? rank(primary) : 0)) primary = n;
  const sources = primary ? [primary, ...nodes.filter((n) => n !== primary && rank(n) === 2)] : [];
  for (const n of sources) {
    set("type", firstString(n["@type"]));
    set("title", firstString(n.headline) ?? names(n.name)[0]);
    set("description", firstString(n.description));
    set("publishedAt", firstString(n.datePublished));
    set("modifiedAt", firstString(n.dateModified));
    set("imageUrl", image(n.image));
    set("siteName", names(n.publisher)[0]);
    if (!out.authors.length) out.authors.push(...new Set(names(n.author)));
  }
  const nameOfA = (type: string) => nodes.filter((n) => typesOf(n).includes(type)).flatMap((n) => names(n.name))[0];
  set("siteName", nameOfA("WebSite"));

  set("title", meta.get("og:title") ?? meta.get("twitter:title"));
  set("description", meta.get("og:description") ?? meta.get("description") ?? meta.get("twitter:description"));
  set("type", meta.get("og:type"));
  set("siteName", meta.get("og:site_name"));
  set("siteName", nameOfA("Organization"));
  set("publishedAt", meta.get("article:published_time") ?? meta.get("datepublished") ?? meta.get("citation_publication_date"));
  set("modifiedAt", meta.get("article:modified_time") ?? meta.get("datemodified"));
  set("imageUrl", meta.get("og:image") ?? meta.get("twitter:image"));
  set("canonicalUrl", htmlCanonicalUrl(html) ?? sources.map((n) => firstString(n.url)).find(Boolean));
  // Scholarly pages give each author a tag of their own; every one counts.
  const authorKeys = new Set(["article:author", "author", "citation_author", "dc.creator"]);
  for (const [key, v] of entries) if (authorKeys.has(key) && !out.authors.includes(v)) out.authors.push(v);

  // `<title>` is the last resort — it carries site chrome ("Foo — Example.com")
  // that the structured fields do not.
  set("title", htmlTitle(html));

  if (opts.baseUrl) {
    out.canonicalUrl = resolveUrl(out.canonicalUrl, opts.baseUrl);
    out.imageUrl = resolveUrl(out.imageUrl, opts.baseUrl);
  }
  return out;
}

/** `url` made absolute against `base`; undefined when that yields no http(s) URL. */
function resolveUrl(url: string | undefined, base: string): string | undefined {
  if (!url) return undefined;
  try {
    const abs = new URL(url, base);
    return abs.protocol === "http:" || abs.protocol === "https:" ? abs.href : undefined;
  } catch {
    return undefined;
  }
}
