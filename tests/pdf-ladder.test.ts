import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Env names are resolved through the brand, exactly as the engine resolves them
// — so these tests stay correct whichever prefix a consumer configures.
import { envName } from "../src/brand.js";
import { assessPdfText, extractPdf, enabledExtractors, resetPdfLadderCache } from "../src/pdf.js";
import { ANYDOC_SPEC, PDF_INSPECTOR_SPEC, runWithInput } from "../src/pdf/exec.js";

// The subprocess layer runs for real unless a case scripts it: the rungs that
// shell out are exercised against an empty PATH below, and the availability
// cases script what npx or a tool answered.
vi.mock("../src/pdf/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/pdf/exec.js")>();
  return { ...actual, runWithInput: vi.fn(actual.runWithInput) };
});
const runMock = vi.mocked(runWithInput);
const { runWithInput: realRunWithInput } = await vi.importActual<typeof import("../src/pdf/exec.js")>("../src/pdf/exec.js");

// A block, not an expression: a function returned from beforeEach is run as
// its teardown, and mockImplementation returns the mock itself.
beforeEach(() => {
  runMock.mockImplementation(realRunWithInput);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetPdfLadderCache();
  runMock.mockReset();
});

// Text long enough to clear the shape-check floor, so the ratio checks are what
// decide — the way real extractions are judged.
const PROSE = "Recurrent neural networks have been firmly established as state of the art approaches in sequence modelling and machine translation. ".repeat(4);

function withControlBytes(prose: string, n: number): string {
  return prose + String.fromCharCode(2).repeat(n);
}

describe("assessPdfText", () => {
  it("accepts ordinary extracted prose", () => {
    expect(assessPdfText(PROSE).ok).toBe(true);
  });

  it("accepts a short but clean extraction — it judges garbage, not brevity", () => {
    expect(assessPdfText("Figure 1.").ok).toBe(true);
  });

  it("rejects an empty extraction with a scanned-PDF reason", () => {
    expect(assessPdfText("")).toMatchObject({ ok: false });
    expect(assessPdfText("   \n ").reason).toMatch(/no text layer/i);
  });

  // The failure this whole gate exists for: a stream of image/font bytes that
  // inflated, contained `Tj`, and got mined as text. It is long and non-empty,
  // so every length-gated check downstream waves it through.
  it("rejects text laced with binary control bytes, however long", () => {
    const v = assessPdfText(withControlBytes(PROSE, Math.ceil(PROSE.length * 0.05)));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/binary\/control/i);
  });

  it("tolerates the stray control byte a clean extractor leaves behind", () => {
    // pdftotext keeps a few form feeds: ~4e-4 of the text. Must not trip the gate.
    expect(assessPdfText(withControlBytes(PROSE, 1)).ok).toBe(true);
  });

  it("rejects a wall of replacement characters (wrong character map)", () => {
    const v = assessPdfText(PROSE + "�".repeat(Math.ceil(PROSE.length * 0.05)));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/replacement characters/i);
  });

  it("rejects one enormous unbroken run of non-letters", () => {
    const v = assessPdfText("=".repeat(900) + "/".repeat(200));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/unreadable/i);
  });

  // pdftotext ends every page with a form feed. The calibration only ever saw
  // papers with thousands of characters a page; a deck of short slides crossed
  // the control-character ratio on form feeds alone and was refused whole.
  it("accepts pdftotext's page-ending form feeds, however short the pages", () => {
    const slides = Array.from({ length: 30 }, (_, i) => `Slide ${i + 1}: quarterly revenue grew in every region we serve.`).join("\f");
    expect(assessPdfText(slides).ok).toBe(true);
  });

  // A form's fill-in rules are long runs with no letters in them — the shape
  // the garbled-glyph check looks for — and they are not garbage.
  it("accepts a form with long fill-in rules", () => {
    const form = `Name: ${"_".repeat(320)}\nSignature: ${"_".repeat(320)}\nDate: ${".".repeat(320)}\n`.repeat(3);
    expect(assessPdfText(form).ok).toBe(true);
  });

  it("judges astral letters, CJK and Thai the way a code-point count does", () => {
    expect(assessPdfText("𝐀𝐁𝐂 ".repeat(100)).ok).toBe(true);
    expect(assessPdfText("自然言語処理は計算機科学の一分野である。".repeat(40)).ok).toBe(true);
    expect(assessPdfText("ภาษาไทยเป็นภาษาที่มีระบบเสียงวรรณยุกต์".repeat(40)).ok).toBe(true);
  });
});

