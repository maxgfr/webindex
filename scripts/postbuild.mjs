#!/usr/bin/env node
// Rename tsup's declaration output to the .d.mts extension.
//
// tsup honours `outExtension` for the JS bundle but not for the declaration
// file, so an ESM-only build emits scripts/engine.d.ts next to engine.mjs.
// That extension is not cosmetic: consumers vendor the pair and import it as
//
//     import { fetchAndExtract } from "./vendor/webindex-engine.mjs";
//
// and TypeScript's `moduleResolution: "Bundler"` resolves the types for a
// `.mjs` specifier from a sibling `.d.mts` — never from `.d.ts`. Ship the wrong
// extension and every consumer silently degrades to `any` on the whole engine.
//
// The rename is safe because the emitted declarations are already bundled and
// self-contained: nothing references the file by its old name.
import { existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const from = join(scriptsDir, "engine.d.ts");
const to = join(scriptsDir, "engine.d.mts");

if (!existsSync(from)) {
  if (existsSync(to)) {
    // tsup started honouring outExtension.dts — nothing to do, and the guard
    // keeps this script from failing the build on the day that lands.
    console.log("postbuild: scripts/engine.d.mts already emitted directly");
    process.exit(0);
  }
  console.error("postbuild: no declaration output found (expected scripts/engine.d.ts) — did `tsup` run with dts enabled?");
  process.exit(1);
}

// A stale .d.mts from a previous build would otherwise survive the rename on
// platforms where rename onto an existing file is not atomic.
if (existsSync(to)) rmSync(to);
renameSync(from, to);
console.log("postbuild: scripts/engine.d.ts -> scripts/engine.d.mts");
