// Office-document text extraction — public surface.
//
// The implementation lives in ./doc/: `formats.ts` (which documents route here,
// and how) and `ladder.ts` (convert with the strongest available tool, refuse
// rather than cite what nothing could read).
//
// Callers want `docFormatForUrl` / `docFormatForContentType` to decide whether a
// response is an office document — `sniffDocument` when neither the URL nor the
// header says, which is how download routes answer — then `extractDocument` to
// convert it.

export { docFormatForUrl, docFormatForContentType, DOC_EXTENSIONS, sniffDocument, type DocFormat } from "./doc/formats.js";
export {
  extractDocument,
  enabledDocExtractors,
  resetDocLadderCache,
  DOC_EXTRACTORS,
  type DocExtraction,
  type DocExtractorId,
  type DocLadderOptions,
} from "./doc/ladder.js";
