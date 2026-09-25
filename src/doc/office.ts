import { inflateRawSync } from "node:zlib";

// A built-in reader for the two ZIP-of-XML office families — OOXML (.docx,
// .xlsx, .pptx and their macro-enabled twins) and OpenDocument (.odt, .ods,
// .odp) — and the office ladder's last rung.
//
// Why one exists after all. The ladder used to have no built-in rung, on the
// reasoning that unzipping OOXML and walking its parts was "a different order
// of problem" from mining a PDF text layer, and a wrong answer worse than none.
// But with no network, under NO_NPX, or wherever anydoc cannot be installed,
// that meant EVERY office document was refused — anydoc offline took 70 s to
// fail. The problem turned out to be small: a central-directory ZIP reader,
// node:zlib's inflateRawSync, and a walk over a handful of known parts. Its
// output still goes through the same quality gate as every other rung, so it
// is allowed to fail, not to lie. Legacy binary formats (.doc, .xls, .ppt) and
// RTF stay with anydoc and Firecrawl.
//
// A ZIP is attacker-controlled input, so the reader is strict and bounded:
//   - at most MAX_ENTRIES entries, and nothing from ZIP64, encrypted entries or
//     compression methods other than stored and deflate — refused, not guessed;
//   - every inflation capped per entry AND in total through maxOutputLength, so
//     a 1 GiB bomb is refused after 64 MB of work instead of allocated;
//   - every XML walk linear in its input: no regex that backtracks over a part,
//     so an unclosed tag costs one scan, not one per `<`;
//   - output capped for the whole document (see Budget), and spreadsheet rows
//     capped in width, so a single cell at column XFD cannot pad every row with
//     sixteen thousand empties.
// Nothing is ever written to disk, so path traversal in entry names is moot.

const MAX_ENTRIES = 10_000;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
// The same ceiling the external rungs' stdout has (../pdf/exec.ts).
const MAX_OUTPUT_CHARS = 24 * 1024 * 1024;
const MAX_COLUMNS = 256;
// ODF compresses runs of identical cells and rows into one element with a
// repeat count — typically a million empty rows padding a sheet to its end.
const MAX_REPEAT = 1000;

/** Why the reader gave up on a file, in words fit for the refusal note. */
class Refused extends Error {}

// ── The ZIP container ────────────────────────────────────────────────────────

interface ZipEntry {
  flags: number;
  method: number;
  compressedSize: number;
  size: number;
  localHeader: number;
}

class Zip {
  private inflated = 0;

  constructor(
    private readonly buf: Buffer,
    private readonly entries: Map<string, ZipEntry>,
  ) {}

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** An entry's bytes, or undefined when there is no such entry. Throws Refused on anything it will not read. */
  read(name: string): Buffer | undefined {
    const e = this.entries.get(name);
    if (!e) return undefined;
    if (e.flags & 0x1) throw new Refused("encrypted ZIP entries");
    if (e.compressedSize === 0xffffffff || e.size === 0xffffffff || e.localHeader === 0xffffffff) throw new Refused("ZIP64 archives are not supported");
    const buf = this.buf;
    const lh = e.localHeader;
    if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) throw new Refused("truncated or corrupt ZIP archive");
    const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
    const end = start + e.compressedSize;
    if (end > buf.length) throw new Refused("truncated or corrupt ZIP archive");
    const cap = Math.min(MAX_ENTRY_BYTES, MAX_TOTAL_BYTES - this.inflated);
    const tooLarge = () =>
      new Refused(
        cap < MAX_ENTRY_BYTES
          ? `the archive inflates past ${MAX_TOTAL_BYTES >> 20} MB`
          : `an entry inflates past ${MAX_ENTRY_BYTES >> 20} MB (a decompression bomb?)`,
      );
    if (cap <= 0) throw tooLarge();
    let out: Buffer;
    if (e.method === 0) {
      if (e.compressedSize > cap) throw tooLarge();
      out = buf.subarray(start, end);
    } else if (e.method === 8) {
      try {
        // Stops at the cap: a bomb costs `cap` of work, never its full size.
        out = inflateRawSync(buf.subarray(start, end), { maxOutputLength: cap });
      } catch (err) {
        throw (err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ? tooLarge() : new Refused("truncated or corrupt ZIP archive");
      }
    } else {
      throw new Refused(`unsupported ZIP compression method ${e.method}`);
    }
    this.inflated += out.length;
    return out;
  }

