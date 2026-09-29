// HTML to CommonMark.
//
// htmlToText keeps a page's headings as `#` lines and flattens the rest, which
// is right for scoring lines against a question and loses what the page said
// with its structure: which words were a link and to where, which lines were
// code, what was a list. Firecrawl hands back Markdown for the same page, so
// the same fetch returned two shapes depending on whether a container happened
// to be running. This is the built-in reader's Markdown, so the shape no longer
// depends on the machine.
//
// One left-to-right pass over the tags, with two small stacks: the open blocks
// that prefix every line they hold (list items, blockquotes), and the open
// inline elements that wrap the text they hold (links, emphasis, code). No DOM
// and no tree — lines are written out as their blocks close. It is built on the
// primitives html.ts shares with htmlToText and is linear for the same
// reasons: every forward search remembers that it failed, and both stacks are
// bounded, so no close tag ever searches further than a fixed depth.

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
import { extractTables, tableToMarkdown } from "./tables.js";

export interface MarkdownOptions {
  /**
   * The address the HTML came from. Links and images resolve against it — or
   * against the page's own `<base href>`, itself resolved against this — so
   * every URL in the output is absolute. Without either, a relative URL is
   * kept as written.
   */
  baseUrl?: string;
  /** Keep navigation, footers and ARIA chrome, as htmlToText's `fullPage` does. */
  fullPage?: boolean;
}

/**
 * A page as CommonMark: headings, paragraphs, links and images with absolute
 * URLs, emphasis, inline code, fenced code blocks (verbatim, with the language
 * a `language-x`, `lang-x` or `highlight-x` class names), ordered, unordered
 * and nested lists, blockquotes, rules, and tables as GFM tables.
 *
 * Drops what htmlToText drops — scripts, styles, forms' option lists, and the
 * page chrome unless `fullPage` — and escapes the text's own Markdown
 * metacharacters, so a literal `*` or `[1]` does not become syntax. Pass the
 * main-content region (extractMainHtml) for an article rather than a page.
 */
export function htmlToMarkdown(html: string, opts: MarkdownOptions = {}): string {
  return markdownAgainst(html, documentBaseUrl(withoutNul(html), opts.baseUrl), opts.fullPage);
}

/**
 * htmlToMarkdown for a caller that has already read the page's <base href>
 * off the whole page, as it must once isolation has cut the <head> away:
 * `base` is final, and a <base> still in `html` is not applied again. A
 * path-relative one (`docs/`) resolved a second time against its own result
 * would send every link one directory too deep.
 */
