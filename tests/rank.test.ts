import { describe, expect, it } from "vitest";
import {
  applyRelevanceFloor,
  arxivIdFromUrl,
  bm25MatchedTerms,
  bm25Score,
  bm25Tokenize,
  buildBm25Index,
  contentCoverage,
  dedupeByUrl,
  dedupeNearDuplicates,
  diversify,
  doiFromUrl,
  externalHosts,
  hammingDistance,
  recencyScore,
  rrf,
  simhash,
  type Bm25Doc,
} from "../src/rank.js";
import { configure, resetBrand } from "../src/brand.js";
import { buildMatcher, foldTerm } from "../src/text.js";

const src = (url: string, score: number, text = "") => ({ url, score, text });

describe("rrf", () => {
  it("fuses on position, so two lists with incomparable scores still merge", () => {
    const a = [{ id: "x" }, { id: "y" }];
    const b = [{ id: "y" }, { id: "z" }];
    const fused = rrf([a, b], (i) => i.id);
    // y appears in both lists (rank 2 and rank 1) and must beat either singleton.
    expect(fused.get("y")!).toBeGreaterThan(fused.get("x")!);
    expect(fused.get("y")!).toBeGreaterThan(fused.get("z")!);
  });

  it("damps the tail with k, so one top-10 does not lose to a rank-40", () => {
    const top = [{ id: "top" }];
    const tail = Array.from({ length: 40 }, (_, i) => ({ id: i === 39 ? "deep" : `f${i}` }));
    const fused = rrf([top, tail], (i) => i.id);
    expect(fused.get("top")!).toBeGreaterThan(fused.get("deep")!);
  });

  it("is empty for empty input", () => {
    expect(rrf<{ id: string }>([], (i) => i.id).size).toBe(0);
  });

  it("counts an item once per list, at its best rank", () => {
    // Callers key by canonical URL or DOI, so tracking-param variants inside
    // ONE engine's list share a key. Summing them let one engine repeating a
    // URL count as much as two engines agreeing (Cormack et al. count once).
    const key = (u: string) => u.replace(/\?.*$/, "");
    const fused = rrf(
      [
        ["x.test/a", "y.test/b", "x.test/a?utm_source=feed"],
        ["y.test/b", "z.test/c"],
      ],
      key,
    );
    expect(fused.get("x.test/a")).toBeCloseTo(1 / 61, 10);
    expect(fused.get("y.test/b")!).toBeGreaterThan(fused.get("x.test/a")!);
  });
});

describe("identity parsed out of a URL", () => {
  it("collapses abs/pdf/html variants of one arXiv paper", () => {
    const ids = [
      "https://arxiv.org/abs/2405.12345",
      "https://arxiv.org/pdf/2405.12345",
      "https://arxiv.org/pdf/2405.12345v3.pdf",
      "https://www.arxiv.org/html/2405.12345v1",
    ].map(arxivIdFromUrl);
    expect(new Set(ids)).toEqual(new Set(["2405.12345"]));
  });

  it("handles legacy arXiv ids and refuses non-arXiv hosts", () => {
    expect(arxivIdFromUrl("https://arxiv.org/abs/math.GT/0309136")).toBe("math.gt/0309136");
    expect(arxivIdFromUrl("https://notarxiv.org/abs/2405.12345")).toBeUndefined();
    expect(arxivIdFromUrl("https://arxiv.org/list/cs.CL/recent")).toBeUndefined();
    expect(arxivIdFromUrl("not a url")).toBeUndefined();
  });

  it("reads a DOI from a resolver link or a publisher path", () => {
    expect(doiFromUrl("https://doi.org/10.1145/3178876.3186111")).toBe("10.1145/3178876.3186111");
    expect(doiFromUrl("https://dx.doi.org/10.1145/3178876.3186111")).toBe("10.1145/3178876.3186111");
    expect(doiFromUrl("https://dl.acm.org/doi/full/10.1145/3178876.3186111")).toBe("10.1145/3178876.3186111");
    expect(doiFromUrl("https://dl.acm.org/doi/pdf/10.1145/3178876.3186111")).toBe("10.1145/3178876.3186111");
  });

  it("reads a DOI a publisher carries in its path or query without a /doi/ segment", () => {
    expect(doiFromUrl("https://link.springer.com/article/10.1007/s11263-015-0816-y")).toBe("10.1007/s11263-015-0816-y");
    expect(doiFromUrl("https://www.biorxiv.org/content/10.1101/2020.03.22.002386v1")).toBe("10.1101/2020.03.22.002386");
    expect(doiFromUrl("https://www.biorxiv.org/content/10.1101/2020.03.22.002386v2.full.pdf")).toBe("10.1101/2020.03.22.002386");
    expect(doiFromUrl("https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0000001")).toBe("10.1371/journal.pone.0000001");
    // …so the landing page and the resolver link collapse to one identity.
    expect(doiFromUrl("https://www.biorxiv.org/content/10.1101/2020.03.22.002386v1")).toBe(doiFromUrl("https://doi.org/10.1101/2020.03.22.002386"));
  });

  it("reads an arXiv id behind a trailing slash", () => {
    expect(arxivIdFromUrl("https://arxiv.org/abs/2405.12345v2/")).toBe("2405.12345");
    expect(arxivIdFromUrl("https://arxiv.org/abs/math.GT/0309136/")).toBe("math.gt/0309136");
  });

  it("returns nothing for a URL that carries no DOI", () => {
    expect(doiFromUrl("https://example.com/article")).toBeUndefined();
    expect(doiFromUrl("https://doi.org/nonsense")).toBeUndefined();
  });
});

