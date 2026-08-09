// Bounded-concurrency map — zero dependencies.
//
// Every consumer of this engine ends up writing one of these. Retrieval is
// latency-bound, not bandwidth-bound: a sequential `for (const url of urls)
// await fetchAndExtract(url)` spends almost all of its wall-clock waiting on
// round trips that could have overlapped. But unbounded `Promise.all` over a
// candidate list is how a keyless engine starts answering 429 to everything, so
// the width has to be a number the caller chooses.
//
// INPUT ORDER is preserved in the result. That is not a nicety: consumers number
// their sources from this array, and a race-ordered list would make two runs over
// the same inputs produce different citations.

/**
 * Map `items` through `fn` with at most `limit` in flight, preserving order.
 *
 * A rejecting `fn` rejects the whole call, the same contract as `Promise.all`.
 * A caller that must degrade per item catches inside `fn` — which is what
 * retrieval wants, since one unreachable page should never abandon the rest.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const width = Math.max(1, Math.floor(limit));
  if (items.length <= 1 || width === 1) {
    const out: R[] = [];
    for (let i = 0; i < items.length; i++) out.push(await fn(items[i]!, i));
    return out;
  }

  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    // Each worker claims the next index. JS does not interleave between awaits,
    // so the increment cannot race.
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}
