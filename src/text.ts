// Keyword extraction and accent-insensitive matching.
//
// Moved verbatim out of each skill's util.ts, where three drifting copies of it
// lived. Used to score fetched page text against the question so an excerpt
// carries the lines that actually answer it.
//
// Lowercase, drop stopwords (EN + FR question scaffolding), keep identifiers,
// fold accents and plurals, split camelCase/snake_case, compile
// accent-insensitive patterns. Deterministic, no LLM, no dependencies.

import { brand } from "./brand.js";

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "do",
  "does",
  "did",
  "how",
  "what",
  "why",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "of",
  "in",
  "on",
  "to",
  "for",
  "with",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "than",
  "as",
  "at",
  "by",
  "from",
  "into",
  "about",
  "it",
  "its",
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "there",
  "here",
  "can",
  "could",
  "should",
  "would",
  "will",
  "shall",
  "may",
  "might",
  "must",
  "have",
  "has",
  "had",
  "not",
  "no",
  "yes",
  "so",
  "such",
  "only",
  "any",
  "some",
  "all",
  "get",
  "set",
  "use",
  "used",
  "using",
  "work",
  "works",
  "working",
  "handle",
  "handled",
  "happen",
  "happens",
  "default",
  "value",
  "values",
  "please",
  "explain",
  "tell",
  "me",
  "my",
  "our",
  "le",
  "la",
  "les",
  "de",
  "des",
  "du",
  "un",
  "une",
  "est",
  "sont",
  "que",
  "qui",
  "quoi",
  "quel",
  "quelle",
  "quels",
  "quelles",
  "pour",
  "dans",
  "avec",
  "entre",
  "sur",
  "par",
  "pas",
  "plus",
  "et",
  "ou",
  "où",
  "ce",
  "cette",
  "ces",
  "se",
  "sa",
  "son",
  "ses",
  "leur",
  "leurs",
  "comment",
  "pourquoi",
  "quand",
  "fait",
  "faire",
  "peut",
  "doit",
  "être",
  "avoir",
  "il",
  "elle",
  "nous",
  "vous",
  "ils",
  "elles",
  "au",
  "aux",
  "si",
  "ne",
]);

/**
 * Is this term question scaffolding rather than content?
 *
 * Exported because a consumer's own scorer must agree with buildMatcher on what
 * a term IS. A caller's own ranking tokeniser should drop the same words and
 * apply the same folding, so a document ranks against the same vocabulary the
 * excerpt matcher highlights. Two lists that drift apart make the two disagree,
 * and the symptom — a source that scores well but shows an excerpt with no
 * highlight — looks like a bug in neither.
 */
export function isStopword(term: string): boolean {
  const t = term.toLowerCase();
  if (STOPWORDS.has(t)) return true;
  // Read through the brand, at CALL time, so a consumer's extras apply to
  // buildMatcher and to its own tokeniser alike — the two must agree on what a
  // term is, or a document ranks on a word the excerpt never highlights.
  const extra = brand().extraStopwords;
  return extra ? extra.some((w) => w.toLowerCase() === t) : false;
}

export function keywords(question: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of question.split(/[^\p{L}\p{N}_]+/u)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (raw.length < 2) continue;
    if (isStopword(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(raw);
  }
  return out;
}

// Keywords ordered most-distinctive first (numbers, identifiers, long tokens
// carry more signal). Useful to feed narrow search APIs the few best terms.
export function rankedKeywords(question: string): string[] {
  const base = keywords(question);
  const score = (raw: string): number => {
    let s = 0;
    if (/\d/.test(raw)) s += 3;
    if (/[A-Z]/.test(raw) && !/^[A-Z0-9]+$/.test(raw)) s += 2;
    if (/_/.test(raw)) s += 2;
    if (raw.length >= 8) s += 1.5;
    else if (raw.length >= 5) s += 0.5;
    return s;
  };
  return base
    .map((k, i) => ({ k, s: score(k), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.k);
}

const ACCENT_CLASSES: Record<string, string> = {
  a: "aàáâãäåāăą",
  c: "cçćĉċč",
  d: "dďđ",
  e: "eèéêëēĕėęě",
  g: "gĝğġģ",
  i: "iìíîïĩīĭįı",
  l: "lĺļľŀł",
  n: "nñńņň",
  o: "oòóôõöøōŏő",
  r: "rŕŗř",
  s: "sśŝşš",
  t: "tţťŧ",
  u: "uùúûüũūŭůűų",
  y: "yýÿŷ",
  z: "zźżž",
};
const BASE_OF = new Map<string, string>();
for (const [base, cls] of Object.entries(ACCENT_CLASSES)) {
  for (const ch of cls) BASE_OF.set(ch, base);
}

function baseChar(ch: string): string {
  const known = BASE_OF.get(ch);
  if (known) return known;
  const stripped = ch.normalize("NFD").replace(/\p{M}+/gu, "");
  return stripped.length === 1 ? stripped : ch;
}

export function deaccent(s: string): string {
  let out = "";
  for (const ch of s) out += baseChar(ch);
  return out;
}

function foldPlural(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 4 && /(?:[sxz]|[cs]h)es$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !/(?:ss|us|is)$/.test(t)) return t.slice(0, -1);
  return t;
}

export function foldTerm(raw: string): string {
  return foldPlural(deaccent(raw.toLowerCase()));
}

export function subtokens(raw: string): string[] {
  const spaced = raw
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/(\p{L})(\p{N})/gu, "$1 $2")
    .replace(/(\p{N})(\p{L})/gu, "$1 $2");
  const parts = spaced.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (parts.length < 2) return [];
  const out: string[] = [];
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower.length < 3 || isStopword(lower)) continue;
    if (!out.includes(lower)) out.push(lower);
    if (out.length >= 4) break;
  }
  return out;
}

