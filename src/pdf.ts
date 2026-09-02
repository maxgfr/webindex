// PDF text extraction — public surface.
//
// The implementation lives in ./pdf/: `native.ts` (the built-in reader),
// `quality.ts` (is this text fit to cite?), `exec.ts` (run an external tool on
// stdin), `ocr.ts` (the scanned-document rung) and `ladder.ts` (try the
// strongest available extractor first).
//
// Callers want `extractPdf`. `pdfToText` stays exported because it is the
// ladder's built-in rung and is worth testing on its own.

export { pdfToText } from "./pdf/native.js";
export { assessExtractedText, assessPdfText, type PdfVerdict } from "./pdf/quality.js";
export { ocrBudgetLeft, ocrPdf, ocrTools, resetOcrBudget, resetOcrTools } from "./pdf/ocr.js";
export {
  extractPdf,
  enabledExtractors,
  resetPdfLadderCache,
  PDF_EXTRACTORS,
  type PdfExtraction,
  type PdfExtractorId,
  type PdfLadderOptions,
} from "./pdf/ladder.js";
