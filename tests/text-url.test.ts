import { describe, expect, it } from "vitest";
import { buildMatcher, isStopword, keywords, rankedKeywords } from "../src/text.js";
import { canonicalizeUrl, domainOf, fnv1a64, LOCAL_FILE_DOMAIN, normalizeDoi } from "../src/url.js";

// Ported from the blocks of each skill's util.test.ts whose subjects moved into
// the engine. The rest of that suite covers functions still on the consumer
// side (slugify, runId, trustScore, rrf, simhash, shq) and follows them when
// the ranking layer lands.

describe("canonicalizeUrl", () => {
  it("lowercases scheme and host but preserves path case", () => {
    // github.com/Microsoft/TypeScript is not github.com/microsoft/typescript,
    // and YouTube ?v= ids are case-bearing.
    expect(canonicalizeUrl("HTTPS://Example.COM/Path/To/Page")).toBe("https://example.com/Path/To/Page");
  });

  it("drops www, the fragment, the default port and a trailing slash", () => {
    expect(canonicalizeUrl("https://www.example.com:443/a/#section")).toBe("https://example.com/a");
    expect(canonicalizeUrl("http://example.com:80/a/")).toBe("http://example.com/a");
  });

  it("strips tracking parameters and sorts what remains", () => {
    expect(canonicalizeUrl("https://x.test/p?utm_source=nl&b=2&a=1&fbclid=zz")).toBe("https://x.test/p?a=1&b=2");
  });

  it("re-encodes values, so an encoded delimiter cannot become one", () => {
    expect(canonicalizeUrl("https://x.test/p?q=a%26b=c")).toBe("https://x.test/p?q=a%26b%3Dc");
  });

  it("degrades gracefully on an unparseable URL instead of throwing", () => {
    expect(canonicalizeUrl("  not a url#frag  ")).toBe("not a url");
  });

  it("collapses the variants of one source to a single key", () => {
    const a = canonicalizeUrl("https://www.Example.com/doc/?utm_campaign=x#top");
    const b = canonicalizeUrl("HTTPS://example.com/doc");
    expect(a).toBe(b);
  });
});

describe("domainOf", () => {
  it("returns the bare hostname without www", () => {
    expect(domainOf("https://www.example.com/a/b")).toBe("example.com");
  });

  it("names the local-file route rather than calling it unknown", () => {
    // "" reads as "unknown" in a source list and would group every local file
    // with every unparseable URL — a reader should see at a glance that the
    // evidence came off the machine, not the web.
    expect(domainOf("file:///Users/x/report.pdf")).toBe(LOCAL_FILE_DOMAIN);
  });

  it("returns empty for an unparseable URL", () => {
    expect(domainOf("nonsense")).toBe("");
  });
});

describe("normalizeDoi", () => {
  it("reduces a DOI URL and a bare DOI to the same key", () => {
    expect(normalizeDoi("https://doi.org/10.1000/ABC")).toBe("10.1000/abc");
    expect(normalizeDoi("https://dx.doi.org/10.1000/abc")).toBe("10.1000/abc");
    expect(normalizeDoi("  10.1000/AbC ")).toBe("10.1000/abc");
  });
});

describe("fnv1a64", () => {
  it("is deterministic and distinguishes near-identical inputs", () => {
    expect(fnv1a64("https://x.test/a")).toBe(fnv1a64("https://x.test/a"));
    expect(fnv1a64("https://x.test/a")).not.toBe(fnv1a64("https://x.test/b"));
  });

  it("stays inside 64 bits", () => {
    expect(fnv1a64("x")).toBeLessThan(1n << 64n);
  });
});

describe("keywords", () => {
  it("drops stopwords and single characters, keeps identifiers", () => {
    const k = keywords("What is the default for maxRetries in the client?");
    expect(k).toContain("maxRetries");
    expect(k).not.toContain("the");
    expect(k).not.toContain("is");
  });

  it("drops French question scaffolding too", () => {
    const k = keywords("Quelle est la valeur par défaut de maxRetries ?");
    expect(k).toContain("maxRetries");
    expect(k).not.toContain("la");
    expect(k).not.toContain("est");
  });

  it("deduplicates case-insensitively while keeping the original spelling", () => {
    expect(keywords("Retry retry RETRY")).toEqual(["Retry"]);
  });
});

describe("rankedKeywords", () => {
  it("puts the most distinctive terms first", () => {
    // Numbers, camelCase and underscores carry more signal than plain words —
    // which is what lets a narrow search API be fed only its best few terms.
    const r = rankedKeywords("error connectTimeout 5000 happens sometimes");
    expect(r.slice(0, 2)).toContain("connectTimeout");
    expect(r.slice(0, 2)).toContain("5000");
  });
});

describe("buildMatcher", () => {
  it("matches accent-insensitively in both directions", () => {
    const m = buildMatcher("télémétrie");
    expect(m.matchLine("the telemetrie pipeline").size).toBe(1);
    expect(m.matchLine("la télémétrie du serveur").size).toBe(1);
  });

  it("folds plurals onto one canonical term", () => {
    const m = buildMatcher("buckets");
    expect(m.matchLine("a token bucket algorithm").size).toBe(1);
  });

  it("splits camelCase so a prose line still matches an identifier", () => {
    const m = buildMatcher("connectTimeout");
    expect(m.matchLine("the connect timeout is configurable").size).toBeGreaterThan(0);
  });

  it("reports nothing for an unrelated line", () => {
    const m = buildMatcher("rate limiting");
    expect(m.matchLine("an unrelated sentence about cats").size).toBe(0);
  });

  it("counts each keyword once, however many variants hit", () => {
    const m = buildMatcher("retry");
    expect(m.matchLine("retry retry retries").size).toBe(1);
  });
});

describe("isStopword", () => {
  it("names the scaffolding both scorers must drop", () => {
    // A consumer's own tokeniser calls this so its vocabulary matches
    // buildMatcher's. Two lists that drift make a source rank on a term the
    // excerpt never highlights, which looks like a bug in neither.
    for (const w of ["the", "is", "for", "la", "est", "une"]) expect(isStopword(w), w).toBe(true);
    for (const w of ["retry", "maxRetries", "télémétrie", "5000"]) expect(isStopword(w), w).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isStopword("THE")).toBe(true);
  });
});
