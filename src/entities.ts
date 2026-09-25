// Character references: `&amp;`, `&#8212;`, `&#x2014;`.
//
// Internal — fetch.ts re-exports decodeEntities, which is the public name, and
// every reader of markup (htmlToText, titles, tables, metadata, feeds, the
// search-engine parsers) decodes through it, so they all agree on what a page
// said.

import { CP1252_C1 } from "./charset.js";

// HTML 4's 252 named references, with HTML5's code points for &lang;/&rang;,
// plus &apos; and the uppercase legacy spellings HTML5 still accepts. Name,
// then code point in hex. The full HTML5 list is 2,231 names, nearly all of
// them MathML that no page this engine reads spells out; these are the ones
// that turn up in prose — accented Latin, Greek, arrows, maths, typography.
const NAMED = `
  quot 22 amp 26 apos 27 lt 3c gt 3e QUOT 22 AMP 26 LT 3c GT 3e COPY a9 REG ae
  nbsp a0 iexcl a1 cent a2 pound a3 curren a4 yen a5 brvbar a6 sect a7 uml a8 copy a9 ordf aa laquo ab not ac shy ad reg ae macr af
  deg b0 plusmn b1 sup2 b2 sup3 b3 acute b4 micro b5 para b6 middot b7 cedil b8 sup1 b9 ordm ba raquo bb frac14 bc frac12 bd frac34 be iquest bf
  Agrave c0 Aacute c1 Acirc c2 Atilde c3 Auml c4 Aring c5 AElig c6 Ccedil c7 Egrave c8 Eacute c9 Ecirc ca Euml cb Igrave cc Iacute cd Icirc ce Iuml cf
  ETH d0 Ntilde d1 Ograve d2 Oacute d3 Ocirc d4 Otilde d5 Ouml d6 times d7 Oslash d8 Ugrave d9 Uacute da Ucirc db Uuml dc Yacute dd THORN de szlig df
  agrave e0 aacute e1 acirc e2 atilde e3 auml e4 aring e5 aelig e6 ccedil e7 egrave e8 eacute e9 ecirc ea euml eb igrave ec iacute ed icirc ee iuml ef
  eth f0 ntilde f1 ograve f2 oacute f3 ocirc f4 otilde f5 ouml f6 divide f7 oslash f8 ugrave f9 uacute fa ucirc fb uuml fc yacute fd thorn fe yuml ff
  OElig 152 oelig 153 Scaron 160 scaron 161 Yuml 178 fnof 192 circ 2c6 tilde 2dc
  Alpha 391 Beta 392 Gamma 393 Delta 394 Epsilon 395 Zeta 396 Eta 397 Theta 398 Iota 399 Kappa 39a Lambda 39b Mu 39c Nu 39d Xi 39e Omicron 39f
  Pi 3a0 Rho 3a1 Sigma 3a3 Tau 3a4 Upsilon 3a5 Phi 3a6 Chi 3a7 Psi 3a8 Omega 3a9
  alpha 3b1 beta 3b2 gamma 3b3 delta 3b4 epsilon 3b5 zeta 3b6 eta 3b7 theta 3b8 iota 3b9 kappa 3ba lambda 3bb mu 3bc nu 3bd xi 3be omicron 3bf
  pi 3c0 rho 3c1 sigmaf 3c2 sigma 3c3 tau 3c4 upsilon 3c5 phi 3c6 chi 3c7 psi 3c8 omega 3c9 thetasym 3d1 upsih 3d2 piv 3d6
  ensp 2002 emsp 2003 thinsp 2009 zwnj 200c zwj 200d lrm 200e rlm 200f ndash 2013 mdash 2014 lsquo 2018 rsquo 2019 sbquo 201a
  ldquo 201c rdquo 201d bdquo 201e dagger 2020 Dagger 2021 bull 2022 hellip 2026 permil 2030 prime 2032 Prime 2033 lsaquo 2039 rsaquo 203a
  oline 203e frasl 2044 euro 20ac image 2111 weierp 2118 real 211c trade 2122 alefsym 2135
  larr 2190 uarr 2191 rarr 2192 darr 2193 harr 2194 crarr 21b5 lArr 21d0 uArr 21d1 rArr 21d2 dArr 21d3 hArr 21d4
  forall 2200 part 2202 exist 2203 empty 2205 nabla 2207 isin 2208 notin 2209 ni 220b prod 220f sum 2211 minus 2212 lowast 2217 radic 221a
  prop 221d infin 221e ang 2220 and 2227 or 2228 cap 2229 cup 222a int 222b there4 2234 sim 223c cong 2245 asymp 2248 ne 2260 equiv 2261
  le 2264 ge 2265 sub 2282 sup 2283 nsub 2284 sube 2286 supe 2287 oplus 2295 otimes 2297 perp 22a5 sdot 22c5
  lceil 2308 rceil 2309 lfloor 230a rfloor 230b lang 27e8 rang 27e9 loz 25ca spades 2660 clubs 2663 hearts 2665 diams 2666
`;

