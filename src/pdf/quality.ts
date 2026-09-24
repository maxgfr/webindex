// Is this extracted text fit to be cited?
//
// This is the rung test for both extractor ladders (see ./ladder.ts and
// ../doc/ladder.ts) AND the last gate before a converted document's text enters
// a dossier. It exists because the built-in PDF text-layer reader can hand back
// output that LOOKS like prose but isn't: a stream of image/font bytes that
// happened to inflate and contain `Tj`, or a CID-font page decoded through the
// wrong code map. Such text is long, non-empty and plausible, so nothing
// downstream catches it — `looksLikeJunkExtraction` only inspects the first 800
// chars of texts SHORTER than 2000 and only looks for consent/anti-bot walls.
//
// The same checks guard office documents, where the failure is cruder and used
// to be worse: a .docx is a ZIP, and decoding one as UTF-8 yields kilobytes of
// U+FFFD that sailed into dossiers as evidence until the document ladder began
// routing them here.
//
// A false positive costs one rung (we fall through to the next extractor, or
// keep the search snippet). A false negative puts fabricated evidence under a
// citation. So the checks below key on signals that essentially never occur in
// real prose, rather than on anything stylistic.

export interface PdfVerdict {
  ok: boolean;
  /** Short, human-readable cause when `ok` is false. */
  reason?: string;
}

// The two weaker heuristics below need enough text to mean anything; under this
// length only the control/replacement ratios apply. Note there is deliberately
// no minimum LENGTH for acceptance: this gate judges garbage, not brevity. A
// short-but-clean extraction is the caller's problem (it degrades to a snippet
// like any other thin source), not something to relabel as unreadable.
const MIN_CHARS_FOR_SHAPE_CHECKS = 200;

// Calibrated on a real corpus (arXiv 1706.03762 and 2404.19756, each through
// every rung). Clean extractors land at 0 – 4.0e-4; the built-in reader's
// garbage lands at 4.5e-2 – 1.7e-1. 5e-3 sits an order of magnitude clear of
// both sides.
const CONTROL_RATIO_MAX = 0.005;
const REPLACEMENT_RATIO_MAX = 0.005;

// Mojibake also shows up as absurdly long unbroken runs (no spaces survive the
// mis-decoding) and as a collapsed share of letters.
const LONGEST_RUN_MAX = 300;
const LETTER_RATIO_MIN = 0.5;

// C0 controls and C1 controls are the strongest tell: real text, in any
// language and any encoding, does not contain them, while binary read as latin1
// is full of them. Tab, LF and CR are text; so are VT and FF, which are
// whitespace as much as a newline is — and pdftotext ends every page with a
// form feed, so a deck of short slides crossed the ratio on page breaks alone.
// Tested by code point rather than as a literal character class so this file
// stays free of raw control bytes (which would make git and grep treat it as
// binary — see tests/source-hygiene.test.ts).
function isControlCode(c: number): boolean {
  if (c >= 0x09 && c <= 0x0d) return false;
  return c < 0x20 || (c >= 0x7f && c <= 0x9f);
}

const REPLACEMENT_CODE = 0xfffd; // U+FFFD: a decoder already gave up on these bytes.

// `\s` as JavaScript means it, so a run ends exactly where `split(/\s+/)` would
// have cut it. ASCII is answered without a regex; the rest is rare.
const SPACE_RE = /\s/;
const isSpace = (c: number): boolean => (c < 0x80 ? c === 0x20 || (c >= 0x09 && c <= 0x0d) : SPACE_RE.test(String.fromCharCode(c)));
const LETTER_RE = /[\p{L}\p{N}]/u;

// Fill-in rules and leaders — `____`, `----`, `....`, `====` — are long runs with
// no letters in them, the shape of garbled glyphs, and they are not garbage: a
// form with a 320-character signature line was refused as unreadable.
const isRuleChar = (c: number): boolean => c === 0x5f || c === 0x2d || c === 0x2e || c === 0x3d;

interface Shape {
  control: number;
  replacement: number;
  /** The longest whitespace-delimited run, in UTF-16 units, rules excepted. */
  longestRun: number;
  /** Letters and digits, per code point, over the non-space UTF-16 units. */
  letterRatio: number;
}

// One pass for everything the gate weighs. It used to be four — a ratio loop,
// `split(/\s+/)`, a `match` building one array element per letter and a
// `replace` — which cost over a second on 13 MB of prose, per rung attempt.
function scanShape(t: string): Shape {
  let control = 0;
  let replacement = 0;
  let letters = 0;
  let nonSpace = 0;
  let run = 0;
  let runIsRule = true;
  let longestRun = 0;
  const endRun = () => {
    if (!runIsRule && run > longestRun) longestRun = run;
    run = 0;
    runIsRule = true;
  };
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (isSpace(c)) {
      endRun();
      continue;
    }
    if (c === REPLACEMENT_CODE) replacement++;
    else if (isControlCode(c)) control++;
    if (!isRuleChar(c)) runIsRule = false;
    if (c < 0x80) {
      if ((c >= 0x30 && c <= 0x39) || ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a)) letters++;
      nonSpace++;
      run++;
      continue;
    }
    // Astral letters (mathematical alphanumerics, rare CJK) are one letter in
    // two UTF-16 units.
    const cp = t.codePointAt(i)!;
    const units = cp > 0xffff ? 2 : 1;
    if (LETTER_RE.test(String.fromCodePoint(cp))) letters++;
    nonSpace += units;
    run += units;
    i += units - 1;
  }
  endRun();
  return { control: control / t.length, replacement: replacement / t.length, longestRun, letterRatio: nonSpace ? letters / nonSpace : 0 };
}

/** What an empty PDF extraction means — most often, a scan. The ladder sharpens it when it knows better. */
export const NO_TEXT_LAYER = "no text layer (scanned or image-only PDF?)";

/**
 * Judge extracted PDF text. Returns `{ ok: true }` when the text is safe to
 * cite, else a short reason the caller can put in a dossier note.
 */
export function assessPdfText(text: string): PdfVerdict {
  return assessExtractedText(text, NO_TEXT_LAYER);
}

/**
 * Judge extracted text. Returns `{ ok: true }` when the text is safe to cite,
 * else a short reason the caller can put in a dossier note. `emptyReason` names
 * what an empty extraction means for the format at hand — a PDF with no text
 * layer was probably scanned, an empty .docx conversion means something else.
 *
 * Deliberately independent of length: the failure this guards against produces
 * HUNDREDS of kilobytes, which is exactly what a length-gated check misses.
 */
export function assessExtractedText(text: string, emptyReason: string): PdfVerdict {
  const t = text.trim();
  if (!t) return { ok: false, reason: emptyReason };

  const shape = scanShape(t);
  if (shape.control > CONTROL_RATIO_MAX) {
    return { ok: false, reason: "binary/control characters in the text (undecodable PDF stream)" };
  }
  if (shape.replacement > REPLACEMENT_RATIO_MAX) {
    return { ok: false, reason: "replacement characters throughout (wrong character map)" };
  }

  // Two weaker signals, both required: a page of dense tabular data can trip
  // either one on its own.
  if (t.length < MIN_CHARS_FOR_SHAPE_CHECKS) return { ok: true };
  if (shape.longestRun > LONGEST_RUN_MAX && shape.letterRatio < LETTER_RATIO_MIN) {
    return { ok: false, reason: "unreadable text layer (garbled glyph encoding)" };
  }

  return { ok: true };
}
