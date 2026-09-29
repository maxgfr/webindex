// Content types that say nothing about the body. Download routes answer these
// for PDFs and office files as often as for anything else, so for them the
// bytes decide (see sniffDocument in fetch.ts). `application/zip` is here
// because every .docx, .xlsx and .odt is one.
//
// One set for the two modules that ask: fetchAndExtract reads such a body as
// HTML when it looks like HTML, so decodeBody must honour that HTML's
// `<meta charset>`. Kept apart, the two drifted: an S3 object served as
// binary/octet-stream was extracted as HTML with its declared cp1251 unread.
//
// Internal on purpose: src/index.ts re-exports charset.ts and fetch.ts
// wholesale, and both need this, so it lives in a module neither re-exports.
export const AMBIGUOUS_TYPES: ReadonlySet<string> = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/x-download",
  "application/force-download",
  "application/download",
  "application/unknown",
  "application/zip",
  "application/x-zip-compressed",
]);
