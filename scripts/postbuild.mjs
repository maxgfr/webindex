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
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const from = join(scriptsDir, "engine.d.ts");
const to = join(scriptsDir, "engine.d.mts");

if (existsSync(from)) {
  // A stale .d.mts from a previous build would otherwise survive the rename on
  // platforms where rename onto an existing file is not atomic.
  if (existsSync(to)) rmSync(to);
  renameSync(from, to);
  console.log("postbuild: scripts/engine.d.ts -> scripts/engine.d.mts");
} else if (existsSync(to)) {
  // tsup started honouring outExtension.dts — nothing to rename. Deliberately
  // NOT an early exit: the version check below has to run on every path, and it
  // was silently skipped here until a negative control caught it.
  console.log("postbuild: scripts/engine.d.mts already emitted directly");
} else {
  console.error("postbuild: no declaration output found (expected scripts/engine.d.ts) — did `tsup` run with dts enabled?");
  process.exit(1);
}

// tsup emits declarations per entry, but nobody imports the CLI as a module —
// it is a program. Shipping scripts/webindex.d.ts would advertise an API that
// is not one, and it would have to be kept reproducible by check:build for no
// reason.
const cliDts = join(scriptsDir, "webindex.d.ts");
if (existsSync(cliDts)) {
  rmSync(cliDts);
  console.log("postbuild: dropped scripts/webindex.d.ts (the CLI is a program, not an API)");
}

// Every built artifact must report the version in package.json.
//
// This exists because v1.7.0 shipped a CLI that said 1.6.0: semantic-release
// bumps the version, rebuilds, then commits the files listed in .releaserc.json
// — and scripts/webindex.mjs was not on that list. The rebuilt CLI was thrown
// away and the tag captured the previous one. Nothing failed; the tarball was
// simply wrong, and `brew test` would have been the first thing to notice.
//
// Checking here means a mismatched artifact cannot survive a build, whatever
// forgot to commit it.
const pkgVersion = JSON.parse(readFileSync(join(scriptsDir, "..", "package.json"), "utf8")).version;
for (const artifact of ["engine.mjs", "webindex.mjs"]) {
  const file = join(scriptsDir, artifact);
  if (!existsSync(file)) continue;
  const found = readFileSync(file, "utf8").match(/ENGINE_VERSION = "([^"]+)"/)?.[1];
  if (found !== pkgVersion) {
    console.error(`postbuild: scripts/${artifact} reports ${found ?? "no version"} but package.json says ${pkgVersion}`);
    process.exit(1);
  }
}
console.log(`postbuild: both artifacts report ${pkgVersion}`);
