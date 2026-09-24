import { inflateRawSync, inflateSync } from "node:zlib";

// Best-effort, dependency-free PDF text extraction — the ladder's LAST rung.
//
// Finds content streams, decodes them (FlateDecode through node:zlib, plus the
// ASCII85/ASCIIHex wrappers reportlab puts around it) and pulls text from the
// showing operators (Tj / TJ / ' / "). It has no font tables, so Type0/CID
// pages and ligature glyphs come out wrong. That is acceptable ONLY because
// every result goes through assessPdfText: this rung is allowed to fail, not
// to lie. Deliberately not a real PDF parser — pdf-inspector and pdftotext do
// this properly and are tried first.
//
// It is, though, the rung every offline or NO_NPX run actually gets, and it
// runs synchronously on the caller's thread, where no rung timeout applies. So
// whatever the bytes are, it must finish in time linear in their length and
// memory bounded by the budgets below — a hostile PDF may get "" out of it,
// never a frozen process.
//
// Never throws: returns whatever it could read, possibly "".

// Inflation budgets. A FlateDecode stream inflates about 1000:1, so a 16 MB
// download can otherwise demand gigabytes, synchronously. No real content
// stream comes near the per-stream cap; the total is what stops a file made
// of many bombs from spending it again and again.
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

// How far before `stream` to look for its dictionary. Bounded so a file of
// tiny streams costs a constant per stream, never a rescan of the file.
const DICT_WINDOW = 4096;

// WinAnsiEncoding's 0x80–0x9F: Windows-1252's typographic characters, with the
// five codes cp1252 leaves undefined drawn as a bullet, as the PDF spec's
// Annex D does. Simple fonts almost always use it (reportlab, Word's TrueType
// Latin text), and decoded as latin1 those bytes are C1 CONTROLS — which the
// quality gate rightly reads as binary, rejecting a page of prose for its curly
// quotes.
const WIN_ANSI_C1 = [
  0x20ac, 0x2022, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x2022, 0x017d, 0x2022, 0x2022, 0x2018, 0x2019,
  0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x2022, 0x017e, 0x0178,
];
const winAnsi = (c: string): string => {
  const code = c.charCodeAt(0);
  return code === 0x7f ? "•" : String.fromCharCode(WIN_ANSI_C1[code - 0x80]!);
};

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };

// A PDF literal string "( … )", resolved in ONE pass: two passes (escapes, then
// octal) turned an escaped backslash followed by digits into a character. A
// backslash before an end of line is a line continuation and vanishes; before
// any other character, only the backslash goes.
function decodePdfString(tok: string): string {
  return tok.slice(1, -1).replace(/\\(?:([nrtbf()\\])|([0-7]{1,3})|(\r\n|\r|\n)|([\s\S]))/g, (_m, esc, oct, _eol, other) => {
    if (esc) return ESCAPES[esc]!;
    if (oct) return String.fromCharCode(parseInt(oct, 8) & 0xff);
    return other ?? "";
  });
}

// A hex string "<48656C6C6F>". Used heavily by CID fonts; the previous reader
// ignored these entirely, so such pages came back silently empty.
function decodeHexString(tok: string): string {
  const hex = tok.slice(1, -1).replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  if (hex.length % 2) out += String.fromCharCode(parseInt(hex[hex.length - 1]! + "0", 16));
  return out;
}

function decodeString(tok: string): string {
  const bytes = tok[0] === "<" ? decodeHexString(tok) : decodePdfString(tok);
  return bytes.replace(/[\x7f-\x9f]/g, winAnsi);
}

// A TJ array's elements: strings, and numbers — kerning adjustments, where a
// large negative one is a word break.
type ArrayItem = string | number;

function decodeTJArray(items: ArrayItem[]): string {
  let out = "";
  for (const item of items) {
    if (typeof item === "string") out += decodeString(item);
    else if (item <= -100) out += " ";
  }
  return out;
}

