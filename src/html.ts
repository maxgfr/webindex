// HTML scanning primitives shared by the readers of markup: htmlToText and
// extractMainHtml in fetch.ts, extractTables, pageMetadata.
//
// Internal on purpose — index.ts does not re-export this module, so nothing
// here is public API and it can change with its callers. What it holds is the
// part each reader kept re-deriving and getting subtly different: which tags
// break a line, what one tag looks like, and how to drop a whole element
// without a DOM.
//
// Every pattern here is linear on adversarial input. That is the constraint
// that shaped them, and the comments say where it bites.

import { decodeEntities } from "./entities.js";

// Tags whose opening or closing marks a line break in extracted text.
export const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "p",
  "div",
  "section",
  "article",
  "li",
  "tr",
  "td",
  "th",
  "ul",
  "ol",
  "pre",
  "blockquote",
  "table",
  "caption",
  "dl",
  "dt",
  "dd",
  "header",
  "footer",
  "nav",
  "aside",
  "main",
  "search",
  "figure",
  "figcaption",
  "details",
  "summary",
  "address",
  "form",
  "fieldset",
  "legend",
  "hgroup",
  "center",
  "dialog",
  "menu",
]);

// Phrasing elements, which a browser renders with no whitespace of their own:
// H<sub>2</sub>O is "H2O", and "Perry White</a>, said" has no space before the
// comma. Anything neither block nor inline (img, input, button, an unknown or
// custom element) is safest read as a space.
export const INLINE_TAGS: ReadonlySet<string> = new Set([
  "a",
  "abbr",
  "acronym",
  "b",
  "bdi",
  "bdo",
  "big",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "font",
  "i",
  "ins",
  "kbd",
  "label",
  "mark",
  "nobr",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "time",
  "tt",
  "u",
  "var",
  "wbr",
]);

