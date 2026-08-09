import { foldTerm, isStopword, type KeywordMatcher } from "./text.js";
import { canonicalizeUrl, domainOf, fnv1a64, normalizeDoi } from "./url.js";

// Ranking: turning a pool of candidates into a reading order.
//
// This layer used to be disclaimed in the README ("BM25, RRF, near-duplicate
// collapse, diversification — not here yet"). It was not absent, it was written
// three times: a full BM25F index and SimHash collapse in one consumer, a
// reduced BM25 in another, and `rrf` typed out identically in two of them.
// Retrieval is the same problem everywhere — which of these fifty candidates
// should someone read first — so it belongs with the retrieval primitives.
//
// EVERY function here is generic over the caller's own item type. The engine
// never sees an evidence model: a consumer's source object satisfies `Ranked`
// structurally, keeps its own fields, and gets these back unchanged. That is the
// line the charter draws — how a tool numbers, stores and cites its sources
// stays its business.

/**
 * The minimum a candidate must expose to be ranked: where it came from and how
 * good the caller currently thinks it is. `text` is optional because only the
 * content-similarity passes need it.
 */
export interface Ranked {
  url: string;
  score: number;
  text?: string;
}

// ── Fusion ──────────────────────────────────────────────────────────────────

/**
 * Reciprocal Rank Fusion: merge several ranked lists into one ranking without
 * comparable cross-list scores.
 *
 * The problem it solves is that a keyless web engine's "score" and a scholarly
 * API's "relevance" are not the same quantity and cannot be added. RRF only
 * reads POSITION, so it needs no calibration: an item's contribution from each
 * list is `1/(k + rank)`, and `k` damps the tail so rank 40 cannot outvote a
 * couple of top-tens.
 */
export function rrf<T>(lists: T[][], keyOf: (item: T) => string, k = 60): Map<string, number> {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, idx) => {
      const key = keyOf(item);
      score.set(key, (score.get(key) ?? 0) + 1 / (k + idx + 1));
    });
  }
  return score;
}

// ── Identity ────────────────────────────────────────────────────────────────

/**
 * The arXiv id inside a URL, so `abs/`, `pdf/` and `html/` variants of the SAME
 * paper collapse to one identity even when the backend supplied no metadata.
 * Handles modern (2405.12345) and legacy (math.GT/0309136) ids, any arxiv.org
 * subdomain, and strips a version suffix and a trailing `.pdf`.
 */
export function arxivIdFromUrl(url: string): string | undefined {
  let host: string;
  let path: string;
  try {
    const u = new URL(url.trim());
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return undefined;
  }
  if (!/(^|\.)arxiv\.org$/.test(host)) return undefined;
  const modern = /\/(?:abs|pdf|html|format)\/(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?$/i.exec(path);
  if (modern) return modern[1]!.toLowerCase();
  const legacy = /\/(?:abs|pdf|html|format)\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?(?:\.pdf)?$/i.exec(path);
  if (legacy) return legacy[1]!.toLowerCase();
  return undefined;
}

/**
 * The DOI inside a URL — a doi.org resolver link, or a publisher landing page
 * that carries the DOI in its path (`dl.acm.org/doi/…`, `/doi/full/…`). Returned
 * normalised, so a DOI-in-path collapses with a bare one.
 */
export function doiFromUrl(url: string): string | undefined {
  let host: string;
  let path: string;
  try {
    const u = new URL(url.trim());
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return undefined;
  }
  if (/(^|\.)(dx\.)?doi\.org$/.test(host)) {
    const doi = normalizeDoi(decodeURIComponent(path.replace(/^\/+/, "").replace(/\/+$/, "")));
    return /^10\.\d{4,9}\//.test(doi) ? doi : undefined;
  }
  const m = /\/doi(?:\/(?:abs|full|pdf|epdf|e?pub))?\/(10\.\d{4,9}\/[^\s?#]+)/i.exec(path);
  if (m) return normalizeDoi(decodeURIComponent(m[1]!).replace(/\/+$/, ""));
  return undefined;
}

/**
 * Drop duplicates by canonical URL, keeping the best-scored copy. Survivors keep
 * their input order, so a caller that already ranked its list does not have to
 * re-sort after de-duplicating.
 */
export function dedupeByUrl<T extends Ranked>(items: readonly T[]): { items: T[]; dropped: number } {
  const best = new Map<string, T>();
  const order: string[] = [];
  let dropped = 0;
  for (const it of items) {
    const key = canonicalizeUrl(it.url);
    const prev = best.get(key);
    if (!prev) {
      best.set(key, it);
      order.push(key);
    } else {
      dropped++;
      if (it.score > prev.score) best.set(key, it);
    }
  }
  return { items: order.map((k) => best.get(k)!), dropped };
}

// ── BM25F ───────────────────────────────────────────────────────────────────
//
// Lexical relevance with TF saturation, IDF over the candidate pool, field
// weighting (title > headings > body) and a bounded proximity bonus. Preferred
// over binary keyword coverage because a single repeated term saturates instead
// of dominating, and covering more DISTINCT query terms is what wins.

export interface Bm25Doc {
  id: string;
  title: string;
  headings: string;
  body: string;
}

export interface Bm25Index {
  idf: Map<string, number>;
  avgdl: number;
  N: number;
  queryTerms: string[];
  k1: number;
  b: number;
  titleWeight: number;
  headingWeight: number;
}

/**
 * Tokenise into canonical terms WITH repetition, so term frequency survives.
 *
 * Shares `foldTerm` and `isStopword` with `buildMatcher`, which is the point:
 * two scorers that disagree about whether "requests" and "request" are the same
 * term will disagree about relevance for reasons nobody can debug.
 */
export function bm25Tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length < 2) continue;
    if (isStopword(raw)) continue;
    const t = foldTerm(raw);
    if (t.length >= 2) out.push(t);
  }
  return out;
}