const isWhite = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
// ( ) < > [ ] { } / %
const isDelimiter = (c: number) =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
const isHexDigit = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const isNumberChar = (c: number) => (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2b || c === 0x2e;

// A hand-written tokenizer rather than a regex, because the regex it replaces
// was exponential: its array alternative let a string match either as a string
// or char by char, so an unclosed `[` followed by n strings backtracked 2^n
// ways (27 strings, 28 s). A scan that never closes costs one pass, and then a
// flag makes sure the same scan is never paid twice — which is what keeps a
// file of 50 000 unclosed `[` linear rather than quadratic.
class Lexer {
  // Cleared by the first literal string whose parentheses never balance: from
  // then on strings are read flat, which is what every string was before
  // nesting was supported, and costs no more than the next parenthesis.
  private nested = true;
  // Cleared by the first array that runs to the end of the stream. Every later
  // `[` is scanned through the same segmentation and reaches the same end, so
  // scanning them would re-pay the whole stream each time.
  private arrays = true;

  constructor(private readonly s: string) {}

  /** End (exclusive) of the literal string opening at `i`, or -1. */
  stringEnd(i: number): number {
    const s = this.s;
    if (this.nested) {
      // Balanced inner parentheses are legal unescaped: "(f(x) returns)".
      let depth = 0;
      for (let j = i; j < s.length; j++) {
        const c = s.charCodeAt(j);
        if (c === 0x5c) j++;
        else if (c === 0x28) depth++;
        else if (c === 0x29 && --depth === 0) return j + 1;
      }
      this.nested = false;
    }
    for (let j = i + 1; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (c === 0x5c) j++;
      else if (c === 0x29) return j + 1;
      else if (c === 0x28) return -1;
    }
    return -1;
  }

  /** End (exclusive) of the hex string opening at `i`, or -1. */
  hexEnd(i: number): number {
    const s = this.s;
    for (let j = i + 1; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (c === 0x3e) return j + 1;
      if (!isHexDigit(c) && !isWhite(c)) return -1;
    }
    return -1;
  }

  /**
   * The array opening at `i`: its strings and numbers, and where it ends.
   *
   * A `]` inside one of its strings does not close it. That detail is
   * load-bearing: `[(] and gated recurrent [)-250(7)]` truncated at the inner
   * `]` silently dropped the rest of the array — on a real paper, whole clauses
   * from the middle of sentences, leaving fluent, citable prose.
   */
  array(i: number): { end: number; items: ArrayItem[] } | undefined {
    if (!this.arrays) return undefined;
    const s = this.s;
    const items: ArrayItem[] = [];
    for (let j = i + 1; j < s.length; ) {
      const c = s.charCodeAt(j);
      if (c === 0x5d) return { end: j + 1, items };
      const end = c === 0x28 ? this.stringEnd(j) : c === 0x3c ? this.hexEnd(j) : -1;
      if (end > 0) {
        items.push(s.slice(j, end));
        j = end;
      } else if (isNumberChar(c)) {
        let e = j + 1;
        while (e < s.length && isNumberChar(s.charCodeAt(e))) e++;
        items.push(Number(s.slice(j, e)));
        j = e;
      } else j++;
    }
    this.arrays = false;
    return undefined;
  }
}

// Where inline image data (`BI … ID <bytes> EI`) ends: at an `EI` standing
// alone. Its bytes are arbitrary, so tokenizing them would mine an image.
function inlineImageEnd(s: string, from: number): number {
  for (let k = s.indexOf("EI", from); k >= 0; k = s.indexOf("EI", k + 1)) {
    const after = k + 2 >= s.length || isWhite(s.charCodeAt(k + 2)) || isDelimiter(s.charCodeAt(k + 2));
    if (isWhite(s.charCodeAt(k - 1)) && after) return k + 2;
  }
  return s.length;
}

// Pull visible text out of one decoded content stream.
function extractTextOps(s: string): string {
  const lexer = new Lexer(s);
  let out = "";
  // Operands accumulate until an operator consumes them. The previous reader
  // kept a single "last string" and a single "last array" slot instead, so an
  // operator preceded by several operands saw only the most recent one.
  let operands: (string | ArrayItem[])[] = [];
  const take = (): string => {
    const last = operands[operands.length - 1];
    if (last === undefined) return "";
    return typeof last === "string" ? decodeString(last) : decodeTJArray(last);
  };

  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 0x28 || (c === 0x3c && s.charCodeAt(i + 1) !== 0x3c)) {
      const end = c === 0x28 ? lexer.stringEnd(i) : lexer.hexEnd(i);
      if (end > 0) {
        operands.push(s.slice(i, end));
        i = end;
      } else i++;
      continue;
    }
    if (c === 0x5b) {
      const arr = lexer.array(i);
      if (arr) {
        operands.push(arr.items);
        i = arr.end;
      } else i++;
      continue;
    }
    if (c === 0x25) {
      // A comment runs to the end of the line.
      while (i < s.length && s.charCodeAt(i) !== 0x0a && s.charCodeAt(i) !== 0x0d) i++;
      continue;
    }
    if (isWhite(c) || isDelimiter(c)) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < s.length && !isWhite(s.charCodeAt(end)) && !isDelimiter(s.charCodeAt(end))) end++;
    const word = s.slice(i, end);
    i = end;
    if (word === "Tj" || word === "TJ") out += take() + " ";
    else if (word === "'" || word === '"') out += "\n" + take() + " ";
    else if (word === "T*") out += "\n";
    else if (word === "ID") i = inlineImageEnd(s, i);
    else if (word !== "Td" && word !== "TD") continue; // names, numbers, other operators
    operands = [];
  }
  return out;
}

function ascii85Decode(text: string): Buffer | undefined {
  const out: number[] = [];
  let group = 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x7e) break; // "~>" ends the data
    if (isWhite(c)) continue;
    if (c === 0x7a && count === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) return undefined;
    group = group * 85 + (c - 0x21);
    if (++count === 5) {
      out.push((group >>> 24) & 0xff, (group >>> 16) & 0xff, (group >>> 8) & 0xff, group & 0xff);
      group = 0;
      count = 0;
    }
  }
  if (count === 1) return undefined;
  if (count > 1) {
    // A partial final group is padded with the highest digit and truncated.
    for (let k = count; k < 5; k++) group = group * 85 + 84;
    const bytes = [(group >>> 24) & 0xff, (group >>> 16) & 0xff, (group >>> 8) & 0xff, group & 0xff];
    out.push(...bytes.slice(0, count - 1));
  }
  return Buffer.from(out);
}