// One tag, opening or closing. A `>` inside a quoted attribute value does not
// end it. The unquoted runs exclude `<` as well as `>`, and that is what keeps
// the scan linear: prose like "if a<b then" has no `>` after its `<`, and a
// run allowed to cross `<` read from EVERY such `<` to the end of the page —
// O(n²), a minute of CPU for one hostile megabyte.
export const TAG_RE = /<[a-zA-Z!/?][^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/g;
// The fallback for a tag whose quotes never balance. Stops at the next `<` for
// the same reason.
export const LOOSE_TAG_RE = /<[a-zA-Z!/?][^<>]*>/g;

/** The lower-cased element name of a tag, "" for a comment or a doctype. */
export const tagName = (tag: string): string => /^<\/?([a-zA-Z][^\s/>]*)/.exec(tag)?.[1]?.toLowerCase() ?? "";

// `</name>` regexes, compiled once per element name.
const CLOSE_TAG_RE = new Map<string, RegExp>();
export function closeTagRe(name: string): RegExp {
  let re = CLOSE_TAG_RE.get(name);
  if (!re) CLOSE_TAG_RE.set(name, (re = new RegExp(`</${name}\\s*>`, "gi")));
  return re;
}

/**
 * The attributes of one tag, names lower-cased, first occurrence winning.
 *
 * A name only starts where the previous character is a delimiter: without the
 * lookbehind, a tag holding one long unbroken run and no `=` was re-scanned from
 * every character of the run.
 */
export function htmlAttributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of tag.matchAll(/(?<![^\s"'<>/=])([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    const name = m[1]!.toLowerCase();
    if (!attrs.has(name)) attrs.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

// RCDATA, stepped over whole: a browser reads everything up to `</title>` as
// text, so a "<script>" written in a title opens nothing. Taken for an opener,
// it paired with the head's real </script> and deleted the title and the
// canonical after it.
const RCDATA_ELEMENTS: ReadonlySet<string> = new Set(["title"]);

// Foreign elements, the only ones a trailing "/>" closes in HTML: `<svg/>` is
// empty, where `<script/>` still runs to its `</script>`.
const SELF_CLOSING_FOREIGN: ReadonlySet<string> = new Set(["svg", "math"]);

// What a head may hold. The first tag that is none of these ends a head whose
// </head> was omitted, as a browser ends it (`<body` included).
const HEAD_CONTENT: ReadonlySet<string> = new Set(["title", "meta", "link", "base", "style", "script", "noscript", "template"]);
const HEAD_RAW: ReadonlySet<string> = new Set(["title", "style", "script", "noscript", "template"]);

/** Where a head with no `</head>` ends, or -1 when its own content never closes. */
function implicitHeadEnd(html: string, from: number): number {
  const re = new RegExp(TAG_RE.source, "g");
  re.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (tag[1] === "/" || tag[1] === "!" || tag[1] === "?") continue;
    const name = tagName(tag);
    if (!HEAD_CONTENT.has(name)) return m.index;
    if (!HEAD_RAW.has(name) || tag.endsWith("/>")) continue;
    const close = closeTagRe(name);
    close.lastIndex = re.lastIndex;
    const c = close.exec(html);
    if (!c) return -1;
    re.lastIndex = c.index + c[0].length;
  }
  return -1;
}

/**
 * Replace every comment and every `<name …>…</name>` element among `names`
 * with a space, content and all.
 *
 * Comments and elements go in ONE left-to-right pass, so whichever opens first
 * owns the text up to its own close. Two separate passes get one of the two
 * orders wrong: comments first lets a script containing "<!--" swallow the
 * prose after it; elements first lets "<!-- <script> -->" pair with a real
 * </script> further down and delete the article in between.
 *
 * The pass steps over every other tag whole, quoted values and all, so an
 * opener QUOTED in an attribute — alt="how a <script> tag works" — is text, as
 * it is to a browser. Searched for bare, it ran to the end of the page. The
 * bare opener is still the fallback for a tag that never closes, such as a
 * script cut off by a size cap inside its own tag.
 *
 * Linear by construction. The close is searched forward from its opener, and a
 * search that fails proves no close exists anywhere after it — so that name is
 * never searched for again, rather than once per opener (which is what made the
 * lazy `[\s\S]*?</nav>` regex quadratic on a page of unclosed openers). An
 * element in `toEof` with no close runs to the end of the input instead, the
 * browser's own rule for a raw-text element such as a script cut off by a size
 * cap; the others keep their content, as they always did.
 */
export function dropElements(html: string, names: readonly string[], toEof: ReadonlySet<string> = new Set()): string {
  // Nothing to drop is the common case for a second pass over a copy already
  // cleaned, and for a fragment: one scan for an opener, not one per tag.
  if (!new RegExp(`<!--|<(?:${names.join("|")})(?=[\\s/>])`, "i").test(html)) return html;
  const drop = new Set(names);
  const open = new RegExp(`<!--|${TAG_RE.source}|<(${names.join("|")})(?=[\\s/>])`, "gi");
  const unclosed = new Set<string>();
  // Names whose close was searched for and is absent: never searched again.
  const noClose = new Set<string>();
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = open.exec(html))) {
    const tag = m[0];
    const name = m[1]?.toLowerCase() ?? (tag === "<!--" ? "!--" : tag[1] === "/" ? "" : tagName(tag));
    const opaque = !drop.has(name) && RCDATA_ELEMENTS.has(name);
    if ((name !== "!--" && !drop.has(name) && !opaque) || unclosed.has(name)) continue;
    let end: number;
    if (!m[1] && SELF_CLOSING_FOREIGN.has(name) && tag.endsWith("/>")) {
      // `<svg/>` is a whole, empty element: its close is the NEXT svg's.
      end = m.index + tag.length;
    } else if (name === "!--") {
      // From +2, so the degenerate `<!-->` closes itself as the spec says.
      const close = html.indexOf("-->", m.index + 2);
      end = close < 0 ? -1 : close + 3;
    } else {
      let c: RegExpExecArray | null = null;
      if (!noClose.has(name)) {
        const close = closeTagRe(name);
        close.lastIndex = open.lastIndex;
        c = close.exec(html);
        if (!c) noClose.add(name);
      }
      end = c ? c.index + c[0].length : toEof.has(name) ? html.length : name === "head" ? implicitHeadEnd(html, open.lastIndex) : -1;
    }
    if (end < 0) {
      unclosed.add(name);
      continue;
    }
    if (!opaque) {
      out += html.slice(last, m.index) + " ";
      last = end;
    }
    open.lastIndex = end; // an opaque element is kept, only stepped over
  }
  return last === 0 ? html : out + html.slice(last);
}

export interface Region {
  /** Just past the opening tag. */
  start: number;
  /** At the matching close tag. */
  end: number;
  /** At the opening tag. */
  from: number;
  /** Just past the matching close tag. */
  to: number;
  /** The opening tag itself. */
  open: string;
}

/**
 * Every `<tag>` element whose opening tag passes `isCandidate`, as the span
 * between its opening tag and its MATCHING close.
 *
 * One pass with a stack: push on open, pop on close. A lazy `[\s\S]*?</tag>`
 * truncates a container at its first nested close, and re-scanning forward from
 * each candidate to balance it by hand costs a pass per candidate — quadratic
 * on a page of thousands of unclosed ones. An element that never closes yields
 * no region.
 */
export function balancedRegions(html: string, tag: string, isCandidate: (open: string) => boolean): Region[] {
  const re = new RegExp(`<${tag}(?=[\\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>|</${tag}\\s*>`, "gi");
  const stack: { start: number; from: number; open?: string }[] = [];
  const out: Region[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[0][1] === "/") {
      const top = stack.pop();
      if (top?.open) out.push({ start: top.start, end: m.index, from: top.from, to: re.lastIndex, open: top.open });
    } else {
      stack.push({ start: re.lastIndex, from: m.index, open: isCandidate(m[0]) ? m[0] : undefined });
    }
  }
  return out;
}

