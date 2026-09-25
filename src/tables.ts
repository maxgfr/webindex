// A table, read as a table.
//
// `htmlToText` flattens `<table>` into a run of cell text, which for prose is
// the right call and for data is destructive: a pricing grid, a compatibility
// matrix or a conformance table becomes a sentence in which no value is
// attached to any row or column any more. That loss is invisible downstream —
// the text reads plausibly, and every figure in it has lost its meaning.
//
// So this reads the structure instead, and it handles the features that make
// real tables hard. `colspan` and `rowspan` are not exotic: a spec table with
// a merged header cell is ordinary, and a parser that ignores them silently
// shifts every value in the affected rows one column left, which is worse than
// not parsing at all because the result still looks like a table. Neither are
// omitted end tags — `</td>` and `</tr>` are optional in HTML — nor a table
// nested in another's cell.
//
// Deliberately a small, forgiving tokenizer rather than a correct HTML parser —
// this package has no dependencies and will not grow a DOM. One left-to-right
// pass over the table tags, with a stack of open tables, applying the few
// implied-end rules a browser applies: a new cell closes the open cell, a new
// row closes the open row, and a table's end closes everything inside it.

import { decodeEntities } from "./entities.js";
import { dropElements, htmlAttributes, INLINE_TAGS, LOOSE_TAG_RE, RAW_TEXT_ELEMENTS, TAG_RE, tagName } from "./html.js";

export interface Table {
  /** The `<caption>`, when there is one. */
  caption?: string;
  /** Header cells, from `<thead>` or a first row of `<th>`. Empty when the table declares none. */
  headers: string[];
  /** Body rows, each padded to the widest row so a column index means one thing. */
  rows: string[][];
}

/**
 * A cell fragment's visible text, read as htmlToText reads it: inline markup
 * goes without a trace ("12<small>ms</small>" is "12ms"), any other tag is a
 * space, so a list of "x64" and "arm64" in one cell stays two words; entities
 * decode once.
 */
function fragmentText(html: string): string {
  return decodeEntities(html.replace(TAG_RE, (tag) => (INLINE_TAGS.has(tagName(tag)) ? "" : " ")).replace(LOOSE_TAG_RE, " "));
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

interface RawCell {
  text: string;
  colspan: number;
  rowspan: number;
  header: boolean;
}

function spanAttr(attrs: Map<string, string>, name: string): number {
  const n = Number.parseInt(attrs.get(name) ?? "", 10);
  // A span of 0 is legal HTML meaning "to the end of the section", and a huge
  // one is a typo or an attack on the parser. Clamp both: the alternative is a
  // row of ten thousand empty cells.
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100) : 1;
}

// The most slots one table may expand to. Each clamped span can still claim a
// hundred by a hundred of them, so a page of `<td rowspan=100 colspan=100>`
// asks for billions, and padding one very wide row's width onto every other
// row multiplies again. A table this size is a data dump no reader takes in as
// a table, or an attack; either way it is left out rather than allowed to take
// the process with it.
const MAX_SLOTS = 1_000_000;

/**
 * Expand a grid of spanned cells into a rectangular one.
 *
 * The whole reason this module is not twenty lines. A cell with `rowspan=2`
 * occupies a slot in the NEXT row too, so that row's remaining cells must shift
 * right around it. Ignoring that shifts every later value one column left — and
 * because the output still looks like a well-formed table, nothing downstream
 * can notice.
 *
 * The spanned slots are filled with a copy of the value rather than left empty,
 * so reading a column gives the value that applies to each row, which is what a
 * human reading the rendered table sees.
 */
