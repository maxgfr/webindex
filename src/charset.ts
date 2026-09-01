// Character encoding: turning response bytes into the text the page meant.
//
// Everything here exists because `bytes.toString("utf8")` is a guess, and it is
// wrong for a large and unglamorous slice of the web. A Windows-1252 page — most
// of the older European web, plenty of government and university sites, most
// vendor documentation written before 2010 — decodes into mojibake: every
// accented character becomes U+FFFD, silently. The extraction "succeeds", the
// text looks almost right, and the quotes anyone takes from it are corrupt.
//
// Worse, it is invisible downstream. The PDF ladder has a garbage gate that
// refuses an unreadable text layer; the HTML path had nothing equivalent,
// because nothing was checking.
//
// TextDecoder knows most of these encodings, so the fix is largely to ask it —
// with one exception. Windows-1252 is decoded from a table here rather than
// delegated, because CI proved the delegation is not portable: the same byte
// gave an em dash on one Node version and a raw control character on another.
// See CP1252_C1 below.

/** A BOM is authoritative — it beats every declaration. */
function bomEncoding(bytes: Buffer): { encoding: string; skip: number } | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: "utf-8", skip: 3 };
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: "utf-16le", skip: 2 };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: "utf-16be", skip: 2 };
  return undefined;
}

const CHARSET_IN_CONTENT_TYPE = /charset\s*=\s*["']?([a-z0-9_:.+-]+)/i;

/** The charset named by a Content-Type header, if it names one. */
export function charsetFromContentType(contentType: string): string | undefined {
  return CHARSET_IN_CONTENT_TYPE.exec(contentType ?? "")?.[1]?.toLowerCase();
}

/**
 * The charset a document declares about itself: `<meta charset>` or the older
 * `<meta http-equiv="content-type">`.
 *
 * Only the first 4 KB is scanned. The spec requires the declaration inside the
 * first 1024 bytes, and reading further would mean decoding the body to find out
 * how to decode the body.
 */
export function charsetFromHtml(head: string): string | undefined {
  const window = head.slice(0, 4096);
  const direct = /<meta[^>]+charset\s*=\s*["']?([a-z0-9_:.+-]+)/i.exec(window);
  if (direct) return direct[1]!.toLowerCase();
  const httpEquiv = /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_:.+-]+)/i.exec(window);
  return httpEquiv?.[1]?.toLowerCase();
}

/**
 * Decode response bytes into text, honouring — in order — a BOM, the
 * Content-Type header, and the document's own `<meta charset>`.
 *
 * Precedence follows what actually helps: a BOM cannot be wrong, a header is
 * usually right, and a meta tag is the last resort because a page served as
 * UTF-8 while declaring latin1 in its markup is almost always a stale template
 * rather than a truthful declaration.
 *
 * Falls back to UTF-8 on an unknown or unsupported label, so a nonsense charset
 * degrades to today's behaviour rather than failing the fetch.
 */
export function decodeBody(bytes: Buffer, contentType = ""): string {
  const bom = bomEncoding(bytes);
  if (bom) return decodeWith(bytes.subarray(bom.skip), bom.encoding);

  const declared = charsetFromContentType(contentType);
  if (declared && declared !== "utf-8" && declared !== "utf8") return decodeWith(bytes, declared);
  if (declared) return bytes.toString("utf8");

  // No header charset. Sniff the markup — safe as ASCII, since every encoding
  // this matters for is ASCII-compatible in the byte range a tag name uses.
  const meta = charsetFromHtml(bytes.subarray(0, 4096).toString("latin1"));
  if (meta && meta !== "utf-8" && meta !== "utf8") return decodeWith(bytes, meta);
  return bytes.toString("utf8");
}

// The 32 code points where Windows-1252 differs from ISO-8859-1 — the C1 range,
// which cp1252 fills with typographic characters (curly quotes, en/em dashes,
// the euro sign) and latin1 leaves as control characters.
//
// Hand-rolled rather than delegated to TextDecoder, and that is the point. On
// one Node version `new TextDecoder("windows-1252")` produced the em dash for
// 0x97; on another it produced U+0097, the raw control character — the latin1
// answer. An engine whose floor is Node 18 and whose consumers vendor it into
// unknown environments cannot have "which typographic characters survive"
// depend on how the runtime was compiled. Thirty-two entries buy determinism.
const CP1252_C1 = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019,
  0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

const CP1252_LABELS = new Set([
  "windows-1252",
  "cp1252",
  "cp-1252",
  "x-cp1252",
  "ansi_x3.4-1968",
  "iso-8859-1",
  "iso8859-1",
  "latin1",
  "l1",
  "us-ascii",
  "ascii",
]);

// Windows-1252 is ISO-8859-1 with the 32 C1 controls reassigned, so Node's
// native latin1 decoder does 224 of the 256 rows in one native pass and a
// single replace patches the rest. The byte-at-a-time `out +=` it replaces was
// ~170 ms on a 4 MB page; this is a few ms and produces the same string.
const CP1252_C1_RANGE = /[\x80-\x9f]/g;
const cp1252C1 = (c: string): string => String.fromCharCode(CP1252_C1[c.charCodeAt(0) - 0x80]!);

/**
 * Decode a Windows-1252 byte run.
 *
 * ISO-8859-1 and US-ASCII are routed here too, deliberately: the HTML spec says
 * a document labelled `iso-8859-1` must be decoded as windows-1252, because in
 * practice that is what the authors meant. A page declaring latin1 and using an
 * em dash is common; a page genuinely wanting U+0097 is not.
 */
function decodeCp1252(bytes: Buffer): string {
  return bytes.toString("latin1").replace(CP1252_C1_RANGE, cp1252C1);
}

function decodeWith(bytes: Buffer, encoding: string): string {
  if (CP1252_LABELS.has(encoding)) return decodeCp1252(bytes);
  try {
    // fatal:false so a stray malformed byte becomes U+FFFD rather than throwing
    // — one bad byte must not cost the whole page.
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString("utf8"); // unknown label — no worse than before
  }
}
