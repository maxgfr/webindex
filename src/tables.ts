// A table, read as a table.
//
// `htmlToText` flattens `<table>` into a run of cell text, which for prose is
// the right call and for data is destructive: a pricing grid, a compatibility
// matrix or a conformance table becomes a sentence in which no value is
// attached to any row or column any more. That loss is invisible downstream —
// the text reads plausibly, and every figure in it has lost its meaning.
//
// So this reads the structure instead, and it handles the two features that
// make real tables hard. `colspan` and `rowspan` are not exotic: a spec table
// with a merged header cell is ordinary, and a parser that ignores them
// silently shifts every value in the affected rows one column left, which is
// worse than not parsing at all because the result still looks like a table.
//
// Deliberately a small, forgiving parser rather than a correct HTML one — this
// package has no dependencies and will not grow a DOM. It handles the markup
// people actually write; it does not handle unclosed tags nested three deep,
// and says so by leaving such a table out rather than guessing.

export interface Table {
  /** The `<caption>`, when there is one. */
  caption?: string;
  /** Header cells, from `<thead>` or the first row of `<th>`. Empty when the table declares none. */
  headers: string[];
  /** Body rows, each padded to the widest row so a column index means one thing. */
  rows: string[][];
}

/** Undo the entity escapes a cell's text can carry. Deliberately the common five plus numerics. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}

/** A cell's visible text: markup out, entities decoded, whitespace collapsed. */
function cellText(html: string): string {
  return decodeEntities(
    html
      // A <br> inside a cell is a line break the reader sees, so it must not
      // glue two values into one word.
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " "),
  ).trim();
}

interface RawCell {
  text: string;
  colspan: number;
  rowspan: number;
  header: boolean;
}

function intAttr(tag: string, name: string): number {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, "i").exec(tag);
  const n = m ? Number(m[1]) : 1;
  // A span of 0 is legal HTML meaning "to the end of the section", and a huge
  // one is a typo or an attack on the parser. Clamp both: the alternative is a
  // row of ten thousand empty cells.
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100) : 1;
}

function parseRow(rowHtml: string): RawCell[] {
  const cells: RawCell[] = [];
  for (const m of rowHtml.matchAll(/<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
    cells.push({
      text: cellText(m[3] as string),
      colspan: intAttr(m[2] as string, "colspan"),
      rowspan: intAttr(m[2] as string, "rowspan"),
      header: (m[1] as string).toLowerCase() === "th",
    });
  }
  return cells;
}

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
function expand(rows: RawCell[][]): string[][] {
  const grid: string[][] = [];
  // Slots claimed by a rowspan from an earlier row: key `${row}:${col}`.
  const carried = new Map<string, string>();

  rows.forEach((cells, r) => {
    const out: string[] = [];
    let c = 0;
    /** Fill every slot already claimed by a rowspan from above, and return the next free column. */
    const skipCarried = () => {
      while (carried.has(`${r}:${c}`)) {
        out[c] = carried.get(`${r}:${c}`) as string;
        c++;
      }
      return c;
    };

    for (const cell of cells) {
      // Resolve the carried slots FIRST, so the span is recorded at the column
      // the cell actually lands in rather than the one it was written at.
      const startCol = skipCarried();
      for (let i = 0; i < cell.colspan; i++) {
        out[startCol + i] = cell.text;
        for (let j = 1; j < cell.rowspan; j++) carried.set(`${r + j}:${startCol + i}`, cell.text);
      }
      c = startCol + cell.colspan;
    }
    skipCarried(); // trailing slots, after the row's last written cell
    grid.push(out);
  });

  // Pad to the widest row, so a column index means the same thing in every row.
  const width = grid.reduce((w, row) => Math.max(w, row.length), 0);
  return grid.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ""));
}

/**
 * Every table in a document, as rows and columns.
 *
 * A table with no data rows is dropped: a layout table used for positioning is
 * still common on older sites, and returning it as data is a false positive a
 * caller has no way to filter.
 */
export function extractTables(html: string): Table[] {
  const tables: Table[] = [];
  for (const m of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/gi)) {
    const inner = m[1] as string;
    const caption = /<caption\b[^>]*>([\s\S]*?)<\/caption\s*>/i.exec(inner);

    const rawRows: RawCell[][] = [];
    for (const r of inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)) {
      const cells = parseRow(r[1] as string);
      if (cells.length) rawRows.push(cells);
    }
    if (!rawRows.length) continue;

    const grid = expand(rawRows);

    // The header row is the first one whose cells are all <th>. Anything looser
    // — "the first row", or "any row containing a th" — misreads a table whose
    // first column is a row label marked up as th, which is extremely common.
    const headerIndex = rawRows.findIndex((cells) => cells.every((c) => c.header));
    const headers = headerIndex === 0 ? (grid[0] as string[]) : [];
    const rows = headerIndex === 0 ? grid.slice(1) : grid;
    if (!rows.length) continue;

    tables.push({ ...(caption ? { caption: cellText(caption[1] as string) } : {}), headers, rows });
  }
  return tables;
}

/**
 * A table as markdown, for folding back into extracted text.
 *
 * Pipes inside a cell are escaped, because an unescaped one silently splits the
 * cell and shifts the rest of the row — the same failure the span handling above
 * exists to prevent, reintroduced at the last step.
 */
export function tableToMarkdown(table: Table): string {
  const width = Math.max(table.headers.length, ...table.rows.map((r) => r.length), 1);
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
