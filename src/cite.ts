// Reading citations out of a markdown report: the mechanics, never the verdict.
//
// This module moves a documented boundary, so the new one is worth stating
// exactly. Until now this package said citation gates were out of scope, and
// meant it — how a tool numbers its sources, what it counts as grounded and
// where it writes them are product decisions, and folding one in here would
// dictate behaviour rather than share plumbing.
//
// That is still true of the VERDICT. What was never product-specific is the
// reading: which bracketed tokens are citations and which are prose, that a
// `[S1]` inside backticks or a code fence or an HTML comment grounds nothing,
// that a table header row is structure rather than a claim, that a trailing
// "## Sources" listing is the rendered appendix and not evidence of coverage.
// Six skills had their own regex for that, and the subtle cases are exactly
// where independent copies disagree.
//
// So the rule this module holds to, and which its tests pin:
//
//   NOTHING HERE RETURNS A PASS OR A FAIL.
//
// There is no runCheck, no `ok: boolean`, no threshold and no severity. This
// module hands back tokens, masks, claim units and set differences; whether an
// uncited claim is an error or a warning, what coverage is sufficient, and
// whether a missing verdict file is fatal all stay with the skill, because
// those are the sentences its users actually argue about.

// ── Tokens ──────────────────────────────────────────────────────────────────

/**
 * A bracketed token that is not a markdown link.
 *
 * The negative lookahead is the whole subtlety: `[see the spec](https://…)` is
 * a link whose text happens to be bracketed, and counting it as a citation
 * makes every linked phrase look grounded.
 *
 * Global, so callers must reset `lastIndex` or use `matchAll`. The helpers
 * below do; a caller reaching for the constant directly should too.
 */
export const TOKEN_RE = /\[([^\]\n]+)\](?!\()/g;

/** `[S1]` — the numbered-source shape. */
export const SOURCE_TOKEN = /^S\d+$/;
/** `[E1]` — the numbered-evidence shape. */
export const EVIDENCE_TOKEN = /^E\d+$/;
/** `[src/foo.ts:12]` or `[src/foo.ts:12-40]` — the file-and-line shape. */
export const FILE_LINE_TOKEN = /^(.+?):(\d+)(?:-(\d+))?$/;

/** A `[path:line]` or `[path:start-end]` citation, parsed. Undefined when the token is not one. */
export function parseFileLine(token: string): { path: string; start: number; end: number } | undefined {
  const m = FILE_LINE_TOKEN.exec(token.trim());
  if (!m) return undefined;
  const start = Number(m[2]);
  const end = m[3] === undefined ? start : Number(m[3]);
  // A backwards range is a typo, not a range. Returning it would have callers
  // silently resolve zero lines and report the citation as fine.
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return undefined;
  return { path: m[1] as string, start, end };
}

// ── Masking: what cannot ground a claim ─────────────────────────────────────

/**
 * Blank HTML comments, preserving line breaks so every later mask still lines
 * up with the original numbering.
 *
 * A citation inside `<!-- [S1] -->` is invisible to the reader, so it must not
 * ground the sentence beside it.
 */
export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/** Remove inline-code spans, so a `` `[S1]` `` shown as an EXAMPLE is not a citation. */
export function stripInlineCode(line: string): string {
  return line.replace(/`[^`\n]*`/g, " ");
}

/**
 * Lines inside ``` or ~~~ fences, plus the fence lines themselves.
 *
 * A report that documents its own citation format has `[S1]` in a code block;
 * that is a sample, not a source.
 */
export function codeMask(lines: readonly string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i] as string)) {
      mask[i] = true;
      inFence = !inFence;
      continue;
    }
    mask[i] = inFence;
  }
  return mask;
}

/**
 * Lines belonging to a marked blockquote region: a maximal run of consecutive
 * `>` lines in which any line carries `marker`.
 *
 * The marker is the caller's, because what it MEANS is the caller's. One skill
 * uses `[model-hint]` to flag a passage it knows is unsourced; the engine only
 * needs to know which lines to set aside.
 */
export function markedQuoteMask(lines: readonly string[], marker: RegExp): { mask: boolean[]; regions: number } {
  const mask = new Array<boolean>(lines.length).fill(false);
  let regions = 0;
  let i = 0;
  while (i < lines.length) {
    if (!/^\s*>/.test(lines[i] as string)) {
      i++;
      continue;
    }
    let j = i;
    let marked = false;
    while (j < lines.length && /^\s*>/.test(lines[j] as string)) {
      if (marker.test(lines[j] as string)) marked = true;
      j++;
    }
    if (marked) {
      regions++;
      for (let k = i; k < j; k++) mask[k] = true;
    }
    i = j;
  }
  return { mask, regions };
}

