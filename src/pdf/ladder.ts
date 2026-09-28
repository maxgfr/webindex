import { env, envFlag, envName } from "../brand.js";
import { runWithInput, ANYDOC_SPEC, PDF_INSPECTOR_SPEC } from "./exec.js";
import { failureDetail, resetNpxState, runNpx, skipNpxHint } from "./npx.js";
import { assessPdfText, NO_TEXT_LAYER } from "./quality.js";
import { pdfToText } from "./native.js";
import { ocrPdf, ocrBudgetLeft, ocrTools, resetOcrBudget, resetOcrTools } from "./ocr.js";

// The PDF extractor ladder: try the strongest tool available, fall through when
// it is missing or its output fails the quality gate, and refuse rather than
// cite what nothing could read.
//
// Same shape as the discovery cascade (SearXNG → DuckDuckGo → … in gather.ts):
// stop at the first rung that returns something good enough. The difference is
// that "good enough" is decided by assessPdfText rather than a result count,
// because a bad PDF extraction is not empty — it is hundreds of kilobytes of
// plausible-looking garbage.
//
// Rung order, and why:
//   1. pdf-inspector  the best output by a wide margin (real Markdown, reading
//                     order, tables). Costs one ~6 MB npx download the first
//                     time it is ever used. Pinned to a compatible range rather
//                     than `latest` — see the specs in ./exec.ts.
//   2. anydoc         the same conversion, reached through the office-document
//                     converter (backends/doc/): anydoc embeds pdf-inspector for
//                     text PDFs, and on a real paper the two outputs differ by a
//                     single trailing newline. It sits here purely for platform
//                     coverage — npm publishes an anydoc binary for darwin-x64
//                     and pdf-inspector does not, so on an Intel Mac this is the
//                     rung that keeps PDFs readable without Docker or poppler.
//                     Costs nothing where rung 1 already worked: it only ever
//                     runs after rung 1 has failed.
//   3. firecrawl      the caller's already-running container. Covers hosts with
//                     no npm at all, and any platform neither binary is built
//                     for, because Docker runs the linux-x64 image there anyway.
//   4. pdftotext      poppler, if it happens to be installed. Fast, no network.
//   5. native         the built-in reader. Always present, frequently wrong;
//                     kept only so an offline machine with no tools at all still
//                     gets something, and gated hard by assessPdfText.
//   6. ocr            copyable-pdf + tesseract, if both are installed. The only
//                     rung that can read a page with NO text layer, which is
//                     precisely what every rung above it fails on. Last because
//                     it is the only expensive one (~2.7s per page), and it is
//                     budgeted per process — see ./ocr.ts.

export type PdfExtractorId = "pdf-inspector" | "anydoc" | "firecrawl" | "pdftotext" | "native" | "ocr";

export const PDF_EXTRACTORS: PdfExtractorId[] = ["pdf-inspector", "anydoc", "firecrawl", "pdftotext", "native", "ocr"];

export interface PdfExtraction {
  text: string;
  /** Which rung produced `text`. Absent when every rung failed. */
  via?: PdfExtractorId;
  /** Why the result is empty, when it is — suitable for a dossier note. */
  reason?: string;
}

export interface PdfLadderOptions {
  /**
   * Fetch this PDF's text through an already-running Firecrawl, or undefined
   * when there is none. Injected by the caller so this module stays free of the
   * Firecrawl client (and so tests can drive the rung without a container).
   */
  firecrawl?: () => Promise<string | undefined>;
  /** Restrict/reorder the ladder. Defaults to PDF_EXTRACTORS. */
  engines?: PdfExtractorId[];
}

const PDFTOTEXT_TIMEOUT_MS = 60_000;

// Rungs proven unavailable in this process (npm absent or offline, poppler not
// installed, unsupported platform), with the reason worth repeating. Without
// this, a 40-source run would re-pay the same failed discovery for every single
// PDF. Only a failure that says something about the TOOL lands here: one that
// says something about a document (it rejected a truncated file, a scan) must
// not cost every later document its best rung — see ./npx.ts.
const dead = new Map<PdfExtractorId, Unread>();

/** Test seam: forget which rungs and OCR binaries were found, and refill the OCR budget. */
export function resetPdfLadderCache(): void {
  dead.clear();
  resetNpxState();
  resetOcrBudget();
  resetOcrTools();
}

const warnedEngineValues = new Set<string>();

