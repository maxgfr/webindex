import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { docFormatForUrl, docFormatForContentType, DOC_EXTENSIONS, sniffDocument } from "../src/doc.js";
import { looksLikePdfUrl } from "../src/fetch.js";
import { ANYDOC_SPEC, PDF_INSPECTOR_SPEC } from "../src/pdf/exec.js";

// The npx rungs run a PINNED range, not `latest`. Floating would let a breaking
// release change what every dossier is grounded on, and a rung that starts
// emitting something subtly different degrades quietly — the quality gate
// catches garbage, not a changed-but-plausible extraction. anydoc is 0.x, where
// semver allows a MINOR to break, so it takes patches only.
describe("the npm specs the rungs run", () => {
  it("pins both to a range instead of floating on latest", () => {
    expect(PDF_INSPECTOR_SPEC).toBe("@firecrawl/pdf-inspector@1");
    expect(ANYDOC_SPEC).toBe("@firecrawl/anydoc@0.1");
  });
});

describe("docFormatForUrl", () => {
  it("recognises every office extension it claims to route", () => {
    for (const ext of DOC_EXTENSIONS) {
      expect(docFormatForUrl(`https://x.test/file.${ext}`), ext).toBeDefined();
    }
  });

  it("recognises an extension regardless of case, query or fragment", () => {
    expect(docFormatForUrl("https://x.test/Report.DOCX")).toBeDefined();
    expect(docFormatForUrl("https://x.test/report.docx?v=2")).toBeDefined();
    expect(docFormatForUrl("https://x.test/report.docx#page3")).toBeDefined();
  });

  it("leaves web pages and PDFs alone", () => {
    // PDFs have their own ladder with rungs this one does not have; routing them
    // here would silently downgrade every paper a research run fetches.
    expect(docFormatForUrl("https://x.test/paper.pdf")).toBeUndefined();
    expect(docFormatForUrl("https://x.test/page.html")).toBeUndefined();
    expect(docFormatForUrl("https://x.test/api.json")).toBeUndefined();
    expect(docFormatForUrl("https://x.test/no-extension")).toBeUndefined();
  });

  it("does not mistake a dotted path segment for an extension", () => {
    expect(docFormatForUrl("https://x.test/v1.2/guide")).toBeUndefined();
  });

  // The three shapes a naive "does the URL contain .docx" test gets wrong. A
  // false positive here costs a wasted binary re-fetch and a refusal note on a
  // page that was readable all along.
  it("reads the RESOURCE's extension, not one that appears elsewhere in the URL", () => {
    expect(docFormatForUrl("https://docs.example.com/guide")).toBeUndefined(); // dotted hostname
    expect(docFormatForUrl("https://x.test/a.docx/preview")).toBeUndefined(); // extension mid-path
    expect(docFormatForUrl("https://x.test/archive.tar.gz")).toBeUndefined(); // unrelated double extension
  });

  // The two ladders must partition the space: a URL routed to both would fetch
  // twice and report whichever branch happened to run first.
  it("never claims a URL is both a PDF and an office document", () => {
    const urls = ["https://x.test/paper.pdf", "https://arxiv.org/pdf/2502.19732", "https://x.test/report.docx", "https://x.test/data.csv", "https://x.test/"];
    for (const u of urls) expect(looksLikePdfUrl(u) && !!docFormatForUrl(u)).toBe(false);
  });

  // The security property: a format reaching argv must come from the table, so
  // nothing a URL carries can ever become a converter argument.
  it("only ever names a format the table declares — never a slice of the URL", () => {
    expect(docFormatForUrl("https://x.test/evil.docx?x=--output=/etc/passwd")?.format).toBeUndefined();
    expect(docFormatForUrl("https://x.test/data.csv")?.format).toBe("csv");
  });
});

describe("docFormatForContentType", () => {
  it("recognises the OOXML, OpenDocument and legacy office types", () => {
    expect(docFormatForContentType("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBeDefined();
    expect(docFormatForContentType("application/vnd.oasis.opendocument.spreadsheet")).toBeDefined();
    expect(docFormatForContentType("application/msword")).toBeDefined();
    expect(docFormatForContentType("application/epub+zip")).toBeDefined();
  });

  it("strips parameters and ignores case", () => {
    expect(docFormatForContentType("TEXT/CSV; charset=utf-8")?.format).toBe("csv");
  });

  it("leaves html, json and pdf alone", () => {
    expect(docFormatForContentType("text/html")).toBeUndefined();
    expect(docFormatForContentType("application/json")).toBeUndefined();
    expect(docFormatForContentType("application/pdf")).toBeUndefined();
    expect(docFormatForContentType("")).toBeUndefined();
  });
});

describe("the text-fallback policy", () => {
  it("refuses binary formats but lets csv fall back to its raw text", () => {
    // A .docx that nothing can convert must refuse: the alternative is citing a
    // decoded ZIP. A .csv was already readable as text before this ladder, so
    // refusing it would be a regression rather than a fix.
    expect(docFormatForUrl("https://x.test/a.docx")?.textFallback).toBe(false);
    expect(docFormatForUrl("https://x.test/a.xlsx")?.textFallback).toBe(false);
    expect(docFormatForUrl("https://x.test/a.epub")?.textFallback).toBe(false);
    expect(docFormatForUrl("https://x.test/a.csv")?.textFallback).toBe(true);
  });
});

// Download routes answer `application/octet-stream` (or nothing at all) for
// PDFs and office files as often as they name the type. Routing on the URL
// and the header alone decoded those bytes as prose; the bytes themselves are
// what can be trusted.
describe("sniffDocument", () => {
  const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", "docs", name));

  it("recognises a PDF by its header, even after up to 1 KB of junk", () => {
    expect(sniffDocument(Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj", "latin1"))).toBe("pdf");
    expect(sniffDocument(Buffer.from(`${"\r\n".repeat(200)}%PDF-1.4\n`, "latin1"))).toBe("pdf");
    expect(sniffDocument(Buffer.from(`${" ".repeat(2000)}%PDF-1.4\n`, "latin1"))).toBeUndefined();
  });

  it("recognises OOXML, OpenDocument, legacy OLE and RTF as office documents", () => {
    for (const name of ["sample.docx", "notes.odt", "legacy.xls"]) {
      expect(sniffDocument(fixture(name)), name).toEqual({ textFallback: false });
    }
    expect(sniffDocument(Buffer.from("{\\rtf1\\ansi Hello}", "latin1"))).toEqual({ textFallback: false });
  });

  // A ZIP is only an office document when it carries a package manifest: a
  // source archive routed to the converter would be refused as unreadable
  // when it should be reported as an archive.
  it("leaves a ZIP without a package manifest alone", () => {
    expect(sniffDocument(Buffer.from("PK\x03\x04\x14\x00\x00\x00\x08\x00src/index.ts", "latin1"))).toBeUndefined();
  });

  it("leaves text, HTML and empty bodies alone", () => {
    expect(sniffDocument(Buffer.from("<!doctype html><title>Login</title>"))).toBeUndefined();
    expect(sniffDocument(Buffer.from("region,q1\nEMEA,1.2\n"))).toBeUndefined();
    expect(sniffDocument(Buffer.alloc(0))).toBeUndefined();
  });
});
