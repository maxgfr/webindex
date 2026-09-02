import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// Env names are resolved through the brand, exactly as the engine resolves them
// — so these tests stay correct whichever prefix a consumer configures.
import { envName } from "../src/brand.js";
import { ocrPdf, ocrTools, ocrBudgetLeft, resetOcrBudget, resetOcrTools } from "../src/pdf/ocr.js";
import { runWithInput } from "../src/pdf/exec.js";

// OCR shells out to `copyable-pdf`, which shells out to tesseract and rasterises
// at 300 DPI — machine-dependent and seconds per page. The suite stays offline
// and deterministic (CONTRIBUTING.md, rule 3), so the subprocess layer is
// stubbed and the CONTRACT is what gets tested: which binaries gate the rung,
// what argv it builds, where it reads its output from, and that the temp
// directory never survives.
vi.mock("../src/pdf/exec.js", () => ({
  runWithInput: vi.fn(async () => ({ ok: false, stdout: "", error: "not installed" })),
  PDF_INSPECTOR_SPEC: "@firecrawl/pdf-inspector@1",
  ANYDOC_SPEC: "@firecrawl/anydoc@0.1",
}));
const runMock = vi.mocked(runWithInput);

const PDF = Buffer.from("%PDF-1.4 a scan with no text layer");

/** Both probes succeed, and `copyable-pdf` writes the .md it promises. */
function toolsPresent(markdown = "OCR'd prose from the scan") {
  runMock.mockImplementation(async (_cmd, args) => {
    // Guard the index before using it. `indexOf` returns -1 on the probe calls
    // (`copyable-pdf --help`, `tesseract --version`, which carry no `-o`), and
    // `args[-1 + 1]` is `args[0]` — so this used to write files literally named
    // `--help` and `--version` into the repo root, and they got committed.
    const i = args.indexOf("-o");
    const out = i >= 0 ? args[i + 1] : undefined;
    if (out) writeFileSync(out.replace(/\.pdf$/, ".md"), markdown);
    return { ok: true, stdout: "" };
  });
}

// tests/setup.ts pins the budget to 0 for the whole suite (the rung must never
// spawn a real converter). These tests are the ones that DO drive it, against
// the stub above, so they give themselves a budget back.
beforeEach(() => vi.stubEnv(envName("OCR_MAX"), "3"));

afterEach(() => {
  vi.unstubAllEnvs();
  resetOcrBudget();
  resetOcrTools();
  runMock.mockReset();
  runMock.mockResolvedValue({ ok: false, stdout: "", error: "not installed" });
});

describe("ocrTools", () => {
  it("reports each binary separately", async () => {
    runMock.mockImplementation(async (cmd) => ({ ok: cmd === "tesseract", stdout: "" }));
    expect(await ocrTools()).toEqual({ copyablePdf: false, tesseract: true });
  });

  it("probes the binaries once per process, not once per document", async () => {
    // Two subprocesses with a 20 s ceiling each, spawned again for every scanned
    // PDF in a run, when the answer cannot change mid-run.
    toolsPresent();
    await ocrPdf(PDF);
    await ocrPdf(PDF);
    await ocrTools();
    const probes = runMock.mock.calls.filter((c) => !c[1].includes("-o"));
    expect(probes).toHaveLength(2); // copyable-pdf --help, tesseract --version — once
    expect(runMock.mock.calls.filter((c) => c[1].includes("-o"))).toHaveLength(2); // the real runs
  });

  it("shares one probe between concurrent callers", async () => {
    runMock.mockImplementation(async () => ({ ok: true, stdout: "" }));
    await Promise.all([ocrTools(), ocrTools(), ocrTools()]);
    expect(runMock).toHaveBeenCalledTimes(2);
  });

  it("forgets the answer through the test seam", async () => {
    runMock.mockImplementation(async () => ({ ok: false, stdout: "" }));
    expect((await ocrTools()).tesseract).toBe(false);
    runMock.mockImplementation(async () => ({ ok: true, stdout: "" }));
    expect((await ocrTools()).tesseract).toBe(false); // memoised
    resetOcrTools();
    expect((await ocrTools()).tesseract).toBe(true);
  });
});