/**
 * The rungs a `<PREFIX>_<NAME>` engine variable asks for: a comma list of rung
 * names in the order to try them, any case, or `none` for no rung at all.
 * Undefined when the variable is unset or names no known rung — the caller's
 * cue to use its default ladder.
 *
 * Only an exact single name used to be honoured, so `pdftotext,native` (the
 * natural way to say "no npx"), `Native` and `none` all silently selected
 * every rung, including the network ones the user was avoiding. Unknown names
 * are now said out loud, once per value.
 */
export function enginesFromEnv<T extends string>(name: string, known: readonly T[]): T[] | undefined {
  const raw = env(name)?.trim();
  if (!raw) return undefined;
  const asked = raw
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (asked.length === 1 && asked[0] === "none") return [];
  const picked = [...new Set(asked.filter((s): s is T => (known as readonly string[]).includes(s)))];
  const unknown = asked.filter((s) => !(known as readonly string[]).includes(s));
  if (unknown.length && !warnedEngineValues.has(`${name}=${raw}`)) {
    warnedEngineValues.add(`${name}=${raw}`);
    const fallback = picked.length ? "" : " — using the full ladder";
    process.emitWarning(`${envName(name)}: ignoring unknown rung ${unknown.map((u) => `"${u}"`).join(", ")} (known: ${known.join(", ")}, or none)${fallback}`);
  }
  return picked.length ? picked : undefined;
}

/**
 * The rungs to try, honouring `<PREFIX>_PDF_ENGINE` (a comma list of rungs to
 * run, in order, or `none`) and `<PREFIX>_NO_NPX` (skip the rungs that need an
 * implicit install), where `<PREFIX>` is whatever the consuming skill declared
 * via `configure()`.
 *
 * An explicit `engines` list wins over both: it is the most specific instruction
 * available, and it is how callers and tests drive the ladder deterministically
 * without fighting whatever the environment happens to say.
 */
export function enabledExtractors(engines?: PdfExtractorId[]): PdfExtractorId[] {
  if (engines) return engines;
  const chosen = enginesFromEnv("PDF_ENGINE", PDF_EXTRACTORS);
  if (chosen) return chosen;
  // Both npx rungs go, not just the first: `anydoc` needs the same implicit
  // install, so leaving it in would defeat the point of the switch.
  if (envFlag("NO_NPX")) return PDF_EXTRACTORS.filter((e) => e !== "pdf-inspector" && e !== "anydoc");
  return PDF_EXTRACTORS;
}

/** A rung that produced no text, and what is worth saying about it. */
interface Unread {
  text?: undefined;
  /** Worth telling the reader: the tool's own words, or why it cannot run. */
  failure?: string;
  /** What the reader can do about it, said once however many rungs need it. */
  hint?: string;
  /** The rung cannot run in this process at all; stop asking. */
  unavailable?: boolean;
}

/** What one rung made of the PDF: text to judge, or why there is none. */
type RungResult = { text: string } | Unread;

async function viaNpx(id: PdfExtractorId, spec: string, args: string[], bytes: Buffer): Promise<RungResult> {
  const r = await runNpx(spec, args, bytes);
  if (r.ok) return { text: r.stdout };
  // npx itself missing is the ordinary state of a machine without npm, not news.
  if (r.unavailable === "not installed") return { unavailable: true };
  if (r.unavailable) return { unavailable: true, failure: `${id} ${r.unavailable}`, hint: skipNpxHint() };
  return { failure: failureDetail(id, r) };
}

async function viaPdftotext(bytes: Buffer): Promise<RungResult> {
  // `-layout` preserves column structure, which is what keeps a two-column
  // paper's sentences from interleaving. Trailing `-` writes to stdout.
  const r = await runWithInput("pdftotext", ["-layout", "-", "-"], bytes, PDFTOTEXT_TIMEOUT_MS);
  // pdftotext ends each page with a form feed; a reader wants a paragraph break.
  if (r.ok) return { text: r.stdout.replace(/\f/g, "\n\n") };
  return r.error === "not installed" ? { unavailable: true } : { failure: failureDetail("pdftotext", r) };
}