function expand(rows: RawCell[][]): string[][] | undefined {
  // Rows are laid out directly into the grid, so a slot claimed by a rowspan
  // from above is simply already filled when its own row gets there.
  const grid: string[][] = rows.map(() => []);
  let slots = 0;
  for (let r = 0; r < rows.length; r++) {
    const out = grid[r]!;
    let c = 0;
    for (const cell of rows[r]!) {
      while (out[c] !== undefined) c++; // the cell lands after the slots carried into this row
      // A rowspan stops at the table's last row, as a browser's does.
      const down = Math.min(cell.rowspan, rows.length - r);
      slots += down * cell.colspan;
      if (slots > MAX_SLOTS) return undefined;
      for (let j = 0; j < down; j++) for (let i = 0; i < cell.colspan; i++) grid[r + j]![c + i] = cell.text;
      c += cell.colspan;
    }
  }

  // Pad to the widest row, so a column index means the same thing in every row.
  const width = grid.reduce((w, row) => Math.max(w, row.length), 0);
  if (width * grid.length > MAX_SLOTS) return undefined;
  return grid.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ""));
}

/**
 * Every table in a document, as rows and columns.
 *
 * A table with no data rows is dropped: a layout table used for positioning is
 * still common on older sites, and returning it as data is a false positive a
 * caller has no way to filter. A table nested in another's cell is reported on
 * its own, and its text also stays in the cell that holds it.
 */
export function extractTables(html: string): Table[] {
  // Comments, scripts and templates can quote a whole table; none of it renders.
  // A <noscript> does, for a reader that runs no scripts — Discourse serves its
  // whole thread in one.
  const src = dropElements(html, NOT_RENDERED, RAW_TEXT_ELEMENTS);
  const tag = /<(\/?)(table|caption|thead|tbody|tfoot|tr|td|th)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
  const done: { order: number; table: Table }[] = [];
  const stack: OpenTable[] = [];
  let order = 0;
  let last = 0;
  // Tables opened past MAX_DEPTH and not closed yet.
  let buried = 0;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(src))) {
    const top = stack[stack.length - 1];
    if (top) top.text(src.slice(last, m.index));
    last = tag.lastIndex;
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    if (top && (buried || (name === "table" && !closing && stack.length >= MAX_DEPTH))) {
      // A buried table is only words in the cell that holds it; its tags still
      // separate them.
      if (name === "table") buried += closing ? -1 : 1;
      top.text(" ");
      continue;
    }
    if (name === "table") {
      if (!closing) stack.push(new OpenTable(order++));
      else if (top) closeTable(stack, done);
      continue;
    }
    if (!top) continue; // table markup outside any table renders as nothing
    if (name === "td" || name === "th") {
      if (closing) top.endCell();
      else top.startCell(name === "th", htmlAttributes(m[0]));
    } else if (name === "tr") {
      top.endRow();
      if (!closing) top.startRow();
    } else if (name === "caption") {
      top.endRow();
      top.inCaption = !closing;
    } else {
      // thead / tbody / tfoot: a row group boundary ends the open row.
      top.endRow();
      top.inHead = name === "thead" && !closing;
    }
  }
  // A table the document never closes — a page cut short — still holds rows.
  while (stack.length) closeTable(stack, done);
  return done.sort((a, b) => a.order - b.order).map((d) => d.table);
}

// What no reader sees, so no table in it is one.
const NOT_RENDERED: readonly string[] = ["script", "style", "template", "svg", "select", "datalist"];

// How deep tables nest before the deeper ones are read as text only. Every
// table's text is also copied into the cell that holds it, so each level of
// nesting copies everything below it once more — linear at a fixed depth,
// quadratic at an unbounded one. Real layouts stop at four or five.
const MAX_DEPTH = 8;

/** One table being read: its rows so far and whatever is open inside it. */
class OpenTable {
  rows: { cells: RawCell[]; head: boolean }[] = [];
  caption: string[] = [];
  inCaption = false;
  inHead = false;
  private row?: { cells: RawCell[]; head: boolean };
  private cell?: { parts: string[]; header: boolean; colspan: number; rowspan: number };

  constructor(readonly order: number) {}

  /** Text between two table tags: it belongs to the open cell, else the caption. */
  text(fragment: string): void {
    if (this.cell) this.cell.parts.push(fragmentText(fragment));
    else if (this.inCaption) this.caption.push(fragmentText(fragment));
  }

