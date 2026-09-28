import { bench, describe } from "vitest";
import { bm25MatchedTerms, bm25Score, bm25Tokenize, buildBm25Index, dedupeNearDuplicates, diversify, simhash } from "../src/rank.js";
import { fnv1a64 } from "../src/url.js";

// Micro-benchmarks for the ranking hot paths. Run with `pnpm run bench`; not
// collected by `vitest run` (pattern *.test.ts) nor by coverage (src/** only).

const paragraph = "A token bucket refills at a fixed rate and caps at its burst size. Each request removes one token from the bucket. ";
const doc5k = paragraph.repeat(45); // ~5 KB
const doc200k = paragraph.repeat(1_800); // ~200 KB
const page2m = paragraph.repeat(19_000); // ~2.2 MB

// A pool that behaves like a real one. The first version repeated one
// paragraph with a few words appended, so dedupe collapsed 281 of 300 (its kept
// list stayed tiny and hid the n·kept scan), every term had the same IDF, and
// MMR — most of `rank`'s time — was not measured at all. This one is topical
// prose over a Zipf vocabulary from a seeded PRNG, ~5 KB per document, with
// every tenth document a near copy (two words changed) of an earlier one.
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makePool(n: number, seed = 42): { url: string; title: string; text: string }[] {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const syllables = ["ka", "to", "ri", "men", "sa", "lo", "vex", "dra", "pul", "ion", "ter", "qua", "bel", "nor", "fin", "gra", "ste", "mar", "cul", "zen"];
  const vocab = [...new Set(Array.from({ length: 8_000 }, () => Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => pick(syllables)).join("")))];
  const common = "the of and to in is that for it as with was on be by this are or from at an which have not but".split(" ");
  // Zipf over the vocabulary, by inverse CDF.
  const cum: number[] = [];
  let total = 0;
  for (let i = 0; i < vocab.length; i++) cum.push((total += 1 / (i + 1) ** 1.05));
  const zipf = (): string => {
    const r = rnd() * total;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((cum[mid] as number) < r) lo = mid + 1;
      else hi = mid;
    }
    return vocab[lo] as string;
  };
  const topics = Array.from({ length: 30 }, () => Array.from({ length: 40 }, () => pick(vocab)));
  const docs: { url: string; title: string; text: string }[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 10 === 9) {
      const src = pick(docs);
      const words = src.text.split(" ");
      for (let k = 0; k < 2; k++) words[Math.floor(rnd() * words.length)] = zipf();
      docs.push({ url: `https://mirror${i}.test/p`, title: src.title, text: words.join(" ") });
      continue;
    }
    const topic = pick(topics);
    let text = "";
    while (text.length < 4_500 + rnd() * 1_000) {
      const len = 8 + Math.floor(rnd() * 13);
      const words = Array.from({ length: len }, () => {
        const r = rnd();
        return r < 0.35 ? pick(common) : r < 0.5 ? pick(topic) : zipf();
      });
      text += `${words.join(" ")}. `;
    }
    docs.push({ url: `https://site${i}.test/page`, title: Array.from({ length: 4 }, () => pick(topic)).join(" "), text: text.trim() });
  }
  return docs;
}

const docs300 = makePool(300);
const docs2000 = makePool(2_000);
const query = docs300[0]!.title;

const bm25Docs = docs300.map((d, i) => ({ id: `d${i}`, title: d.title, headings: "", body: d.text }));
const tokens300 = docs300.map((d) => bm25Tokenize(d.text));
const scored300 = docs300.map((d, i) => ({ url: d.url, text: d.text, score: ((i * 7_919) % 101) / 100, tokens: tokens300[i]! }));

/** The `webindex rank` pipeline: index, score, collapse, diversify. */
function rankPipeline(docs: { url: string; title: string; text: string }[], limit: number): unknown[] {
  const bm = docs.map((d, i) => ({ id: String(i), title: d.title, headings: "", body: d.text }));
  const bodyTokens = bm.map((d) => bm25Tokenize(d.body));
  const index = buildBm25Index(query, bm, { tokensOf: (d) => bodyTokens[Number(d.id)]! });
  const scored = bm.map((d, i) => ({
    url: docs[i]!.url,
    text: d.body,
    score: bm25Score(index, d),
    matched: bm25MatchedTerms(index, d),
    tokens: bodyTokens[i]!,
  }));
  scored.sort((a, b) => b.score - a.score || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const { items } = dedupeNearDuplicates(scored, { tokensOf: (it) => it.tokens });
  return diversify(items, (it) => it.tokens, 0.75, { window: Math.max(limit * 5, 100) }).slice(0, limit);
}

describe("hashing", () => {
  bench("fnv1a64 (200 KB)", () => {
    fnv1a64(doc200k);
  });
  bench("simhash (5 KB)", () => {
    simhash(doc5k);
  });
  bench("simhash (200 KB)", () => {
    simhash(doc200k);
  });
  bench("simhash (2.2 MB)", () => {
    simhash(page2m);
  });
});

describe("ranking", () => {
  bench("bm25Tokenize (300 × 5 KB)", () => {
    for (const d of docs300) bm25Tokenize(d.text);
  });
  bench("dedupeNearDuplicates (300 × 5 KB, 10% near copies)", () => {
    dedupeNearDuplicates(scored300);
  });
  bench("dedupeNearDuplicates with shared tokens (300 × 5 KB)", () => {
    dedupeNearDuplicates(scored300, { tokensOf: (it) => it.tokens });
  });
  bench("buildBm25Index (300 × 5 KB)", () => {
    buildBm25Index(query, bm25Docs);
  });
  const index = buildBm25Index(query, bm25Docs);
  bench("bm25Score × 300 (one scoring per document)", () => {
    for (const d of bm25Docs) bm25Score(index, d);
  });
  bench("bm25Score inside a sort comparator (the pattern hybridSearch used)", () => {
    [...bm25Docs].sort((a, b) => bm25Score(index, b) - bm25Score(index, a));
  });
});

describe("diversify", () => {
  bench("diversify, exact (300 × 5 KB)", () => {
    diversify(scored300, (it) => it.tokens);
  });
  bench("diversify, window 100 (300 × 5 KB)", () => {
    diversify(scored300, (it) => it.tokens, 0.75, { window: 100 });
  });
});

describe("the rank pipeline", () => {
  bench("rank, limit 10 (300 × 5 KB)", () => {
    rankPipeline(docs300, 10);
  });
  bench("rank, limit 10 (2 000 × 5 KB)", () => {
    rankPipeline(docs2000, 10);
  });
});
