// Has this page changed since I last read it?
//
// The parts were all here: `httpGet` carries `etag` and `lastModified` up from
// the response, `revalidationHeaders` turns them into a conditional GET, and
// the cache already spends a 304 rather than a re-download. What was missing is
// the ANSWER — a caller could revalidate a cache entry but could not ask the
// question directly, so every tool that wanted to watch a page stored its own
// fingerprints and wrote its own comparison.
//
// A 304 is the cheap path and the reason this is worth having: asking costs one
// round trip and no body at all. Once a body has crossed the wire anyway, its
// content hash is the strongest evidence there is and decides; the validators
// decide only when there is no hash pair to compare. The verdict says which it
// used, because "unchanged by etag" and "unchanged by hash" are different
// strengths of evidence and a caller deciding whether to re-extract should be
// able to tell them apart.

import { createHash } from "node:crypto";
import { httpGet, type HttpResult } from "./fetch.js";

export interface Fingerprint {
  /** The URL as asked for. Not canonicalised: a caller comparing must compare like with like. */
  url: string;
  /** The strong validator, when the server sent one. */
  etag?: string;
  lastModified?: string;
  /** SHA-256 of the body's bytes as received — before any character decoding — when all of it was read. */
  contentHash?: string;
  /** Bytes read. 0 on a 304, which is the whole point of a 304. */
  bytes: number;
  status: number;
  /** ISO timestamp of the observation, so a caller can age its own record. */
  fetchedAt: string;
  /** Why no complete body was read, when none was: a baseline without a hash is no baseline. */
  error?: string;
}

/** SHA-256 of a body, hex. Exported because a caller holding bytes from elsewhere wants the same digest. */
export function contentHash(body: string | Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

// The hash is taken over the raw bytes, never over their decoding: decoding is
// lossy (invalid UTF-8 becomes U+FFFD, a BOM is stripped, cp1252 is transcoded),
// so two different binaries could share one "hash" and a real change read as
// "unchanged". Bytes also make the digest what `sha256sum` of the download
// gives. The ceiling is well above the 4 MB text cap so a watched PDF or dataset
// can be fingerprinted at all; past it the body is reported, not hashed as a
// prefix.
const FINGERPRINT_MAX_BYTES = 64 * 1024 * 1024;

function read(url: string, opts: { timeoutMs?: number; maxBytes?: number }, headers?: Record<string, string>): Promise<HttpResult> {
  return httpGet(url, { timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes ?? FINGERPRINT_MAX_BYTES, binary: true, ...(headers ? { headers } : {}) });
}

function observation(url: string, res: HttpResult): Fingerprint {
  const complete = res.ok && !res.truncated;
  const error = res.status === 304 || complete ? undefined : !res.ok ? (res.error ?? `status ${res.status}`) : "response truncated at the byte cap";
  return {
    url,
    ...(res.etag ? { etag: res.etag } : {}),
    ...(res.lastModified ? { lastModified: res.lastModified } : {}),
    ...(complete ? { contentHash: contentHash(res.bytes ?? Buffer.alloc(0)) } : {}),
    bytes: res.bytesRead ?? 0,
    status: res.status,
    fetchedAt: new Date().toISOString(),
    ...(error ? { error } : {}),
  };
}

/**
 * Observe a URL: its validators, its hash, and when it was seen.
 *
 * Always reads the body, because that is what makes the hash available for the
 * many servers that send neither an ETag nor a Last-Modified. Use `hasChanged`
 * when a validator is already in hand — that is the path that costs nothing.
 * `error` says why there is no hash, when there is none.
 */
export async function fingerprint(url: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<Fingerprint> {
  return observation(url, await read(url, opts));
}

export interface ChangeVerdict {
  /** Undefined when the request failed — "I could not tell" is not "unchanged". */
  changed?: boolean;
  /** How it was decided, so a caller can weigh the evidence. */
  via: "not-modified" | "etag" | "last-modified" | "hash" | "unknown";
  /** The fresh observation, so a caller can store it without a second request. */
  fingerprint: Fingerprint;
  note?: string;
}

/**
 * Whether a URL has changed since a previous observation.
 *
 * Sends the conditional headers when `previous` carries validators. A 304 is
 * the ideal answer: definitive, and no body crossed the wire.
 *
 * `changed` is deliberately OPTIONAL rather than defaulting to false. A network
 * error, a 500 or a redirect to an error page all mean "I could not tell", and
 * a caller that treats those as "unchanged" silently stops watching the page it
 * asked to watch — which is the failure this shape exists to make impossible to
 * write by accident.
 */
export async function hasChanged(
  url: string,
  previous?: Pick<Fingerprint, "etag" | "lastModified" | "contentHash">,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<ChangeVerdict> {
  const headers: Record<string, string> = {};
  if (previous?.etag) headers["if-none-match"] = previous.etag;
  if (previous?.lastModified) headers["if-modified-since"] = previous.lastModified;

  const res = await read(url, opts, Object.keys(headers).length ? headers : undefined);
  const observed = observation(url, res);

  if (res.status === 304) {
    // The fresh observation wins — its timestamp, its URL, any validator the
    // 304 rotated (RFC 9110 lets it) — and `previous` fills in only what a 304
    // cannot carry: a validator it did not repeat, and the hash of the body it
    // did not resend. Spreading `previous` over it handed a stored fingerprint
    // back unchanged, so a watcher's record never aged.
    const etag = observed.etag ?? previous?.etag;
    const lastModified = observed.lastModified ?? previous?.lastModified;
    const fingerprint: Fingerprint = {
      ...observed,
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
      ...(previous?.contentHash ? { contentHash: previous.contentHash } : {}),
      status: 304,
      bytes: 0,
    };
    return { changed: false, via: "not-modified", fingerprint };
  }

  if (!res.ok) {
    return { via: "unknown", fingerprint: observed, note: `could not read ${url}: ${res.error ?? `status ${res.status}`}` };
  }

  if (res.truncated) {
    return { via: "unknown", fingerprint: observed, note: `could not compare ${url}: response truncated at the byte cap.` };
  }

  // With nothing to compare against, the first observation is not a change —
  // it is the baseline. Saying "changed" here would fire every watcher on its
  // first run.
  if (!previous || (!previous.etag && !previous.lastModified && !previous.contentHash)) {
    return { changed: false, via: "unknown", fingerprint: observed, note: "no previous observation — this is the baseline." };
  }

  // The body is already here, so its hash outranks the validators: per-node
  // ETags and a Last-Modified stamped at request time fire "changed" on
  // identical bytes, and a stale ETag can hide a real change.
  if (previous.contentHash && observed.contentHash) {
    return { changed: previous.contentHash !== observed.contentHash, via: "hash", fingerprint: observed };
  }
  if (previous.etag && observed.etag) return { changed: previous.etag !== observed.etag, via: "etag", fingerprint: observed };
  if (previous.lastModified && observed.lastModified) {
    return { changed: previous.lastModified !== observed.lastModified, via: "last-modified", fingerprint: observed };
  }

  // The previous observation and this one have no comparable field: the server
  // stopped sending a validator and the caller stored no hash. Say so rather
  // than guess in either direction.
  return { via: "unknown", fingerprint: observed, note: "nothing comparable between the two observations — store contentHash to make this answerable." };
}
