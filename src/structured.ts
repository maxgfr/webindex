import { decodeEntities } from "./fetch.js";

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

const META_TAG = /<meta\b[^>]*>/gi;
const ATTR = (tag: string, name: string): string | undefined => {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  const v = m?.[1] ?? m?.[2] ?? m?.[3];
  return v ? decodeEntities(v).trim() : undefined;
};

/**
 * Every `<script type="application/ld+json">` block that parses.
 *
 * A block that does not parse is skipped rather than thrown: malformed JSON-LD
 * is common (trailing commas, templating artefacts, HTML comments wrapped around
 * it) and must never cost the caller the rest of the page.
 */
export function extractJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = m[1]!
      .replace(/^\s*<!--/, "")
      .replace(/-->\s*$/, "")
      .trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      // A @graph wrapper is the common shape from CMS plugins; flatten it so a
      // caller does not have to know which generator produced the page.
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as { "@graph"?: unknown[] })["@graph"])) {
        out.push(...(parsed as { "@graph": unknown[] })["@graph"]);
      } else if (Array.isArray(parsed)) {
        out.push(...parsed);
      } else {
        out.push(parsed);
      }
    } catch {
      /* malformed block — skip it, keep the page */
    }
  }
  return out;
}

/** Every `<meta>` name/property and its content, lower-cased keys. */
export function extractMetaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  META_TAG.lastIndex = 0;
  for (const m of html.matchAll(META_TAG)) {
    const tag = m[0];
    const key = (ATTR(tag, "property") ?? ATTR(tag, "name") ?? ATTR(tag, "itemprop"))?.toLowerCase();
    const content = ATTR(tag, "content");
    if (key && content && !out.has(key)) out.set(key, content);
  }
  return out;
}

function firstString(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = firstString(x);
      if (s) return s;
    }
    return undefined;
  }
  if (v && typeof v === "object") return firstString((v as { name?: unknown }).name);
  return undefined;
}

function allStrings(v: unknown): string[] {
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  if (Array.isArray(v)) return v.flatMap(allStrings);
  if (v && typeof v === "object") return allStrings((v as { name?: unknown }).name);
  return [];
}

/**
 * What a page says about itself, merged from JSON-LD and its meta tags.
 *
 * JSON-LD wins on conflict: OpenGraph is written for social-preview cards and is
 * routinely stale or templated, while JSON-LD is what the site feeds search
 * engines and tends to be generated from the real record.
 */
export function pageMetadata(html: string): PageMetadata {
  const meta = extractMetaTags(html);
  const jsonLd = extractJsonLd(html);
  const out: PageMetadata = { authors: [], jsonLd };

  const set = <K extends keyof PageMetadata>(k: K, v: PageMetadata[K] | undefined) => {
    if (v !== undefined && out[k] === undefined) out[k] = v;
  };

  // JSON-LD first, so it takes precedence.
  for (const node of jsonLd) {
    if (!node || typeof node !== "object") continue;
    const n = node as Record<string, unknown>;
    set("type", firstString(n["@type"]));
    set("title", firstString(n.headline) ?? firstString(n.name));
    set("description", firstString(n.description));
    set("publishedAt", firstString(n.datePublished));
    set("modifiedAt", firstString(n.dateModified));
    set("canonicalUrl", firstString(n.url) ?? firstString(n["@id"]));
    set("imageUrl", firstString(n.image));
    set("siteName", firstString(n.publisher));
    for (const a of allStrings(n.author)) if (!out.authors.includes(a)) out.authors.push(a);
  }

  set("title", meta.get("og:title") ?? meta.get("twitter:title"));
  set("description", meta.get("og:description") ?? meta.get("description") ?? meta.get("twitter:description"));
  set("type", meta.get("og:type"));
  set("siteName", meta.get("og:site_name"));
  set("publishedAt", meta.get("article:published_time") ?? meta.get("datepublished") ?? meta.get("citation_publication_date"));
  set("modifiedAt", meta.get("article:modified_time") ?? meta.get("datemodified"));
  set("imageUrl", meta.get("og:image") ?? meta.get("twitter:image"));
  set("canonicalUrl", meta.get("og:url"));
  for (const key of ["article:author", "author", "citation_author", "dc.creator"]) {
    const v = meta.get(key);
    if (v && !out.authors.includes(v)) out.authors.push(v);
  }

  // `<title>` is the last resort — it carries site chrome ("Foo — Example.com")
  // that the structured fields do not.
  if (out.title === undefined) {
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
    if (t) out.title = decodeEntities(t).replace(/\s+/g, " ").trim() || undefined;
  }
  return out;
}
