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
 * Linear by construction. The close is searched forward from its opener, and a
 * search that fails proves no close exists anywhere after it — so that name is
 * never searched for again, rather than once per opener (which is what made the
 * lazy `[\s\S]*?</nav>` regex quadratic on a page of unclosed openers). An
 * element in `toEof` with no close runs to the end of the input instead, the
 * browser's own rule for a raw-text element such as a script cut off by a size
 * cap; the others keep their content, as they always did.
 */
export function dropElements(html: string, names: readonly string[], toEof: ReadonlySet<string> = new Set()): string {
  const open = new RegExp(`<!--|<(${names.join("|")})(?=[\\s/>])`, "gi");
  const unclosed = new Set<string>();
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = open.exec(html))) {
    const name = m[1]?.toLowerCase() ?? "!--";
    if (unclosed.has(name)) continue;
    let end: number;
    if (name === "!--") {
      // From +2, so the degenerate `<!-->` closes itself as the spec says.
      const close = html.indexOf("-->", m.index + 2);
      end = close < 0 ? -1 : close + 3;
    } else {
      const close = closeTagRe(name);
      close.lastIndex = open.lastIndex;
      const c = close.exec(html);
      end = c ? c.index + c[0].length : toEof.has(name) ? html.length : -1;
    }
    if (end < 0) {
      unclosed.add(name);
      continue;
    }
    out += html.slice(last, m.index) + " ";
    last = open.lastIndex = end;
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
