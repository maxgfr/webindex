import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendixMask,
  bracketedTokensIn,
  citationTokensIn,
  type ClaimUnit,
  codeMask,
  collectCitations,
  danglingTokens,
  extractClaimUnits,
  extractNumerals,
  markedQuoteMask,
  normalizeNumeralText,
  orMasks,
  parseFileLine,
  SOURCE_TOKEN,
  stripHtmlComments,
  stripInlineCode,
  uncitedIds,
  unitTexts,
} from "../src/cite.js";

const isSource = (t: string) => SOURCE_TOKEN.test(t);
const texts = (units: ClaimUnit[]) => units.flatMap(unitTexts);

describe("the boundary this module holds", () => {
  it("exports nothing that returns a pass or a fail", () => {
    // The one invariant that keeps citation POLICY with the skill. A function
    // here returning ok/valid/passed is the signal the line has been crossed —
    // whether an uncited claim is fatal is not this package's sentence to write.
    const src = readFileSync(join(import.meta.dirname, "..", "src", "cite.ts"), "utf8");

    // A SCALAR boolean return is the tell. `boolean[]` is a per-line mask —
    // data about the document — while `boolean` is a judgment of it.
    const verdicts = [...src.matchAll(/^export (?:async )?function (\w+)[^\n]*\):\s*(?:Promise<)?boolean>?\s*\{/gm)].map((m) => m[1]);
    expect(verdicts).toEqual([]);

    // The same rule stated over the shapes it hands back, and over the name
    // every skill's gate goes by. Comments are stripped first, or the module's
    // own paragraph explaining the rule trips the assertion enforcing it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\b(ok|valid|passed|grounded|conforms):\s*boolean\b/);
    expect(code).not.toMatch(/^export (?:async )?function (run)?[Cc]heck/m);

    // A negative control: the assertion above has to be able to see a return
    // type at all, or it passes on an empty match forever.
    expect(src).toMatch(/^export function \w+[^\n]*\): string\[\] \{/m);
  });
});

describe("tokens", () => {
  it("does not read a markdown link as a citation", () => {
    // [see the spec](https://…) is a link whose text happens to be bracketed.
    expect(citationTokensIn("As [S1] says, see [the spec](https://x.test)", isSource)).toEqual(["S1"]);
  });

  it("returns each token once, in order of first appearance", () => {
    expect(citationTokensIn("[S2] then [S1] then [S2]", isSource)).toEqual(["S2", "S1"]);
  });

  it("hands back the tokens the predicate rejected, for a caller that reports them", () => {
    expect(bracketedTokensIn("[S1] and [TODO] and [M]")).toEqual(["S1", "TODO", "M"]);
  });

  it("parses a file-and-line citation, single line or range", () => {
    expect(parseFileLine("src/foo.ts:12")).toEqual({ path: "src/foo.ts", start: 12, end: 12 });
    expect(parseFileLine("src/foo.ts:12-40")).toEqual({ path: "src/foo.ts", start: 12, end: 40 });
  });

  it("refuses a backwards or zero range rather than resolving nothing quietly", () => {
    expect(parseFileLine("src/foo.ts:40-12")).toBeUndefined();
    expect(parseFileLine("src/foo.ts:0")).toBeUndefined();
    expect(parseFileLine("S1")).toBeUndefined();
  });
});