// Field-weighted token stream: body once, headings ×headingWeight, title
// ×titleWeight — a query term in the title outranks the same term buried deep.
function docTokens(doc: Bm25Doc, titleWeight: number, headingWeight: number): string[] {
  const out = bm25Tokenize(doc.body);
  const headings = bm25Tokenize(doc.headings);
  for (let r = 0; r < headingWeight; r++) out.push(...headings);
  const title = bm25Tokenize(doc.title);
  for (let r = 0; r < titleWeight; r++) out.push(...title);
  return out;
}

// Bounded proximity bonus in [0, cap]: "token bucket" adjacent should beat the
// two words scattered across a page. Returns a multiplier addend.
function proximityBonus(tokens: string[], queryTerms: string[], window = 6, cap = 0.1): number {
  if (queryTerms.length < 2) return 0;
  const q = new Set(queryTerms);
  const hits: { pos: number; term: string }[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (q.has(tok)) hits.push({ pos: i, term: tok });
  }
  if (hits.length < 2) return 0;
  let close = 0;
  for (let i = 1; i < hits.length; i++) {
    if (hits[i]!.term !== hits[i - 1]!.term && hits[i]!.pos - hits[i - 1]!.pos <= window) close++;
  }
  return Math.min(cap, cap * (close / Math.max(1, queryTerms.length - 1)));
}

/**
 * Build the index over the candidate pool — the pool IS the corpus, so IDF is
 * relative to what was actually retrieved.
 *
 * Below three documents IDF is too noisy to mean anything, so it degrades to
 * uniform (pure TF). A three-result pool where one term happens to be missing
 * from two of them would otherwise assign that term a huge weight on no evidence.
 */
export function buildBm25Index(question: string, docs: readonly Bm25Doc[], opts: { k1?: number; b?: number } = {}): Bm25Index {
  const k1 = opts.k1 ?? 1.2;
  const b = opts.b ?? 0.75;
  const titleWeight = 3;
  const headingWeight = 2;
  const queryTerms = [...new Set(bm25Tokenize(question))];
  const N = docs.length;
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const doc of docs) {
    const toks = docTokens(doc, titleWeight, headingWeight);
    totalLen += toks.length;
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avgdl = N ? totalLen / N : 0;
  const idf = new Map<string, number>();
  for (const t of queryTerms) {
    if (N < 3) {
      idf.set(t, 1);
      continue;
    }
    const dfi = df.get(t) ?? 0;
    idf.set(t, Math.log(1 + (N - dfi + 0.5) / (dfi + 0.5)));
  }
  return { idf, avgdl, N, queryTerms, k1, b, titleWeight, headingWeight };
}

/** BM25F score of one document against the index (raw, ≥0). */
export function bm25Score(index: Bm25Index, doc: Bm25Doc): number {
  if (!index.queryTerms.length) return 0;
  const toks = docTokens(doc, index.titleWeight, index.headingWeight);
  const dl = toks.length;
  if (!dl) return 0;
  const tf = new Map<string, number>();
  for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
  const { k1, b, avgdl } = index;
  const lenNorm = 1 - b + b * (avgdl ? dl / avgdl : 1);
  let score = 0;
  for (const term of index.queryTerms) {
    const f = tf.get(term);
    if (!f) continue;
    const idf = index.idf.get(term) ?? 0;
    score += (idf * (f * (k1 + 1))) / (f + k1 * lenNorm);
  }
  return score * (1 + proximityBonus(toks, index.queryTerms));
}