describe("enabledExtractors", () => {
  it("defaults to the full ladder, strongest first", () => {
    vi.stubEnv(envName("PDF_ENGINE"), undefined);
    expect(enabledExtractors()).toEqual(["pdf-inspector", "anydoc", "firecrawl", "pdftotext", "native", "ocr"]);
  });

  it("drops BOTH rungs that need an implicit install under <PREFIX>_NO_NPX", () => {
    vi.stubEnv(envName("PDF_ENGINE"), undefined);
    vi.stubEnv(envName("NO_NPX"), "1");
    expect(enabledExtractors()).not.toContain("pdf-inspector");
    expect(enabledExtractors()).not.toContain("anydoc");
    expect(enabledExtractors()).toContain("pdftotext");
  });

  it("honours <PREFIX>_PDF_ENGINE by running exactly that rung", () => {
    vi.stubEnv(envName("PDF_ENGINE"), "native");
    expect(enabledExtractors()).toEqual(["native"]);
  });

  it("ignores an unknown engine name rather than emptying the ladder", () => {
    vi.stubEnv(envName("PDF_ENGINE"), "nope");
    expect(enabledExtractors()).toEqual(["pdf-inspector", "anydoc", "firecrawl", "pdftotext", "native", "ocr"]);
  });

  // Only an exact single name was honoured: `pdftotext,native` (the natural way
  // to say "no npx"), `Native` and `none` all silently selected every rung —
  // including the network ones the user was trying to avoid.
  it("reads a comma list, in the order given, whatever the case and spacing", () => {
    vi.stubEnv(envName("PDF_ENGINE"), "pdftotext, Native");
    expect(enabledExtractors()).toEqual(["pdftotext", "native"]);
    vi.stubEnv(envName("PDF_ENGINE"), "native,native");
    expect(enabledExtractors()).toEqual(["native"]);
  });

  it("disables the ladder on none", () => {
    vi.stubEnv(envName("PDF_ENGINE"), "none");
    expect(enabledExtractors()).toEqual([]);
  });

  it("keeps the known names of a list and says which it ignored", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    vi.stubEnv(envName("PDF_ENGINE"), "pdftotext,pdfminer");
    expect(enabledExtractors()).toEqual(["pdftotext"]);
    expect(enabledExtractors()).toEqual(["pdftotext"]);
    expect(warn).toHaveBeenCalledTimes(1); // once per value, not per document
    expect(String(warn.mock.calls[0]![0])).toMatch(/pdfminer/);
    warn.mockRestore();
  });

  it("says so when nothing in the value names a rung", () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    vi.stubEnv(envName("PDF_ENGINE"), "nothing-real");
    enabledExtractors();
    expect(String(warn.mock.calls[0]![0])).toMatch(/full ladder/);
    warn.mockRestore();
  });
});

