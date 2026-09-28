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

describe("a full language tag is parsed, not split in two", () => {
  // The second subtag is not always the region: BCP-47 puts an optional
  // 4-letter SCRIPT there ("zh-Hant-TW", "sr-Latn-RS"), and a region can be
  // three digits ("es-419", Latin America). Read as a region, the script
  // produced kl=hant-zh and an Accept-Language of "zh-HANT", sent to every page.
  it("skips a script subtag to find the region", () => {
    expect(resolveRegion("zh-Hant-TW")).toBe("tw");
    expect(resolveRegion("sr-Latn-RS")).toBe("rs");
    expect(resolveRegion("es-419")).toBe("419");
    expect(acceptLanguageHeader("zh-Hant-TW")).toBe("zh-TW,zh;q=0.9,en;q=0.5");
    expect(acceptLanguageHeader("es-419")).toBe("es-419,es;q=0.9,en;q=0.5");
  });

  it("accepts the POSIX spelling", () => {
    expect(baseLang("fr_FR")).toBe("fr");
    expect(ddgRegion("fr_FR")).toBe("fr-fr");
    expect(acceptLanguageHeader("pt_BR.UTF-8")).toBe("pt-BR,pt;q=0.9,en;q=0.5");
  });

  it("knows the country of a language whose code is not one", () => {
    // Falling back to the language code sent Estonian to Ethiopia (ET), Catalan
    // to Canada (CA) and Slovenian to Sierra Leone (SL).
    expect(resolveRegion("et")).toBe("ee");
    expect(resolveRegion("vi")).toBe("vn");
    expect(resolveRegion("ms")).toBe("my");
    expect(resolveRegion("fa")).toBe("ir");
    expect(resolveRegion("ca")).toBe("es");
    expect(resolveRegion("sl")).toBe("si");
    expect(resolveRegion("sr")).toBe("rs");
    expect(resolveRegion("fil")).toBe("ph");
    expect(acceptLanguageHeader("et")).toBe("et-EE,et;q=0.9,en;q=0.5");
    // "xa" is DuckDuckGo's name for Arabia, not a country: it belongs in `kl`
    // alone, never in a header sent to every page.
    expect(resolveRegion("ar")).toBe("sa");
    expect(acceptLanguageHeader("ar")).toBe("ar-SA,ar;q=0.9,en;q=0.5");
  });
});

describe("ddgRegion speaks DuckDuckGo's own region list", () => {
  // Every value below is on the region list DuckDuckGo's own result pages
  // offer. An unrecognised `kl` is IGNORED, so a wrong one de-localises the run
  // silently.
  it.each([
    ["ko", "kr-kr"],
    ["ko-KR", "kr-kr"],
    ["zh-TW", "tw-tzh"],
    ["zh-HK", "hk-tzh"],
    ["zh-Hant-TW", "tw-tzh"],
    ["zh-Hant", "tw-tzh"],
    ["zh-Hans", "cn-zh"],
    ["es-419", "xl-es"],
    ["es-US", "ue-es"],
    ["ca", "ct-ca"],
    ["sl-SI", "sl-sl"],
    ["sl", "sl-sl"],
    ["ar-SA", "xa-ar"],
    ["ar-EG", "xa-ar"],
    ["et", "ee-et"],
    ["vi", "vn-vi"],
    ["ms", "my-ms"],
    ["fa", "ir-fa"],
    ["fil", "ph-tl"],
  ])("%s → %s", (tag, kl) => {
    expect(ddgRegion(tag)).toBe(kl);
  });

  it("gives --region wt the meaning the docs promise: no region at all", () => {
    expect(ddgRegion("en", "wt")).toBe("wt-wt");
    expect(ddgRegion("fr", "WT")).toBe("wt-wt");
    // …and no country in the header it pairs with.
    expect(acceptLanguageHeader("fr", "wt")).toBe("fr,en;q=0.5");
    expect(acceptLanguageHeader("en", "wt")).toBe("en");
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
