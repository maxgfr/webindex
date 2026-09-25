import { readFileSync } from "node:fs";
import { join } from "node:path";
import { constants as zlibConstants, deflateRawSync, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { assessPdfText, pdfToText } from "../src/pdf.js";

// Assemble a one-stream PDF buffer around a raw (uncompressed) content stream.
function pdf(streamBody: Buffer | string): Buffer {
  const body = typeof streamBody === "string" ? Buffer.from(streamBody, "latin1") : streamBody;
  return Buffer.concat([Buffer.from("%PDF-1.4\nstream\n", "latin1"), body, Buffer.from("\nendstream\n%%EOF", "latin1")]);
}

describe("pdfToText", () => {
  it("extracts Tj strings, TJ kerning arrays (as spaces), and ' / T* line breaks", () => {
    const content = "BT\n(Hello) Tj\n[(Wor) -300 (ld)] TJ\nT*\n(second line) '\nET";
    const text = pdfToText(pdf(content));
    expect(text).toContain("Hello");
    expect(text).toContain("Wor ld"); // -300 kerning → a word-break space
    expect(text).toContain("second line");
  });

  it("inflates a FlateDecode content stream (zlib) transparently", () => {
    const raw = "BT (Compressed body text) Tj ET";
    const text = pdfToText(pdf(deflateSync(Buffer.from(raw, "latin1"))));
    expect(text).toContain("Compressed body text");
  });

  it("skips streams with no text operators and returns '' (not a throw)", () => {
    // a stream that inflates/reads but carries only font/xobject noise
    expect(pdfToText(pdf("/Font /Helvetica /Type1 no ops here"))).toBe("");
  });

  it("returns '' for a buffer that is not a PDF at all, never throwing", () => {
    expect(pdfToText(Buffer.from("this is just some bytes, not a pdf", "latin1"))).toBe("");
    expect(pdfToText(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]))).toBe("");
  });

  it("decodes octal escapes and escaped parens inside a literal string", () => {
    const text = pdfToText(pdf("BT (A\\050paren\\051 and \\101) Tj ET")); // \050=( \051=) \101=A
    expect(text).toContain("A(paren) and A");
  });

  // Regression: on arXiv 1706.03762 the reader used to emit "long short-term
  // memory [ 13 7 in particular", silently deleting "] and gated recurrent ["
  // and "] neural networks". Cause: the TJ-array token pattern excluded "]",
  // so an array was truncated at the first "]" INSIDE one of its strings and
  // everything after it in that array was dropped. The damage is invisible —
  // what survives is fluent, citable prose with clauses missing.
  it("keeps a TJ array whose strings contain a literal ] character", () => {
    const content = "BT [(memory [) -250 (13) -250 (] and gated recurrent [) -250 (7) -250 (] neural networks)] TJ ET";
    const text = pdfToText(pdf(content));
    expect(text).toContain("and gated recurrent");
    expect(text).toContain("neural networks");
  });

  // An operator is preceded by exactly one operand in well-formed PDFs, but
  // real-world streams interleave others. The reader used to keep a single
  // "last string" slot, so anything but the most recent operand was lost.
  it("resolves the showing operator's operand when other operands precede it", () => {
    expect(pdfToText(pdf("BT /F1 12 Tf 1 0 0 1 72 720 Tm (Positioned text) Tj ET"))).toContain("Positioned text");
  });

  it("decodes hex strings, which CID-font pages use throughout", () => {
    // <48656C6C6F> = "Hello"; hex strings used to be ignored entirely.
    expect(pdfToText(pdf("BT <48656C6C6F> Tj ET"))).toContain("Hello");
    expect(pdfToText(pdf("BT [<576F72> -300 <6C64>] TJ ET"))).toContain("Wor ld");
  });
});

// A PDF with one object per content stream, each carrying its own dictionary —
// the shape real writers produce, which the one-stream helper above never had.
function objects(...streams: { dict?: string; body: Buffer | string }[]): Buffer {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  streams.forEach((s, i) => {
    const body = typeof s.body === "string" ? Buffer.from(s.body, "latin1") : s.body;
    parts.push(
      Buffer.from(`${i + 1} 0 obj\n<< ${s.dict ?? ""}/Length ${body.length} >>\nstream\n`, "latin1"),
      body,
      Buffer.from("\nendstream\nendobj\n", "latin1"),
    );
  });
  parts.push(Buffer.from("%%EOF\n", "latin1"));
  return Buffer.concat(parts);
}

