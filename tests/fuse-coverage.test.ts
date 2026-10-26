import { describe, expect, it } from "vitest";
import { coverageWindow, fuse, termCoverage, UNDER_COVERED_MIN, underCovered } from "../src/rank.js";

interface Hit {
  url: string;
  score: number;
  text?: string;
  snippet?: string;
  meta?: Record<string, unknown>;
}
const src = (url: string, text: string): Hit => ({ url, text, score: 1 });

describe("termCoverage / underCovered", () => {
  it("counts, per term, how many of the top sources mention it", () => {
    const items = [src("https://a.test", "token bucket"), src("https://b.test", "token only"), src("https://c.test", "unrelated prose")];
    expect(termCoverage(items, ["token", "bucket"])).toEqual([
      { term: "token", sources: 2 },
      { term: "bucket", sources: 1 },
    ]);
  });

  it("preserves queryTerms order so the report reads like the question", () => {
    expect(termCoverage([src("https://a.test", "beta")], ["zulu", "alpha", "beta"]).map((c) => c.term)).toEqual(["zulu", "alpha", "beta"]);
  });

  it("falls back to the snippet when a source carries no text", () => {
    expect(termCoverage([{ snippet: "quota" }], ["quota"])).toEqual([{ term: "quota", sources: 1 }]);
  });

  it("only looks at the top N sources — an 11th mention does not rescue a term", () => {
    const items = [...Array(10)].map((_, i) => src(`https://x${i}.test`, "filler")).concat(src("https://late.test", "quota"));
    expect(termCoverage(items, ["quota"], 10)).toEqual([{ term: "quota", sources: 0 }]);
    expect(termCoverage(items, ["quota"], 11)).toEqual([{ term: "quota", sources: 1 }]);
    expect(termCoverage(items, ["quota"])).toEqual([{ term: "quota", sources: 0 }]);
  });

  it("widens the window to one source per term for a broad question", () => {
    expect(coverageWindow(3)).toBe(10);
    expect(coverageWindow(27)).toBe(27);
    const terms = [..."abcdefghijklmn"].map((c) => `term${c}`);
    const items = [...Array(11)]
      .map((_, i) => src(`https://x${i}.test`, "filler"))
      .concat(src("https://late.test", "termn"), src("https://late2.test", "termn"));
    expect(termCoverage(items, terms).find((c) => c.term === "termn")).toEqual({ term: "termn", sources: 2 });
  });

  it("flags exactly the terms under the floor, which a caller may raise", () => {
    const cov = [
      { term: "covered", sources: UNDER_COVERED_MIN },
      { term: "weak", sources: UNDER_COVERED_MIN - 1 },
    ];
    expect(underCovered(cov)).toEqual(["weak"]);
    expect(underCovered(cov, UNDER_COVERED_MIN + 1)).toEqual(["covered", "weak"]);
  });
});

describe("fuse", () => {
  it("collapses the same canonical URL across lists, preferring text and merging meta", () => {
    const a: Hit = { url: "https://example.test/page?utm_source=x", score: 3, meta: { engine: "ddg" } };
    const b: Hit = { url: "https://example.test/page", score: 2, text: "the page", meta: { year: 2020 } };
    const out = fuse([[a], [b]]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe("the page");
    expect(out[0]!.meta).toMatchObject({ engine: "ddg", year: 2020, foundBy: 2 });
  });

  it("takes the caller's identity key and scores by RRF, ties broken by URL", () => {
    const doi = (h: Hit) => String(h.meta?.doi ?? h.url);
    const a: Hit = { url: "https://arxiv.test/abs/1", score: 0, meta: { doi: "10.1/x" } };
    const b: Hit = { url: "https://doi.test/10.1/x", score: 0, meta: { doi: "10.1/x" } };
    const c: Hit = { url: "https://other.test/", score: 0 };
    const out = fuse([[a, c], [b]], doi);
    expect(out.map((h) => h.url)).toEqual(["https://arxiv.test/abs/1", "https://other.test/"]);
    expect(out[0]!.score).toBeGreaterThan(out[1]!.score);
    expect(out[1]!.meta?.foundBy).toBe(1);
  });
});
