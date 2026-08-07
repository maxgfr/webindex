#!/usr/bin/env node
// Assert the built bundle can actually be vendored.
//
// Consumers copy scripts/engine.mjs into their own src/vendor/ and let their
// bundler inline it. Nothing resolves it through a package manager, and no
// node_modules is guaranteed to exist beside it — so every specifier it imports
// must be a Node builtin. A single non-builtin import silently makes the file
// unvendorable: the consumer's build either fails, or worse, quietly pulls in a
// dependency their skill never declared and their zero-dep promise no longer
// holds.
//
// Note the bundler drops the `node:` prefix (esbuild normalises `node:fs` to
// `fs` for a node platform target). That is the established shape — the
// codeindex bundle the skills already vendor, and ultrasearch's own shipped
// engine, both look like this and run fine. So the check is "is this a
// builtin?", resolved against Node's own list, NOT "does it carry the prefix".
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const bundle = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "engine.mjs");
const src = readFileSync(bundle, "utf8");

// Static `import ... from "x"`, side-effect `import "x"`, and re-exports.
const SPECIFIER_RE = /(?:^|\n)\s*(?:import|export)\b[^'"\n]*?["']([^"']+)["']/g;
const builtins = new Set(builtinModules);

const offenders = new Set();
const seen = new Set();
for (const m of src.matchAll(SPECIFIER_RE)) {
  const spec = m[1];
  seen.add(spec);
  const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
  if (!builtins.has(bare)) offenders.add(spec);
}

if (offenders.size) {
  console.error("check-vendorable: the bundle imports non-builtin modules — it is no longer vendorable:");
  for (const o of [...offenders].sort()) console.error(`  - ${o}`);
  process.exit(1);
}

console.log(`check-vendorable: ${seen.size} import(s), all Node builtins — the bundle is vendorable.`);