export function markdownAgainst(html: string, base: string | undefined, fullPage?: boolean): string {
  const src = withoutNul(html);
  const hidden = fullPage ? HIDDEN_ELEMENTS : [...HIDDEN_ELEMENTS, ...CHROME_ELEMENTS];
  let s = dropElements(src, hidden, RAW_TEXT_ELEMENTS);
  if (!fullPage) s = dropLandmarks(s, CHROME_ROLES);

  // Every table that closes, by where it opens: one stack pass for the page.
  const tables = new Map<number, Region>();
  if (TABLE_OPEN.test(s)) for (const r of balancedRegions(s, "table", () => true)) tables.set(r.from, r);

  const w = new Writer();
  // A copy of the shared pattern: extractTables runs TAG_RE itself mid-scan,
  // and a shared lastIndex would be reset under this loop.
  const tag = new RegExp(TAG_RE.source, "g");
  const headingEdge = new RegExp(HEADING_EDGE.source, "gi");
  let preUnclosed = false;
  // Where the open heading's own close is; -1 while none is open, or while the
  // open one never closes and ends at the next block instead.
  let headingEnd = -1;
  // The opening <div>s around the scan, for a highlighter's language class on
  // the wrapper of a <pre> (GitHub's, Sphinx's). Bounded like the other stacks.
  const divs: string[] = [];
  let divOverflow = 0;
  let prevEnd = -1;
  let prevClosed = false;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(s))) {
    if (m.index > last) w.text(s.slice(last, m.index));
    last = tag.lastIndex;
    const t = m[0];
    const closing = t[1] === "/";
    const adjacent = m.index === prevEnd && prevClosed && !closing;
    prevEnd = tag.lastIndex;
    prevClosed = closing;
    const name = tagName(t);
    if (!name) continue; // a doctype or processing instruction; comments are gone

    if (name === "div") {
      if (closing) {
        if (divOverflow) divOverflow--;
        else divs.pop();
      } else if (divs.length < MAX_BLOCK_DEPTH * 4) divs.push(t);
      else divOverflow++;
    }

    const heading = /^h[1-6]$/.test(name) ? Number(name[1]) : 0;
    if (w.heading) {
      if (heading) {
        // A heading tag of any level ends the open heading, as a browser ends it.
        w.flush();
        headingEnd = -1;
        if (closing) continue;
      } else if (BLOCK_TAGS.has(name) || name === "br" || name === "hr") {
        // Inside a heading that closes, a block is a space: the heading stays
        // one line. One that never closes ends here instead, rather than
        // swallowing the rest of the page.
        if (headingEnd >= 0 && m.index < headingEnd) {
          w.space();
          continue;
        }
        w.flush();
        headingEnd = -1;
      }
    }

    if (heading) {
      w.flush();
      if (closing) continue;
      w.heading = heading;
      headingEdge.lastIndex = tag.lastIndex;
      const edge = headingEdge.exec(s);
      headingEnd = edge && edge[0][1] === "/" ? edge.index : -1;
      continue;
    }

    if (name === "pre" && !closing && !preUnclosed) {
      const close = closeTagRe("pre");
      close.lastIndex = tag.lastIndex;
      const c = close.exec(s);
      if (c) {
        w.flush();
        w.codeBlock(s.slice(tag.lastIndex, c.index), codeLanguage(t, s.slice(tag.lastIndex, c.index), divs));
        last = tag.lastIndex = prevEnd = c.index + c[0].length;
        prevClosed = true;
        continue;
      }
      preUnclosed = true; // no </pre> anywhere after: never searched for again
    }

    if (name === "table" && !closing) {
      const region = tables.get(m.index);
      const table = region && !isLayoutTable(t, s, region) ? extractTables(s.slice(region.from, region.to))[0] : undefined;
      if (region && table) {
        w.flush();
        // Cells are text like any other: `<length>` or `*` in one is not syntax.
        const escaped = {
          ...(table.caption ? { caption: escapeText(table.caption) } : {}),
          headers: table.headers.map((cell) => escapeText(cell)),
          rows: table.rows.map((row) => row.map((cell) => escapeText(cell))),
        };
        w.block(tableToMarkdown(escaped).split("\n"));
        last = tag.lastIndex = prevEnd = region.to;
        prevClosed = true;
        continue;
      }
    }

    switch (name) {
      case "ul":
      case "ol":
        w.flush();
        if (closing) w.closeList();
        else w.openList(name === "ol", listStart(t));
        continue;
      case "li":
        w.flush();
        if (closing) w.closeItem();
        else w.openItem();
        continue;
      case "blockquote":
        w.flush();
        if (closing) w.closeQuote();
        else w.openQuote();
        continue;
      case "hr":
        w.flush();
        w.rule();
        continue;
      case "br":
        w.hardBreak();
        continue;
      case "img":
        w.image(htmlAttributes(t), base);
        continue;
    }

    const kind = INLINE_KIND[name];
    if (kind) {
      if (closing) {
        w.close(kind);
        continue;
      }
      if (adjacent) w.space();
      if (kind === "a") {
        // An <a> inside an open <a> closes it first, as the HTML parser does.
        w.close("a");
        const href = htmlAttributes(t).get("href");
        w.open("a", linkTarget(href, base), href?.trimStart().startsWith("#"));
      } else w.open(kind);
      continue;
    }
    if (BLOCK_TAGS.has(name)) w.flush();
    else if (INLINE_TAGS.has(name)) {
      if (adjacent) w.space();
    } else w.space();
  }
  if (last < s.length) w.text(s.slice(last));
  return w.finish();
}