describe("dedupeByUrl", () => {
  it("collapses tracking-param and case variants, keeping the best score", () => {
    const { items, dropped } = dedupeByUrl([src("https://a.test/p?utm_source=x", 0.4), src("https://a.test/p", 0.9), src("https://b.test/q", 0.5)]);
    expect(dropped).toBe(1);
    expect(items).toHaveLength(2);
    expect(items[0]!.score).toBe(0.9); // the better copy survived…
    expect(items[0]!.url).toBe("https://a.test/p");
    expect(items[1]!.url).toBe("https://b.test/q"); // …in first-seen order
  });

  it("keeps the earlier item on a score tie", () => {
    const { items } = dedupeByUrl([src("https://a.test/p", 0.5), src("https://a.test/p?utm_source=y", 0.5)]);
    expect(items[0]!.url).toBe("https://a.test/p");
  });
});

describe("BM25F", () => {
  const doc = (id: string, title: string, headings: string, body: string): Bm25Doc => ({ id, title, headings, body });

  it("folds plurals and accents, and drops stopwords, like the matcher does", () => {
    const toks = bm25Tokenize("The requests and the RÉPONSES are cached");
    expect(toks).toContain("request"); // "requests" → "request"
    expect(toks).toContain("repons"); // deaccented, and "-ses" folded off
    expect(toks).not.toContain("the"); // stopword
    expect(toks).not.toContain("and");
  });

  it("agrees with buildMatcher on what a term is — that is why it shares foldTerm", () => {
    // Not "the folding is correct", which is text.ts's business, but "both
    // scorers fold identically". A BM25 that disagrees with the matcher about
    // whether two words are the same term produces relevance nobody can explain.
    // (It shows the rules' edges too: French "-se/-ses" folds asymmetrically.)
    for (const w of ["requests", "réponses", "réponse", "Buckets"]) {
      expect(bm25Tokenize(w)).toEqual([foldTerm(w.toLowerCase())]);
    }
  });

  it("preserves term frequency (it is not a set)", () => {
    expect(bm25Tokenize("bucket bucket bucket").length).toBe(3);
  });

  it("reads Chinese and Japanese as overlapping character bigrams", () => {
    // No spaces, so a whole clause used to be ONE token: a natural CJK question
    // matched nothing and every score was 0. Bigrams are Lucene's
    // CJKBigramFilter: deterministic, no dictionary, nothing for Latin text.
    expect(bm25Tokenize("东京塔的高度是多少")).toEqual(["东京", "京塔", "塔的", "的高", "高度", "度是", "是多", "多少"]);
    // A kana run bigrams too, and the digits between runs stay one token.
    expect(bm25Tokenize("タワーの高さは333メートル")).toEqual(["タワ", "ワー", "ーの", "の高", "高さ", "さは", "333", "メー", "ート", "トル"]);
    // A lone ideograph is a word, not noise under the two-character rule.
    expect(bm25Tokenize("塔 and 米")).toEqual(["塔", "米"]);
    // Latin next to a CJK run is still an ordinary term.
    expect(bm25Tokenize("towers東京")).toEqual(["tower", "東京"]);
  });

  it("ranks the CJK document that answers the question first", () => {
    const docs = [
      doc("weather", "今天的天气", "", "今天的天气很好，适合出门散步。"),
      doc("eiffel", "埃菲尔铁塔", "", "埃菲尔铁塔位于巴黎，高度约330米。"),
      doc("tokyo", "东京塔简介", "", "东京塔的高度是333米，位于东京都港区。"),
    ];
    const idx = buildBm25Index("东京塔的高度是多少", docs);
    const scores = docs.map((d) => bm25Score(idx, d));
    expect(scores[2]).toBeGreaterThan(scores[1]!);
    expect(scores[1]).toBeGreaterThan(scores[0]!);
  });

  it("keeps combining marks inside the word they belong to", () => {
    // Every vowel sign or virama used to split an Indic or Thai word and was
    // dropped with the fragments under two characters.
    expect(bm25Tokenize("हिन्दी भाषा का इतिहास")).toEqual(["हिन्दी", "भाषा", "का", "इतिहास"]);
    expect(bm25Tokenize("ภาษาไทย ประวัติศาสตร์")).toEqual(["ภาษาไทย", "ประวัติศาสตร์"]);
    expect(bm25Tokenize("தமிழ் மொழி வரலாறு")).toEqual(["தமிழ்", "மொழி", "வரலாறு"]);
    // A decomposed Latin accent still folds away, as a precomposed one does.
    expect(bm25Tokenize("cafe\u0301 café")).toEqual(["cafe", "cafe"]);
    expect(buildBm25Index("हिन्दी इतिहास", []).queryTerms).toEqual(["हिन्दी", "इतिहास"]);
  });

  it("splits identifiers into their words, as the matcher does", () => {
    // buildMatcher expands RateLimiter into rate / limiter / ratelimiter; a
    // BM25 that did not scored 0 the page an excerpt then highlighted.
    expect(bm25Tokenize("RateLimiter")).toEqual(["ratelimiter", "rate", "limiter"]);
    expect(bm25Tokenize("rate_limiter")).toEqual(["rate_limiter", "rate", "limiter"]);
    expect(bm25Tokenize("TokenBuckets")).toEqual(["tokenbucket", "token", "bucket"]);
    expect(bm25Tokenize("rate-limiter")).toEqual(["rate", "limiter"]);
    const docs = [doc("a", "RateLimiter class", "", "The RateLimiter throttles."), doc("b", "", "", "cooking"), doc("c", "", "", "weather")];
    const idx = buildBm25Index("rate limiter", docs);
    expect(bm25Score(idx, docs[0]!)).toBeGreaterThan(0);
    expect(bm25MatchedTerms(idx, docs[0]!)).toEqual(["rate", "limiter"]);
    // …and the query side expands the same way.
    expect(buildBm25Index("RateLimiter", docs).queryTerms).toEqual(["ratelimiter", "rate", "limiter"]);
  });

  it("drops an identifier's words that are stopwords, under whichever list is configured now", () => {
    expect(bm25Tokenize("RateLimiter")).toEqual(["ratelimiter", "rate", "limiter"]);
    configure({ name: "t", envPrefix: "T", cli: "t", extraStopwords: ["limiter"] });
    expect(bm25Tokenize("RateLimiter")).toEqual(["ratelimiter", "rate"]);
    resetBrand();
    expect(bm25Tokenize("RateLimiter")).toEqual(["ratelimiter", "rate", "limiter"]);
  });

  it("keeps SimHash on the unexpanded words, so a hash never moves between versions", () => {
    expect(simhash("The RateLimiter throttles rate_limiter calls from getHTTPClient and parseJSON2")).toBe(0x292a0806401246c2n);
  });

  it("tokenises a long mixed-script text in linear time", () => {
    const text = `${"東京タワー".repeat(20_000)} ${"RateLimiterX".repeat(5_000)} ${"हिन्दी ".repeat(10_000)} ${"a_".repeat(20_000)}`;
    const started = performance.now();
    bm25Tokenize(text);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("ranks a title match above the same term buried in the body", () => {
    const docs = [
      doc("titled", "Token bucket rate limiting", "", "filler ".repeat(200)),
      doc("buried", "Unrelated heading", "", `${"filler ".repeat(200)} token bucket`),
      doc("other", "Something else", "", "filler ".repeat(200)),
    ];
    const idx = buildBm25Index("token bucket", docs);
    expect(bm25Score(idx, docs[0]!)).toBeGreaterThan(bm25Score(idx, docs[1]!));
  });

  it("saturates a repeated term instead of letting it dominate", () => {
    const stuffed = doc("stuffed", "", "", "bucket ".repeat(200));
    const balanced = doc("balanced", "", "", `${"bucket ".repeat(3)} ${"token ".repeat(3)} ${"filler ".repeat(50)}`);
    const docs = [stuffed, balanced, doc("c", "", "", "filler ".repeat(50))];
    const idx = buildBm25Index("token bucket", docs);
    // Covering both query terms beats hammering one of them 200 times.
    expect(bm25Score(idx, balanced)).toBeGreaterThan(bm25Score(idx, stuffed));
  });

  it("degrades to uniform IDF on a pool too small to estimate it", () => {
    const docs = [doc("a", "", "", "token bucket"), doc("b", "", "", "unrelated")];
    const idx = buildBm25Index("token bucket", docs);
    expect(idx.N).toBe(2);
    expect([...idx.idf.values()].every((v) => v === 1)).toBe(true);
  });

  it("reports which query terms a document actually matched", () => {
    const d = doc("a", "Token buckets", "", "the bucket refills steadily");
    const idx = buildBm25Index("token bucket windows", [d, doc("b", "", "", "x"), doc("c", "", "", "y")]);
    const matched = bm25MatchedTerms(idx, d);
    expect(matched).toContain("token");
    expect(matched).toContain("bucket");
    expect(matched).not.toContain("window");
  });

  it("re-tokenizes a document that changed after the index was built", () => {
    const changing = doc("a", "Unrelated", "", "nothing useful");
    const idx = buildBm25Index("token bucket", [changing, doc("b", "", "", "x"), doc("c", "", "", "y")]);
    expect(bm25MatchedTerms(idx, changing)).toEqual([]);
    changing.body = "token bucket";
    expect(bm25MatchedTerms(idx, changing)).toEqual(["token", "bucket"]);
    expect(bm25Score(idx, changing)).toBeGreaterThan(0);
  });

  it("scores the same from body tokens the caller already has", () => {
    const docs = [doc("a", "Token buckets", "Rate limits", "a bucket refills"), doc("b", "", "", "cooking"), doc("c", "", "", "token weather")];
    const plain = buildBm25Index("token bucket", docs);
    const shared = buildBm25Index("token bucket", docs, { tokensOf: (d) => bm25Tokenize(d.body) });
    expect(docs.map((d) => bm25Score(shared, d))).toEqual(docs.map((d) => bm25Score(plain, d)));
  });

  it("scores zero for an empty query or an empty document", () => {
    const d = doc("a", "", "", "some prose");
    expect(bm25Score(buildBm25Index("", [d]), d)).toBe(0);
    expect(bm25Score(buildBm25Index("token", [d]), doc("b", "", "", ""))).toBe(0);
  });
});

describe("applyRelevanceFloor", () => {
  const matched = (m: Record<string, string[]>) => (id: string) => m[id] ?? [];

  it("drops candidates that share no term with the query", () => {
    const r = applyRelevanceFloor(["good", "offtopic"], matched({ good: ["token"], offtopic: [] }), ["token", "bucket"], 0);
    expect(r.kept).toEqual(["good"]);
    expect(r.dropped).toEqual(["offtopic"]);
  });

  it("drops a match that is only numeric — the year/PR-number false friend", () => {
    const r = applyRelevanceFloor(["real", "digits"], matched({ real: ["token"], digits: ["2024"] }), ["token", "2024"], 0);
    expect(r.kept).toEqual(["real"]);
    expect(r.dropped).toEqual(["digits"]);
  });

  it("never leaves fewer than the floor — a thin pool survives its own filter", () => {
    const r = applyRelevanceFloor(["a", "b", "c"], matched({}), ["token", "bucket"], 2);
    expect(r.kept).toEqual(["a", "b"]); // best-ranked re-admitted, in order
    expect(r.dropped).toEqual(["c"]);
  });

  it("stays inert on a query too weak to filter on", () => {
    const one = applyRelevanceFloor(["a"], matched({}), ["token"], 0);
    expect(one.kept).toEqual(["a"]);
    const numeric = applyRelevanceFloor(["a"], matched({}), ["404", "500"], 0);
    expect(numeric.kept).toEqual(["a"]);
  });
});

describe("contentCoverage", () => {
  it("reports the fraction of question keywords present", () => {
    const m = buildMatcher("token bucket refill rate");
    expect(contentCoverage(m, "a token bucket refills at a steady rate")).toBe(1);
    expect(contentCoverage(m, "nothing relevant here")).toBe(0);
    expect(contentCoverage(m, "the bucket is here")).toBeGreaterThan(0);
    expect(contentCoverage(m, "")).toBe(0);
  });
});

describe("recencyScore", () => {
  it("is pool-relative, and neutral when there is nothing to compare", () => {
    expect(recencyScore({ year: 2024 }, 2020, 2024)).toBe(1);
    expect(recencyScore({ year: 2020 }, 2020, 2024)).toBe(0);
    expect(recencyScore({ year: 2022 }, 2020, 2024)).toBe(0.5);
    expect(recencyScore(undefined, 2020, 2024)).toBe(0.5);
    expect(recencyScore({}, 2020, 2024)).toBe(0.5);
    expect(recencyScore({ year: 2022 }, 2022, 2022)).toBe(0.5); // no spread
  });

  it("clamps a year outside the pool range", () => {
    expect(recencyScore({ year: 2099 }, 2020, 2024)).toBe(1);
    expect(recencyScore({ year: 1990 }, 2020, 2024)).toBe(0);
  });
});

describe("simhash near-duplicate detection", () => {
  const article = `A token bucket refills at a fixed rate and caps at its burst size. ${"Each request removes one token from the bucket. ".repeat(20)}`;

  it("is blind to reformatting — a republished copy hashes identically", () => {
    // The common syndication case: same words, different whitespace and casing.
    const reformatted = `\n\n  ${article.replace(/ /g, "  ").toUpperCase()}  \n`;
    expect(hammingDistance(simhash(article), simhash(reformatted))).toBe(0);
  });

  it("separates a lightly-edited copy from an unrelated text by a wide margin", () => {
    // An edited copy moves a handful of bits; unrelated prose moves an order of
    // magnitude more. The MARGIN is the signal — the absolute distance depends on
    // how much was rewritten, which is why `maxBits` is a caller's knob.
    const edited = article.replace("burst size", "burst limit");
    const unrelated = "Sourdough fermentation depends on hydration and ambient temperature. ".repeat(20);
    const near = hammingDistance(simhash(article), simhash(edited));
    const far = hammingDistance(simhash(article), simhash(unrelated));
    expect(near).toBeLessThan(12);
    expect(far).toBeGreaterThan(20);
    expect(far).toBeGreaterThan(near * 2);
  });

  it("is deterministic and self-identical", () => {
    expect(simhash(article)).toBe(simhash(article));
    expect(hammingDistance(simhash(article), simhash(article))).toBe(0);
    expect(simhash("")).toBe(0n);
  });

  it("is frozen bit-for-bit — a faster implementation must not move a single bit", () => {
    // Values pinned on the reference implementation (BigInt per shingle). A
    // hash that drifts would make `maxBits` mean something different between
    // two versions of the engine.
    expect(simhash(article)).toBe(0xf687b8f62c241fdcn);
    expect(simhash("alpha beta")).toBe(0x0206219b85442023n);
    expect(simhash("alpha beta gamma")).toBe(0x29496d94f8235e1en);
  });

  it("counts differing bits across the full 64-bit width", () => {
    expect(hammingDistance(0n, (1n << 64n) - 1n)).toBe(64);
    expect(hammingDistance(1n << 63n, 0n)).toBe(1);
    expect(hammingDistance(0x8000000080000000n, 0x0000000100000001n)).toBe(4);
  });

  it("does not silently drop bits above 64, however it was asked", () => {
    // A SimHash never has them, but this is an exported function and a bigint
    // has no width: the two-popcount fast path must not answer "identical" for
    // two values that plainly differ.
    expect(hammingDistance(1n << 64n, 0n)).toBe(1);
    expect(hammingDistance(1n << 80n, 0n)).toBe(1);
    expect(hammingDistance((1n << 100n) | 5n, 0n)).toBe(3);
    expect(hammingDistance((1n << 200n) - 1n, 0n)).toBe(200);
  });

  it("hashes 200 KB of prose well under a tenth of a second", () => {
    const big = article.repeat(200);
    expect(big.length).toBeGreaterThan(200_000);
    const started = performance.now();
    simhash(big);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("collapses syndicated copies, keeping the best-scored one", () => {
    const items = [
      src("https://origin.test/a", 0.9, article),
      src("https://mirror.test/a", 0.4, `${article} `),
      src("https://other.test/b", 0.5, "Something entirely different. ".repeat(40)),
    ];
    const { items: kept, dropped } = dedupeNearDuplicates(items);
    expect(dropped).toBe(1);
    expect(kept.map((k) => k.url)).toEqual(["https://origin.test/a", "https://other.test/b"]);
  });

  it("reports which URL each dropped copy duplicated", () => {
    // A mirror is an alternate citation, and the evidence when a collapse was wrong.
    const other = "Something entirely different. ".repeat(40);
    const items = [
      src("https://origin.test/a", 0.9, article),
      src("https://mirror.test/a", 0.4, `${article} `),
      src("https://other.test/b", 0.5, other),
      src("https://better.test/b", 0.8, other),
    ];
    const r = dedupeNearDuplicates(items);
    expect(r.dropped).toBe(2);
    expect(r.duplicates).toEqual([
      { url: "https://mirror.test/a", of: "https://origin.test/a" },
      // A later, better copy displaces the kept one: the displaced URL is the duplicate.
      { url: "https://other.test/b", of: "https://better.test/b" },
    ]);
  });

  it("breaks a score tie between copies by code unit, whatever the machine's locale", () => {
    // localeCompare read LANG: under da_DK "aa" sorts after "ab". Code units
    // put "B" (0x42) before "a" (0x61) everywhere.
    const tie = [src("https://m.test/a", 0.5, article), src("https://m.test/B", 0.5, article)];
    expect(dedupeNearDuplicates(tie).items.map((i) => i.url)).toEqual(["https://m.test/B"]);
  });

  it("hashes tokens a caller already has exactly as it hashes the text", () => {
    // A pipeline that indexed a document need not tokenise it again.
    const plain = bm25Tokenize(article, { subtokens: false });
    expect(simhash(article, { tokens: plain })).toBe(simhash(article));
    const items = [src("https://origin.test/a", 0.9, article), src("https://mirror.test/a", 0.4, `${article} `)];
    const tokens = new Map(items.map((it) => [it, bm25Tokenize(it.text, { subtokens: false })]));
    expect(dedupeNearDuplicates(items, { tokensOf: (it) => tokens.get(it)! })).toEqual(dedupeNearDuplicates(items));
  });

  it("never collapses short texts, which carry too little signal", () => {
    const items = [src("https://a.test/1", 0.9, "short"), src("https://b.test/2", 0.5, "short")];
    expect(dedupeNearDuplicates(items).dropped).toBe(0);
  });
});

describe("diversify", () => {
  it("promotes the one source saying something else above a wall of restatements", () => {
    // The measured failure: independent pages restating one argument are each
    // genuinely relevant, so relevance ranking alone buries the outlier.
    const restatement = (n: number) => src(`https://blog${n}.test/x`, 0.9 - n * 0.01, "");
    const items = [...Array.from({ length: 8 }, (_, i) => restatement(i)), src("https://spec.test/std", 0.55, "")];
    const tokens = new Map<string, Set<string>>([
      ...items.slice(0, 8).map((it) => [it.url, new Set(["rate", "limit", "api", "throttle"])] as const),
      ["https://spec.test/std", new Set(["normative", "grammar", "header", "syntax"])] as const,
    ]);
    const out = diversify(items, (it) => tokens.get(it.url)!);
    const specRank = out.findIndex((o) => o.url === "https://spec.test/std");

    // By score alone the spec is dead last (rank 8) — every restatement outranks
    // it. Diversity lifts it several places without pretending it is the most
    // relevant thing in the pool: λ = 0.75 keeps relevance dominant on purpose,
    // so this promotes, it does not invert.
    expect(specRank).toBeLessThan(8);
    expect(specRank).toBeLessThanOrEqual(5);
    // …and the redundant pages it jumped are still there, just later.
    expect(out).toHaveLength(9);
  });

  it("returns every input exactly once — it reorders, it never filters", () => {
    const items = Array.from({ length: 6 }, (_, i) => src(`https://s${i}.test/`, 1 - i * 0.1, ""));
    const out = diversify(items, () => new Set(["a", "b"]));
    expect(out).toHaveLength(items.length);
    expect(new Set(out.map((o) => o.url))).toEqual(new Set(items.map((i) => i.url)));
  });

  it("leads with the best-scored item", () => {
    const items = [src("https://b.test/", 0.3, ""), src("https://a.test/", 0.95, ""), src("https://c.test/", 0.6, "")];
    const out = diversify(items, () => new Set(["x"]));
    expect(out[0]!.url).toBe("https://a.test/");
  });

  it("is a passthrough on pools too small to reorder", () => {
    const items = [src("https://a.test/", 0.1, ""), src("https://b.test/", 0.9, "")];
    expect(diversify(items, () => new Set()).map((i) => i.url)).toEqual(items.map((i) => i.url));
  });

  it("never ranks a matched document below one that matched nothing", () => {
    // Pool-normalised similarity made any overlap with the picked set carry the
    // full penalty, so a relevant page (rel < sim/3) went negative while every
    // off-topic page sat at 0 and was picked first — and `limit` then cut it.
    const items = [src("https://tb.test/", 1, ""), src("https://cook.test/", 0, ""), src("https://leaky.test/", 0.294, "")];
    const tokens: Record<string, string[]> = {
      "https://tb.test/": ["token", "bucket", "rate", "refill"],
      "https://cook.test/": ["braise", "beef", "slow"],
      "https://leaky.test/": ["leaky", "bucket", "rate", "queue"],
    };
    const out = diversify(items, (it) => new Set(tokens[it.url]));
    expect(out.map((o) => o.url)).toEqual(["https://tb.test/", "https://leaky.test/", "https://cook.test/"]);
  });

  it("still diversifies among the relevant ones, and among the rest", () => {
    const items = [
      src("https://a1.test/", 1, ""),
      src("https://a2.test/", 0.95, ""),
      src("https://b.test/", 0.7, ""),
      src("https://z1.test/", 0, ""),
      src("https://z2.test/", 0, ""),
    ];
    const tokens: Record<string, string[]> = {
      "https://a1.test/": ["rate", "limit", "api"],
      "https://a2.test/": ["rate", "limit", "api"],
      "https://b.test/": ["normative", "grammar"],
      "https://z1.test/": ["x"],
      "https://z2.test/": ["y"],
    };
    const out = diversify(items, (it) => new Set(tokens[it.url])).map((o) => o.url);
    // b says something else and jumps the restatement; zero relevance stays last.
    expect(out.slice(0, 3)).toEqual(["https://a1.test/", "https://b.test/", "https://a2.test/"]);
    expect(out.slice(3).sort()).toEqual(["https://z1.test/", "https://z2.test/"]);
  });

  it("breaks ties by code unit, not by the machine's locale", () => {
    const items = [src("https://s.test/a", 0.5, ""), src("https://s.test/B", 0.5, ""), src("https://s.test/c", 0.5, "")];
    expect(diversify(items, () => new Set(["t"])).map((i) => i.url)).toEqual(["https://s.test/B", "https://s.test/a", "https://s.test/c"]);
  });

  it("diversifies only the window, and keeps the tail in relevance order", () => {
    const items = Array.from({ length: 10 }, (_, i) => src(`https://w${i}.test/`, 1 - i * 0.05, ""));
    const tokens = (it: { url: string }) => (it.url < "https://w4" ? ["same", "words"] : [it.url]);
    const out = diversify(items, tokens, 0.75, { window: 4 });
    expect(out).toHaveLength(10);
    expect(new Set(out.slice(0, 4))).toEqual(new Set(items.slice(0, 4)));
    expect(out.slice(4)).toEqual(items.slice(4));
    // A window at least as large as the pool is the exact pass.
    expect(diversify(items, tokens, 0.75, { window: 50 })).toEqual(diversify(items, tokens));
  });

  it("stays fast on a large pool when windowed, and completes when exact", () => {
    // MMR is quadratic: 2 000 documents took 35 s in `webindex rank` with
    // string-set Jaccard computed twice per pair.
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pool = Array.from({ length: 2_000 }, (_, i) => ({
      ...src(`https://p${i}.test/`, rnd(), ""),
      tokens: Array.from({ length: 300 }, () => `t${Math.floor(rnd() * 5_000)}`),
    }));
    // Only the windowed pass carries a clock, and a loose one: it runs in ~25 ms
    // locally against the ~28 s the unwindowed string-set version took, so a
    // bound this wide still catches that regression without failing on a
    // loaded CI runner. The exact pass is quadratic by construction (226 ms at
    // 400 items locally, ~13× that on a busy runner) — a wall-clock bound on it
    // measures the machine, not the code, so it is only checked for its answer.
    const started = performance.now();
    expect(diversify(pool, (it) => it.tokens, 0.75, { window: 100 })).toHaveLength(2_000);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(diversify(pool.slice(0, 400), (it) => it.tokens)).toHaveLength(400);
  });

  it("is deterministic — the same pool ranks identically twice", () => {
    const items = Array.from({ length: 7 }, (_, i) => src(`https://s${i}.test/`, 0.5, ""));
    const toks = (it: { url: string }) => new Set([it.url.slice(-8)]);
    expect(diversify(items, toks).map((i) => i.url)).toEqual(diversify(items, toks).map((i) => i.url));
  });
});

describe("externalHosts", () => {
  it("lists the hosts a text links out to, minus its own", () => {
    const text = "See https://www.rfc-editor.org/rfc/rfc6585 and https://example.com/self and https://mdn.io/x";
    const hosts = externalHosts("https://example.com/article", text);
    expect(hosts).toEqual(new Set(["rfc-editor.org", "mdn.io"]));
  });

  it("is empty for a text that cites nothing", () => {
    expect(externalHosts("https://example.com/a", "no links at all").size).toBe(0);
  });

  it("leaves a sentence's final period out of the host", () => {
    const hosts = externalHosts("https://example.com/a", "Read https://example.com. Also see https://mdn.io/x and https://mdn.io.");
    expect(hosts).toEqual(new Set(["mdn.io"]));
  });

  it("reads a Unicode host whole and skips a userinfo prefix", () => {
    const hosts = externalHosts("https://example.com/a", "https://müller.de/x et https://user@evil.test/ puis https://user:pw@b.test");
    expect(hosts).toEqual(new Set(["xn--mller-kva.de", "evil.test", "b.test"]));
  });

  it("stays linear on a long run of host characters", () => {
    const started = performance.now();
    externalHosts("https://example.com/a", `https://${"a.".repeat(50_000)} https://${"x@".repeat(20_000)} ${"https://".repeat(20_000)}`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
