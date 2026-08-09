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
// Node ships full ICU, so TextDecoder already knows these encodings. What was
// missing was asking it.

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

function decodeWith(bytes: Buffer, encoding: string): string {
  try {
    // fatal:false so a stray malformed byte becomes U+FFFD rather than throwing
    // — one bad byte must not cost the whole page.
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString("utf8"); // unknown label — no worse than before
  }
}