const APPENDIX_HEADING = /^\s*(#{2,6})\s+(sources|references|bibliography)\b/i;

/**
 * Lines belonging to a trailing "## Sources" / "## References" section — from
 * its heading through to the next heading of the same or shallower level.
 *
 * That section is the rendered listing of what was cited, not a place where
 * citing happens. Counting its `[S#]` entries marks every source as cited and
 * pads any coverage number computed downstream, which is the failure mode this
 * exists for.
 */
export function appendixMask(lines: readonly string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = /^\s*(#{1,6})\s/.exec(lines[i] as string);
    if (level && h && (h[1] as string).length <= level) level = 0;
    if (!level) {
      const a = APPENDIX_HEADING.exec(lines[i] as string);
      if (a) level = (a[1] as string).length;
    }
    mask[i] = level > 0;
  }
  return mask;
}

/** OR a set of per-line masks together. Length is taken from the first. */
export function orMasks(...masks: readonly boolean[][]): boolean[] {
  const first = masks[0] ?? [];
  return first.map((_, i) => masks.some((m) => m[i] === true));
}

// ── Claim units ─────────────────────────────────────────────────────────────

/**
 * A unit of assertion: one block of prose or one table row, or a list read as a
 * group. Lists stay grouped because an item is often only a claim in the
 * context of its lead-in.
 *
 * `section` is whatever the caller's `sectionTag` returned for the heading this
 * unit sits under — a hook for "this part of the document plays by different
 * rules" without the engine having to know which rules.
 */
export type ClaimUnit = ({ kind: "text"; text: string } | { kind: "list"; items: string[] }) & { section?: string };

export interface ClaimUnitOptions {
  /**
   * Extra lines to set aside, on top of code fences and HTML comments — a
   * marked-quote mask, an appendix mask, or both through `orMasks`.
   */
  exclude?(lines: readonly string[]): boolean[];
  /**
   * A blockquote is its own unit ("unit", the default) or folds into the
   * surrounding prose ("prose").
   *
   * "unit" is the safer reading and the reason it is the default: folding a
   * quotation into the preceding paragraph lets it inherit that paragraph's
   * citation, so a fabricated quote passes on someone else's source.
   */
  blockquotes?: "unit" | "prose";
  /**
   * Drop the header row of a table — the row immediately above the `|---|`
   * separator. It is structure, not an assertion. Default true.
   */
  skipTableHeader?: boolean;
  /**
   * Keep inline-code spans in the STORED text. Structure detection always runs
   * on the stripped form, so a pipe or a bracket inside backticks is never read
   * as a table or a citation either way; this only decides whether a warning
   * that echoes the claim can quote it verbatim. Default false.
   */
  keepInlineCode?: boolean;
  /** Given a heading line's text, the tag to carry on units beneath it. */
  sectionTag?(heading: string): string | undefined;
}

const isHeadingOrRule = (t: string): boolean => /^#{1,6}\s/.test(t) || /^([-*_])\1{2,}$/.test(t);
const isTableSeparator = (line: string): boolean => /\|/.test(line) && /^[\s:|-]+$/.test(line.trim()) && /-/.test(line);
const isTableRow = (line: string): boolean => /\|/.test(line.trim()) && !isTableSeparator(line);
const isListItem = (line: string): boolean => /^\s*([-*+]|\d+\.)\s+\S/.test(line);

function tableCells(line: string): string {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim())
    .join(" ");
}

/**
 * Split a markdown document into claim units.
 *
 * Headings, horizontal rules, code fences, HTML comments and table separators
 * are structure and never become units. What remains is what a reader would
 * call an assertion.
 *
 * This is a parser, not a judge: it says what the document asserts, never
 * whether the assertions are grounded.
 */
