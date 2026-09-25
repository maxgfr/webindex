import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { officeToText } from "../src/doc.js";
import { readOffice } from "../src/doc/office.js";
import { docx, zip } from "./zipfile.js";

// The built-in office rung reads attacker-controlled ZIPs on the caller's
// thread, so it is pinned on real files (committed under fixtures/docs) AND on
// hand-built archives that break each of its limits.

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", "docs", name));

const para = (text: string, props = "") => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

describe("officeToText on real files", () => {
  it("reads a .docx: headings, runs, a table, and non-Latin text", () => {
    const text = officeToText(fixture("report.docx"))!;
    expect(text).toContain("# Quarterly report — Rapport trimestriel");
    expect(text).toContain("売上は12%増加しました");
    expect(text).toContain("Split across runs");
    expect(text).toContain("| Region | Q1 | Q2 |\n| --- | --- | --- |\n| EMEA | 1.2 | 1.5 |");
    expect(text.indexOf("Final paragraph")).toBeGreaterThan(text.indexOf("| EMEA"));
  });

  it("reads an .xlsx: every sheet as its own table, shared strings resolved", () => {
    const text = officeToText(fixture("sales.xlsx"))!;
    expect(text).toContain("## Sales\n\n| Region | Q1 | Q2 | Note |\n| --- | --- | --- | --- |\n| EMEA | 1.2 | 1.5 | strong growth |");
    expect(text).toContain("## Costs\n\n| Item | Amount |");
    expect(text).toContain("| Cloud | 4200 |");
  });

  it("reads a .pptx: slides in order, with their speaker notes", () => {
    const text = officeToText(fixture("deck.pptx"))!;
    expect(text).toMatch(/^## Slide 1\n\nRoadmap 2027\nShip the offline reader/);
    expect(text).toContain("Notes: Speaker notes: mention the budget.");
    expect(text.indexOf("## Slide 2\n\nRisks")).toBeGreaterThan(text.indexOf("Notes:"));
  });

  it("reads an .odt: headings, tabs, tables and entities", () => {
    const text = officeToText(fixture("notes.odt"))!;
    expect(text).toContain("# Compte rendu");
    expect(text).toContain("Premier paragraphe\tavec une tabulation.");
    expect(text).toContain("| A1 | B1 |");
    expect(text).toContain("Dernier paragraphe & fin.");
  });

  it("refuses a legacy binary file, saying what it is", () => {
    expect(officeToText(fixture("legacy.xls"))).toBeUndefined();
    expect(readOffice(fixture("legacy.xls")).failure).toMatch(/legacy binary or password-protected Office file/);
  });

  it("refuses what is not an office package at all", () => {
    for (const bytes of [fixture("reportlab-a85.pdf"), Buffer.from("plain text, no archive"), Buffer.alloc(0), zip({ "src/index.js": "x" })]) {
      expect(readOffice(bytes).failure).toBe("not an OOXML or OpenDocument file");
    }
  });

  it("never throws on a truncated download, whatever the cut", () => {
    const whole = fixture("report.docx");
    for (let cut = 0; cut < whole.length; cut += 997) {
      const r = readOffice(whole.subarray(0, cut));
      expect(r.text).toBeUndefined();
    }
    expect(readOffice(whole.subarray(0, whole.length >> 1)).failure).toMatch(/truncated or corrupt ZIP archive|not an OOXML/);
  });
});

describe("the Word reader", () => {
  // <w:tabs> lists a paragraph's tab STOPS; read as characters they put a tab
  // in front of every centred title.
  it("reads a tab character, not a tab stop", () => {
    const text = officeToText(
      docx(para("Centred", '<w:tabs><w:tab w:val="center" w:pos="4680"/></w:tabs>') + "<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t></w:r></w:p>"),
    );
    expect(text).toBe("Centred\n\na\tb");
  });

  it("leaves out deleted revisions and field codes, and reads alternate content once", () => {
    const body =
      "<w:p><w:del><w:r><w:delText>old wording</w:delText></w:r></w:del><w:r><w:t>new wording</w:t></w:r></w:p>" +
      '<w:p><w:r><w:instrText> HYPERLINK "https://x.test" </w:instrText></w:r><w:r><w:t>the link</w:t></w:r></w:p>' +
      '<w:p><mc:AlternateContent><mc:Choice Requires="wps"><w:r><w:t>boxed</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>boxed</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p>';
    expect(officeToText(docx(body))).toBe("new wording\n\nthe link\n\nboxed");
  });

  it("reads a heading from a localised style id, and a list item from its numbering", () => {
    const body =
      para("Einleitung", '<w:pStyle w:val="berschrift2"/>') +
      para("Punkt", '<w:numPr><w:ilvl w:val="0"/></w:numPr>') +
      para("Titulo", '<w:pStyle w:val="Title"/>');
    expect(officeToText(docx(body))).toBe("## Einleitung\n\n- Punkt\n\n# Titulo");
  });
});

describe("the presentation reader", () => {
  it("takes slide order from the presentation, not from the file names", () => {
    const P = 'xmlns:p="p" xmlns:a="a" xmlns:r="r"';
    const slide = (text: string) =>
      `<p:sld ${P}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const rel = (id: string, target: string) =>
      `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="${target}"/>`;
    const pptx = zip({
      "[Content_Types].xml": "<Types/>",
      "ppt/presentation.xml": `<p:presentation ${P}><p:sldIdLst><p:sldId id="256" r:id="rId9"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": `<Relationships>${rel("rId2", "slides/slide1.xml")}${rel("rId9", "/ppt/slides/slide2.xml")}</Relationships>`,
      "ppt/slides/slide1.xml": slide("Shown second"),
      "ppt/slides/slide2.xml": slide("Shown first"),
    });
    expect(officeToText(pptx)).toBe("## Slide 1\n\nShown first\n\n## Slide 2\n\nShown second");
  });
});