// Characters a reference names but a reader never sees, dropped rather than
// decoded: a soft hyphen is only a hyphenation hint, and German pages set
// them inside long compounds, so "Datenschutz&shy;konferenz" decoded to the
// hint character is a word no search for "Datenschutzkonferenz" finds. The
// joiners and direction marks split words the same way.
const INVISIBLE = new Set([0xad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff]);

const charFor = (cp: number): string => (INVISIBLE.has(cp) ? "" : String.fromCodePoint(cp));

const ENTITY_BY_NAME = new Map<string, string>();
{
  const parts = NAMED.trim().split(/\s+/);
  for (let i = 0; i < parts.length; i += 2) ENTITY_BY_NAME.set(parts[i]!, charFor(Number.parseInt(parts[i + 1]!, 16)));
  // A non-breaking space reads as a space: text is compared, split and
  // collapsed downstream, and U+00A0 would have every one of those treat
  // "10&nbsp;km" as one token.
  ENTITY_BY_NAME.set("nbsp", " ");
}

const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * The character a numeric reference stands for, by the HTML spec's rules
 * rather than String.fromCodePoint's.
 *
 * 128–159 are read as Windows-1252, because that is what every page writing
 * `&#146;` meant: Word exports and older CMSes spell their curly quotes,
 * dashes and euro signs this way, and taken literally they are invisible C1
 * controls — "don't" loses its apostrophe. NUL, a lone surrogate and anything
 * past U+10FFFF are U+FFFD, the replacement a browser shows; the last two used
 * to throw out of the whole decode.
 */
function numericChar(n: number): string {
  if (n >= 0x80 && n <= 0x9f) return String.fromCodePoint(CP1252_C1[n - 0x80]!);
  if (n === 0 || !(n <= 0x10ffff) || (n >= 0xd800 && n <= 0xdfff)) return "�";
  return charFor(n);
}

/**
 * Decode named and decimal/hex numeric character references, in ONE
 * non-rescanning pass.
 *
 * The pass count is the whole design. Decoding numeric refs and then walking the
 * named table with split/join re-reads its own output, so `&amp;lt;` — which is
 * how a document writes the literal text "&lt;" — becomes "&lt;" and then "<".
 * The page said one thing and the extract says another, which for a page
 * documenting markup is most of its content. One pass cannot do that: each
 * reference is replaced exactly once, from the original text.
 *
 * Names are matched case-SENSITIVELY, because case is meaningful here: `&dagger;`
 * is † and `&Dagger;` is ‡. An unknown name is left exactly as written rather
 * than guessed at or blanked.
 */
export function decodeEntities(s: string): string {
  return s.replace(ENTITY_RE, (m, ref: string) => {
    if (ref[0] !== "#") return ENTITY_BY_NAME.get(ref) ?? m;
    return numericChar(ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1)));
  });
}