export interface KeywordVariant {
  text: string;
  kind: "original" | "folded" | "subtoken";
}

export interface ExpandedKeyword {
  canonical: string;
  original: string;
  variants: KeywordVariant[];
}

const MAX_PATTERNS = 24;
const VARIANT_PRIORITY: Record<KeywordVariant["kind"], number> = { original: 0, folded: 1, subtoken: 2 };

export function expandTokens(tokens: string[], max = 8): ExpandedKeyword[] {
  const byCanonical = new Map<string, ExpandedKeyword>();
  for (const raw of tokens) {
    if (byCanonical.size >= max) break;
    const canonical = foldTerm(raw);
    if (!canonical || byCanonical.has(canonical)) continue;
    const plain = deaccent(raw.toLowerCase());
    const variants: KeywordVariant[] = [{ text: raw.toLowerCase(), kind: "original" }];
    if (canonical !== plain) variants.push({ text: canonical, kind: "folded" });
    if (plain.length > 4 && plain.endsWith("ies")) variants.push({ text: plain.slice(0, -1), kind: "folded" });
    for (const sub of subtokens(raw)) variants.push({ text: sub, kind: "subtoken" });
    byCanonical.set(canonical, { canonical, original: raw, variants });
  }
  const all = [...byCanonical.values()].flatMap((ek, kwIdx) => ek.variants.map((v) => ({ ek, v, kwIdx })));
  all.sort((a, b) => VARIANT_PRIORITY[a.v.kind] - VARIANT_PRIORITY[b.v.kind] || a.kwIdx - b.kwIdx);
  const seen = new Set<string>();
  const kept = new Set<KeywordVariant>();
  for (const { v } of all) {
    if (kept.size >= MAX_PATTERNS) break;
    const key = deaccent(v.text);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.add(v);
  }
  for (const ek of byCanonical.values()) ek.variants = ek.variants.filter((v) => kept.has(v));
  return [...byCanonical.values()];
}

export function accentPattern(text: string): string {
  let out = "";
  for (const ch of text) {
    const cls = ACCENT_CLASSES[baseChar(ch)];
    out += cls ? `[${cls}]` : escapeRegExp(ch);
  }
  return out;
}

export interface KeywordMatcher {
  expanded: ExpandedKeyword[];
  canonicals: string[];
  /**
   * The compiled pattern sources, each with the keyword it attributes to.
   *
   * What makes the matcher usable by something other than this process: a
   * consumer can hand these to ripgrep or any external scanner and still map
   * the hits back to canonicals. Without them the matcher only works line by
   * line in memory, which is the wrong shape for searching a whole repository.
   */
  patterns: { source: string; canonical: string }[];
  /** Map a matched span — as an external scanner reports it — back to its keyword. */
  canonicalOf(span: string): string | undefined;
  /** Which canonicals does this line of text cover? */
  matchLine(line: string): Set<string>;
}

function makeMatcher(expanded: ExpandedKeyword[]): KeywordMatcher {
  const regexes: { re: RegExp; canonical: string }[] = [];
  for (const ek of expanded) {
    for (const v of ek.variants) {
      regexes.push({ re: new RegExp(accentPattern(v.text), "i"), canonical: ek.canonical });
    }
  }
  const patterns = expanded.flatMap((ek) => ek.variants.map((v) => ({ source: accentPattern(v.text), canonical: ek.canonical })));
  return {
    expanded,
    canonicals: expanded.map((e) => e.canonical),
    patterns,
    canonicalOf: (span) => regexes.find(({ re }) => new RegExp(`^(?:${re.source})$`, "i").test(span))?.canonical,
    matchLine: (line) => {
      const hit = new Set<string>();
      for (const { re, canonical } of regexes) {
        if (!hit.has(canonical) && re.test(line)) hit.add(canonical);
      }
      return hit;
    },
  };
}

export function buildMatcher(question: string, max = 8): KeywordMatcher {
  return makeMatcher(expandTokens(keywords(question), max));
}

/**
 * A matcher over raw tokens, skipping keyword extraction.
 *
 * The fallback for a question with no distinctive keywords left after stopword
 * removal — "what is it for?" reduces to nothing, and a matcher that matches
 * nothing highlights nothing. Searching the words as given is worse than a good
 * query and much better than an empty one. Still accent-folded and
 * subtoken-expanded, so attribution stays consistent with buildMatcher.
 */