const NUL = "\u0000";

// As htmlToText does: a NUL is U+FFFD, as a browser reads it.
function withoutNul(html: string): string {
  return html.includes(NUL) ? html.split(NUL).join("�") : html;
}
const TABLE_OPEN = /<table[\s/>]/i;
// The next heading tag of any level, open or close: where a heading ends.
const HEADING_EDGE = /<\/h[1-6]\s*>|<h[1-6](?=[\s/>])/;

// How deep blocks and inline elements nest before deeper ones are read as
// plain text. Every line carries its blocks' prefixes, and a close searches
// its stack for its opener; bounding both is what keeps a page of ten thousand
// unclosed <blockquote>s or <b>s linear. Real documents stop well short.
const MAX_BLOCK_DEPTH = 24;
const MAX_INLINE_DEPTH = 16;

type InlineKind = "a" | "em" | "strong" | "code";
const INLINE_KIND: Record<string, InlineKind | undefined> = {
  a: "a",
  em: "em",
  i: "em",
  strong: "strong",
  b: "strong",
  code: "code",
  kbd: "code",
  samp: "code",
  tt: "code",
};

// `first`: nothing written inside it yet. An item's first line carries its
// marker; a quote's marker is left off the blank line that comes before it.
// `alt`: a list's items are marked `+` or `1)` rather than `-` or `1.`.
type Block =
  | { kind: "list"; ordered: boolean; alt: boolean; next: number; items: number; last: string }
  | { kind: "item"; marker: string; first: boolean }
  | { kind: "quote"; first: boolean };

interface Frame {
  kind: InlineKind;
  /** Where its text starts in the paragraph being written. */
  start: number;
  /** A link's absolute target; absent for an anchor that goes nowhere. */
  href?: string;
  /** A link to an anchor on this same page. */
  self?: boolean;
  /** Adds nothing of its own: nested in one of its kind, in code, or past the depth bound. */
  inert?: boolean;
}

/**
 * The Markdown being written: finished lines, and the paragraph in progress as
 * parts, so wrapping a link or an emphasis costs its own text rather than a
 * copy of the paragraph so far.
 */
class Writer {
  heading = 0;
  private readonly lines: string[] = [];
  private readonly blocks: Block[] = [];
  private blockOverflow = 0;
  private parts: string[] = [];
  private frames: Frame[] = [];
  private pendingSpace = false;
  private needBlank = false;
  /** The list closed last: its container's depth, its kind, and how many lines were written by then. */
  private closedList?: { depth: number; ordered: boolean; alt: boolean; lines: number };

  text(raw: string): void {
    // A tag whose quotes never balance is not text; htmlToText drops it too.
    const decoded = decodeEntities(raw.includes("<") ? raw.replace(LOOSE_TAG_RE, " ") : raw).replace(HTML_SPACE, " ");
    if (!decoded) return;
    const core = decoded.trim();
    if (decoded[0] === " ") this.space();
    if (core) this.push(this.inCode() ? core : escapeText(core, { before: this.joinsBefore(decoded[0] !== " "), after: decoded[decoded.length - 1] !== " " }));
    if (core && decoded[decoded.length - 1] === " ") this.space();
  }

  space(): void {
    if (this.parts.length) this.pendingSpace = true;
  }

  hardBreak(): void {
    if (this.heading || this.inCode()) this.space();
    else if (this.parts.length) {
      this.parts.push("\n");
      this.pendingSpace = false;
    }
  }

  open(kind: InlineKind, href?: string, self?: boolean): void {
    if (this.frames.length >= MAX_INLINE_DEPTH) return;
    const inert = (kind === "a" && href === undefined) || this.inCode() || (kind !== "a" && this.frames.some((f) => f.kind === kind));
    this.frames.push({ kind, start: this.parts.length, ...(href !== undefined ? { href } : {}), ...(self ? { self } : {}), ...(inert ? { inert } : {}) });
  }

