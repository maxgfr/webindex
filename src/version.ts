// The engine's own version, embedded in the bundle so a vendored copy can be
// identified without its package.json — which consumers never receive, since
// they vendor only scripts/engine.mjs + scripts/engine.d.mts.
//
// Kept in lockstep with package.json by scripts/sync-version.mjs, which
// semantic-release runs during `prepare`. Two things depend on the assignment
// below surviving into the bundle verbatim, as a plain quoted semver literal
// (this comment deliberately avoids spelling that pattern out, so it can never
// be the match a grep finds first):
//
//   1. each consumer's scripts/sync-engine.mjs greps it and REFUSES a pin whose
//      tag does not match the bytes it just downloaded — the tamper/mismatch
//      gate that makes vendoring safe;
//   2. `pnpm run check:build` proves the committed bundle is reproducible.
//
// So: do not template it, do not compute it, and keep minify off in tsup.
export const ENGINE_VERSION = "1.4.0";