// The ladder is driven through `engines` + an injected Firecrawl callback, so
// these stay offline and never shell out to npx or poppler.
describe("extractPdf", () => {
  const SCANNED = Buffer.from("%PDF-1.4\nstream\n/Image only, no text operators\nendstream\n", "latin1");
  const TEXTUAL = Buffer.from(`%PDF-1.4\nstream\nBT (${PROSE}) Tj ET\nendstream\n`, "latin1");

  it("returns the first rung whose output passes the gate", async () => {
    const r = await extractPdf(TEXTUAL, { engines: ["native"] });
    expect(r.via).toBe("native");
    expect(r.text).toContain("Recurrent neural networks");
  });

  it("falls through to the next rung when one yields nothing usable", async () => {
    const firecrawl = vi.fn(async () => PROSE);
    const r = await extractPdf(SCANNED, { engines: ["native", "firecrawl"], firecrawl });
    expect(r.via).toBe("firecrawl");
    expect(firecrawl).toHaveBeenCalledOnce();
  });

  it("skips the Firecrawl rung silently when no container is injected", async () => {
    const r = await extractPdf(SCANNED, { engines: ["firecrawl", "native"] });
    expect(r.via).toBeUndefined();
    expect(r.text).toBe("");
  });

  // The point of the whole exercise: when nothing can read the PDF, say so
  // instead of handing a caller text that will end up under a citation.
  it("refuses with a reason when every rung fails", async () => {
    const r = await extractPdf(SCANNED, { engines: ["native"] });
    expect(r.text).toBe("");
    expect(r.via).toBeUndefined();
    expect(r.reason).toMatch(/no text layer/i);
  });

  it("never throws, whatever the bytes are", async () => {
    const r = await extractPdf(Buffer.from([0x00, 0xff, 0xfe, 0x01]), { engines: ["native"] });
    expect(r.text).toBe("");
  });

  // The two rungs that shell out, exercised without network and without caring
  // what the machine has installed: an empty PATH makes both binaries ENOENT, so
  // the spawn path runs and each rung reports itself unavailable. Covers the
  // real invocations (npx -y --prefer-offline …, pdftotext -layout - -) that the
  // suite otherwise never reaches, since setup.ts pins the ladder to `native`.
  it("falls through when neither external extractor can be launched", async () => {
    vi.stubEnv("PATH", "/nonexistent-webindex-test");
    const r = await extractPdf(TEXTUAL, { engines: ["pdf-inspector", "pdftotext"] });
    expect(r.via).toBeUndefined();
    expect(r.text).toBe("");
  });

  // A spent OCR budget and an unreadable document are different facts, and the
  // dossier has to say which. Reporting "no text layer" for a scan the run
  // merely declined to OCR would send a reader hunting a fault in the PDF.
  it("distinguishes a spent OCR budget from a PDF nothing could read", async () => {
    vi.stubEnv(envName("OCR_MAX"), "0"); // setup.ts already pins this; explicit here
    const r = await extractPdf(SCANNED, { engines: ["native", "ocr"] });
    expect(r.text).toBe("");
    expect(r.reason).toMatch(/OCR budget is spent/i);
    expect(r.reason).toContain(envName("OCR_MAX"));
  });

  // Without this, a 40-source run would re-pay a 90s npx discovery per PDF.
  it("remembers an unavailable rung instead of retrying it for every PDF", async () => {
    const firecrawl = vi.fn(async () => undefined);
    await extractPdf(SCANNED, { engines: ["firecrawl", "native"], firecrawl });
    await extractPdf(SCANNED, { engines: ["firecrawl", "native"], firecrawl });
    // Firecrawl is the exception — its own client memoises the probe, and it can
    // legitimately fail on one URL and work on the next, so it IS retried.
    expect(firecrawl).toHaveBeenCalledTimes(2);
  });
});

