// Constants and small helpers two or more modules need, kept in one place so
// their copies cannot drift apart.
//
// Internal on purpose, like trim.ts and forge-host.ts: src/index.ts re-exports
// most modules wholesale, and none of this is API the engine means to promise.

/** The statuses that carry a `Location` to follow. */
export const REDIRECT_STATUS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * A dot segment, spelled as a URL parser will read it: `%2e` is a dot to WHATWG
 * URL, so `/repos/%2e%2e/%2e%2e/user` resolves to `/user` just as `..` does.
 */
export const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * Real identifiers are short. Past this length a "word" is not split into its
 * camelCase or snake_case pieces: the splitting regexes backtrack on a long run
 * of capitals, and a hostile 200 KB word held the process for tens of seconds.
 */
export const MAX_IDENT = 64;

/**
 * A timer can fire a millisecond or two before Date.now() reaches the instant
 * it was set for, so a request aborted AT a deadline could leave a sliver of
 * budget on the clock and let the next page or rung start with ~1 ms to run — a
 * request that can only fail, sent to a real engine. A remainder this small
 * counts as spent; a tiny budget keeps a proportionate slack.
 */
export function spentSlackMs(budgetMs: number | undefined): number {
  return budgetMs === undefined ? 0 : Math.min(25, budgetMs / 4);
}