  /** A nested table's text, already clean, joins the cell that holds it. */
  nested(text: string): void {
    this.cell?.parts.push(` ${text} `);
  }

  startRow(): void {
    this.inCaption = false;
    this.row = { cells: [], head: this.inHead };
  }

  startCell(header: boolean, attrs: Map<string, string>): void {
    this.endCell(); // a new cell closes the open one: </td> is optional
    if (!this.row) this.startRow(); // and a cell with no <tr> implies one
    this.cell = { parts: [], header, colspan: spanAttr(attrs, "colspan"), rowspan: spanAttr(attrs, "rowspan") };
  }

  endCell(): void {
    if (!this.cell || !this.row) return;
    const { parts, header, colspan, rowspan } = this.cell;
    this.row.cells.push({ text: collapse(parts.join("")), header, colspan, rowspan });
    this.cell = undefined;
  }

  endRow(): void {
    this.endCell();
    if (this.row?.cells.length) this.rows.push(this.row);
    this.row = undefined;
  }
}

/** Close the innermost open table, record it, and hand its text to the cell around it. */
function closeTable(stack: OpenTable[], done: { order: number; table: Table }[]): void {
  const t = stack.pop()!;
  t.endRow();
  const caption = collapse(t.caption.join(""));
  const table = buildTable(t.rows, caption);
  if (table) done.push({ order: t.order, table });
  const flat = [caption, ...t.rows.flatMap((r) => r.cells.map((c) => c.text))].filter(Boolean).join(" ");
  stack[stack.length - 1]?.nested(flat);
}

function buildTable(rows: { cells: RawCell[]; head: boolean }[], caption: string): Table | undefined {
  if (!rows.length) return undefined;
  const grid = expand(rows.map((r) => r.cells));
  if (!grid) return undefined;
  let headers: string[] = [];
  let body = grid;
  if (rows.some((r) => r.head)) {
    // <thead> rows are the header, whatever their cells are marked up as. Several
    // of them (a grouped header) merge per column: "2024 Q1", not two rows.
    const head = grid.filter((_, i) => rows[i]!.head);
    headers = head[0]!.map((_, c) => [...new Set(head.map((r) => r[c]!).filter(Boolean))].join(" "));
    body = grid.filter((_, i) => !rows[i]!.head);
  } else if (isHeaderRow(rows[0]!.cells)) {
    headers = grid[0]!;
    body = grid.slice(1);
  }
  if (!body.length) return undefined;
  return { ...(caption ? { caption } : {}), headers, rows: body };
}

/**
 * Is this first row a header row? Every cell a <th>, or empty — the corner of a
 * matrix table is usually an empty <td>.
 *
 * Anything looser — "the first row", or "any row containing a th" — misreads a
 * table whose first column is a row label marked up as th, which is extremely
 * common.
 */
function isHeaderRow(cells: RawCell[]): boolean {
  return cells.some((c) => c.header) && cells.every((c) => c.header || !c.text);
}

/**
 * A table as markdown, for folding back into extracted text.
 *
 * Pipes inside a cell are escaped, because an unescaped one silently splits the
 * cell and shifts the rest of the row — the same failure the span handling above
 * exists to prevent, reintroduced at the last step.
 */
export function tableToMarkdown(table: Table): string {
  // A reduce, not Math.max(...rows): spreading two hundred thousand rows into
  // arguments overflows the call stack.
  const width = table.rows.reduce((w, r) => Math.max(w, r.length), Math.max(table.headers.length, 1));
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const line = (cells: readonly string[]) => `| ${Array.from({ length: width }, (_, i) => esc(cells[i] ?? "")).join(" | ")} |`;

  const out: string[] = [];
  if (table.caption) out.push(`**${table.caption}**`, "");
  // A table with no header row still needs the separator, or it is not a
  // markdown table at all — an empty header row is the standard way to say so.
  out.push(line(table.headers.length ? table.headers : Array.from({ length: width }, () => "")));
  out.push(`|${" --- |".repeat(width)}`);
  for (const row of table.rows) out.push(line(row));
  return out.join("\n");
}
