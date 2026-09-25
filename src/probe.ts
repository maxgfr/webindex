// The availability verdict for a local service, remembered per base URL.
//
// Internal: the embedding client and the vector store share it, and neither
// the name nor the window is public API.

export interface ProbeEntry {
  verdict: Promise<boolean>;
  /** Set once the probe has answered. */
  ok?: boolean;
  /** When it answered (or was asked, while pending). */
  at: number;
}

/**
 * How long "not answering" stands before the next call asks again. A "yes" is
 * kept for the process; a "no" used to be as well, so a long-lived MCP server
 * kept telling its client to run `semantic up` after it had, without sending a
 * single request. A refused localhost connection costs about a millisecond, and
 * the window bounds what a blackholed one costs to one probe per 30 s.
 */
export const PROBE_RETRY_MS = 30_000;

/**
 * The cached verdict for `key`, asking `ask` when there is none or when a "no"
 * has expired. The verdict is kept as a PROMISE, so callers that ask at the same
 * time share one request instead of each sending their own.
 */
export function cachedProbe(cache: Map<string, ProbeEntry>, key: string, ask: () => Promise<boolean>): Promise<boolean> {
  const hit = cache.get(key);
  if (hit && (hit.ok !== false || Date.now() - hit.at < PROBE_RETRY_MS)) return hit.verdict;
  const entry: ProbeEntry = { verdict: Promise.resolve(false), at: Date.now() };
  entry.verdict = ask()
    .catch(() => false)
    .then((ok) => {
      entry.ok = ok;
      entry.at = Date.now();
      return ok;
    });
  cache.set(key, entry);
  return entry.verdict;
}