export function extractClaimUnits(text: string, opts: ClaimUnitOptions = {}): ClaimUnit[] {
  const lines = stripHtmlComments(text).split("\n");
  const code = codeMask(lines);
  const extra = opts.exclude ? opts.exclude(lines) : [];
  const skip = (i: number) => code[i] === true || extra[i] === true;
  const quoteMode = opts.blockquotes ?? "unit";
  const skipHeader = opts.skipTableHeader !== false;
  const stored = (raw: string) => (opts.keepInlineCode ? raw : stripInlineCode(raw));

  const units: ClaimUnit[] = [];
  let prose: string[] = [];
  let section: string | undefined;
  const tag = (u: ClaimUnit): ClaimUnit => (section === undefined ? u : { ...u, section });
  const flush = () => {
    if (prose.length) units.push(tag({ kind: "text", text: prose.join(" ") }));
    prose = [];
  };

  let i = 0;
  while (i < lines.length) {
    if (skip(i)) {
      flush();
      i++;
      continue;
    }
    const raw = lines[i] as string;
    const line = stripInlineCode(raw);
    const t = line.trim();

    if (t === "" || isHeadingOrRule(t) || isTableSeparator(line)) {
      flush();
      // A heading resets the section tag, so a tagged section ends where the
      // next heading begins rather than running to the end of the document.
      if (/^#{1,6}\s/.test(t)) section = opts.sectionTag?.(t);
      i++;
      continue;
    }

    if (isTableRow(line)) {
      flush();
      const next = i + 1 < lines.length && !skip(i + 1) ? stripInlineCode(lines[i + 1] as string) : "";
      if (!(skipHeader && isTableSeparator(next))) units.push(tag({ kind: "text", text: tableCells(stored(raw)) }));
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      if (quoteMode === "prose") {
        const dequoted = stored(raw)
          .replace(/^\s*>\s?/, "")
          .trim();
        if (dequoted) prose.push(dequoted);
        i++;
        continue;
      }
      // Flush FIRST: without it the quotation joins the paragraph above and
      // inherits its citation.
      flush();
      const quoted: string[] = [];
      while (i < lines.length && !skip(i)) {
        if (!/^\s*>/.test(stripInlineCode(lines[i] as string))) break;
        const dq = stored(lines[i] as string)
          .replace(/^\s*>\s?/, "")
          .trim();
        if (dq) quoted.push(dq);
        i++;
      }
      if (quoted.length) units.push(tag({ kind: "text", text: quoted.join(" ") }));
      continue;
    }

    if (isListItem(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && !skip(i)) {
        const rawL = lines[i] as string;
        const l = stripInlineCode(rawL);
        const tt = l.trim();
        if (tt === "" || isHeadingOrRule(tt) || isTableSeparator(l) || isTableRow(l)) break;
        if (isListItem(l))
          items.push(
            stored(rawL)
              .replace(/^\s*([-*+]|\d+\.)\s+/, "")
              .trim(),
          );
        // A continuation line belongs to the item above it, not to a new one.
        else if (items.length) items[items.length - 1] += ` ${stored(rawL).trim()}`;
        else items.push(stored(rawL).trim());
        i++;
      }
      units.push(tag({ kind: "list", items }));
      continue;
    }

    prose.push(stored(raw));
    i++;
  }
  flush();
  return units;
}

/** The text a unit asserts: one string for prose, one per item for a list. */
export function unitTexts(unit: ClaimUnit): string[] {
  return unit.kind === "text" ? [unit.text] : unit.items;
}

// ── Reading citations ───────────────────────────────────────────────────────

/**
 * The distinct citation tokens in a piece of text, in order of first
 * appearance.
 *
 * `isCitation` is the caller's, and deliberately has no default: `[S1]`,
 * `[E12]`, `[issue#45]` and `[src/foo.ts:12]` are all citations to the skill
 * that uses them and prose to every other one. The engine will not guess.
 */
export function citationTokensIn(text: string, isCitation: (token: string) => boolean): string[] {
  const masked = stripInlineCode(text);
  const out: string[] = [];
  for (const m of masked.matchAll(TOKEN_RE)) {
    const tok = (m[1] as string).trim();
    if (isCitation(tok) && !out.includes(tok)) out.push(tok);
  }
  return out;
}

/**
 * Every bracketed token in the text, whether or not it is a citation.
 *
 * The counterpart to the function above: a caller that wants to report
 * "3 bracketed tokens I did not recognise" needs the ones the predicate
 * rejected, and re-scanning with an inverted predicate would miss that a token
 * can look like two things at once.
 */
export function bracketedTokensIn(text: string): string[] {
  const masked = stripInlineCode(text);
  const out: string[] = [];
  for (const m of masked.matchAll(TOKEN_RE)) {
    const tok = (m[1] as string).trim();
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

/**
 * The citation tokens a document uses to ground its claims, and the ones that
 * appear ONLY where they cannot.
 *
 * The second list is the useful half: a token that exists solely inside a code
 * fence, an HTML comment or an excluded section looks like grounding to a
 * reader skimming the file and grounds nothing. What to do about it — warn,
 * fail, ignore — is the caller's.
 */
export function collectCitations(
  text: string,
  isCitation: (token: string) => boolean,
  opts: ClaimUnitOptions = {},
): { grounding: string[]; inertOnly: string[] } {
  const grounding: string[] = [];
  for (const unit of extractClaimUnits(text, opts)) {
    for (const part of unitTexts(unit)) {
      for (const tok of citationTokensIn(part, isCitation)) if (!grounding.includes(tok)) grounding.push(tok);
    }
  }
  const all: string[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const tok = (m[1] as string).trim();
    if (isCitation(tok) && !all.includes(tok)) all.push(tok);
  }
  return { grounding, inertOnly: all.filter((t) => !grounding.includes(t)) };
}

/**
 * Cited tokens that resolve to nothing known — a set difference, and nothing
 * more. Whether a dangling citation is fatal is the caller's to decide.
 */
export function danglingTokens(cited: Iterable<string>, known: Iterable<string>): string[] {
  const have = new Set(known);
  const out: string[] = [];
  for (const t of cited) if (!have.has(t) && !out.includes(t)) out.push(t);
  return out;
}

/** Known ids that no claim cites. The inverse of the above, same disclaimer. */
export function uncitedIds(cited: Iterable<string>, known: Iterable<string>): string[] {
  const used = new Set(cited);
  return [...new Set(known)].filter((id) => !used.has(id));
}

// ── Numerals ────────────────────────────────────────────────────────────────

/**
 * Strip digit-group separators — comma, NBSP, narrow NBSP, apostrophe, plain
 * space — so "10,000", "10 000" and "1'000" all read as one number.
 *
 * Applied to both sides of any containment test, which is the point: a report
 * writing "10,000" and a source writing "10 000" are stating the same figure,
 * and a comparison that says otherwise generates a false accusation.
 *
 * A comma is only a GROUP separator when it is followed by exactly three digits
 * that no further digit follows. Everywhere else it is a DECIMAL comma and
 * becomes a point, because most of the world writes "0,25" for what an English
 * source writes "0.25". Stripping it unconditionally — as this did until the
 * distinction was drawn — turned "0,25" into "025" and "1,5" into "15", so a
 * report accused itself of inventing every figure it had correctly transcribed.
 * That is not a corner case: the skills built on this engine are told to search
 * in the audience's language and report in the user's, so a French report over
 * English sources is the normal path, not the odd one.
 *
 * "1,000" stays ambiguous by construction and is read as one thousand — the
 * three-digit group is the far more common convention in the corpora these
 * tools fetch. NBSP, narrow NBSP and apostrophe are never decimal marks, so
 * they are still stripped between any two digits.
 */
export function normalizeNumeralText(text: string): string {
  return text
    .replace(/(\d)[\u00A0\u202F'](?=\d)/g, "$1")
    .replace(/(\d)[, ](\d{3})(?!\d)/g, "$1$2")
    .replace(/(\d),(?=\d)/g, "$1.");
}

/**
 * The specific figures a claim asserts, normalised.
 *
 * Digits inside citation tokens, inline code and markdown-link URLs never
 * count — `[S3]` and `/v2/users` are not claims about quantity. A bare single
 * digit is dropped as too weak a signal to check anything with; "two parts" and
 * "3 ways" are prose. Capped at 8, deduped, in order.
 */
export function extractNumerals(text: string, max = 8): string[] {
  // Normalise BEFORE matching, not after: the token pattern below never allowed
  // a plain space, so "1 000 requests" used to match as "1" (dropped as a single
  // digit) and "000" — the figure vanished and a phantom took its place.
  const cleaned = normalizeNumeralText(
    stripInlineCode(text)
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\[[^\]\n]+\](?!\()/g, " "),
  );
  const out: string[] = [];
  for (const m of cleaned.matchAll(/\d[\d,\u00A0\u202F']*(?:\.\d+)?%?/g)) {
    const numeric = normalizeNumeralText(m[0] as string).replace(/[,\u00A0\u202F'%]/g, "");
    if (numeric.replace(/\D/g, "").length < 2 && !numeric.includes(".")) continue;
    if (!out.includes(numeric)) out.push(numeric);
    if (out.length >= max) break;
  }
  return out;
}
