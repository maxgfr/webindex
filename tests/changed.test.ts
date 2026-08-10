import { afterEach, describe, expect, it, vi } from "vitest";
import { contentHash, fingerprint, hasChanged } from "../src/changed.js";
import { extractTables, tableToMarkdown } from "../src/tables.js";
import { installFetchMock } from "./fetchmock.js";

afterEach(() => vi.restoreAllMocks());

const URL_A = "https://a.test/page";

describe("fingerprint", () => {
  it("records the validators, the hash and when it looked", async () => {
    installFetchMock(() => ({
      status: 200,
      body: "hello",
      contentType: "text/html",
      headers: { etag: '"v1"', "last-modified": "Wed, 21 Oct 2015 07:28:00 GMT" },
    }));
    const f = await fingerprint(URL_A);
    expect(f).toMatchObject({ url: URL_A, etag: '"v1"', lastModified: "Wed, 21 Oct 2015 07:28:00 GMT", bytes: 5, status: 200 });
    expect(f.contentHash).toBe(contentHash("hello"));
    expect(Date.parse(f.fetchedAt)).toBeGreaterThan(0);
  });

  it("carries no hash for a response it could not read", async () => {
    installFetchMock(() => ({ status: 500, body: "", contentType: "text/plain" }));
    expect((await fingerprint(URL_A)).contentHash).toBeUndefined();
  });
});

describe("hasChanged", () => {
  it("sends the conditional headers when it has validators", async () => {
    let sent: Record<string, string> = {};
    installFetchMock((_url, init) => {
      sent = (init?.headers ?? {}) as Record<string, string>;
      return { status: 304, body: "", contentType: "text/html" };
    });
    await hasChanged(URL_A, { etag: '"v1"', lastModified: "Wed, 21 Oct 2015 07:28:00 GMT" });
    expect(sent["if-none-match"]).toBe('"v1"');
    expect(sent["if-modified-since"]).toBe("Wed, 21 Oct 2015 07:28:00 GMT");
  });

  it("answers a 304 definitively, with no body across the wire", async () => {
    installFetchMock(() => ({ status: 304, body: "", contentType: "text/html" }));
    const v = await hasChanged(URL_A, { etag: '"v1"' });
    expect(v).toMatchObject({ changed: false, via: "not-modified" });
    expect(v.fingerprint.bytes).toBe(0);
    // The previous validators survive, so a caller can store the result as-is
    // and still revalidate next time.
    expect(v.fingerprint.etag).toBe('"v1"');
  });

  it("compares etags when the server answers 200", async () => {
    installFetchMock(() => ({ status: 200, body: "new", contentType: "text/html", headers: { etag: '"v2"' } }));
    expect(await hasChanged(URL_A, { etag: '"v1"' })).toMatchObject({ changed: true, via: "etag" });

    installFetchMock(() => ({ status: 200, body: "same", contentType: "text/html", headers: { etag: '"v1"' } }));
    expect(await hasChanged(URL_A, { etag: '"v1"' })).toMatchObject({ changed: false, via: "etag" });
  });

  it("falls back to last-modified, then to the content hash", async () => {
    installFetchMock(() => ({ status: 200, body: "x", contentType: "text/html", headers: { "last-modified": "Thu, 22 Oct 2015 07:28:00 GMT" } }));
    expect(await hasChanged(URL_A, { lastModified: "Wed, 21 Oct 2015 07:28:00 GMT" })).toMatchObject({ changed: true, via: "last-modified" });

    installFetchMock(() => ({ status: 200, body: "same body", contentType: "text/html" }));
    expect(await hasChanged(URL_A, { contentHash: contentHash("same body") })).toMatchObject({ changed: false, via: "hash" });
  });

  it("says it could not tell, rather than saying unchanged, when the request failed", async () => {
    // A caller treating an error as "unchanged" silently stops watching the
    // page it asked to watch. `changed` is optional so that cannot be written
    // by accident.
    installFetchMock(() => ({ status: 500, body: "", contentType: "text/plain" }));
    const v = await hasChanged(URL_A, { etag: '"v1"' });
    expect(v.changed).toBeUndefined();
    expect(v.via).toBe("unknown");
    expect(v.note).toMatch(/could not read/);
  });

  it("treats a first observation as the baseline, not as a change", async () => {
    // Otherwise every watcher fires on its first run.
    installFetchMock(() => ({ status: 200, body: "x", contentType: "text/html" }));
    const v = await hasChanged(URL_A);
    expect(v.changed).toBe(false);
    expect(v.note).toMatch(/baseline/);
  });

  it("admits when the two observations share nothing comparable", async () => {
    installFetchMock(() => ({ status: 200, body: "x", contentType: "text/html" }));
    const v = await hasChanged(URL_A, { etag: '"v1"' }); // server stopped sending one
    expect(v.changed).toBeUndefined();
    expect(v.note).toMatch(/store contentHash/);
  });

  it("hands back a fresh observation so the caller need not ask twice", async () => {
    installFetchMock(() => ({ status: 200, body: "new", contentType: "text/html", headers: { etag: '"v2"' } }));
    const v = await hasChanged(URL_A, { etag: '"v1"' });
    expect(v.fingerprint.etag).toBe('"v2"');
    expect(v.fingerprint.contentHash).toBe(contentHash("new"));
  });
});