describe("ocrPdf", () => {
  it("returns the markdown copyable-pdf wrote", async () => {
    toolsPresent("Provided proper attribution is provided…");
    expect(await ocrPdf(PDF)).toContain("attribution");
  });

  it("passes the PDF as a FILE, not on stdin, and asks for markdown", async () => {
    toolsPresent();
    await ocrPdf(PDF);
    // calls: copyable-pdf --help, tesseract --version, then the real run
    const run = runMock.mock.calls.find((c) => c[0] === "copyable-pdf" && c[1].includes("-o"))!;
    const args = run[1];
    expect(args).toContain("-m"); // the .md we then read
    expect(args.at(-1)).toMatch(/in\.pdf$/); // a path, not "-"
    expect(run[2]).toEqual(Buffer.alloc(0)); // stdin closed immediately
  });

  // copyable-pdf answers a missing tesseract by offering `brew install` /
  // `sudo apt-get install -y` and waiting on stdin. A research run must never
  // install a system package as a side effect, so the rung is gated BEFORE the
  // tool is ever spawned.
  it("never spawns the converter when tesseract is missing", async () => {
    runMock.mockImplementation(async (cmd) => ({ ok: cmd === "copyable-pdf", stdout: "" }));
    expect(await ocrPdf(PDF)).toBeUndefined();
    expect(runMock.mock.calls.some((c) => c[1].includes("-o"))).toBe(false);
  });

  it("gives up when the converter fails, rather than throwing", async () => {
    runMock.mockImplementation(async (_cmd, args) => ({ ok: !args.includes("-o"), stdout: "" }));
    expect(await ocrPdf(PDF)).toBeUndefined();
  });

  it("gives up when the converter exits 0 but writes no markdown", async () => {
    runMock.mockResolvedValue({ ok: true, stdout: "" });
    expect(await ocrPdf(PDF)).toBeUndefined();
  });

  it("leaves no temp directory behind, on success or failure", async () => {
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith("webindex-tests-ocr-")).length;
    toolsPresent();
    await ocrPdf(PDF);
    runMock.mockResolvedValue({ ok: false, stdout: "", error: "boom" });
    await ocrPdf(PDF);
    const after = readdirSync(tmpdir()).filter((f) => f.startsWith("webindex-tests-ocr-")).length;
    expect(after).toBe(before);
  });

  it("honours <PREFIX>_OCR_LANG", async () => {
    vi.stubEnv(envName("OCR_LANG"), "fra+eng");
    toolsPresent();
    await ocrPdf(PDF);
    const run = runMock.mock.calls.find((c) => c[1].includes("-o"))!;
    expect(run[1][run[1].indexOf("-l") + 1]).toBe("fra+eng");
  });
});

describe("the per-process OCR budget", () => {
  // Without it, a run that meets ten scanned PDFs pays OCR ten times over — at
  // seconds per page that is the difference between a slow run and a hung one.
  it("stops after <PREFIX>_OCR_MAX documents", async () => {
    vi.stubEnv(envName("OCR_MAX"), "2");
    toolsPresent();
    expect(await ocrPdf(PDF)).toBeDefined();
    expect(await ocrPdf(PDF)).toBeDefined();
    expect(ocrBudgetLeft()).toBe(0);
    expect(await ocrPdf(PDF)).toBeUndefined();
  });

  it("does not spend budget on a rung that could not run at all", async () => {
    vi.stubEnv(envName("OCR_MAX"), "2");
    runMock.mockImplementation(async (cmd) => ({ ok: cmd === "tesseract", stdout: "" }));
    await ocrPdf(PDF);
    expect(ocrBudgetLeft()).toBe(2);
  });

  it("can be switched off entirely with 0", async () => {
    vi.stubEnv(envName("OCR_MAX"), "0");
    toolsPresent();
    expect(await ocrPdf(PDF)).toBeUndefined();
    expect(runMock).not.toHaveBeenCalled();
  });
});
