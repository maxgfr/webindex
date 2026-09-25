// Office-document text extraction — public surface.
//
// The implementation lives in ./doc/: `formats.ts` (which documents route here,
// and how), `ladder.ts` (convert with the strongest available tool, refuse
// rather than cite what nothing could read) and `office.ts` (the built-in
// OOXML/OpenDocument reader that is the ladder's last rung).
//
// Callers want `docFormatForUrl` / `docFormatForContentType` to decide whether a
// response is an office document — `sniffDocument` when neither the URL nor the
// header says, which is how download routes answer — then `extractDocument` to
// convert it. `officeToText` is that last rung on its own, for a caller that
// wants no subprocess and no network at all.

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
export { officeToText } from "./doc/office.js";
