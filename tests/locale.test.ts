import { describe, expect, it } from "vitest";
import { resolveRegion, ddgRegion, acceptLanguageHeader, baseLang } from "../src/locale.js";

describe("baseLang", () => {
  it("lowercases and strips the region subtag", () => {
    expect(baseLang("de-DE")).toBe("de");
    expect(baseLang("EN")).toBe("en");
    expect(baseLang(undefined)).toBe("en");
  });
});

describe("resolveRegion", () => {
  it("mirrors the language for most locales", () => {
    expect(resolveRegion("de")).toBe("de");
    expect(resolveRegion("fr")).toBe("fr");
  });
  it("maps languages whose country differs", () => {
    expect(resolveRegion("en")).toBe("us");
    expect(resolveRegion("pt")).toBe("br");
    expect(resolveRegion("ja")).toBe("jp");
  });
  it("honors an explicit region override", () => {
    expect(resolveRegion("en", "de")).toBe("de");
    expect(resolveRegion("en", "GB")).toBe("gb");
  });
  it("uses a region subtag carried on the lang", () => {
    expect(resolveRegion("de-AT")).toBe("at");
  });
});

describe("ddgRegion (kl = region-language)", () => {
  it("builds de-de, fr-fr, us-en", () => {
    expect(ddgRegion("de")).toBe("de-de");
    expect(ddgRegion("fr")).toBe("fr-fr");
    expect(ddgRegion("en")).toBe("us-en");
  });
  it("aliases gb → uk for DuckDuckGo", () => {
    expect(ddgRegion("en", "gb")).toBe("uk-en");
  });
  it("combines an explicit region with the language", () => {
    expect(ddgRegion("en", "de")).toBe("de-en");
  });

  it("uses DuckDuckGo's language codes where they are not the BCP-47 ones", () => {
    // `kl` is DuckDuckGo's own vocabulary, and it does not spell two of these
    // the way BCP-47 does. Checked against duckduckgo.com's published parameter
    // list: Norway is `no-no`, not `no-nb`, and Japan is `jp-jp`, not `jp-ja`.
    //
    // The consequence of getting it wrong is quiet, which is why it survived: an
    // unrecognised `kl` is IGNORED rather than rejected, so a Norwegian run gets
    // an unlocalised result page and no error anywhere.
    expect(ddgRegion("nb-NO")).toBe("no-no");
    expect(ddgRegion("nn-NO")).toBe("no-no");
    expect(ddgRegion("ja-JP")).toBe("jp-jp");
  });

  it("gets there from the bare language too", () => {
    // A caller that passes only a language relies on the language→country
    // table, which had no entry for Norwegian at all — so `nb` alone produced
    // `nb-no`, wrong in the other half.
    expect(ddgRegion("nb")).toBe("no-no");
    expect(ddgRegion("ja")).toBe("jp-jp");
  });

  it("still spells the ones that already matched the same way", () => {
    // A guard on the alias table: it must not start rewriting codes that were
    // already right. All of these are verbatim from DuckDuckGo's list.
    expect(ddgRegion("cs-CZ")).toBe("cz-cs");
    expect(ddgRegion("da-DK")).toBe("dk-da");
    expect(ddgRegion("sv-SE")).toBe("se-sv");
    expect(ddgRegion("el-GR")).toBe("gr-el");
    expect(ddgRegion("he-IL")).toBe("il-he");
    expect(ddgRegion("zh-CN")).toBe("cn-zh");
    expect(ddgRegion("pt-BR")).toBe("br-pt");
    expect(ddgRegion("nl-BE")).toBe("be-nl");
    expect(ddgRegion("de-CH")).toBe("ch-de");
    expect(ddgRegion("en-IE")).toBe("ie-en");
  });
});

describe("the Accept-Language header keeps the real BCP-47 tag", () => {
  it("does not adopt DuckDuckGo's spelling", () => {
    // The alias exists for one engine's query parameter. An HTTP header that
    // said `no-NO,no;q=0.9` would be asking every server on the web for a
    // language tag that is not the one the caller meant.
    expect(acceptLanguageHeader("nb-NO")).toBe("nb-NO,nb;q=0.9,en;q=0.5");
    expect(acceptLanguageHeader("ja-JP")).toBe("ja-JP,ja;q=0.9,en;q=0.5");
  });
});

describe("acceptLanguageHeader", () => {
  it("biases to the target language with English fallback", () => {
    expect(acceptLanguageHeader("de")).toBe("de-DE,de;q=0.9,en;q=0.5");
    expect(acceptLanguageHeader("fr", "ca")).toBe("fr-CA,fr;q=0.9,en;q=0.5");
  });
  it("does not duplicate English for an English search", () => {
    expect(acceptLanguageHeader("en")).toBe("en-US,en;q=0.9");
  });
});
