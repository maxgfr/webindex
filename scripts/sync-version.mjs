#!/usr/bin/env node
// Sync the release version across the two places it lives, then let the caller
// rebuild the bundle. Invoked by @semantic-release/exec (prepareCmd):
//
//   node scripts/sync-version.mjs <version>
//
// The version is duplicated in package.json and src/version.ts (the value the
// bundle embeds). semantic-release computes it from the Conventional Commits,
// so this keeps both in lockstep. CHANGELOG.md is owned by
// @semantic-release/changelog and is NOT touched here.
//
// Why the duplication is load-bearing: consumers vendor scripts/engine.mjs and
// scripts/engine.d.mts and NOTHING else — no package.json ever reaches them. So
// the version has to travel inside the bundle, and each consumer's
// sync-engine.mjs greps `ENGINE_VERSION = "…"` out of the downloaded bytes and
// refuses a pin whose tag disagrees with them. If these two drift, every
// consumer's re-pin fails closed — noisy, but on the safe side.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
  console.error(`sync-version: expected a semver version, got "${version ?? ""}"`);
  process.exit(1);
}

function edit(path, transform) {
  const before = readFileSync(path, "utf8");
  const after = transform(before);
  if (after === before) {
    console.error(`sync-version: WARNING — no change applied to ${path}`);
  }
  writeFileSync(path, after);
}

// package.json — the top-level "version" field.
edit("package.json", (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`));

// src/version.ts — the ENGINE_VERSION constant the bundle embeds.
edit("src/version.ts", (s) => s.replace(/(export const ENGINE_VERSION = ")[^"]+(";)/, `$1${version}$2`));

console.log(`sync-version: set ${version} in package.json, src/version.ts`);
