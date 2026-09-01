// URL canonicalisation and identity.
//
// Moved verbatim out of each skill's util.ts. These decide when two URLs are
// the SAME source — which is what makes deduplication, the fetch cache key and
// stable source numbering agree with each other.

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|ref_url$|spm$|_hsenc$|_hsmi$|igshid$)/i;

// Canonical form of a URL for deduplication. Lowercases ONLY scheme + host
// (paths and query values are case-sensitive — github.com/Microsoft/TypeScript
// is not github.com/microsoft/typescript, and YouTube ?v= ids are case-bearing).
// Drops the fragment, tracking params and default port, sorts the remaining
// query params, re-encodes their values (so an encoded '&' in a value isn't
// turned into a delimiter), and strips a trailing slash. Built from components
// rather than URL.toString().toLowerCase().
export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    const proto = u.protocol.toLowerCase();
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    let port = u.port;
    if ((proto === "http:" && port === "80") || (proto === "https:" && port === "443")) port = "";
    const path = u.pathname.replace(/\/+$/, ""); // case preserved
    const keep: [string, string][] = [];
    for (const [k, v] of u.searchParams) {
      if (!TRACKING_PARAMS.test(k)) keep.push([k, v]);
    }
    keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const search = keep.length ? "?" + keep.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "";
    return `${proto}//${host}${port ? ":" + port : ""}${path}${search}`.replace(/\/$/, "");
  } catch {
    return raw.trim().replace(/#.*$/, "").replace(/\/$/, "");
  }
}

// Normalize a DOI to a bare lowercase identifier (strip any doi.org prefix) so
// the same work cited as a DOI URL and a bare DOI dedupes to one key.
export function normalizeDoi(doi: string): string {
  return doi
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
}

// Bare hostname of a URL (no leading www), or "" when unparseable.
export function domainOf(raw: string): string {
  try {
    const u = new URL(raw);
    // A file: URL has no hostname, so the honest answer is not "" — that reads
    // as "unknown" in a source list and groups every local file with every
    // unparseable URL. Name the route instead: a reader seeing this in a report
    // should know at a glance the evidence came off the machine, not the web.
    if (u.protocol === "file:") return LOCAL_FILE_DOMAIN;
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** The `domain` a local file is filed under. Not a host, and deliberately not one. */
export const LOCAL_FILE_DOMAIN = "local file";

// ---------------------------------------------------------------------------
// FNV-1a: a fast, deterministic 64-bit hash. Used for cache keys and as the
// mixer under near-duplicate detection.
// ---------------------------------------------------------------------------

// Computed on two 32-bit lanes rather than a BigInt, because a BigInt multiply
// per character is a heap allocation per character: on a 2 MB page that was
// ~300 ms, 40× the rest of the ranking pipeline. The lanes are bit-exact with
// the BigInt reference (the spec vectors are pinned in tests): the 64-bit FNV
// prime is 2^40 + 0x1b3, so h·P = (h << 40) + h·0x1b3, and both terms are cheap
// on split words. Disk cache keys and run ids depend on this exact output.

const FNV_OFFSET_HI = 0xcbf29ce4;
const FNV_OFFSET_LO = 0x84222325;
const FNV_PRIME_LOW = 0x1b3;

// Lane state shared by the two entry points below. Module-level rather than
// returned because the hot caller (simhash) runs this once per shingle and must
// not allocate. Synchronous and single-threaded, so never re-entered.
let laneHi = 0;
let laneLo = 0;

function fnvMix(s: string): void {
  let hi = laneHi;
  let lo = laneLo;
  for (let i = 0; i < s.length; i++) {
    lo = (lo ^ s.charCodeAt(i)) >>> 0;
    // lo · 0x1b3 on 16-bit halves, so the carry into the high lane is exact in
    // 32-bit integer arithmetic: (a·2^16 + b)·P = a·P·2^16 + b·P, both < 2^25.
    const bP = (lo & 0xffff) * FNV_PRIME_LOW;
    const aP = (lo >>> 16) * FNV_PRIME_LOW + (bP >>> 16);
    const carry = aP >>> 16;
    // High lane: carry + hi·0x1b3 + (lo << 40 mod 2^64, i.e. lo << 8).
    hi = (carry + Math.imul(hi, FNV_PRIME_LOW) + (lo << 8)) >>> 0;
    lo = (((aP & 0xffff) << 16) | (bP & 0xffff)) >>> 0;
  }
  laneHi = hi;
  laneLo = lo;
}

export function fnv1a64(s: string): bigint {
  laneHi = FNV_OFFSET_HI;
  laneLo = FNV_OFFSET_LO;
  fnvMix(s);
  return (BigInt(laneHi) << 32n) | BigInt(laneLo);
}

/**
 * FNV-1a 64 of the concatenation of `pieces`, as two 32-bit words written to
 * `out[0]` (high) and `out[1]` (low). Same value as `fnv1a64(pieces.join(""))`
 * without building the string or the BigInt — the form simhash needs, once per
 * shingle.
 */
export function fnv1a64Words(pieces: readonly string[], out: Uint32Array): void {
  laneHi = FNV_OFFSET_HI;
  laneLo = FNV_OFFSET_LO;
  for (const p of pieces) fnvMix(p);
  out[0] = laneHi;
  out[1] = laneLo;
}
