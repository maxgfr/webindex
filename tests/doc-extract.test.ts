import { describe, it, expect, beforeEach, vi } from "vitest";
// Env names resolve through the brand, exactly as the engine resolves them.
import { envName } from "../src/brand.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchAndExtract } from "../src/fetch.js";
import { resetDocLadderCache } from "../src/doc.js";
import { installFetchMock, routes } from "./fetchmock.js";
import { resetPdfLadderCache } from "../src/pdf.js";

// A real .docx — a ZIP whose first bytes are `PK\x03\x04` and which is full of
// bytes above 0x7F. Committed rather than generated so the regression below is
// pinned to a genuine Office file, not to an approximation of one.
const DOCX = readFileSync(join(__dirname, "fixtures", "docs", "sample.docx"));

const OFFICE_CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

beforeEach(() => {
  resetDocLadderCache();
  resetPdfLadderCache();
  // No rung may shell out in the suite (see tests/setup.ts). The point of these
  // tests is what happens when nothing can read the document — which is exactly
  // the situation the bug used to mishandle.
  vi.stubEnv(envName("DOC_ENGINE"), "none");
});

describe("office documents fetched from the web", () => {
  // THE regression. Before the document ladder existed, a .docx was neither a
  // PDF nor HTML, so fetchAndExtract fell through to `text = res.body` — the ZIP
  // decoded as UTF-8. Hundreds of kilobytes of U+FFFD entered the dossier as
  // citable evidence, and the quality gate that would have caught it instantly
  // was only ever applied to PDFs.
  it("never hands back the raw bytes of a .docx as source text", async () => {
    installFetchMock(routes([["x.test/report.docx", { bytes: DOCX, contentType: OFFICE_CT }]]));
    const r = await fetchAndExtract("https://x.test/report.docx");

    expect(r.text).toBe("");
    expect(r.text).not.toContain("PK");
    expect(r.text).not.toContain("�");
    expect(r.note).toMatch(/could not extract text/i);
  });

  it("says which document it could not read, and why", async () => {
    installFetchMock(routes([["x.test/deck.pptx", { bytes: DOCX, contentType: OFFICE_CT }]]));
    const r = await fetchAndExtract("https://x.test/deck.pptx");
    expect(r.note).toContain("https://x.test/deck.pptx");
    expect(r.note).toMatch(/no document converter available/i);
  });

  // The same fall-through applied when only the content-type gave the format
  // away. That path also has to re-fetch the bytes, because the first GET
  // decoded them as text.
  it("routes a content-type-only office document (no extension in the URL)", async () => {
    installFetchMock(routes([["x.test/download?id=7", { bytes: DOCX, contentType: OFFICE_CT }]]));
    const r = await fetchAndExtract("https://x.test/download?id=7");
    expect(r.text).toBe("");
    expect(r.note).toMatch(/could not extract text/i);
  });

  // The Firecrawl rung, reached through the real fetch seam: an office document
  // must go to the DOCUMENT ladder with Firecrawl injected as rung 2, never down
  // the HTML Firecrawl path that pages take.
  it("converts an office document through the Firecrawl rung", async () => {
    vi.stubEnv(envName("DOC_ENGINE"), "firecrawl");
    const scrape = { success: true, data: { markdown: "# Q3 report\n\nRevenue grew across every region.", metadata: { title: "Q3", statusCode: 200 } } };
    installFetchMock((url) => {
      if (url.includes("/scrape")) return { body: JSON.stringify(scrape), contentType: "application/json" };
      if (url.includes("x.test/q3.docx")) return { bytes: DOCX, contentType: OFFICE_CT };
      return { body: "ok" }; // the availability probe
    });
    const r = await fetchAndExtract("https://x.test/q3.docx", { firecrawl: "http://fc-doc.test" });
    expect(r.extractor).toBe("firecrawl");
    expect(r.text).toContain("Revenue grew");
  });

  // CSV is the one format in the table that is already readable as plain text.
  // Refusing it when the converter is absent would be a regression, so it falls
  // back to the raw body instead of joining the binary formats in refusing.
  it("falls back to the raw text of a .csv rather than refusing it", async () => {
    installFetchMock(routes([["x.test/data.csv", { body: "a,b,c\n1,2,3\n", contentType: "text/csv" }]]));
    const r = await fetchAndExtract("https://x.test/data.csv");
    expect(r.text).toContain("a,b,c");
  });
});

// Download routes rarely name an office type: `application/octet-stream` or
// `application/zip`, with the real name in Content-Disposition. Those used to
// fall through to the text branch — 35 KB of `PK\u0003\u0004…` returned as
// the document's text, with no note, exactly what this ladder exists to stop.
describe("office documents behind a download route", () => {
  it.each([
    ["octet-stream with a filename", { contentType: "application/octet-stream", headers: { "content-disposition": "attachment; filename=report.docx" } }],
    ["octet-stream alone", { contentType: "application/octet-stream" }],
    ["application/zip", { contentType: "application/zip" }],
    ["no content-type", { contentType: "" }],
  ])("routes a .docx served as %s to the document ladder", async (_label, response) => {
    installFetchMock(routes([["x.test/download", { bytes: DOCX, ...response }]]));
    const r = await fetchAndExtract("https://x.test/download?id=docx");
    expect(r.documentType).toBe("doc");
    expect(r.text).toBe("");
    expect(r.note).toMatch(/could not extract text/i);
  });

  // The built-in rung, end to end: offline and without npx, a download route's
  // .docx is still read — and the refusals above still hold for what it cannot.
  it("reads a .docx behind a download route through the built-in rung", async () => {
    vi.stubEnv(envName("DOC_ENGINE"), "builtin");
    const report = readFileSync(join(__dirname, "fixtures", "docs", "report.docx"));
    installFetchMock(routes([["x.test/download", { bytes: report, contentType: "application/octet-stream" }]]));
    const r = await fetchAndExtract("https://x.test/download?id=9");
    expect(r).toMatchObject({ documentType: "doc", extractor: "builtin" });
    expect(r.text).toContain("# Quarterly report");
    expect(r.note).toBeUndefined();
  });

  it("still refuses, with the reader's reason, a document the built-in rung cannot read", async () => {
    vi.stubEnv(envName("DOC_ENGINE"), "builtin");
    const legacy = readFileSync(join(__dirname, "fixtures", "docs", "legacy.xls"));
    installFetchMock(routes([["x.test/old.xls", { bytes: legacy, contentType: "application/vnd.ms-excel" }]]));
    const r = await fetchAndExtract("https://x.test/old.xls");
    expect(r.text).toBe("");
    expect(r.note).toMatch(/could not extract text — builtin: a legacy binary or password-protected Office file/);
  });

  it("reads a CSV named by Content-Disposition as its text when nothing converts it", async () => {
    installFetchMock(() => ({
      body: "region,q1\nEMEA,1.2\n",
      contentType: "application/octet-stream",
      headers: { "content-disposition": 'attachment; filename="q1.csv"' },
    }));
    const r = await fetchAndExtract("https://x.test/export?id=3");
    expect(r).toMatchObject({ text: "region,q1\nEMEA,1.2\n", documentType: "doc" });
  });

  it("reads a .docx URL that answered HTML as the page it is", async () => {
    installFetchMock(() => ({ body: "<html><body><main><p>Please sign in to download this report.</p></main></body></html>", contentType: "text/html" }));
    const r = await fetchAndExtract("https://x.test/report.docx");
    expect(r.text).toContain("Please sign in");
    expect(r.documentType).toBeUndefined();
    expect(r.note).toMatch(/looked like an office document but the server returned HTML/);
  });
});