describe("what cannot ground a claim", () => {
  it("ignores a citation inside inline code", () => {
    expect(citationTokensIn("write it as `[S1]`", isSource)).toEqual([]);
  });

  it("blanks HTML comments but keeps the line numbering", () => {
    const text = "a\n<!-- [S1]\nstill hidden -->\nb";
    const out = stripHtmlComments(text);
    expect(out.split("\n")).toHaveLength(4);
    expect(out).not.toContain("S1");
  });

  it("masks fenced code, fence lines included", () => {
    expect(codeMask(["prose", "```", "[S1]", "```", "prose"])).toEqual([false, true, true, true, false]);
  });

  it("masks a marked blockquote region as a whole", () => {
    const lines = ["a", "> [model-hint]", "> still the hint", "b", "> a plain quote"];
    const { mask, regions } = markedQuoteMask(lines, /\[model-hint\]/i);
    expect(mask).toEqual([false, true, true, false, false]);
    expect(regions).toBe(1);
  });

  it("masks a Sources appendix to the next heading of the same or shallower level", () => {
    const lines = ["# Report", "body", "## Sources", "- [S1] a", "## Appendix", "more"];
    expect(appendixMask(lines)).toEqual([false, false, true, true, false, false]);
  });

  it("does not let a deeper heading end the appendix", () => {
    const lines = ["## References", "### Primary", "- [S1]", "## Next"];
    expect(appendixMask(lines)).toEqual([true, true, true, false]);
  });

  it("ors masks together", () => {
    expect(orMasks([true, false, false], [false, true, false])).toEqual([true, true, false]);
  });
});

describe("claim units", () => {
  it("treats headings, rules and blank lines as structure", () => {
    expect(texts(extractClaimUnits("# Title\n\n---\n\nThe body asserts something."))).toEqual(["The body asserts something."]);
  });

  it("makes a table row a claim, but not the header row", () => {
    const md = "| Engine | Keyless |\n|---|---|\n| Mojeek | yes [S1] |";
    expect(texts(extractClaimUnits(md))).toEqual(["Mojeek yes [S1]"]);
  });

  it("keeps the header row when the caller asks for it", () => {
    const md = "| Engine | Keyless |\n|---|---|\n| Mojeek | yes |";
    expect(texts(extractClaimUnits(md, { skipTableHeader: false }))).toEqual(["Engine Keyless", "Mojeek yes"]);
  });

  it("does not let a blockquote inherit the citation above it", () => {
    // The default. Folding the quote into the paragraph would let a fabricated
    // quotation pass on someone else's source.
    const md = "Grounded prose [S1].\n\n> An unattributed quotation.";
    const units = texts(extractClaimUnits(md));
    expect(units).toEqual(["Grounded prose [S1].", "An unattributed quotation."]);
    expect(citationTokensIn(units[1] as string, isSource)).toEqual([]);
  });

  it("folds a blockquote into prose when the caller prefers that reading", () => {
    const md = "Lead in.\n> quoted";
    expect(texts(extractClaimUnits(md, { blockquotes: "prose" }))).toEqual(["Lead in. quoted"]);
  });

  it("folds consecutive quote lines into one unit", () => {
    expect(texts(extractClaimUnits("> one\n> two"))).toEqual(["one two"]);
  });

  it("groups a list and folds continuation lines into their item", () => {
    const md = "- first item\n  continued here\n- second item";
    const units = extractClaimUnits(md);
    expect(units).toEqual([{ kind: "list", items: ["first item continued here", "second item"] }]);
  });

  it("excludes whatever the caller masks, on top of fences and comments", () => {
    const md = "Real claim.\n\n## Sources\n\n- [S1] something";
    const units = texts(extractClaimUnits(md, { exclude: (lines) => appendixMask(lines) }));
    expect(units).toEqual(["Real claim."]);
  });

  it("strips inline code from the stored text by default", () => {
    expect(texts(extractClaimUnits("call `makeRetriable` first"))).toEqual(["call   first"]);
  });

  it("keeps inline code when the caller wants to echo the claim verbatim", () => {
    expect(texts(extractClaimUnits("call `makeRetriable` first", { keepInlineCode: true }))).toEqual(["call `makeRetriable` first"]);
  });

  it("does not read a pipe inside backticks as a table", () => {
    expect(texts(extractClaimUnits("use `a | b` here"))).toEqual(["use   here"]);
  });

  it("tags units with the caller's own section label, and stops at the next heading", () => {
    // Generalises "this section plays by different rules" without the engine
    // knowing which rules — one skill exempts a declared-unknowns section.
    const md = "## Findings\n\nA grounded claim.\n\n## Unknowns\n\nWhat we could not settle.\n\n## More\n\nBack to claims.";
    const units = extractClaimUnits(md, { sectionTag: (h) => (/unknowns/i.test(h) ? "unknown" : undefined) });
    expect(units.map((u) => u.section)).toEqual([undefined, "unknown", undefined]);
  });
});

