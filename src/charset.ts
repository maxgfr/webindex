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

// Labels a byte-level prescan can never truthfully find. Reading the tag at all
// means the bytes are ASCII-compatible, which UTF-16 is not, so the WHATWG
// prescan resolves a declared UTF-16 to UTF-8 — and x-user-defined to
// windows-1252. Honouring the label as written decoded an ordinary ASCII page
// as UTF-16LE: every pair of characters fused into one CJK ideograph.
const UTF16_LABELS = new Set(["utf-16", "utf-16le", "utf-16be", "unicode", "unicodefeff", "unicodefffe", "ucs-2", "csunicode", "iso-10646-ucs-2"]);

function prescanLabel(label: string): string {
  const lower = label.toLowerCase();
  if (UTF16_LABELS.has(lower)) return "utf-8";
  return lower === "x-user-defined" ? "windows-1252" : lower;
}

// One `<meta …>` at a time, quotes respected: a raw `<` or `>` is valid inside
// a quoted value, so `content="Learn <meta charset=…>"` must not end the tag and
// leak its prose out as a declaration. Every way through the pattern succeeds —
// an unclosed quote or tag runs to the end of the window (`$`) — so nothing is
// ever rescanned from a later `<meta`, and it stays linear. The value is optional
// in the attribute pattern for the same reason: a name with no `=` is consumed
// whole, not retried from each of its characters.
const META_TAG = /<meta\b(?:[^>"']|"[^"]*(?:"|$)|'[^']*(?:'|$))*(?:>|$)/gi;
const TAG_ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)(?:"|$)|'([^']*)(?:'|$)|([^\s"'=<>`]+)))?/g;

function metaAttributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const m of tag.slice(5).matchAll(TAG_ATTRIBUTE)) {
    const value = m[2] ?? m[3] ?? m[4];
    const name = m[1]!.toLowerCase();
    if (value !== undefined && !attrs.has(name)) attrs.set(name, value);
  }
  return attrs;
}

/**
 * The charset a document declares about itself: `<meta charset>` or the older
 * `<meta http-equiv="content-type">`, the first one found winning.
 *
 * Read attribute by attribute, as the WHATWG prescan does: `charset=` counts in
 * a meta tag's own `charset`, or in its `content` when the tag is a
 * content-type pragma — never anywhere else. A description reading "how to set
 * charset=utf-16" is prose, and used to outrank the real `<meta charset>` after
 * it. A declared UTF-16 resolves to UTF-8 (see UTF16_LABELS).
 *
 * Only the first 4 KB is scanned. The spec requires the declaration inside the
 * first 1024 bytes, and reading further would mean decoding the body to find out
 * how to decode the body.
 */
export function charsetFromHtml(head: string): string | undefined {
  for (const [tag] of head.slice(0, 4096).matchAll(META_TAG)) {
    const attrs = metaAttributes(tag);
    const direct = attrs.get("charset")?.trim();
    if (direct) return prescanLabel(direct);
    if (attrs.get("http-equiv")?.trim().toLowerCase() !== "content-type") continue;
    const pragma = charsetFromContentType(attrs.get("content") ?? "");
    if (pragma) return prescanLabel(pragma);
  }
  return undefined;
}

// An XML declaration at the very start. Anchored and read from a short head, so
// it costs nothing on a body that has none.
const XML_DECLARATION = /^\s*<\?xml\b[^>]*?\bencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/;

/**
 * The encoding an XML document names in its `<?xml … encoding="…"?>`.
 *
 * RFC 7303 gives it the last word when the Content-Type carries no charset —
 * the everyday case for an RSS or Atom feed in ISO-8859-1, every accented title
 * of which used to come out as U+FFFD. Like a meta tag, a declared UTF-16 that
 * an ASCII scan could read resolves to UTF-8.
 */
function charsetFromXmlDeclaration(bytes: Buffer): string | undefined {
  const label = XML_DECLARATION.exec(bytes.subarray(0, 256).toString("latin1"))?.[1];
  return label ? prescanLabel(label) : undefined;
}

const isUtf8Label = (label: string | undefined) => label === "utf-8" || label === "utf8";