/** Which distinct query terms actually occur in a document. */
export function bm25MatchedTerms(index: Bm25Index, doc: Bm25Doc): string[] {
  if (!index.queryTerms.length) return [];
  const present = new Set(docTokens(doc, index.titleWeight, index.headingWeight));
  return index.queryTerms.filter((t) => present.has(t));
}

/**
 * Drop candidates that share no meaningful term with the query.
 *
 * Two off-topic shapes: an EMPTY overlap, and an overlap that is only numeric —
 * a page whose sole connection to the question is that a PR number happens to
 * contain the same digits as a year. Only active when the query has at least two
 * terms and at least one alphabetic one, since a one-word query carries too
 * little signal to filter on.
 *
 * NEVER drops below `floor`. A genuinely thin pool has to survive its own filter,
 * so the best-ranked "off-topic" candidates are re-admitted until the floor is
 * met. `ranked` must be best-first.
 */
export function applyRelevanceFloor<T>(ranked: readonly T[], matchedOf: (t: T) => string[], queryTerms: string[], floor: number): { kept: T[]; dropped: T[] } {
  const isAlpha = (t: string) => /\p{L}/u.test(t);
  const alphaTerms = queryTerms.filter(isAlpha);
  if (queryTerms.length < 2 || alphaTerms.length < 1) return { kept: [...ranked], dropped: [] };
  const offTopic = (t: T): boolean => {
    const m = matchedOf(t);
    return m.length === 0 || m.every((term) => !isAlpha(term));
  };
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const t of ranked) (offTopic(t) ? dropped : kept).push(t);
  while (kept.length < floor && dropped.length) kept.push(dropped.shift()!);
  return { kept, dropped };
}

/**
 * What fraction of the question's distinctive keywords appear in a text. Cheaper
 * and blunter than BM25 — useful for snippet selection, where "does this line
 * mention the thing at all" is the whole question.
 */
export function contentCoverage(matcher: KeywordMatcher, text: string): number {
  if (!matcher.canonicals.length || !text) return 0;
  const hit = new Set<string>();
  for (const line of text.split("\n")) {
    for (const c of matcher.matchLine(line)) hit.add(c);
    if (hit.size === matcher.canonicals.length) break;
  }
  return hit.size / matcher.canonicals.length;
}

/**
 * Pool-relative recency in 0..1, neutral 0.5 when the item has no year or the
 * pool has no spread.
 *
 * Relative to the RESULT SET rather than wall-clock on purpose: a score computed
 * against "now" changes every day, which would make two runs over identical
 * inputs rank differently and make any golden test rot on a calendar.
 */
export function recencyScore(meta: { year?: number } | undefined, minYear: number, maxYear: number): number {
  const y = typeof meta?.year === "number" ? meta.year : undefined;
  if (y === undefined || maxYear <= minYear) return 0.5;
  const clamped = Math.min(maxYear, Math.max(minYear, y));
  return (clamped - minYear) / (maxYear - minYear);
}

// ── Near-duplicate content ──────────────────────────────────────────────────
//
// Identity dedup collapses the SAME resource. This catches the same CONTENT
// syndicated across different URLs and domains — mirrors, scraper copies, a
// press release reprinted verbatim — which would otherwise each eat a slot.

/**
 * 64-bit SimHash over 3-gram shingles. Near-duplicate documents land a few bits
 * apart; unrelated ones sit around 32.
 */