describe("limits", () => {
  it("refuses a decompression bomb after the per-entry cap, not after allocating it", () => {
    const bomb = docx("", { "word/document.xml": Buffer.alloc(80 * 1024 * 1024, 0x20) });
    expect(bomb.length).toBeLessThan(200_000);
    const t0 = performance.now();
    expect(readOffice(bomb).failure).toBe("an entry inflates past 64 MB (a decompression bomb?)");
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  // Each read is metered, so naming one part many times cannot reset the cap.
  it("refuses an archive whose reads add up past the total cap", () => {
    const P = 'xmlns:p="p" xmlns:r="r"';
    const ids = Array.from({ length: 6 }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId1"/>`).join("");
    const pptx = zip({
      "ppt/presentation.xml": `<p:presentation ${P}><p:sldIdLst>${ids}</p:sldIdLst></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": '<Relationships><Relationship Id="rId1" Type="x/slide" Target="slides/slide1.xml"/></Relationships>',
      "ppt/slides/slide1.xml": Buffer.alloc(60 * 1024 * 1024, 0x20),
    });
    expect(readOffice(pptx).failure).toBe("the archive inflates past 256 MB");
  });

  it("refuses encrypted entries, unknown compression methods and ZIP64", () => {
    expect(readOffice(docx("", { "word/document.xml": { data: "x", flags: 1 } })).failure).toBe("encrypted ZIP entries");
    expect(readOffice(docx("", { "word/document.xml": { data: "x", method: 12 } })).failure).toBe("unsupported ZIP compression method 12");
    const zip64 = Buffer.from(docx(para("x")));
    zip64.writeUInt16LE(0xffff, zip64.length - 12);
    expect(readOffice(zip64).failure).toBe("ZIP64 archives are not supported");
  });

  it("refuses an archive with more entries than any office file has", () => {
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(10_001, 10);
    expect(readOffice(Buffer.concat([Buffer.from("PK\x03\x04"), end])).failure).toBe("more than 10000 ZIP entries");
  });

  // An .xlsx writes a string once and shows it wherever a cell points at it:
  // 1 MB shown in 400 cells is 400 MB of "text" from a 2 KB entry.
  it("meters shared strings where they are shown, for the whole workbook", () => {
    const big = "word ".repeat(200_000);
    const cells = Array.from({ length: 200 }, (_, r) => `<row r="${r + 1}"><c r="A${r + 1}" t="s"><v>0</v></c></row>`).join("");
    const rel = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="x/${type}" Target="${target}"/>`;
    const xlsx = zip({
      "xl/workbook.xml": '<workbook xmlns:r="r"><sheets><sheet name="A" r:id="rId1"/><sheet name="B" r:id="rId2"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels": `<Relationships>${rel("rId1", "worksheet", "sheet1.xml")}${rel("rId2", "worksheet", "sheet2.xml")}${rel("rId3", "sharedStrings", "sharedStrings.xml")}</Relationships>`,
      "xl/sharedStrings.xml": `<sst><si><t>${big}</t></si></sst>`,
      "xl/sheet1.xml": `<worksheet><sheetData>${cells}</sheetData></worksheet>`,
      "xl/sheet2.xml": `<worksheet><sheetData>${cells}</sheetData></worksheet>`,
    });
    const t0 = performance.now();
    const text = officeToText(xlsx)!;
    expect(text.length).toBeGreaterThan(20 * 1024 * 1024);
    expect(text.length).toBeLessThanOrEqual(25 * 1024 * 1024);
    expect(performance.now() - t0).toBeLessThan(10_000);
  });

  // ODF pads a sheet to its last row with one element repeated a million times.
  it("keeps a repeated OpenDocument row from multiplying without bound", () => {
    const content =
      '<office:document-content><office:body><office:spreadsheet><table:table table:name="S">' +
      "<table:table-row><table:table-cell><text:p>head</text:p></table:table-cell></table:table-row>" +
      '<table:table-row table:number-rows-repeated="1048575"><table:table-cell table:number-columns-repeated="16384"><text:p>x</text:p></table:table-cell></table:table-row>' +
      '<table:table-row table:number-rows-repeated="1048575"><table:table-cell table:number-columns-repeated="16384"/></table:table-row>' +
      "</table:table></office:spreadsheet></office:body></office:document-content>";
    const ods = zip({ mimetype: { data: "application/vnd.oasis.opendocument.spreadsheet", method: 0 }, "content.xml": content });
    const text = officeToText(ods)!;
    expect(text.startsWith("## S\n\n| head |")).toBe(true);
    // The heading, the header row and its rule, then the repeat cap's 1000
    // rows; the empty padding after them is not repeated at all.
    expect(text.split("\n").length).toBe(1004);
  });

  // Linear-time guard: every XML walk moves past the next `>`, so neither an
  // unclosed tag nor a flood of unclosed elements costs a rescan.
  it("walks adversarial XML in linear time", () => {
    const unclosed = "<w:p><w:r><w:t>x".repeat(200_000);
    const cases = [unclosed, `${unclosed}<w:t`, `${para("a")}<!--${"<w:p>".repeat(400_000)}`, `<w:p a="${"<".repeat(1_000_000)}`];
    for (const body of cases) {
      const t0 = performance.now();
      readOffice(docx(body));
      expect(performance.now() - t0).toBeLessThan(3000);
    }
  });
});