  /** Close the innermost open `kind`, and whatever opened inside it and never closed. */
  close(kind: InlineKind): void {
    let i = this.frames.length - 1;
    while (i >= 0 && this.frames[i]!.kind !== kind) i--;
    if (i < 0) return;
    while (this.frames.length > i) this.wrap(this.frames.pop()!);
  }

  image(attrs: Map<string, string>, base: string | undefined): void {
    // A lazy-loading page puts a placeholder in src and the picture elsewhere.
    const candidates = [attrs.get("src"), attrs.get("data-src"), attrs.get("data-original"), attrs.get("srcset")?.trim().split(/\s+/)[0]];
    const src = candidates.map((c) => linkTarget(c, base)).find((u) => u !== undefined);
    // A tracking pixel is not a picture.
    const pixel = ["width", "height"].some((d) => /^[01]$/.test(attrs.get(d)?.trim() ?? ""));
    if (!src || pixel || this.inCode()) {
      this.space();
      return;
    }
    const alt = decodeEntities(attrs.get("alt") ?? "")
      .replace(HTML_SPACE, " ")
      .trim();
    this.push(`![${escapeText(alt)}](${destination(src)})`);
  }

  codeBlock(inner: string, lang: string): void {
    const body = decodeEntities(inner.replace(/<br\s*\/?>/gi, "\n").replace(LOOSE_TAG_RE, ""))
      .replace(/\r\n?/g, "\n")
      .replace(/^\n/, "") // the newline right after <pre> is not content, per the spec
      .trimEnd();
    if (!body.trim()) return;
    const fence = "`".repeat(Math.max(3, longestRun(body, "`") + 1));
    this.block([fence + lang, ...body.split("\n"), fence]);
  }

  rule(): void {
    // `***`, never `---`: on an item's first line `- ---` is itself a rule and
    // cuts the list in two (Bootstrap's dropdown dividers are <li><hr>), and
    // straight under a line of text `---` underlines it into a heading.
    this.block(["***"]);
  }

  openList(ordered: boolean, start: number): void {
    const top = this.blocks[this.blocks.length - 1];
    // A list set straight inside a list, no item round it, belongs to the item
    // before it — where a browser draws it. That item goes back on the stack.
    if (top?.kind === "list" && top.items && this.blocks.length + 1 < MAX_BLOCK_DEPTH) this.blocks.push({ kind: "item", marker: top.last, first: false });
    if (!this.room()) return;
    // A list nested in an item follows the item's text with no blank line —
    // when it can: an ordered list interrupts a paragraph only from 1, and
    // "4. Fourth" straight under the item's text continues it. A list opening
    // an empty item shares the item's marker line, so the blank line owed to
    // what came before stands.
    const item = this.blocks[this.blocks.length - 1];
    if (item?.kind === "item" && !item.first && (!ordered || start === 1)) this.needBlank = false;
    // Straight after a list of its kind in the same place, nothing written
    // between, a blank line alone would join the two into one loose list and
    // renumber the second. A new marker character starts a new list.
    const prev = this.closedList;
    const alt = prev !== undefined && prev.depth === this.blocks.length && prev.ordered === ordered && prev.lines === this.lines.length && !prev.alt;
    this.blocks.push({ kind: "list", ordered, alt, next: start, items: 0, last: "" });
  }

  closeList(): void {
    if (this.blockOverflow) {
      this.blockOverflow--;
      return;
    }
    const i = this.nearest("list");
    if (i < 0) return;
    const { ordered, alt } = this.blocks[i] as Extract<Block, { kind: "list" }>;
    this.closedList = { depth: i, ordered, alt, lines: this.lines.length };
    this.blocks.length = i;
    this.needBlank = true;
  }