// Every failed run used to mark its rung "unavailable" for the rest of the
// process. pdf-inspector exits 1 on any PDF it cannot parse and anydoc on any
// scan, so ONE truncated download or login page at a .pdf URL disabled the best
// rungs for every later document — for the MCP server, until it restarted.
describe("rung availability", () => {
  const GOOD = Buffer.from(`%PDF-1.4\nstream\nBT (${PROSE}) Tj ET\nendstream\n`, "latin1");
  const TRUNCATED = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length 9", "latin1");
  const SCANNED = Buffer.from("%PDF-1.4\nstream\n/Image only, no text operators\nendstream\n", "latin1");
  const npxCalls = (spec: string) => runMock.mock.calls.filter(([cmd, args]) => cmd === "npx" && args.includes(spec));

  /** A stand-in for a working tool: it reads GOOD and rejects everything else the way pdf-inspector does. */
  function workingTool() {
    runMock.mockImplementation(async (_cmd, _args, input) =>
      input.equals(GOOD)
        ? { ok: true, stdout: `# Paper\n\n${PROSE}` }
        : { ok: false, stdout: "", error: "exit 1", stderr: "Error: process_pdf: Invalid cross-reference table\n    at main (index.js:1:1)\n" },
    );
  }

  it("keeps a rung that failed on one document for the next one", async () => {
    workingTool();
    const engines = ["pdf-inspector", "native"] as const;
    expect((await extractPdf(GOOD, { engines: [...engines] })).via).toBe("pdf-inspector");
    expect((await extractPdf(TRUNCATED, { engines: [...engines] })).text).toBe("");
    expect((await extractPdf(GOOD, { engines: [...engines] })).via).toBe("pdf-inspector");
  });

  it("gives the tool's own words for a document it rejected", async () => {
    workingTool();
    const r = await extractPdf(TRUNCATED, { engines: ["pdf-inspector"] });
    expect(r.reason).toContain("pdf-inspector: Error: process_pdf: Invalid cross-reference table");
    expect(r.reason).not.toContain("at main"); // one line, not the stack
  });

  it("marks the npx rungs unavailable when npm cannot reach its registry, and says how to skip them", async () => {
    runMock.mockResolvedValue({ ok: false, stdout: "", error: "exit 1", stderr: "npm error code ECONNREFUSED\nnpm error syscall connect\n" });
    const r = await extractPdf(SCANNED, { engines: ["pdf-inspector", "anydoc", "native"] });
    expect(r.reason).toMatch(/no text layer/);
    expect(r.reason).toMatch(/pdf-inspector could not be installed \(npm error ECONNREFUSED — offline\?\)/);
    expect(r.reason).toContain(`${envName("NO_NPX")}=1`);
    // The same registry serves anydoc: it is not asked to fail the same way.
    expect(npxCalls(ANYDOC_SPEC)).toHaveLength(0);
    // …and neither is asked again for the next document, which still hears why.
    runMock.mockClear();
    const again = await extractPdf(SCANNED, { engines: ["pdf-inspector", "anydoc", "native"] });
    expect(runMock).not.toHaveBeenCalled();
    expect(again.reason).toMatch(/could not be installed/);
  });

  it("gives up on an npx rung that timed out before it ever worked", async () => {
    runMock.mockResolvedValue({ ok: false, stdout: "", error: "timed out after 90s" });
    await extractPdf(GOOD, { engines: ["pdf-inspector", "native"] });
    await extractPdf(GOOD, { engines: ["pdf-inspector", "native"] });
    expect(npxCalls(PDF_INSPECTOR_SPEC)).toHaveLength(1);
  });

  it("keeps an npx rung that worked before and then timed out on one large document", async () => {
    workingTool();
    await extractPdf(GOOD, { engines: ["pdf-inspector", "native"] });
    runMock.mockResolvedValueOnce({ ok: false, stdout: "", error: "timed out after 90s" });
    await extractPdf(SCANNED, { engines: ["pdf-inspector", "native"] });
    expect((await extractPdf(GOOD, { engines: ["pdf-inspector", "native"] })).via).toBe("pdf-inspector");
  });

  // npm's defaults (two retries, 10 s → 60 s back-off) made an unreachable
  // registry cost ~70 s per rung, twice per PDF, on every CLI invocation.
  it("runs npx with a fail-fast network policy unless npm was configured", async () => {
    runMock.mockResolvedValue({ ok: false, stdout: "", error: "not installed" });
    await extractPdf(GOOD, { engines: ["pdf-inspector"] });
    const env = runMock.mock.calls[0]![4]?.env;
    expect(env).toMatchObject({ npm_config_fetch_retries: "1", npm_config_fetch_retry_mintimeout: "1000", npm_config_fetch_retry_maxtimeout: "2000" });

    resetPdfLadderCache();
    runMock.mockClear();
    vi.stubEnv("npm_config_fetch_retries", "5");
    await extractPdf(GOOD, { engines: ["pdf-inspector"] });
    expect(runMock.mock.calls[0]![4]?.env?.npm_config_fetch_retries).toBe("5");
  });

  it("honours <PREFIX>_NPX_TIMEOUT_MS", async () => {
    vi.stubEnv(envName("NPX_TIMEOUT_MS"), "5000");
    runMock.mockResolvedValue({ ok: false, stdout: "", error: "not installed" });
    await extractPdf(GOOD, { engines: ["pdf-inspector"] });
    expect(runMock.mock.calls[0]![3]).toBe(5000);
  });

  // An HTML login page, an error body: the tools would all exit 1 and the
  // native reader find nothing — and the note blamed a scanned PDF.
  it("says 'not a PDF' for bytes without a PDF header, without running a tool", async () => {
    const r = await extractPdf(Buffer.from("<!doctype html><title>Sign in</title>"), { engines: ["pdf-inspector", "native"] });
    expect(r.reason).toMatch(/not a PDF/);
    expect(runMock).not.toHaveBeenCalled();
  });

  it("says 'encrypted' rather than 'scanned' for an encrypted PDF nothing could read", async () => {
    const encrypted = Buffer.concat([SCANNED, Buffer.from("trailer\n<< /Root 1 0 R /Encrypt 9 0 R >>\n%%EOF\n", "latin1")]);
    const r = await extractPdf(encrypted, { engines: ["native"] });
    expect(r.reason).toMatch(/encrypted PDF/);
    expect(r.reason).not.toMatch(/scanned/);
  });
});