  /** An XML part as text: UTF-8, or UTF-16LE when it says so with a BOM. */
  text(name: string): string | undefined {
    const b = this.read(name);
    if (!b) return undefined;
    if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString("utf16le");
    return b.toString("utf8").replace(/^﻿/, "");
  }
}

function openZip(buf: Buffer): Zip {
  // The end-of-central-directory record: 22 bytes, then up to 64 KB of comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0)
    throw new Refused(buf.subarray(0, 4).toString("latin1") === "PK\x03\x04" ? "truncated or corrupt ZIP archive" : "not an OOXML or OpenDocument file");
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) throw new Refused("ZIP64 archives are not supported");
  const count = buf.readUInt16LE(eocd + 10);
  const dirSize = buf.readUInt32LE(eocd + 12);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) throw new Refused("ZIP64 archives are not supported");
  if (count > MAX_ENTRIES) throw new Refused(`more than ${MAX_ENTRIES} ZIP entries`);
  if (dirOffset + dirSize > eocd) throw new Refused("truncated or corrupt ZIP archive");

  const entries = new Map<string, ZipEntry>();
  let p = dirOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new Refused("truncated or corrupt ZIP archive");
    const nameLength = buf.readUInt16LE(p + 28);
    const next = p + 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (next > eocd) throw new Refused("truncated or corrupt ZIP archive");
    entries.set(buf.toString("utf8", p + 46, p + 46 + nameLength), {
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localHeader: buf.readUInt32LE(p + 42),
    });
    p = next;
  }
  return new Zip(buf, entries);
}

// ── The output allowance ─────────────────────────────────────────────────────

// The inflation caps bound what a package holds, not what it shows: an .xlsx
// writes a string once and may show it in every cell of every sheet, and an
// .ods repeats a row a thousand times with one attribute. So the text itself is
// metered, once for the whole document; past the allowance nothing more is
// kept — as with the external rungs, whose stdout stops at the same size.
class Budget {
  private left = MAX_OUTPUT_CHARS;

  /** Spend `n` characters: false, and nothing spent, once they no longer fit — the caller drops them. */
  take(n: number): boolean {
    if (n > this.left) {
      this.left = 0;
      return false;
    }
    this.left -= n;
    return true;
  }

  get spent(): boolean {
    return this.left <= 0;
  }
}

// ── A linear XML walk ────────────────────────────────────────────────────────

interface XmlVisitor {
  /** A start tag; self-closing ones are followed by their `close` at once. */
  open?(name: string, attrs: string): void;
  close?(name: string): void;
  /** Character data, entities decoded. */
  text?(text: string): void;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([a-zA-Z]{2,4}));/g, (m, hex, dec, name) => {
    if (name) return ENTITIES[name] ?? m;
    const cp = hex ? parseInt(hex, 16) : Number(dec);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

/** The name after any namespace prefix: `w:p` → `p`. */
const local = (name: string): string => name.slice(name.indexOf(":") + 1);

// Every step moves past the next `>` (or ends the walk), so a part costs one
// pass whatever it holds; a `<` with no `>` after it ends the walk, since no
// later tag could close either.
function walkXml(xml: string, v: XmlVisitor): void {
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    const textEnd = lt < 0 ? xml.length : lt;
    if (textEnd > i && v.text) v.text(decodeXml(xml.slice(i, textEnd)));
    if (lt < 0) return;
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) return;
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) return;
      v.text?.(xml.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    const gt = xml.indexOf(">", lt + 1);
    if (gt < 0) return;
    i = gt + 1;
    const first = xml.charCodeAt(lt + 1);
    if (first === 0x3f || first === 0x21) continue; // <?xml …?>, <!DOCTYPE …>
    if (first === 0x2f) {
      v.close?.(xml.slice(lt + 2, gt).trim());
      continue;
    }
    const selfClosing = xml.charCodeAt(gt - 1) === 0x2f;
    const body = xml.slice(lt + 1, selfClosing ? gt - 1 : gt);
    const space = body.search(/\s/);
    const name = space < 0 ? body : body.slice(0, space);
    v.open?.(name, space < 0 ? "" : body.slice(space));
    if (selfClosing) v.close?.(name);
  }
}