function asciiHexDecode(text: string): Buffer {
  const end = text.indexOf(">");
  const hex = (end < 0 ? text : text.slice(0, end)).replace(/[^0-9A-Fa-f]/g, "");
  return Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex");
}

/** Inflation within `cap`: the bytes, TOO_BIG when the cap was hit, or undefined when it is not deflate at all. */
const TOO_BIG = Symbol("too big");
function inflateCapped(data: Buffer, cap: number): Buffer | typeof TOO_BIG | undefined {
  for (const inflate of [inflateSync, inflateRawSync]) {
    try {
      return inflate(data, { maxOutputLength: cap });
    } catch (e) {
      // Anything but a spent cap is "not this framing": try the next one.
      if ((e as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") return TOO_BIG;
    }
  }
  return undefined;
}

// The filters named in a stream dictionary, in the order they apply, or
// undefined when it names none.
function filtersOf(dict: string): string[] | undefined {
  const m = /\/Filter\s*(\[[^\]]*\]|\/[^\s/<>[\]()]+)/.exec(dict);
  return m ? (m[1]!.match(/\/[^\s/<>[\]()]+/g) ?? []).map((f) => f.slice(1)) : undefined;
}

// Streams that are never text: images and embedded font programs. Skipped
// before they are inflated, which is where most of a real PDF's bytes are.
const NOT_TEXT_RE = /\/Subtype\s*\/Image\b|\/Length[123]\b/;

// Find each `stream … endstream` body, decode it, and hand it over one at a
// time — so a stream that cannot be decoded costs nothing but itself, and
// nothing is held beyond the stream being mined.
function* contentStreams(buf: Buffer): Generator<string> {
  const s = buf.toString("latin1"); // 1 char per byte → indices == byte offsets
  // Not preceded by `end`: `stream\n` also matches the tail of `endstream\n`,
  // and each such false start used to mine the gap to the next stream — every
  // page after the first came out twice.
  const re = /(?<!end)stream\r?\n/g;
  let budget = MAX_TOTAL_BYTES;
  let previousEnd = 0;
  let m: RegExpExecArray | null;
  while (budget > 0 && (m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    // No later stream can have an `endstream` either; searching again for each
    // one would make a file of unterminated streams quadratic.
    if (end < 0) return;
    re.lastIndex = end + "endstream".length;

    // Its dictionary lies between the previous stream and this one; bounded, so
    // the windows never overlap and the whole walk stays linear.
    const window = s.slice(Math.max(previousEnd, m.index - DICT_WINDOW), m.index);
    previousEnd = re.lastIndex;
    const dict = window.slice(window.lastIndexOf("obj") + 1);
    if (NOT_TEXT_RE.test(dict)) continue;

    // Strip the single EOL the spec puts before `endstream`.
    let stop = end;
    if (s[stop - 1] === "\n") stop--;
    if (s[stop - 1] === "\r") stop--;
    let data: Buffer | undefined = buf.subarray(start, stop);

    const filters = filtersOf(dict);
    if (filters) {
      for (const f of filters) {
        if (!data) break;
        if (f === "ASCII85Decode" || f === "A85") data = ascii85Decode(data.toString("latin1"));
        else if (f === "ASCIIHexDecode" || f === "AHx") data = asciiHexDecode(data.toString("latin1"));
        else if (f === "FlateDecode" || f === "Fl") {
          const cap = Math.min(MAX_STREAM_BYTES, budget);
          const inflated = inflateCapped(data, cap);
          if (inflated === TOO_BIG) budget -= cap; // the work was done; it counts
          data = inflated instanceof Buffer ? inflated : undefined;
        } else data = undefined; // an image codec, LZW, a crypt filter: not text we can read
      }
    } else {
      // No dictionary to go on (a hand-built or damaged file): guess, as the
      // reader always has — zlib, then raw deflate, else uncompressed.
      if (/~>\s*$/.test(s.slice(Math.max(start, stop - 8), stop))) data = ascii85Decode(data.toString("latin1")) ?? data;
      const cap = Math.min(MAX_STREAM_BYTES, budget);
      const inflated = inflateCapped(data, cap);
      if (inflated === TOO_BIG) {
        budget -= cap;
        data = undefined;
      } else if (inflated) data = inflated;
    }
    if (!data) continue;
    budget -= data.length;
    yield data.toString("latin1");
  }
}

export function pdfToText(buf: Buffer): string {
  let out = "";
  try {
    for (const stream of contentStreams(buf)) {
      // Only mine streams that actually contain text operators (skip fonts,
      // images, XObjects that happen to inflate).
      if (/\b(Tj|TJ)\b/.test(stream) || /\)\s*'/.test(stream)) out += extractTextOps(stream) + "\n";
    }
  } catch {
    /* best-effort: return whatever accumulated */
  }
  return out
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
