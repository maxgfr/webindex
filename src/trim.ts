// Trailing-character trims, written as a loop.
//
// `/\/+$/` reads as linear and is not: on a run of slashes that stops short of
// the end, the engine starts again from every slash of the run, and 200 000 of
// them in a URL path took 27 s. URLs, repository fields and configured base
// URLs all come from someone else, so every such trim goes through here.
//
// Internal on purpose: src/index.ts re-exports url.ts and rank.ts wholesale,
// and a string helper is not API the engine means to promise.

/** `s` without any run of `ch` at its end. */
export function trimTrailing(s: string, ch: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === ch) end--;
  return s.slice(0, end);
}