export function simhash(text: string): bigint {
  const toks = bm25Tokenize(text);
  const shingles: string[] = [];
  if (toks.length < 3) shingles.push(...toks);
  else for (let i = 0; i + 3 <= toks.length; i++) shingles.push(`${toks[i]} ${toks[i + 1]} ${toks[i + 2]}`);
  if (!shingles.length) return 0n;
  const v = new Array<number>(64).fill(0);
  for (const sh of shingles) {
    const h = fnv1a64(sh);
    for (let b = 0; b < 64; b++) v[b]! += ((h >> BigInt(b)) & 1n) === 1n ? 1 : -1;
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if (v[b]! > 0) out |= 1n << BigInt(b);
  return out;
}

/** How many bits two SimHashes differ by. */
export function hammingDistance(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}

/**
 * Collapse near-duplicate items by SimHash over their text, keeping the
 * best-scored copy. Items shorter than `minChars` carry too little signal and
 * are never collapsed. Expects best-first input and preserves that order.
 */
export function dedupeNearDuplicates<T extends Ranked>(
  items: readonly T[],
  opts: { maxBits?: number; minChars?: number } = {},
): { items: T[]; dropped: number } {
  const maxBits = opts.maxBits ?? 3;
  const minChars = opts.minChars ?? 500;
  const better = (a: T, b: T): boolean => (a.score !== b.score ? a.score > b.score : a.url.localeCompare(b.url) < 0);
  const kept: { it: T; hash: bigint | null }[] = [];
  let dropped = 0;
  for (const it of items) {
    const text = it.text || "";
    const hash = text.length >= minChars ? simhash(text) : null;
    if (hash !== null) {
      const dup = kept.find((k) => k.hash !== null && hammingDistance(k.hash, hash) <= maxBits);
      if (dup) {
        dropped++;
        if (better(it, dup.it)) {
          dup.it = it;
          dup.hash = hash;
        }
        continue;
      }
    }
    kept.push({ it, hash });
  }
  return { items: kept.map((k) => k.it), dropped };
}

/**
 * Re-order a ranked list so the top of it says several DIFFERENT things.
 *
 * The failure this fixes is not redundancy in the near-duplicate sense: eight
 * independent pages can each restate the same argument in their own words, be
 * correctly on-topic, and collectively bury the one source that says something
 * else. Relevance ranking has no defence against that, because each one really
 * is relevant.
 *
 * Greedy Maximal Marginal Relevance: at each rank pick the candidate maximising
 * `λ·relevance − (1−λ)·(similarity to what is already ranked)`. Similarity is
 * Jaccard over BM25 tokens — no new extraction, no model, deterministic.
 *
 * It REORDERS ONLY. Every input comes back exactly once: this changes what you
 * read first, never what you have. λ = 0.75 keeps relevance dominant, so
 * diversity breaks ties and demotes redundancy rather than promoting noise.
 */
export function diversify<T extends Ranked>(items: readonly T[], tokensOf: (it: T) => Set<string>, lambda = 0.75): T[] {
  if (items.length <= 2) return [...items];
  const toks = new Map<T, Set<string>>(items.map((it) => [it, tokensOf(it)]));
  const max = Math.max(...items.map((it) => it.score), 1e-9);
  const rel = (it: T): number => it.score / max;

  const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (!a.size || !b.size) return 0;
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    let inter = 0;
    for (const t of small) if (large.has(t)) inter++;
    return inter / (a.size + b.size - inter);
  };

  // Similarity is normalised WITHIN the pool. Raw Jaccard between two long
  // documents is small even when they are redundant, so a raw penalty of ~0.06
  // is lost against a relevance range of 0..1. Dividing by the pool's own maximum
  // makes "as similar as anything here gets" equal 1, which is the quantity λ is
  // actually trading against.
  let simMax = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const v = jaccard(toks.get(items[i]!)!, toks.get(items[j]!)!);
      if (v > simMax) simMax = v;
    }
  }
  const sim = (a: T, b: T): number => (simMax > 0 ? jaccard(toks.get(a)!, toks.get(b)!) / simMax : 0);

  const remaining = [...items];
  const out: T[] = [];
  // The best-scored item always leads: the most relevant result is never demoted
  // for being similar to nothing.
  remaining.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  out.push(remaining.shift()!);
  // Running max-similarity to the selected set, updated incrementally — what
  // keeps this O(n²) rather than O(n³).
  const maxSim = new Map<T, number>(remaining.map((it) => [it, sim(it, out[0]!)]));

  while (remaining.length) {
    let bestIdx = 0;
    let bestVal = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i++) {
      const it = remaining[i]!;
      const val = lambda * rel(it) - (1 - lambda) * (maxSim.get(it) ?? 0);
      if (val > bestVal || (val === bestVal && it.url.localeCompare(remaining[bestIdx]!.url) < 0)) {
        bestVal = val;
        bestIdx = i;
      }
    }
    const picked = remaining.splice(bestIdx, 1)[0]!;
    out.push(picked);
    for (const it of remaining) maxSim.set(it, Math.max(maxSim.get(it) ?? 0, sim(it, picked)));
  }
  return out;
}

// ── Attribution ─────────────────────────────────────────────────────────────

const URL_IN_TEXT = /https?:\/\/[a-z0-9.-]+/gi;

/**
 * The hosts a text links out to, excluding its own domain and `www.` noise.
 *
 * A page that cites nothing external is not automatically bad, but it is a fact
 * worth surfacing next to a claim — so this reports the set and lets the caller
 * decide what it means.
 */
export function externalHosts(url: string, text: string): Set<string> {
  const self = domainOf(url).replace(/^www\./, "");
  const out = new Set<string>();
  for (const m of text.match(URL_IN_TEXT) ?? []) {
    const h = domainOf(m).replace(/^www\./, "");
    if (h && h !== self) out.add(h);
  }
  return out;
}