describe("extractTables", () => {
  it("reads headers and rows", () => {
    const html = `<table><thead><tr><th>Engine</th><th>Keyless</th></tr></thead>
      <tbody><tr><td>Mojeek</td><td>yes</td></tr><tr><td>Firecrawl</td><td>no</td></tr></tbody></table>`;
    expect(extractTables(html)).toEqual([
      {
        headers: ["Engine", "Keyless"],
        rows: [
          ["Mojeek", "yes"],
          ["Firecrawl", "no"],
        ],
      },
    ]);
  });

  it("keeps a caption", () => {
    expect(extractTables("<table><caption>Rung costs</caption><tr><td>a</td></tr></table>")[0]?.caption).toBe("Rung costs");
  });

  it("shifts nothing when a cell spans columns", () => {
    // Ignoring colspan moves every later value one column left, and the result
    // still looks like a well-formed table — which is why it goes unnoticed.
    const html = "<table><tr><th>a</th><th>b</th><th>c</th></tr><tr><td colspan='2'>wide</td><td>tail</td></tr></table>";
    expect(extractTables(html)[0]?.rows).toEqual([["wide", "wide", "tail"]]);
  });

  it("carries a rowspan into the rows below it", () => {
    const html = "<table><tr><th>k</th><th>v</th></tr><tr><td rowspan='2'>shared</td><td>1</td></tr><tr><td>2</td></tr></table>";
    expect(extractTables(html)[0]?.rows).toEqual([
      ["shared", "1"],
      ["shared", "2"],
    ]);
  });

  it("pads short rows, so a column index means one thing", () => {
    const html = "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td></tr></table>";
    expect(extractTables(html)[0]?.rows).toEqual([["1", ""]]);
  });

  it("does not mistake a th row-label for a header row", () => {
    // Very common markup: the first COLUMN is th. "Any row containing a th"
    // would eat the first data row.
    const html = "<table><tr><th>Name</th><td>Mojeek</td></tr><tr><th>Keyless</th><td>yes</td></tr></table>";
    const t = extractTables(html)[0];
    expect(t?.headers).toEqual([]);
    expect(t?.rows).toEqual([
      ["Name", "Mojeek"],
      ["Keyless", "yes"],
    ]);
  });

  it("decodes entities and turns a <br> into a space, not a glued word", () => {
    const html = "<table><tr><td>a&amp;b</td><td>one<br>two</td><td>&#8364;5</td></tr></table>";
    expect(extractTables(html)[0]?.rows[0]).toEqual(["a&b", "one two", "€5"]);
  });

  it("strips markup inside a cell", () => {
    expect(extractTables('<table><tr><td><a href="/x"><strong>link</strong></a></td></tr></table>')[0]?.rows[0]).toEqual(["link"]);
  });

  it("drops a table with no data rows rather than returning a layout table as data", () => {
    expect(extractTables("<table><tr><th>a</th><th>b</th></tr></table>")).toEqual([]);
    expect(extractTables("<table></table>")).toEqual([]);
  });

  it("clamps an absurd span instead of building ten thousand empty cells", () => {
    expect(extractTables("<table><tr><td colspan='99999'>x</td></tr></table>")[0]?.rows[0]).toHaveLength(100);
  });

  it("reads several tables from one document", () => {
    expect(extractTables("<table><tr><td>1</td></tr></table><table><tr><td>2</td></tr></table>")).toHaveLength(2);
  });
});

describe("tableToMarkdown", () => {
  it("renders a header, a separator and the rows", () => {
    const md = tableToMarkdown({ headers: ["a", "b"], rows: [["1", "2"]] });
    expect(md.split("\n")).toEqual(["| a | b |", "| --- | --- |", "| 1 | 2 |"]);
  });

  it("escapes a pipe inside a cell", () => {
    // An unescaped pipe splits the cell and shifts the rest of the row — the
    // same failure the span handling exists to prevent, at the last step.
    expect(tableToMarkdown({ headers: ["x"], rows: [["a|b"]] })).toContain("a\\|b");
  });

  it("still emits a separator for a table with no headers", () => {
    const md = tableToMarkdown({ headers: [], rows: [["1", "2"]] });
    expect(md.split("\n")[1]).toBe("| --- | --- |");
  });

  it("puts the caption above the table", () => {
    expect(tableToMarkdown({ caption: "Costs", headers: ["a"], rows: [["1"]] }).startsWith("**Costs**")).toBe(true);
  });

  it("round-trips a spanned table into a rectangular markdown one", () => {
    const [t] = extractTables("<table><tr><th>a</th><th>b</th></tr><tr><td colspan='2'>wide</td></tr></table>");
    expect(tableToMarkdown(t as never).split("\n")[2]).toBe("| wide | wide |");
  });
});