describe("collecting citations", () => {
  it("separates tokens that ground a claim from tokens that only look like it", () => {
    const md = ["Grounded prose [S1].", "", "```", "example: [S2]", "```", "", "## Sources", "- [S3] listed"].join("\n");
    const { grounding, inertOnly } = collectCitations(md, isSource, { exclude: (lines) => appendixMask(lines) });
    expect(grounding).toEqual(["S1"]);
    // S2 is a sample inside a fence; S3 is the rendered appendix listing.
    expect(inertOnly).toEqual(["S2", "S3"]);
  });
});

describe("set differences", () => {
  it("names cited tokens that resolve to nothing", () => {
    expect(danglingTokens(["S1", "S9", "S9"], ["S1", "S2"])).toEqual(["S9"]);
  });

  it("names known ids that nothing cites", () => {
    expect(uncitedIds(["S1"], ["S1", "S2", "S3"])).toEqual(["S2", "S3"]);
  });
});

describe("numerals", () => {
  it("reads a figure through any digit-group separator", () => {
    expect(normalizeNumeralText("10,000")).toBe("10000");
    expect(normalizeNumeralText("10 000")).toBe("10000");
    expect(normalizeNumeralText("1'000")).toBe("1000");
  });

  it("extracts the figures a claim asserts, normalised", () => {
    expect(extractNumerals("throughput rose to 10,000 rps at 99.9% uptime")).toEqual(["10000", "99.9"]);
  });

  it("ignores digits in citations, inline code and link URLs", () => {
    expect(extractNumerals("as [S12] shows, `port 8080`, see [the doc](https://x.test/v2/44)")).toEqual([]);
  });

  it("drops a bare single digit as too weak to check anything with", () => {
    expect(extractNumerals("there are 3 ways and 2 reasons")).toEqual([]);
    expect(extractNumerals("3.5 seconds")).toEqual(["3.5"]);
  });

  it("caps what it returns", () => {
    expect(extractNumerals("10 20 30 40 50 60 70 80 90 100")).toHaveLength(8);
    expect(extractNumerals("10 20 30", 2)).toEqual(["10", "20"]);
  });

  // A comma between digits is a group separator in English and a DECIMAL mark
  // almost everywhere else. Stripping it unconditionally turned "0,25" into
  // "025" and "1,5" into "15" — so a report written in the reader's language
  // over English sources accused itself of inventing every figure it had
  // correctly transcribed. The skills on this engine are told to search in the
  // audience's language and report in the user's, which makes that the normal
  // path rather than the odd one.
  it("reads a decimal comma as a decimal point, not as a group separator", () => {
    expect(normalizeNumeralText("0,25")).toBe("0.25");
    expect(normalizeNumeralText("1,5")).toBe("1.5");
    expect(extractNumerals("0,25 %")).toEqual(["0.25"]);
    expect(extractNumerals("1,5 million")).toEqual(["1.5"]);
  });

  it("still reads a three-digit group as one number, comma or space", () => {
    expect(normalizeNumeralText("1,000")).toBe("1000");
    expect(normalizeNumeralText("1 000")).toBe("1000");
    // The token pattern never allowed a plain space, so this used to come back
    // as "000" with the leading 1 dropped as a bare single digit.
    expect(extractNumerals("1 000 requêtes par seconde")).toEqual(["1000"]);
  });

  it("lets a figure survive translation between the two notations", () => {
    const source = extractNumerals("For a 60-second window, 150ms of skew is 0.25%");
    const report = extractNumerals("150 ms représentent 0,25 % sur une fenêtre de 60 secondes");
    expect(report.filter((n) => !source.includes(n))).toEqual([]);
  });
});

describe("stripInlineCode", () => {
  it("leaves a lone backtick alone rather than eating the rest of the line", () => {
    expect(stripInlineCode("a ` b [S1]")).toBe("a ` b [S1]");
  });
});