export function matcherFromTokens(tokens: string[], max = 8): KeywordMatcher {
  return makeMatcher(expandTokens(tokens.filter(Boolean), max));
}

/**
 * The markdown heading a line sits under, ignoring heading-lookalikes inside
 * fenced code blocks. `anchor` is a 0-based line index.
 *
 * Lives here rather than with the HTTP layer because it is a fact about text:
 * the extractor happens to be what usually produces the markdown, but a caller
 * reading a `.md` off disk has exactly the same question.
 */
export function nearestHeading(lines: string[], anchor: number): string | undefined {
  let heading: string | undefined;
  let inFence = false;
  for (let i = 0; i <= anchor && i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (m) heading = m[1]!.trim();
  }
  return heading;
}

/** A passage of a document, chosen because it answers the question. */
export interface ExcerptWindow {
  /** First line kept, 0-based. */
  start: number;
  /** One past the last line kept. */
  end: number;
  /** The line the window was centred on. */
  anchor: number;
  /**
   * How many DISTINCT question keywords the anchor line covered.
   *
   * Zero is meaningful and is not an error: it is the top-of-page fallback,
   * emitted when nothing in the document matched. A caller that ranks evidence
   * wants to know it is looking at boilerplate rather than at an answer.
   */
  score: number;
  /** The markdown section the anchor sits under, when there is one. */
  heading?: string;
  snippet: string;
}

/**
 * Find the passages of `text` that answer `question`.
 *
 * This is the half of "turn a page into excerpts" that is the same everywhere:
 * score each line against the question, take the best ones, widen each into a
 * readable window, and stop windows from overlapping. What an excerpt then IS —
 * a citation, an evidence item, a snippet with a section title — is the caller's
 * model and stays with the caller.
 *
 * Three decisions, each taken from whichever copy had it right:
 *
 * - Scoring goes through `buildMatcher`, so accents, plurals and camelCase
 *   subtokens all match. A raw `line.includes(keyword)` misses "Générateur" for
 *   "generateur" and "parseQuery" for "query".
 * - `question` may be a LIST, and a line scores by its best single-question
 *   coverage rather than by the union. A page then gets excerpted around the one
 *   claim it actually supports instead of around a diluted average of all of them.
 * - Windows are de-duplicated by RANGE OVERLAP, not by bucketing line numbers.
 *   Fixed buckets let two near-identical excerpts straddle a boundary and both
 *   survive, which is how the same paragraph ends up quoted twice.
 */
export function excerptWindows(
  text: string,
  question: string | string[],
  opts: { perDoc?: number; before?: number; after?: number; maxChars?: number } = {},
): ExcerptWindow[] {
  const lines = text.split("\n");
  const before = opts.before ?? 3;
  const after = opts.after ?? 12;
  const maxChars = opts.maxChars ?? 1500;
  const perDoc = Math.max(1, opts.perDoc ?? 2);

  const matchers = (Array.isArray(question) ? question : [question]).filter((q) => q.trim()).map((q) => buildMatcher(q));

  const hits: { anchor: number; score: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    let score = 0;
    for (const m of matchers) {
      const cov = m.matchLine(lines[i]!).size;
      if (cov > score) score = cov;
    }
    if (score > 0) hits.push({ anchor: i, score });
  }
  hits.sort((a, b) => b.score - a.score || a.anchor - b.anchor);

  // Nothing matched: hand back the top of the document at score 0 rather than
  // nothing at all. A caller with a pinned URL still needs SOMETHING to show,
  // and the score tells it exactly how much to trust what it got.
  const take = hits.length ? hits : [{ anchor: 0, score: 0 }];

  const out: ExcerptWindow[] = [];
  for (const h of take) {
    if (out.length >= perDoc) break;
    const start = Math.max(0, h.anchor - before);
    const end = Math.min(lines.length, h.anchor + after);
    if (out.some((w) => start < w.end && end > w.start)) continue;
    const snippet = lines.slice(start, end).join("\n").slice(0, maxChars);
    if (!snippet.trim()) continue;
    const heading = nearestHeading(lines, h.anchor);
    out.push({ start, end, anchor: h.anchor, score: h.score, ...(heading ? { heading } : {}), snippet });
  }
  return out;
}

/**
 * Turn an arbitrary identifier into a filesystem-safe slug —
 * `github.com/expressjs/express` → `github.com-expressjs-express`.
 *
 * Used as an on-disk cache key, which is why the normalisation matters: a
 * repository named as `https://github.com/x/y.git`, `git@github.com:x/y.git`
 * and `github.com/x/y` is ONE repository, and three slugs would mean three
 * clones of it.
 *
 * `max` is a parameter because the two uses want different lengths — a repo
 * identity is short and a research question is not — and truncating a question
 * at a repo's length collides distinct runs.
 */
export function slugify(input: string, opts: { max?: number; fallback?: string } = {}): string {
  const s = input
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^git@/, "")
    .replace(/\.git$/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, opts.max ?? 120);
  return s || (opts.fallback ?? "");
}