/**
 * Remove every element whose ARIA `role` is one of `roles`, content and all.
 *
 * The names of the elements carrying such a role are found first, then each
 * name is balanced in one stack pass, so a `<div role="navigation">` holding
 * nested divs ends at its own close. Where such elements nest, the outermost
 * goes. One whose close never comes is left in place: guessing where it ends
 * could take the article with it.
 */
export function dropLandmarks(html: string, roles: readonly string[]): string {
  const role = `\\srole\\s*=\\s*["']?(?:${roles.join("|")})(?=["'\\s/>])`;
  const hasRole = new RegExp(role, "i");
  const names = new Set<string>();
  for (const m of html.matchAll(new RegExp(`<([a-zA-Z][a-zA-Z0-9-]*)(?=[\\s/>])[^<>]*${role}`, "gi"))) names.add(m[1]!.toLowerCase());
  if (!names.size) return html;
  const regions = [...names].flatMap((name) => balancedRegions(html, name, (open) => hasRole.test(open))).sort((a, b) => a.from - b.from);
  let out = "";
  let last = 0;
  for (const r of regions) {
    if (r.from < last) continue; // inside one already dropped
    out += `${html.slice(last, r.from)} `;
    last = r.to;
  }
  return last === 0 ? html : out + html.slice(last);
}

// The elements a language selector is built from.
const SELECTOR_CONTAINERS: ReadonlySet<string> = new Set(["div", "ul", "ol", "menu", "nav", "section", "aside", "details"]);
// Content no selector holds: a container with one of these is more than a selector.
const SELECTOR_BLOCKERS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "table", "article", "main", "pre", "blockquote"]);
const HREFLANG_ATTR = /\shreflang\s*=/i;
// A selector offers more choices than this; two "read it in" links are prose.
const MIN_LANGUAGE_LINKS = 3;
// Text a selector may hold beside its language links: "163 languages", "Edit links".
const MAX_SELECTOR_TEXT = 80;

interface SelectorNode {
  from: number;
  to: number;
  links: number;
  lang: number;
  text: number;
  blocks: number;
  parent: SelectorNode | undefined;
}

/**
 * Remove every language selector: a block whose links mostly carry `hreflang`
 * (the other versions of this page), with its label and its edit link.
 *
 * A selector is found from the inside out. The smallest container whose links
 * are mostly `hreflang` is one; it widens to its parent only while the parent
 * still is one, holds no heading, paragraph or table, and adds almost no text
 * of its own. So "163 languages" above the list goes with it, and the article
 * of a stub, which has fewer links than the page has languages, never does.
 * Whatever the site: MediaWiki's dropdown, a docs theme's language menu.
 *
 * One pass over the tags; the counts of a container are differences of running
 * totals taken at its open and its close.
 */