  openItem(): void {
    if (this.blockOverflow) {
      this.blockOverflow++;
      return;
    }
    // A new item closes the open one: </li> is optional.
    let list = this.nearest("list");
    if (list >= 0) this.blocks.length = list + 1;
    else {
      // An item outside any list reads as one of an unordered list.
      if (!this.room()) return;
      this.blocks.push({ kind: "list", ordered: false, alt: false, next: 1, items: 0, last: "" });
      list = this.blocks.length - 1;
    }
    if (!this.room()) return;
    const owner = this.blocks[list] as Extract<Block, { kind: "list" }>;
    // Not `*`: "* ***", an item holding only a rule, would be a rule itself.
    const marker = owner.ordered ? `${owner.next++}${owner.alt ? ")" : "."} ` : owner.alt ? "+ " : "- ";
    owner.last = marker;
    this.blocks.push({ kind: "item", marker, first: true });
    // The items of one list sit together. The first keeps the blank line owed
    // to what came before: "4. Four" straight under a line of text continues
    // that paragraph rather than starting a list.
    if (owner.items++) this.needBlank = false;
  }

  closeItem(): void {
    if (this.blockOverflow) {
      this.blockOverflow--;
      return;
    }
    // Only an item of the innermost list: a stray </li> closes nothing else.
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const kind = this.blocks[i]!.kind;
      if (kind === "list") return;
      if (kind === "item") {
        this.blocks.length = i;
        return;
      }
    }
  }

  openQuote(): void {
    if (this.room()) this.blocks.push({ kind: "quote", first: true });
  }

  closeQuote(): void {
    if (this.blockOverflow) {
      this.blockOverflow--;
      return;
    }
    const i = this.nearest("quote");
    if (i < 0) return;
    this.blocks.length = i;
    // A paragraph straight after a quote would continue it.
    this.needBlank = true;
  }

  /**
   * End the paragraph or heading in progress and write it out. The inline
   * elements still open close over the text so far and reopen for what
   * follows, so a link wrapped round a heading and a paragraph — a card —
   * links both.
   */
  flush(): void {
    const open = this.frames.map((f) => ({ ...f }));
    while (this.frames.length) this.wrap(this.frames.pop()!);
    const text = this.parts.join("");
    this.parts = [];
    this.pendingSpace = false;
    this.frames = open.map((f) => ({ ...f, start: 0 }));
    const level = this.heading;
    this.heading = 0;
    if (level) {
      const title = text.replace(/\s+/g, " ").trim();
      // "Section #" would lose its "#" as a closing sequence, and a title of
      // nothing but hashes (a glossary's "#") would leave the heading empty.
      if (title) this.block([`${"#".repeat(level)} ${title.replace(/(^|\s)(#+)$/, "$1\\$2")}`]);
      return;
    }
    // Hard breaks split the paragraph into lines; two in a row end it.
    let para: string[] = [];
    for (const raw of `${text}\n\n`.split("\n")) {
      const line = raw.trim();
      if (line) {
        para.push(escapeLineStart(line));
        continue;
      }
      if (!para.length) continue;
      this.block(para.map((l, i) => (i < para.length - 1 ? `${l}  ` : l)));
      para = [];
    }
  }

  /** Write finished lines under the open blocks' prefixes, a blank line before them where one is due. */
  block(content: string[]): void {
    if (!content.length) return;
    if (this.needBlank && this.lines.length) this.lines.push(this.prefix(false).trimEnd());
    for (const line of content) {
      const prefix = this.prefix(true);
      this.lines.push(line ? prefix + line : prefix.trimEnd());
    }
    this.needBlank = true;
  }

  finish(): string {
    this.flush();
    // trimEnd, not /\s+$/: a pattern anchored at the end rescans a verbatim
    // code block's long whitespace run from each of its characters.
    return this.lines.join("\n").trimEnd();
  }

  private push(markdown: string): void {
    if (this.pendingSpace) this.parts.push(" ");
    this.pendingSpace = false;
    this.parts.push(markdown);
  }

  private inCode(): boolean {
    return this.frames.some((f) => f.kind === "code");
  }

  /**
   * Whether text pushed next will stand straight after something other than
   * a space or a line start: the text before it, when `touching` it, or the
   * marker of an emphasis or link that opens where it starts (the marker goes
   * in when the element closes, and moves the element's leading space outside).
   */
  private joinsBefore(touching: boolean): boolean {
    const last = this.parts[this.parts.length - 1];
    if (touching && !this.pendingSpace && last !== undefined && last !== "\n") return true;
    return this.frames.some((f) => !f.inert && f.start === this.parts.length);
  }

  /** Replace an element's text with its Markdown, its outer whitespace kept outside it. */
  private wrap(f: Frame): void {
    if (f.inert) return;
    const trailing = this.pendingSpace;
    this.pendingSpace = false;
    const content = this.parts.splice(f.start).join("");
    const core = content.trim();
    const lead = content.slice(0, content.length - content.trimStart().length);
    const trail = content.slice(content.trimEnd().length);
    this.whitespace(lead);
    if (core) {
      const markdown = wrapInline(f, core, this.heading > 0);
      // A "!" straight before a link's "[" would turn the link into an image.
      const last = this.parts.length - 1;
      if (f.kind === "a" && markdown && !this.pendingSpace && this.parts[last]?.endsWith("!")) this.parts[last] = `${this.parts[last]!.slice(0, -1)}\\!`;
      this.push(markdown);
    }
    this.whitespace(trail);
    if (trailing) this.space();
  }

  private whitespace(ws: string): void {
    if (ws.includes("\n")) {
      if (this.parts.length) this.parts.push("\n");
      this.pendingSpace = false;
    } else if (ws) this.space();
  }

  private prefix(consume: boolean): string {
    let p = "";
    for (const b of this.blocks) {
      if (b.kind === "quote") {
        if (consume || !b.first) p += "> ";
        if (consume) b.first = false;
      } else if (b.kind === "item") {
        p += b.first && consume ? b.marker : " ".repeat(b.marker.length);
        if (consume) b.first = false;
      }
    }
    return p;
  }

  private nearest(kind: Block["kind"]): number {
    for (let i = this.blocks.length - 1; i >= 0; i--) if (this.blocks[i]!.kind === kind) return i;
    return -1;
  }

  /** Whether one more block may nest; past the bound it is counted instead, and its close uncounted. */
  private room(): boolean {
    if (this.blocks.length < MAX_BLOCK_DEPTH) return true;
    this.blockOverflow++;
    return false;
  }
}

