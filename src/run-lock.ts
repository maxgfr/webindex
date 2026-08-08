// Serialise work that touches one directory.
//
// The pattern this exists for: a caller reads an index file, checks whether a
// URL is already in it, assigns the next free id and writes the file back. Two
// overlapping calls both read the same highest id, both claim it, and one entry
// silently overwrites the other — worse than losing it, because a citation to
// it still resolves, just to the wrong page. Readers of that same file see it
// mid-rewrite.
//
// A CLI never hits this: one process runs one command to completion. An MCP
// server can have several tool calls in flight at once, and ingesting a handful
// of URLs concurrently is the obvious thing for a client to do.
//
// The fix is a promise chain per key — the smallest thing that is actually
// correct. It is deliberately coarse: a read blocks a write on the SAME key,
// while different keys stay fully parallel. Work that creates its own directory
// has nothing to contend for and should not take a lock at all.
//
// This guards a single process. Two processes writing the same directory side
// by side remains a known gap.
const chains = new Map<string, Promise<unknown>>();

export function withRunLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(slug) ?? Promise.resolve();
  // Chain off `prev` however it settled: a failed predecessor must not poison
  // every later call for the same repo.
  const next = prev.then(fn, fn);
  // The tail the NEXT caller waits on never rejects, so one thrown tool call
  // can't reject the whole queue behind it.
  const tail = next.then(noop, noop);
  chains.set(slug, tail);
  // Drop the entry once the tail is still us, so a long-lived server doesn't
  // accumulate a settled promise per repo it ever touched.
  tail.then(() => {
    if (chains.get(slug) === tail) chains.delete(slug);
  }, noop);
  return next;
}

function noop(): void {}

// Test seam: drop every pending chain. Never call this from product code — an
// in-flight lock holder would stop serializing against later arrivals.
export function resetRunLocks(): void {
  chains.clear();
}