async function viaOcr(bytes: Buffer): Promise<RungResult> {
  const text = await ocrPdf(bytes);
  if (text !== undefined) return { text };
  // ocrPdf says only "no text". The tools decide which kind of no: missing
  // binaries are the machine's; a conversion that failed or timed out is this
  // scan's, and must not cost every later scan its only reader.
  const { copyablePdf, tesseract } = await ocrTools();
  if (!copyablePdf || !tesseract) return { unavailable: true };
  // Spent by concurrent scans between the ladder's check and this one.
  if (ocrBudgetLeft() <= 0) return {};
  return { failure: "ocr: the conversion failed on this document" };
}

async function runRung(id: PdfExtractorId, bytes: Buffer, opts: PdfLadderOptions): Promise<RungResult> {
  try {
    // `--format pdf` rather than letting anydoc sniff: this rung is only ever
    // reached with bytes the caller already judged to be a PDF, and naming the
    // format keeps a truncated download from being misread as something else.
    if (id === "pdf-inspector") return await viaNpx(id, PDF_INSPECTOR_SPEC, ["-"], bytes);
    if (id === "anydoc") return await viaNpx(id, ANYDOC_SPEC, ["-", "--format", "pdf"], bytes);
    if (id === "pdftotext") return await viaPdftotext(bytes);
    if (id === "ocr") return await viaOcr(bytes);
    if (id === "firecrawl") {
      const text = opts.firecrawl ? await opts.firecrawl() : undefined;
      // Never remembered as unavailable: its own client memoises the probe, and
      // it can legitimately fail on one URL and work on the next.
      return text === undefined ? {} : { text };
    }
    return { text: pdfToText(bytes) };
  } catch {
    return {}; // a rung must never take the run down
  }
}

/**
 * Extract text from PDF bytes, trying each enabled rung in order and returning
 * the first result that `assessPdfText` accepts.
 *
 * Never throws. When every rung fails, returns empty text plus the reason — the
 * last rung's verdict, sharpened where the bytes say more (not a PDF at all, an
 * encrypted one, a scan that OCR would read), then what the tools themselves
 * said — so the caller can say why the source is unusable instead of silently
 * citing nothing.
 */
export async function extractPdf(bytes: Buffer, opts: PdfLadderOptions = {}): Promise<PdfExtraction> {
  // An error page or a login wall: every tool would fail on it and the note
  // would blame a scan. No reader accepts a PDF whose header is not in its
  // first kilobyte, so neither does this.
  if (!bytes.subarray(0, 1024).includes("%PDF-")) {
    return { text: "", reason: "not a PDF (no %PDF- header — an error page or a login wall?)" };
  }

  let lastReason: string | undefined;
  const failures: string[] = [];
  const hints = new Set<string>();
  let ocrMissing = false;
  // A rung that produced nothing: keep what it said, and what to do about it.
  const noteFailure = (id: PdfExtractorId, got: Unread) => {
    if (id === "ocr" && got.unavailable) ocrMissing = true;
    else if (got.failure) failures.push(got.failure);
    if (got.hint) hints.add(got.hint);
  };

  for (const id of enabledExtractors(opts.engines)) {
    const known = dead.get(id);
    if (known) {
      // Still said for every document: the reason is as true for this one.
      noteFailure(id, known);
      continue;
    }
    // A spent OCR budget is NOT the same as an unreadable document, and saying
    // so matters: without this the run would report "no text layer" for a scan
    // it simply declined to read, and the reader would go looking for a fault in
    // the PDF instead of raising the OCR budget.
    if (id === "ocr" && ocrBudgetLeft() <= 0) {
      lastReason = `scanned PDF, and this run's OCR budget is spent (raise ${envName("OCR_MAX")})`;
      continue;
    }

    const got = await runRung(id, bytes, opts);
    if (got.text === undefined) {
      if (got.unavailable) dead.set(id, got);
      noteFailure(id, got);
      continue;
    }

    const verdict = assessPdfText(got.text);
    if (verdict.ok) return { text: got.text.trim(), via: id };
    lastReason = verdict.reason;
  }

  if (lastReason === NO_TEXT_LAYER) {
    // An encrypted PDF extracts as nothing through every rung that cannot
    // decrypt it, which reads exactly like a scan.
    if (bytes.includes("/Encrypt")) lastReason = "encrypted PDF (no rung here could decrypt its text)";
    else if (ocrMissing) lastReason = `${NO_TEXT_LAYER} — install copyable-pdf and tesseract to OCR it`;
  }
  const reason = [...new Set([lastReason, ...failures, ...hints].filter(Boolean))].join("; ");
  return { text: "", reason: reason || "no PDF extractor available" };
}