// A permalink's whole text: Sphinx's ¶, a docs theme's # or §, GitHub's icon.
const PERMALINK_TEXT = /^(?:¶|#|§|🔗)$/u;

function wrapInline(f: Frame, core: string, inHeading: boolean): string {
  switch (f.kind) {
    case "em":
      return `*${core}*`;
    case "strong":
      return `**${core}**`;
    case "code": {
      const code = core.replace(/\s+/g, " ");
      const ticks = "`".repeat(longestRun(code, "`") + 1);
      // A span that starts or ends with a backtick needs a space inside its fence.
      const pad = code[0] === "`" || code[code.length - 1] === "`" ? " " : "";
      return `${ticks}${pad}${code}${pad}${ticks}`;
    }
    default:
      if (inHeading && PERMALINK_TEXT.test(core)) return "";
      // A heading's link to its own anchor is a permalink as well: the title is its text.
      if (inHeading && f.self) return core;
      // Two breaks in a row would end the paragraph inside the brackets.
      return `[${core.replace(/\n{2,}/g, "\n")}](${destination(f.href!)})`;
  }
}

// HTML's whitespace, collapsed as a browser collapses it. Not U+00A0: a
// non-breaking space written as a character is content (&nbsp; already decodes
// to a plain space).
const HTML_SPACE = /[ \t\n\r\f]+/g;

// Text characters that are Markdown syntax wherever they stand. A `_` only
// opens or closes emphasis at a word's edge — snake_case is safe as written,
// and escaping it would stop a search for the identifier matching the page.
const ALWAYS_SYNTAX = /[\\`*[\]]/g;
const EDGE_UNDERSCORE = /(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu;
const HTML_LIKE = /<(?=[a-zA-Z/!?])/g;
const ENTITY_LIKE = /&(?=#?[a-zA-Z0-9]+;)/g;
// GFM strikes `~x~` as well as `~~x~~`. A tilde closes only with no space
// before it: escaping those, and a doubled one, leaves every opener without a
// closer, so `~5 minutes` keeps its tilde as written.
const STRIKE = /~(?=~)|(?<=[^\t\n\f\r\p{Zs}])~/gu;
// A '<' or an entity's start that the next run of text could complete.
const OPEN_END = /(?:<|&#?[a-zA-Z0-9]*)$/;

/**
 * A run of text with its Markdown metacharacters escaped, so it reads back as
 * the same text. The syntax that depends on its neighbours — `<` before a tag
 * name, `&` before an entity's name, `~` after a character — is judged within
 * the run. `edges` says which of its ends may touch the next or the last run,
 * no space between: an element that splits `&lt;script&gt;` round "script"
 * writes nothing of its own, and the two halves would join into a live tag.
 * A '<' or '&' at such an end, and a '~' at such a start, is escaped whatever
 * joins it.
 */
function escapeText(s: string, edges?: { before: boolean; after: boolean }): string {
  let out = s.replace(ALWAYS_SYNTAX, "\\$&").replace(EDGE_UNDERSCORE, "\\_").replace(HTML_LIKE, "\\<").replace(ENTITY_LIKE, "\\&").replace(STRIKE, "\\~");
  if (edges?.after) out = out.replace(OPEN_END, "\\$&");
  // STRIKE leaves only a first tilde with none after it; whatever stands before it is outside the run.
  if (edges?.before && out[0] === "~") out = `\\${out}`;
  return out;
}

/**
 * A paragraph line whose start would read as a block marker: a heading, a
 * quote, a bullet, an ordered item ("1986. A good year"), or a line of `-`/`=`
 * that would underline the line above into a heading.
 */
function escapeLineStart(line: string): string {
  const c = line[0];
  if (c === "#") return /^#{1,6}(?:\s|$)/.test(line) ? `\\${line}` : line;
  if (c === ">") return `\\${line}`;
  if (c === "-" || c === "+" || c === "=") return /^[-+=](?:\s|$)/.test(line) || /^(?:[-=]\s*)+$/.test(line) ? `\\${line}` : line;
  const ordered = /^(\d{1,9})[.)](?=\s|$)/.exec(line);
  return ordered ? `${ordered[1]}\\${line.slice(ordered[1]!.length)}` : line;
}

/** The longest run of `ch` in `s`: a fence must be longer than any it holds. */
function longestRun(s: string, ch: string): number {
  let best = 0;
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    run = s[i] === ch ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/**
 * A link or image target as the page meant it: entities decoded, resolved
 * against the base when there is one. undefined for a target that goes
 * nowhere a reader can follow — javascript:, data:, or one that will not
 * resolve.
 */
function linkTarget(raw: string | undefined, base: string | undefined): string | undefined {
  // Read as the URL parser reads it, and a browser following the link: a tab
  // or newline anywhere is dropped, and so is every C0 control or space before
  // the scheme — "&#1;javascript:" is javascript:.
  const href = raw === undefined ? "" : afterControls(decodeEntities(raw).replace(/[\t\n\r]/g, "")).trim();
  if (!href || UNFOLLOWABLE.test(href)) return undefined;
  try {
    const url = new URL(href, base);
    // Judged again on what the parser made of it, which is what is written out.
    return UNFOLLOWABLE.test(url.protocol) ? undefined : url.href;
  } catch {
    return base === undefined ? href : undefined;
  }
}

const UNFOLLOWABLE = /^(?:javascript|vbscript|data):/i;

/** `s` without the C0 controls and spaces the URL parser strips from its start. */
function afterControls(s: string): string {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) <= 0x20) i++;
  return s.slice(i);
}

/**
 * A URL as a Markdown link destination: no raw space, angle bracket or
 * backslash (the URL parser keeps one in a query or fragment, and `\*` there
 * would read as an escaped `*`), parentheses escaped unless they balance.
 */
function destination(url: string): string {
  const d = url.replace(/[ <>\\]/g, (c) => encodeURIComponent(c));
  let depth = 0;
  for (const c of d) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) break;
  }
  return depth === 0 ? d : d.replace(/[()]/g, "\\$&");
}

const BASE_TAG = /<base(?=[\s/>])[^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/gi;

/**
 * The URL a document's relative links resolve against: its first `<base href>`,
 * itself resolved against `pageUrl`, else `pageUrl`. Read from the WHOLE page —
 * the base lives in <head>, which main-content isolation cuts away. A data: or
 * javascript: base is ignored, as the HTML spec has a browser ignore it.
 */
export function documentBaseUrl(html: string, pageUrl?: string): string | undefined {
  if (!/<base[\s/>]/i.test(html)) return pageUrl;
  for (const m of dropElements(html, ["script", "style", "template"], RAW_TEXT_ELEMENTS).matchAll(BASE_TAG)) {
    const href = htmlAttributes(m[0]).get("href");
    if (href === undefined) continue;
    try {
      const base = new URL(decodeEntities(href).trim(), pageUrl);
      return base.protocol === "data:" || base.protocol === "javascript:" ? pageUrl : base.href;
    } catch {
      return pageUrl;
    }
  }
  return pageUrl;
}

// A highlighter's language class: Prism's and highlight.js's `language-x`,
// prettify's `lang-x`, Sphinx's `highlight-x`, GitHub's `highlight-source-x`,
// SyntaxHighlighter's `brush: x` (MDN's).
const LANGUAGE_CLASS = /(?:^|\s)(?:(?:language|lang|highlight(?:-source)?)-|brush:\s*)([\w+#.-]+)/i;
const NO_LANGUAGE = new Set(["none", "nohighlight", "plaintext"]);

/**
 * The language of a code block, from the <pre>, the <code> it opens with, or
 * the nearest wrapping <div>s — "" when none says.
 */
function codeLanguage(pre: string, inner: string, divs: readonly string[]): string {
  const code = /^\s*(<code(?=[\s/>])[^<>]*>)/i.exec(inner)?.[1];
  for (const t of [pre, code, divs[divs.length - 1], divs[divs.length - 2]]) {
    if (!t) continue;
    const lang = LANGUAGE_CLASS.exec(htmlAttributes(t).get("class") ?? "")?.[1]?.toLowerCase();
    if (lang && !NO_LANGUAGE.has(lang)) return lang;
  }
  return "";
}

/**
 * A table used for layout rather than data: one that says so with its role,
 * one holding another table, or one holding a code block (Pygments sets line
 * numbers beside the code in a table). Written as blocks — flattened into one
 * GFM row, a whole page laid out in a table would read as a single cell, and
 * the code would lose its newlines.
 *
 * The search stops at the first <table> or <pre> after the opener, inside or
 * not, so the tables of a page between them scan it once.
 */
function isLayoutTable(open: string, html: string, region: Region): boolean {
  if (/^(?:presentation|none)$/i.test(htmlAttributes(open).get("role")?.trim() ?? "")) return true;
  const inner = new RegExp(LAYOUT_INSIDE.source, "gi");
  inner.lastIndex = region.start;
  const next = inner.exec(html);
  return next !== null && next.index < region.end;
}

const LAYOUT_INSIDE = /<(?:table|pre)[\s/>]/;

/** An ordered list's first number: its `start`, else 1. */
function listStart(open: string): number {
  const n = Number.parseInt(htmlAttributes(open).get("start") ?? "", 10);
  return Number.isFinite(n) && n >= 0 && n < 1e9 ? n : 1;
}
