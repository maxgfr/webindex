// Locale helpers for language/region-aware web search. Pure and deterministic
// (no network, no clock) so they unit-test trivially. The agent picks the search
// LANGUAGE (it translates the queries); these derive the per-engine knobs that
// bias each backend toward that locale: DuckDuckGo's `kl` region code, and the
// `Accept-Language` header every fetch sends.
//
// We default to the language as the primary signal (the agent translated for a
// market), and only split out a separate country when the language alone is
// ambiguous (English) or the caller passes an explicit --region.

// Language → default country. For most locales the country mirrors the language
// (de→de, fr→fr); the entries below are the cases where it does NOT, plus the
// English default. Anything unlisted falls back to the language code itself —
// which is how Estonian (et) was sent to Ethiopia, Catalan (ca) to Canada and
// Slovenian (sl) to Sierra Leone before they were listed here.
const LANG_COUNTRY: Record<string, string> = {
  en: "us",
  pt: "br",
  ja: "jp",
  zh: "cn",
  ko: "kr",
  sv: "se",
  da: "dk",
  cs: "cz",
  el: "gr",
  nb: "no", // Bokmål → Norway
  nn: "no", // Nynorsk → Norway
  uk: "ua", // Ukrainian language → Ukraine
  ar: "sa",
  he: "il",
  hi: "in",
  et: "ee",
  vi: "vn",
  ms: "my",
  fa: "ir",
  ca: "es",
  sl: "si",
  sr: "rs",
  tl: "ph",
  fil: "ph",
  ga: "ie",
  cy: "gb",
  eu: "es",
  gl: "es",
  sq: "al",
  bs: "ba",
  be: "by",
  ka: "ge",
  hy: "am",
  kk: "kz",
  af: "za",
  sw: "ke",
  ur: "pk",
  bn: "bd",
  ta: "in",
  te: "in",
  mr: "in",
  ne: "np",
  si: "lk",
  km: "kh",
  lo: "la",
  lb: "lu",
};

// A script subtag that implies a country when no region follows it: Traditional
// Chinese is Taiwan's, Simplified the mainland's.
const SCRIPT_COUNTRY: Record<string, string> = {
  "zh-hant": "tw",
  "zh-hans": "cn",
};

// Region aliases for DuckDuckGo's `kl`, which spells a few regions its own way:
// the United Kingdom is `uk`, Latin America (UN M.49 `419`) is `xl`, Slovenia is
// `sl`. Applied to `kl` only.
const REGION_ALIASES: Record<string, string> = {
  gb: "uk",
  en: "us",
  "419": "xl",
  si: "sl",
};

// Language aliases for DuckDuckGo's `kl`, which is its OWN vocabulary and spells
// several languages differently from BCP-47. Checked against duckduckgo.com's
// published region list: Norway is `no-no`, Japan `jp-jp`, Korea `kr-kr` and
// the Philippines in Tagalog `ph-tl`, so a caller asking in `nb-NO` or `ja-JP`
// was producing `no-nb` and `jp-ja`.
//
// The damage is quiet, which is why it lasted: DuckDuckGo IGNORES a `kl` it does
// not recognise rather than rejecting it, so the run simply comes back
// unlocalised, with nothing anywhere saying so. This table only applies to `kl`
// — the Accept-Language header must keep the real tag.
const DDG_LANG_ALIASES: Record<string, string> = {
  nb: "no", // Bokmål
  nn: "no", // Nynorsk
  ja: "jp",
  ko: "kr",
  fil: "tl",
};

// Whole `kl` values no region-language rule produces. DuckDuckGo has ONE
// Arabic region (`xa-ar`) and one Catalan (`ct-ca`) whatever the country,
// spells Traditional Chinese `tzh`, and lists Spanish in the United States as
// `ue-es` — `us-es` is not on its list. Keyed by language, or by
// language-region when only that pair differs.
const DDG_KL: Record<string, string> = {
  ar: "xa-ar",
  ca: "ct-ca",
  "zh-tw": "tw-tzh",
  "zh-hk": "hk-tzh",
  "es-us": "ue-es",
};

// DuckDuckGo's "no region", and what `--region wt` means everywhere here.
const NO_REGION = "wt";

// A language tag's parts, read the way BCP-47 lays them out: the language, an
// optional 4-letter SCRIPT, then an optional region of 2 letters or 3 digits.
// Taking the second subtag for the region read "zh-Hant-TW" as region "hant".
// The POSIX spelling (`fr_FR`, `pt_BR.UTF-8`) is accepted too: it is what an
// agent copies out of `$LANG`.
function parseTag(tag: string | undefined): { lang: string; script?: string; region?: string } {
  const parts = (tag || "en")
    .trim()
    .replace(/[.@].*$/, "")
    .split(/[-_]/);
  const lang = (parts[0] || "en").toLowerCase();
  let i = 1;
  const script = /^[a-z]{4}$/i.test(parts[i] ?? "") ? parts[i++]!.toLowerCase() : undefined;
  const region = /^(?:[a-z]{2}|\d{3})$/i.test(parts[i] ?? "") ? parts[i]!.toLowerCase() : undefined;
  return { lang, script, region };
}

// Base language subtag, lowercased: "de-DE" → "de", "EN" → "en", "fr_FR" → "fr".
export function baseLang(lang: string | undefined): string {
  return parseTag(lang).lang;
}

// The country/region code to use, lowercased. Precedence: an explicit region,
// else a region subtag carried on the lang ("de-AT" → "at", "zh-Hant-TW" →
// "tw"), else the country its script implies, else the language's default
// country, else the language code itself.
export function resolveRegion(lang: string | undefined, region?: string): string {
  if (region?.trim()) return region.trim().toLowerCase();
  const t = parseTag(lang);
  if (t.region) return t.region;
  const byScript = t.script ? SCRIPT_COUNTRY[`${t.lang}-${t.script}`] : undefined;
  return byScript ?? LANG_COUNTRY[t.lang] ?? t.lang;
}

// DuckDuckGo's `kl` parameter: `{region}-{language}` (e.g. de-de, fr-fr, us-en,
// uk-en). For most non-English locales region == language; English splits by
// country. `wt-wt` is DDG's "no region", which a caller asks for with
// --region wt.
export function ddgRegion(lang: string | undefined, region?: string): string {
  const r = resolveRegion(lang, region);
  if (r === NO_REGION) return "wt-wt";
  const l = baseLang(lang);
  return DDG_KL[`${l}-${r}`] ?? DDG_KL[l] ?? `${REGION_ALIASES[r] ?? r}-${DDG_LANG_ALIASES[l] ?? l}`;
}

// An RFC-7231 Accept-Language header biased to the target language, with English
// as a low-priority fallback (so a page with no localized copy still returns
// something). e.g. "de-DE,de;q=0.9,en;q=0.5"; for English: "en-US,en;q=0.9".
// Under --region wt there is no country to name, so the language stands alone.
export function acceptLanguageHeader(lang: string | undefined, region?: string): string {
  const l = baseLang(lang);
  const r = resolveRegion(lang, region);
  if (r === NO_REGION) return l === "en" ? "en" : `${l},en;q=0.5`;
  const R = r.toUpperCase();
  if (l === "en") return `${l}-${R},${l};q=0.9`;
  return `${l}-${R},${l};q=0.9,en;q=0.5`;
}
