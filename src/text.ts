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
 * a term IS. ultrasearch's BM25 tokeniser drops the same words and applies the
 * same folding, so a document ranks against the same vocabulary the excerpt
 * matcher highlights. Two lists that drift apart make the two disagree, and the
 * symptom — a source that scores well but shows an excerpt with no highlight —
 * looks like a bug in neither.
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
  matchLine(line: string): Set<string>;
}

function makeMatcher(expanded: ExpandedKeyword[]): KeywordMatcher {
  const regexes: { re: RegExp; canonical: string }[] = [];
  for (const ek of expanded) {
    for (const v of ek.variants) {
      regexes.push({ re: new RegExp(accentPattern(v.text), "i"), canonical: ek.canonical });
    }
  }
  return {
    expanded,
    canonicals: expanded.map((e) => e.canonical),
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