// ASCII85 as reportlab writes it: 4-byte groups, `z` for zeros, `~>` to close.
function ascii85(bytes: Buffer): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 4) {
    const n = Math.min(4, bytes.length - i);
    const word = Buffer.alloc(4);
    bytes.copy(word, 0, i, i + n);
    let v = word.readUInt32BE(0);
    if (v === 0 && n === 4) {
      out += "z";
      continue;
    }
    const digits: string[] = [];
    for (let d = 0; d < 5; d++) {
      digits.unshift(String.fromCharCode(33 + (v % 85)));
      v = Math.floor(v / 85);
    }
    out += digits.slice(0, n + 1).join("");
  }
  return `${out}~>`;
}

// A FlateDecode stream that inflates to `mb` MiB of zeros from ~1 KB per MiB.
// Built from one sync-flushed segment repeated, so the test pays microseconds
// for what the reader would pay seconds and gigabytes to decode in full.
function zeroBomb(mb: number): Buffer {
  const seg = deflateRawSync(Buffer.alloc(1 << 20), { level: 9, finishFlush: zlibConstants.Z_SYNC_FLUSH });
  const adler = Buffer.alloc(4);
  adler.writeUInt32BE(((((mb * (1 << 20)) % 65521) << 16) | 1) >>> 0);
  return Buffer.concat([Buffer.from([0x78, 0xda]), ...Array<Buffer>(mb).fill(seg), Buffer.from([0x03, 0x00]), adler]);
}

const timed = <T>(f: () => T): { value: T; ms: number } => {
  const t0 = performance.now();
  const value = f();
  return { value, ms: performance.now() - t0 };
};

describe("pdfToText on hostile input", () => {
  // An unclosed array followed by strings used to cost 2^n backtracking steps
  // in the token regex (27 strings: 28 s, synchronously, with no rung timeout
  // able to interrupt it). The bounds here are generous; the tokenizer takes
  // milliseconds on all of them.
  it("stays linear on an array that never closes", () => {
    const { value, ms } = timed(() => pdfToText(pdf(`BT [${"(a)".repeat(40)} TJ ET\nBT (after the array) Tj ET`)));
    expect(ms).toBeLessThan(1000);
    expect(value).toContain("after the array");
  });

  it("stays linear on a run of opening brackets, parens or angle brackets", () => {
    expect(timed(() => pdfToText(pdf(`BT ${"[".repeat(50_000)} (x) Tj ET`))).ms).toBeLessThan(1000);
    expect(timed(() => pdfToText(pdf(`BT ${"(".repeat(50_000)} Tj ET`))).ms).toBeLessThan(1000);
    expect(timed(() => pdfToText(pdf(`BT ${"<0".repeat(50_000)} Tj ET`))).ms).toBeLessThan(1000);
  });

  it("stays linear on many `stream` keywords that never end", () => {
    const body = Buffer.from(`%PDF-1.4\n${"stream\n".repeat(200_000)}`, "latin1");
    expect(timed(() => pdfToText(body)).ms).toBeLessThan(1000);
  });

  // A 600 KB PDF whose second stream inflates to 600 MB used to take 6 s and
  // 1.9 GB, then overflow V8's string limit — and the outer catch threw away
  // the sentence the FIRST stream had already yielded.
  it("refuses a decompression bomb without losing the real text beside it", () => {
    const doc = objects(
      { dict: "/Filter /FlateDecode ", body: deflateSync(Buffer.from("BT (This paper studies attention mechanisms.) Tj ET", "latin1")) },
      { dict: "/Filter /FlateDecode ", body: zeroBomb(600) },
    );
    const { value, ms } = timed(() => pdfToText(doc));
    expect(value).toBe("This paper studies attention mechanisms.");
    expect(ms).toBeLessThan(3000);
  });

  it("caps the total inflated across many bombs", () => {
    const doc = objects(
      { dict: "/Filter /FlateDecode ", body: deflateSync(Buffer.from("BT (Opening sentence survives.) Tj ET", "latin1")) },
      ...Array.from({ length: 12 }, () => ({ dict: "/Filter /FlateDecode ", body: zeroBomb(500) })),
    );
    const { value, ms } = timed(() => pdfToText(doc));
    expect(value).toBe("Opening sentence survives.");
    expect(ms).toBeLessThan(5000);
  });

  it("does not mine image or font programs, whatever bytes they carry", () => {
    const doc = objects(
      { dict: "/Type /XObject /Subtype /Image /Width 8 /Height 8 ", body: "BT (pixels that look like text) Tj ET" },
      { dict: "/Length1 40 ", body: "BT (a font program that looks like text) Tj ET" },
      { body: "BT (The page itself.) Tj ET" },
    );
    expect(pdfToText(doc)).toBe("The page itself.");
  });

  it("skips a stream in a filter it cannot decode instead of mining its bytes", () => {
    const doc = objects({ dict: "/Filter /DCTDecode ", body: "BT (jpeg bytes) Tj ET" }, { body: "BT (Readable.) Tj ET" });
    expect(pdfToText(doc)).toBe("Readable.");
  });
});

