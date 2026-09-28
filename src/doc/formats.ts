// Which fetched documents go to the document converter, and how.
//
// This table is the ONLY place a format is decided. Two rules follow from that:
//
//   1. Nothing derived from a URL ever reaches argv. A converter is spawned with
//      the document on stdin (see ../pdf/exec.ts), and the only argument that can
//      vary is a `format` string read from THIS table — never a substring of the
//      URL the run happened to fetch.
//   2. `format` is set only where content detection cannot work. anydoc reads the
//      format from the bytes themselves (ZIP package mimetype, OLE stream names,
//      the RTF open group), which is strictly better than trusting an extension:
//      a mislabelled .doc that is really a .docx still converts. CSV is the lone
//      exception — plain text has no signature to read, so stdin needs telling.
//
// PDFs are deliberately absent: they have their own ladder (../pdf/ladder.ts)
// with rungs this one does not have.

export interface DocFormat {
  /** Passed as `--format` only when byte detection cannot work. */
  format?: string;
  /**
   * Is this format readable as plain text when no converter is available?
   *
   * False for every binary format: refusing is the whole point, because the
   * alternative is citing a decoded ZIP. True for CSV, which was already served
   * as usable text before this ladder existed — refusing it would be a
   * regression, not a fix.
   */
  textFallback: boolean;
}

const BINARY: DocFormat = { textFallback: false };
const CSV: DocFormat = { format: "csv", textFallback: true };

// Extension (without the dot, lowercase) → how to convert it.
const BY_EXTENSION: Record<string, DocFormat> = {
  // Word
  doc: BINARY,
  docx: BINARY,
  docm: BINARY,
  odt: BINARY,
  rtf: BINARY,
  // PowerPoint
  ppt: BINARY,
  pps: BINARY,
  pot: BINARY,
  pptx: BINARY,
  pptm: BINARY,
  ppsx: BINARY,
  ppsm: BINARY,
  odp: BINARY,
  // Excel
  xls: BINARY,
  xlsx: BINARY,
  xlsm: BINARY,
  xlsb: BINARY,
  ods: BINARY,
  // Everything else the converter reads
  epub: BINARY,
  csv: CSV,
};

// Content-type → how to convert it, for a URL that gives nothing away (a
// `?download=7` route). Matched against the type only; parameters are stripped.
const BY_CONTENT_TYPE: Record<string, DocFormat> = {
  "application/msword": BINARY,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": BINARY,
  "application/vnd.ms-word.document.macroenabled.12": BINARY,
  "application/vnd.oasis.opendocument.text": BINARY,
  "application/rtf": BINARY,
  "text/rtf": BINARY,
  "application/vnd.ms-powerpoint": BINARY,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": BINARY,
  "application/vnd.oasis.opendocument.presentation": BINARY,
  "application/vnd.ms-excel": BINARY,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": BINARY,
  "application/vnd.ms-excel.sheet.binary.macroenabled.12": BINARY,
  "application/vnd.oasis.opendocument.spreadsheet": BINARY,
  "application/epub+zip": BINARY,
  "text/csv": CSV,
};

/** Every extension this module routes, for docs and tests. */
export const DOC_EXTENSIONS: readonly string[] = Object.keys(BY_EXTENSION);

/**
 * Is this URL an office document, judged before the fetch?
 *
 * Extension-only, and deliberately so. The PDF sniffer also has to recognise
 * extension-less routes because `arxiv.org/pdf/<id>` is the single most common
 * PDF a run fetches; office documents have no such convention — a route that
 * serves one without saying so in the path is caught after the fetch, by
 * `docFormatForContentType`.
 *
 * Returns the table entry (never a URL-derived string) or undefined.
 */
export function docFormatForUrl(url: string): DocFormat | undefined {
  const m = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url);
  return m ? BY_EXTENSION[m[1]!.toLowerCase()] : undefined;
}

/** Is this response an office document, judged from its content-type? */
export function docFormatForContentType(contentType: string): DocFormat | undefined {
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  return type ? BY_CONTENT_TYPE[type] : undefined;
}

// A PDF header may follow up to 1 KB of junk (readers accept it there), but it
// starts a line: prose that merely mentions `%PDF-` mid-sentence is not one.
const PDF_HEADER_RE = /(?:^|[\r\n])%PDF-\d/;
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/**
 * What these bytes are, when they are a document: `"pdf"`, an office format,
 * or undefined for anything else (text, HTML, images, plain archives).
 *
 * For a response whose URL and headers gave nothing away — a download route
 * answering `application/octet-stream`, or no type at all — and for a local
 * file whose name lies. The signatures are the ones the converters themselves
 * trust, which is why an office match carries no `format`: anydoc reads the
 * real one from the same bytes.
 *
 * A ZIP counts only with a package manifest (`[Content_Types].xml` for OOXML,
 * a leading `mimetype` entry for OpenDocument and EPUB): a source archive is
 * not a document, and routing it to the converter would misreport it.
 */
export function sniffDocument(bytes: Buffer): "pdf" | DocFormat | undefined {
  const head = bytes.subarray(0, 1024).toString("latin1");
  if (PDF_HEADER_RE.test(head)) return "pdf";
  if (bytes.subarray(0, 8).equals(OLE_SIGNATURE)) return BINARY;
  if (head.startsWith("{\\rtf")) return BINARY;
  if (head.startsWith("PK\x03\x04") && (head.startsWith("mimetype", 30) || bytes.includes("[Content_Types].xml"))) return BINARY;
  return undefined;
}
