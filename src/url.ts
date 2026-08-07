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

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

export function fnv1a64(s: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}
