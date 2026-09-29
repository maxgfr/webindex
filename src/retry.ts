import { envInt } from "./brand.js";

// When a failed request is worth sending again, and after how long.
//
// Shared by the two HTTP clients: httpGet/httpJson, and the forge client, which
// follows its redirects by hand and so cannot go through httpGet. The forge
// client used to keep a policy of its own, and it drifted — it ignored
// MAX_ATTEMPTS, retried a 503 that asked for an hour, and walked a redirect
// loop twice. Deliberately not exported from the library: these are the
// engine's own tunables, and a new engine export is a name every vendoring
// skill must then avoid declaring.

// Retry policy, tunable via env (keyless, no new CLI surface): attempts and the
// fixed backoff, clamped to sane bounds.
export const maxAttempts = () => envInt("MAX_ATTEMPTS", 2, 1, 5);
export const defaultRetryMs = () => envInt("RETRY_MS", 600, 0, 5000);

// The longest Retry-After a request waits out itself before trying again.
export const RETRY_AFTER_CAP_MS = 5000;

// How long to wait before a retry: the server's Retry-After (seconds or
// HTTP-date), else a small fixed backoff. Undefined — do not retry — when the
// server asked for longer than the cap. Retrying after 5 s anyway knowingly
// sent the request it had been told not to send for an hour; the caller gets
// the real ask in `retryAfterMs` instead, for a queue (crawlSite) to honour.
export function retryDelayMs(retryAfterMs: number | undefined): number | undefined {
  if (retryAfterMs === undefined) return defaultRetryMs();
  return retryAfterMs <= RETRY_AFTER_CAP_MS ? retryAfterMs : undefined;
}

type NetworkError = { message?: unknown; code?: unknown; cause?: { message?: unknown; code?: unknown } };

// Failures a second attempt a few hundred ms later cannot change: the name does
// not resolve, the redirect chain loops, the scheme or port is refused, the
// certificate is wrong. Retrying them doubled the cost for the same answer — a
// redirect loop was walked twice over, 42 requests to one server. Transient
// socket errors (ECONNRESET, UND_ERR_SOCKET…) are deliberately absent.
const PERMANENT_CODES = new Set([
  "ENOTFOUND",
  "ERR_INVALID_URL",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);
const PERMANENT_MESSAGE = /redirect count exceeded|scheme must be|unknown scheme|bad port|invalid url|failed to parse url/i;

export function isPermanentFailure(e: unknown): boolean {
  const err = e as NetworkError | undefined;
  const code = err?.cause?.code ?? err?.code;
  if (typeof code === "string" && PERMANENT_CODES.has(code)) return true;
  return [err?.message, err?.cause?.message].some((m) => typeof m === "string" && PERMANENT_MESSAGE.test(m));
}
