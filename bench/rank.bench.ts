import { bench, describe } from "vitest";
import { bm25Score, buildBm25Index, dedupeNearDuplicates, simhash } from "../src/rank.js";
import { fnv1a64 } from "../src/url.js";

// Micro-benchmarks for the ranking hot paths. Run with `pnpm run bench`; not
// collected by `vitest run` (pattern *.test.ts) nor by coverage (src/** only).

const paragraph = "A token bucket refills at a fixed rate and caps at its burst size. Each request removes one token from the bucket. ";
const doc5k = paragraph.repeat(45); // ~5 KB
const doc200k = paragraph.repeat(1_800); // ~200 KB
const page2m = paragraph.repeat(19_000); // ~2.2 MB

const pool = Array.from({ length: 300 }, (_, i) => ({
  url: `https://ex.test/${i}`,
  score: 1 - i / 1000,
  // Every tenth document is a near copy of its predecessor.
  text: i % 10 === 0 ? doc5k : `${doc5k} variant ${i} ${"extra words ".repeat(i % 7)}`,
}));

const bm25Docs = pool.map((p, i) => ({ id: `d${i}`, title: `Token bucket ${i}`, headings: "", body: p.text }));

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
  bench("dedupeNearDuplicates (300 × 5 KB)", () => {
    dedupeNearDuplicates(pool);
  });
  bench("buildBm25Index (300 × 5 KB)", () => {
    buildBm25Index("token bucket", bm25Docs);
  });
  const index = buildBm25Index("token bucket", bm25Docs);
  bench("bm25Score × 300 (one scoring per document)", () => {
    for (const d of bm25Docs) bm25Score(index, d);
  });
  bench("bm25Score inside a sort comparator (the pattern hybridSearch used)", () => {
    [...bm25Docs].sort((a, b) => bm25Score(index, b) - bm25Score(index, a));
  });
});