export function dropLanguageSelectors(html: string): string {
  let seen = 0;
  for (let i = html.indexOf("hreflang"); i >= 0 && seen < MIN_LANGUAGE_LINKS; i = html.indexOf("hreflang", i + 8)) seen++;
  if (seen < MIN_LANGUAGE_LINKS) return html;

  const totals = { links: 0, lang: 0, text: 0, blocks: 0 };
  const stack: { name: string; node: SelectorNode; at: typeof totals }[] = [];
  // How many elements of each name are on the stack.
  const open = new Map<string, number>();
  const done: SelectorNode[] = [];
  let inLangLink = false;
  let last = 0;
  const re = new RegExp(TAG_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (!inLangLink) totals.text += countVisible(html, last, m.index);
    last = re.lastIndex;
    const tag = m[0];
    const closing = tag[1] === "/";
    const name = tagName(tag);
    if (name === "a") {
      if (closing) inLangLink = false;
      else {
        totals.links++;
        if (HREFLANG_ATTR.test(tag)) {
          totals.lang++;
          inLangLink = true;
        }
      }
    } else if (!closing && SELECTOR_BLOCKERS.has(name)) totals.blocks++;
    if (!SELECTOR_CONTAINERS.has(name)) continue;
    if (!closing) {
      if (tag.endsWith("/>")) continue;
      stack.push({ name, node: { from: m.index, to: -1, links: 0, lang: 0, text: 0, blocks: 0, parent: stack.at(-1)?.node }, at: { ...totals } });
      open.set(name, (open.get(name) ?? 0) + 1);
      continue;
    }
    // Close the nearest open element of this name; any left open inside it
    // never closed. A close with no open element of its name is skipped
    // without a walk down the stack: searched every time, a run of stray
    // </div> under thousands of open <ul> was quadratic.
    if (!open.get(name)) continue;
    let i = stack.length - 1;
    while (stack[i]!.name !== name) i--;
    // Each element leaves the stack once, so the walk is paid for by the pushes.
    for (let j = i; j < stack.length; j++) open.set(stack[j]!.name, open.get(stack[j]!.name)! - 1);
    const { node, at } = stack[i]!;
    stack.length = i;
    Object.assign(node, {
      to: re.lastIndex,
      links: totals.links - at.links,
      lang: totals.lang - at.lang,
      text: totals.text - at.text,
      blocks: totals.blocks - at.blocks,
    });
    done.push(node);
  }

  const isSelector = (n: SelectorNode | undefined): n is SelectorNode =>
    !!n && n.to >= 0 && n.lang >= MIN_LANGUAGE_LINKS && n.lang * 2 > n.links && n.blocks === 0 && n.text <= MAX_SELECTOR_TEXT;
  // The outermost selector above each one, outermost first: an element
  // closes after everything inside it, so in reverse close order a parent is
  // settled before its children, and each takes its parent's answer rather
  // than climbing — a climb per node was quadratic on deeply nested selectors.
  const outermost = new Map<SelectorNode, SelectorNode>();
  const targets = new Set<SelectorNode>();
  for (let k = done.length - 1; k >= 0; k--) {
    const n = done[k]!;
    if (!isSelector(n)) continue;
    const top = isSelector(n.parent) ? (outermost.get(n.parent) ?? n.parent) : n;
    outermost.set(n, top);
    targets.add(top);
  }
  if (!targets.size) return html;
  let out = "";
  let at = 0;
  for (const r of [...targets].sort((a, b) => a.from - b.from)) {
    if (r.from < at) continue;
    out += `${html.slice(at, r.from)} `;
    at = r.to;
  }
  return out + html.slice(at);
}

/** Characters of `html[from, to)` that are not whitespace: a container's own text, roughly. */
function countVisible(html: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) {
    const c = html.charCodeAt(i);
    if (c > 32) n++;
  }
  return n;
}

// ARIA landmarks that mark page chrome, as <nav> and <footer> do by name: the
// site's navigation, its header and its footer.
export const CHROME_ROLES: readonly string[] = ["navigation", "banner", "contentinfo"];

// Never prose, whatever the page: dropped with everything inside. A <select>'s
// options are a form widget — a size picker, a list of every country — and
// read as a run-on sentence of noise.
export const HIDDEN_ELEMENTS: readonly string[] = ["script", "style", "noscript", "head", "svg", "template", "select", "datalist"];
// Page chrome, dropped too unless the caller asked for the whole page.
export const CHROME_ELEMENTS: readonly string[] = ["nav", "footer"];
// Raw-text elements run to the end of the document when their close never
// comes. Not <head>: omitting </head> is legal and common.
export const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(["script", "style"]);

// ── What a page says about itself ───────────────────────────────────────────
// Its title, its canonical, its meta tags: read off ONE copy of the page with
// what never names it taken out, rather than a fresh dropElements pass over the
// whole page for each — fetchAndExtract and pageMetadata both read all three.

// Never where a page names itself: an icon's <svg><title> ("Search icon")
// was the title of every SPA shell whose <head> had none.
export const METADATA_HIDDEN: readonly string[] = ["script", "style", "template", "svg"];

/**
 * The text of the first `<name>` element in `html`, markup out, entities
 * decoded, whitespace collapsed. The close is searched once, forward from the
 * opener, so an unclosed one costs one pass rather than a lazy regex's pass
 * per opener.
 */
export function firstElementText(html: string, name: string): string | undefined {
  const open = new RegExp(`<${name}(?=[\\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>`, "i").exec(html);
  if (!open) return undefined;
  const close = closeTagRe(name);
  close.lastIndex = open.index + open[0].length;
  const c = close.exec(html);
  if (!c) return undefined;
  const inner = html.slice(open.index + open[0].length, c.index).replace(TAG_RE, (tag) => (INLINE_TAGS.has(tagName(tag)) ? "" : " "));
  return decodeEntities(inner).replace(/\s+/g, " ").trim() || undefined;
}

// The first `<meta>` content among `keys` (name or property, lower-case), by
// the order of `keys` rather than of the document.
export function metaContent(html: string, keys: readonly string[]): string | undefined {
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
 * The URL a page declares for ITSELF, in a copy with scripts, styles and
 * comments already out: `<link rel="canonical">`, else the OpenGraph `og:url`.
 * Read up to the end of <head>, wherever that is. A fixed window missed the
 * canonical of every page that inlines a large critical stylesheet first, as
 * Next and Gatsby do.
 */
export function canonicalHref(clean: string): string | undefined {
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