// The MIME types whose body may declare its own encoding in markup. Anything
// else (text/plain, JSON, CSS…) that shows `<meta charset>` is only quoting one.
const SNIFFABLE_MIME = new Set(["", "text/html", "application/xhtml+xml", "application/octet-stream"]);

/** UTF-8 when the bytes are valid UTF-8, Windows-1252 when they are not. */
function decodeUtf8OrCp1252(bytes: Buffer): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text: string;
  try {
    text = decoder.decode(bytes, { stream: true });
  } catch {
    return decodeCp1252(bytes);
  }
  try {
    return text + decoder.decode();
  } catch {
    // Everything but the last few bytes is valid, and those start a sequence
    // that never finishes. A UTF-8 body cut at the byte cap mid-character looks
    // exactly like this — and must not turn into cp1252 mojibake — but so does
    // a Latin-1 page ending on an accented letter. UTF-8 elsewhere in the body
    // settles it; without any, the text before the tail is ASCII, which cp1252
    // reads identically, and cp1252 also reads the tail right.
    return /[\x80-\uffff]/.test(text) ? text : decodeCp1252(bytes);
  }
}

/**
 * Decode response bytes into text, honouring — in order — a BOM, the
 * Content-Type header, an XML declaration, and (for a body that may be HTML) the
 * document's own `<meta charset>`; with none of those naming a non-UTF-8
 * encoding, UTF-8 when the bytes are valid and Windows-1252 when they are not.
 *
 * Precedence follows what actually helps: a BOM cannot be wrong, a header is
 * usually right, and a meta tag is the last resort because a page served as
 * UTF-8 while declaring latin1 in its markup is almost always a stale template
 * rather than a truthful declaration. The final rescue is what an undeclared
 * Latin-1 page — or one whose meta sits past the sniff window behind a large
 * inline script — needs; only a header's explicit UTF-8 is trusted over it.
 *
 * Falls back to UTF-8 on an unknown or unsupported label, so a nonsense charset
 * degrades to today's behaviour rather than failing the fetch.
 */
export function decodeBody(bytes: Buffer, contentType = ""): string {
  const bom = bomEncoding(bytes);
  if (bom) return decodeWith(bytes.subarray(bom.skip), bom.encoding);

  const declared = charsetFromContentType(contentType);
  if (declared && !isUtf8Label(declared)) return decodeWith(bytes, declared);
  if (declared) return bytes.toString("utf8");

  // No header charset. Sniff the document — safe as ASCII, since every encoding
  // this matters for is ASCII-compatible in the byte range a tag name uses.
  const mime = contentType.split(";")[0]!.trim().toLowerCase();
  const own = charsetFromXmlDeclaration(bytes) ?? (SNIFFABLE_MIME.has(mime) ? charsetFromHtml(bytes.subarray(0, 4096).toString("latin1")) : undefined);
  if (own && !isUtf8Label(own)) return decodeWith(bytes, own);
  return decodeUtf8OrCp1252(bytes);
}

/**
 * Decode bytes read from disk: BOM, then an XML declaration or `<meta charset>`,
 * then a UTF-8 validity rescue. A local file has no transport header to trust,
 * and a stale template declaring UTF-8 over Latin-1 bytes is common. Without a
 * BOM or a non-UTF-8 declaration, trust UTF-8 only when the bytes are valid;
 * otherwise use Windows-1252 so accents and typographic punctuation survive.
 *
 * `sniffHtmlCharset: false` skips the meta step — for a file the caller already
 * knows is plain text, where a `<meta charset>` can only be quoted markup. An
 * XML declaration is still honoured: it has to open the file to count.
 */
export function decodeLocal(bytes: Buffer, opts: { sniffHtmlCharset?: boolean } = {}): string {
  const bom = bomEncoding(bytes);
  if (bom) return decodeWith(bytes.subarray(bom.skip), bom.encoding);

  const own = charsetFromXmlDeclaration(bytes) ?? (opts.sniffHtmlCharset === false ? undefined : charsetFromHtml(bytes.subarray(0, 4096).toString("latin1")));
  if (own && !isUtf8Label(own)) return decodeWith(bytes, own);

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return decodeCp1252(bytes);
  }
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