const attrPatterns = new Map<string, RegExp>();

/** An attribute's value by qualified name — or, given `*:id`, any prefixed `id`. */
function attr(attrs: string, name: string): string | undefined {
  let re = attrPatterns.get(name);
  if (!re) {
    const key = name.startsWith("*:") ? `[\\w.-]+:${name.slice(2)}` : name.replace(/[.]/g, "\\.");
    re = new RegExp(`(?:^|\\s)${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
    attrPatterns.set(name, re);
  }
  const m = re.exec(attrs);
  return m ? decodeXml(m[1] ?? m[2] ?? "") : undefined;
}

// ── Shared output helpers ────────────────────────────────────────────────────

const cell = (s: string): string => s.replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");

/** A Markdown table, header rule after the first row; trailing empty rows and columns dropped. */
function markdownTable(rows: string[][]): string {
  let last = rows.length;
  while (last > 0 && rows[last - 1]!.every((c) => !c.trim())) last--;
  let width = 0;
  for (let r = 0; r < last; r++) {
    const row = rows[r]!;
    for (let c = Math.min(row.length, MAX_COLUMNS) - 1; c >= width; c--) {
      if (row[c]?.trim()) {
        width = c + 1;
        break;
      }
    }
  }
  if (!last || !width) return "";
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, c) => cell(row[c] ?? "")).join(" | ")} |`;
  const out = [line(rows[0]!), `|${" --- |".repeat(width)}`];
  // The cells are metered; the rules around them are not, and an empty row
  // between two far-apart cells is nothing but rules.
  let size = 0;
  for (let r = 1; r < last && size < MAX_OUTPUT_CHARS; r++) {
    const l = line(rows[r]!);
    size += l.length;
    out.push(l);
  }
  return out.join("\n");
}

/** A part's relationships: id → { target part path, type }. */
function relationships(zip: Zip, part: string): Map<string, { target: string; type: string }> {
  const slash = part.lastIndexOf("/");
  const dir = part.slice(0, slash + 1);
  const rels = new Map<string, { target: string; type: string }>();
  const xml = zip.text(`${dir}_rels/${part.slice(slash + 1)}.rels`);
  if (!xml) return rels;
  walkXml(xml, {
    open(name, attrs) {
      if (local(name) !== "Relationship" || attr(attrs, "TargetMode") === "External") return;
      const id = attr(attrs, "Id");
      const target = attr(attrs, "Target");
      if (id && target) rels.set(id, { target: resolvePart(dir, target), type: attr(attrs, "Type") ?? "" });
    },
  });
  return rels;
}

/** The target of the first relationship of this type (`…/sharedStrings`), if any. */
function relatedPart(rels: Map<string, { target: string; type: string }>, type: string): string | undefined {
  for (const r of rels.values()) if (r.type.endsWith(`/${type}`)) return r.target;
  return undefined;
}

/** A relationship target as a path inside the package. */
function resolvePart(dir: string, target: string): string {
  const segments: string[] = [];
  for (const s of (target.startsWith("/") ? target.slice(1) : dir + target).split("/")) {
    if (s === "..") segments.pop();
    else if (s && s !== ".") segments.push(s);
  }
  return segments.join("/");
}

// ── Word processing (.docx) ──────────────────────────────────────────────────

// Word derives a style's id from its localised name with the non-ASCII letters
// dropped, so a German heading is `berschrift1` and a Spanish one `Ttulo1`.
const HEADING_STYLE_RE = /^(?:heading|titre|berschrift|überschrift|kop|titolo|encabezado|ttulo|título)\s?([1-6])$/i;
const TITLE_STYLE_RE = /^(?:title|titel|titre|titolo|ttulo|título)$/i;

interface Paragraph {
  text: string;
  prefix: string;
}

interface Table {
  rows: string[][];
  row?: string[];
  cell?: string[];
}

function wordText(xml: string, budget: Budget): string {
  const blocks: string[] = [];
  const paragraphs: Paragraph[] = []; // a text box's paragraphs nest inside another
  const tables: Table[] = [];
  let inText = 0;
  // mc:Fallback repeats the mc:Choice content for older readers: read it once.
  let fallback = 0;
  // <w:tabs> holds the paragraph's tab STOPS, not tab characters.
  let tabStops = 0;

  const add = (p: Paragraph | undefined, s: string) => {
    if (p && budget.take(s.length)) p.text += s;
  };
  // A finished paragraph or table goes to the innermost open cell, else out.
  const emit = (block: string) => {
    const table = tables[tables.length - 1];
    if (table?.cell) table.cell.push(block);
    else if (block.trim()) blocks.push(block);
  };

  walkXml(xml, {
    open(name, attrs) {
      const n = local(name);
      if (n === "Fallback") fallback++;
      else if (n === "tabs") tabStops++;
      if (fallback) return;
      const p = paragraphs[paragraphs.length - 1];
      const table = tables[tables.length - 1];
      if (n === "p") paragraphs.push({ text: "", prefix: "" });
      else if (n === "t") inText++;
      else if (n === "tab" && !tabStops) add(p, "\t");
      else if (n === "br" || n === "cr") add(p, "\n");
      else if (n === "noBreakHyphen") add(p, "-");
      else if (n === "pStyle" && p) {
        const style = attr(attrs, "w:val") ?? "";
        const level = HEADING_STYLE_RE.exec(style)?.[1];
        if (level) p.prefix = `${"#".repeat(Number(level))} `;
        else if (TITLE_STYLE_RE.test(style)) p.prefix = "# ";
      } else if (n === "numPr" && p && !p.prefix) p.prefix = "- ";
      else if (n === "tbl") tables.push({ rows: [] });
      else if (n === "tr" && table) table.row = [];
      else if (n === "tc" && table) table.cell = [];
    },
    close(name) {
      const n = local(name);
      if (n === "Fallback") {
        fallback = Math.max(0, fallback - 1);
        return;
      }
      if (n === "tabs") tabStops = Math.max(0, tabStops - 1);
      if (fallback) return;
      const table = tables[tables.length - 1];
      if (n === "t") inText = Math.max(0, inText - 1);
      else if (n === "p") {
        const p = paragraphs.pop();
        if (p) emit(table?.cell ? p.text.trim() : (p.prefix + p.text).trimEnd());
      } else if (n === "tc" && table?.row && table.cell) {
        table.row.push(table.cell.join(" "));
        table.cell = undefined;
      } else if (n === "tr" && table?.row) {
        table.rows.push(table.row);
        table.row = undefined;
      } else if (n === "tbl") {
        const done = tables.pop();
        if (done) emit(tables.length ? done.rows.map((r) => r.join(" ")).join(" ") : markdownTable(done.rows));
      }
    },
    text(s) {
      if (!fallback && inText) add(paragraphs[paragraphs.length - 1], s);
    },
  });
  return blocks.join("\n\n");
}

// ── Spreadsheets (.xlsx) ─────────────────────────────────────────────────────

function sharedStrings(xml: string | undefined): string[] {
  const strings: string[] = [];
  if (!xml) return strings;
  let current: string | undefined;
  let inText = 0;
  let phonetic = 0; // <rPh>: a reading aid, not the cell's text
  walkXml(xml, {
    open(name) {
      const n = local(name);
      if (n === "si") current = "";
      else if (n === "t") inText++;
      else if (n === "rPh") phonetic++;
    },
    close(name) {
      const n = local(name);
      if (n === "si" && current !== undefined) {
        strings.push(current);
        current = undefined;
      } else if (n === "t") inText = Math.max(0, inText - 1);
      else if (n === "rPh") phonetic = Math.max(0, phonetic - 1);
    },
    text(s) {
      if (current !== undefined && inText && !phonetic) current += s;
    },
  });
  return strings;
}

/** `B7` → 1: the column of a cell reference, or undefined. */
function columnOf(ref: string | undefined): number | undefined {
  const letters = ref && /^[A-Za-z]{1,3}/.exec(ref)?.[0];
  if (!letters) return undefined;
  let col = 0;
  for (const ch of letters.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return col - 1;
}

function sheetRows(xml: string, shared: string[], budget: Budget): string[][] {
  const rows: string[][] = [];
  let row: string[] | undefined;
  let col = 0;
  let type: string | undefined;
  let value: string | undefined;
  let collecting = 0;
  walkXml(xml, {
    open(name, attrs) {
      const n = local(name);
      if (n === "row") row = [];
      else if (n === "c" && row) {
        col = columnOf(attr(attrs, "r")) ?? row.length;
        type = attr(attrs, "t");
        value = "";
      } else if ((n === "v" || n === "t") && value !== undefined) collecting++;
    },
    close(name) {
      const n = local(name);
      if ((n === "v" || n === "t") && collecting) collecting--;
      else if (n === "c" && row && value !== undefined) {
        let shown = value;
        if (type === "s") shown = shared[Number(value)] ?? "";
        else if (type === "b") shown = value === "1" ? "TRUE" : "FALSE";
        // Metered here, where a shared string is shown, not where it is written.
        if (col < MAX_COLUMNS && shown && budget.take(shown.length)) {
          while (row.length < col) row.push("");
          row[col] = shown;
        }
        value = undefined;
      } else if (n === "row" && row) {
        rows.push(row);
        row = undefined;
      }
    },
    text(s) {
      if (collecting && value !== undefined && value.length < MAX_OUTPUT_CHARS) value += s;
    },
  });
  return rows;
}

function spreadsheetText(zip: Zip, workbookPart: string, budget: Budget): string {
  const rels = relationships(zip, workbookPart);
  const stringsPart = relatedPart(rels, "sharedStrings");
  const shared = sharedStrings(stringsPart ? zip.text(stringsPart) : undefined);
  const sheets: { name: string; id: string }[] = [];
  walkXml(zip.text(workbookPart) ?? "", {
    open(name, attrs) {
      const id = attr(attrs, "*:id");
      if (local(name) === "sheet" && id) sheets.push({ name: attr(attrs, "name") ?? `Sheet ${sheets.length + 1}`, id });
    },
  });
  const blocks: string[] = [];
  for (const sheet of sheets) {
    if (budget.spent) break;
    const part = rels.get(sheet.id)?.target;
    const xml = part ? zip.text(part) : undefined;
    const table = xml ? markdownTable(sheetRows(xml, shared, budget)) : "";
    if (table) blocks.push(`## ${sheet.name}\n\n${table}`);
  }
  return blocks.join("\n\n");
}

// ── Presentations (.pptx) ────────────────────────────────────────────────────

/** DrawingML text: one line per paragraph. `onlyBody` keeps the body placeholder of a notes page, not its slide number. */
function drawingText(xml: string, budget: Budget, onlyBody = false): string {
  const lines: string[] = [];
  const shapes: { body: boolean; lines: string[] }[] = [];
  let para: string | undefined;
  let inText = 0;
  let fallback = 0;
  const add = (s: string) => {
    if (para !== undefined && budget.take(s.length)) para += s;
  };
  walkXml(xml, {
    open(name, attrs) {
      const n = local(name);
      if (n === "Fallback") fallback++;
      if (fallback) return;
      if (n === "sp") shapes.push({ body: false, lines: [] });
      else if (n === "ph" && shapes.length) shapes[shapes.length - 1]!.body = attr(attrs, "type") === "body";
      else if (n === "p" && name.startsWith("a:")) para = "";
      else if (n === "t") inText++;
      else if (n === "br") add("\n");
    },
    close(name) {
      const n = local(name);
      if (n === "Fallback") {
        fallback = Math.max(0, fallback - 1);
        return;
      }
      if (fallback) return;
      if (n === "t") inText = Math.max(0, inText - 1);
      else if (n === "p" && name.startsWith("a:") && para !== undefined) {
        const line = para.trim();
        para = undefined;
        if (!line) return;
        const shape = shapes[shapes.length - 1];
        if (shape) shape.lines.push(line);
        else if (!onlyBody) lines.push(line);
      } else if (n === "sp") {
        const shape = shapes.pop();
        if (shape && (!onlyBody || shape.body)) lines.push(...shape.lines);
      }
    },
    text(s) {
      if (!fallback && inText) add(s);
    },
  });
  return lines.join("\n");
}

function presentationText(zip: Zip, presentationPart: string, budget: Budget): string {
  const rels = relationships(zip, presentationPart);
  // Slide order is the presentation's list, not the file names: slide7.xml can
  // be shown first.
  const order: string[] = [];
  walkXml(zip.text(presentationPart) ?? "", {
    open(name, attrs) {
      const target = local(name) === "sldId" ? rels.get(attr(attrs, "*:id") ?? "")?.target : undefined;
      if (target) order.push(target);
    },
  });
  const blocks: string[] = [];
  for (const [i, slide] of order.entries()) {
    if (budget.spent) break;
    const text = drawingText(zip.text(slide) ?? "", budget);
    const notesPart = relatedPart(relationships(zip, slide), "notesSlide");
    const notes = notesPart ? drawingText(zip.text(notesPart) ?? "", budget, true) : "";
    if (text || notes) blocks.push(`## Slide ${i + 1}${text ? `\n\n${text}` : ""}${notes ? `\n\nNotes: ${notes}` : ""}`);
  }
  return blocks.join("\n\n");
}

// ── OpenDocument (.odt, .ods, .odp) ─────────────────────────────────────────

function openDocumentText(xml: string, budget: Budget): string {
  const blocks: string[] = [];
  const paragraphs: Paragraph[] = [];
  const tables: (Table & { repeatRow: number; repeatCell: number })[] = [];
  let skip = 0; // footnotes, comments: not the body's text
  let listItem = false;
  let slide = 0;
  let spreadsheet = false;

  const add = (p: Paragraph | undefined, s: string) => {
    if (p && budget.take(s.length)) p.text += s;
  };
  const emit = (block: string) => {
    const table = tables[tables.length - 1];
    if (table?.cell) table.cell.push(block);
    else if (block.trim()) blocks.push(block);
  };
  const repeat = (attrs: string, name: string) => Math.min(MAX_REPEAT, Math.max(1, Number(attr(attrs, name)) || 1));

  walkXml(xml, {
    open(name, attrs) {
      if (name === "text:note" || name === "office:annotation") skip++;
      if (skip) return;
      const p = paragraphs[paragraphs.length - 1];
      const table = tables[tables.length - 1];
      if (name === "text:p" || name === "text:h") {
        const level = name === "text:h" ? Math.min(6, Number(attr(attrs, "text:outline-level")) || 1) : 0;
        paragraphs.push({ text: "", prefix: level ? `${"#".repeat(level)} ` : listItem && !table ? "- " : "" });
        listItem = false;
      } else if (name === "text:list-item") listItem = true;
      else if (name === "text:s") add(p, " ".repeat(Math.min(100, Number(attr(attrs, "text:c")) || 1)));
      else if (name === "text:tab") add(p, "\t");
      else if (name === "text:line-break") add(p, "\n");
      else if (name === "office:spreadsheet") spreadsheet = true;
      else if (name === "draw:page") emit(`## Slide ${++slide}`);
      else if (name === "table:table") {
        const sheet = attr(attrs, "table:name");
        tables.push({ rows: [], repeatRow: 1, repeatCell: 1 });
        if (sheet && spreadsheet) blocks.push(`## ${sheet}`);
      } else if (name === "table:table-row" && table) {
        table.row = [];
        table.repeatRow = repeat(attrs, "table:number-rows-repeated");
      } else if ((name === "table:table-cell" || name === "table:covered-table-cell") && table?.row) {
        table.cell = [];
        table.repeatCell = repeat(attrs, "table:number-columns-repeated");
      }
    },
    close(name) {
      if (name === "text:note" || name === "office:annotation") {
        skip = Math.max(0, skip - 1);
        return;
      }
      if (skip) return;
      const table = tables[tables.length - 1];
      if (name === "text:p" || name === "text:h") {
        const p = paragraphs.pop();
        if (p) emit(table?.cell ? p.text.trim() : (p.prefix + p.text).trim());
      } else if ((name === "table:table-cell" || name === "table:covered-table-cell") && table?.row && table.cell) {
        const text = table.cell.join(" ");
        // The first copy was metered as it was read; the repeats are shown too.
        for (let k = 0; k < table.repeatCell && table.row.length < MAX_COLUMNS; k++) {
          if (k && text && !budget.take(text.length)) break;
          table.row.push(text);
        }
        table.cell = undefined;
      } else if (name === "table:table-row" && table?.row) {
        // A run of repeated rows is padding when empty; real data repeats rarely.
        const size = table.row.reduce((n, c) => n + c.length, 0);
        const times = size ? table.repeatRow : 1;
        for (let k = 0; k < times; k++) {
          if (k && !budget.take(size)) break;
          table.rows.push(table.row);
        }
        table.row = undefined;
      } else if (name === "table:table") {
        const done = tables.pop();
        if (done) emit(tables.length ? done.rows.map((r) => r.join(" ")).join(" ") : markdownTable(done.rows));
      }
    },
    text(s) {
      // ODF collapses white space in text content; explicit spaces are <text:s>.
      if (!skip) add(paragraphs[paragraphs.length - 1], s.replace(/[ \t\r\n]+/g, " "));
    },
  });
  return blocks.join("\n\n");
}

// ── The rung ─────────────────────────────────────────────────────────────────

const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** The package's main part, from its root relationships — else where every known writer puts it. */
function mainPart(zip: Zip): string | undefined {
  const officeDocument = relatedPart(relationships(zip, ""), "officeDocument");
  if (officeDocument && zip.has(officeDocument)) return officeDocument;
  return ["word/document.xml", "xl/workbook.xml", "ppt/presentation.xml"].find((p) => zip.has(p));
}

function packageText(bytes: Buffer, budget: Budget): string {
  // A password-protected .docx is not a ZIP at all but an OLE container, as is
  // every legacy .doc, .xls and .ppt.
  if (bytes.subarray(0, 8).equals(OLE_SIGNATURE))
    throw new Refused("a legacy binary or password-protected Office file (only OOXML and OpenDocument are read here)");
  const zip = openZip(bytes);
  const mimetype = zip.has("mimetype") ? zip.text("mimetype")?.trim() : undefined;
  if (mimetype?.startsWith("application/vnd.oasis.opendocument.")) {
    const content = zip.text("content.xml");
    if (content === undefined) throw new Refused("an OpenDocument package with no content.xml");
    return openDocumentText(content, budget);
  }
  const main = mainPart(zip);
  const xml = main ? zip.text(main) : undefined;
  if (!main || xml === undefined) throw new Refused("not an OOXML or OpenDocument file");
  if (main.startsWith("word/")) return wordText(xml, budget);
  if (main.startsWith("xl/")) return spreadsheetText(zip, main, budget);
  if (main.startsWith("ppt/")) return presentationText(zip, main, budget);
  throw new Refused("not an OOXML or OpenDocument file");
}

/** What the built-in reader made of a file: its Markdown, or why there is none. */
export type OfficeRead = { text: string; failure?: undefined } | { text?: undefined; failure: string };

/**
 * `officeToText`, with the reason when there is no text — for the ladder's
 * refusal note. Internal: the public surface is `officeToText`.
 */
export function readOffice(bytes: Buffer): OfficeRead {
  try {
    const text = packageText(bytes, new Budget())
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { text: text.length > MAX_OUTPUT_CHARS ? text.slice(0, text.lastIndexOf("\n", MAX_OUTPUT_CHARS)) : text };
  } catch (e) {
    return { failure: e instanceof Refused ? e.message : "the built-in reader could not parse it" };
  }
}

/**
 * The text of an OOXML (.docx, .xlsx, .pptx) or OpenDocument (.odt, .ods, .odp)
 * file as Markdown: headings, paragraphs, lists, and tables — a spreadsheet's
 * sheets as one table each, a deck's slides in presentation order with their
 * speaker notes.
 *
 * Undefined when the bytes are not such a file, or break one of the reader's
 * limits (ZIP64, encryption, an unknown compression method, a decompression
 * bomb, too many entries). Never throws. The text is not judged here: callers
 * run it through the same quality gate as every other rung.
 */
export function officeToText(bytes: Buffer): string | undefined {
  return readOffice(bytes).text;
}