describe("pdfToText on well-formed documents it used to misread", () => {
  // `stream\n` also matched the tail of every `endstream\n`, so each page after
  // the first was mined twice — and in a Flate PDF the false chunk was raw
  // compressed bytes, mined as control-character "text".
  it("reads each content stream exactly once", () => {
    const doc = objects(
      { body: "BT (Alpha) Tj ET" },
      { body: "BT (Bravo) Tj ET" },
      { dict: "/Filter /FlateDecode ", body: deflateSync(Buffer.from("BT (Charlie) Tj ET", "latin1")) },
      { dict: "/Filter /FlateDecode ", body: deflateSync(Buffer.from("BT (Delta) Tj ET", "latin1")) },
    );
    expect(pdfToText(doc).split("\n")).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
  });

  // reportlab's default: /Filter [/ASCII85Decode /FlateDecode]. Nothing else in
  // the ladder read these files in the audit, so the built-in rung reading them
  // is what keeps a reportlab invoice from being reported as a scan.
  it("decodes an ASCII85-wrapped Flate stream", () => {
    const body = ascii85(deflateSync(Buffer.from("BT (Wrapped in ASCII85.) Tj ET", "latin1")));
    expect(pdfToText(objects({ dict: "/Filter [/ASCII85Decode /FlateDecode] ", body }))).toBe("Wrapped in ASCII85.");
    expect(pdfToText(objects({ dict: "/Filter [/A85 /Fl] ", body }))).toBe("Wrapped in ASCII85.");
  });

  it("decodes an ASCIIHex-wrapped stream", () => {
    const body = `${Buffer.from("BT (Hex wrapped.) Tj ET", "latin1").toString("hex")}>`;
    expect(pdfToText(objects({ dict: "/Filter /ASCIIHexDecode ", body }))).toBe("Hex wrapped.");
  });

  it("reads a real reportlab PDF (ASCII85 + Flate, two pages)", () => {
    const text = pdfToText(readFileSync(join(__dirname, "fixtures", "docs", "reportlab-a85.pdf")));
    expect(text).toContain("Page 1 heading (with parens) and a café naïve résumé");
    expect(text.match(/Page 2 heading/g)).toHaveLength(1);
    expect(assessPdfText(text).ok).toBe(true);
  });

  // WinAnsiEncoding puts ’ “ ” – — … • at 0x80–0x9F, where latin1 has C1
  // controls. Decoded as latin1, a page of typographic prose was rejected
  // wholesale as binary; below the threshold the punctuation silently vanished.
  it("maps WinAnsiEncoding's typographic range instead of emitting C1 controls", () => {
    const line = "(It\\222s the \\223model\\224 \\226 a \\177 bullet\\205 we don\\222t \\223know\\224 \\227 yet) Tj T* ";
    const text = pdfToText(pdf(`BT ${line.repeat(12)}ET`));
    expect(text).toContain("It’s the “model” – a • bullet… we don’t “know” — yet");
    expect(assessPdfText(text).ok).toBe(true);
  });

  it("keeps balanced parentheses inside a literal string", () => {
    expect(pdfToText(pdf("BT (The function f(x) returns a value) Tj ET"))).toBe("The function f(x) returns a value");
  });

  it("joins a literal string continued across lines with a backslash", () => {
    expect(pdfToText(pdf("BT (split \\\nword) Tj ET"))).toBe("split word");
  });

  it("decodes an escaped backslash followed by digits as a backslash, not an octal code", () => {
    expect(pdfToText(pdf("BT (C:\\\\101 path) Tj ET"))).toBe("C:\\101 path");
  });

  it("ignores a comment that looks like a text operator", () => {
    expect(pdfToText(pdf("BT % (commented out) Tj\n(kept) Tj ET"))).toBe("kept");
  });

  it("skips inline image data, whatever bytes it holds", () => {
    expect(pdfToText(pdf("BT (before) Tj ET BI /W 4 /H 4 ID (x) Tj ) ( [ EI BT (after) Tj ET"))).toBe("before after");
  });
});
