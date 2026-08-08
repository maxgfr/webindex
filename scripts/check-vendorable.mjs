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
// codeindex bundle looks exactly like this and runs fine. So the check is "is
// this a builtin?", resolved against Node's own list, NOT "does it carry the
// prefix".
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const src = readFileSync(join(scriptsDir, "engine.mjs"), "utf8");

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

// The DECLARATIONS have to be self-contained too, and for a sharper reason.
//
// Consumers vendor exactly two files. When a second tsup entry appeared, its
// dts bundler hoisted the types both entries shared into a chunk and left
// engine.d.mts importing it — a file nobody copies. The JS was still perfect,
// so this check passed; but every MCP type resolved to nothing downstream and
// three skills' typechecks broke on implicit `any`. The declarations lost 129
// lines and nothing noticed until a re-pin failed in CI.
const dts = readFileSync(join(scriptsDir, "engine.d.mts"), "utf8");
const dtsImports = [...dts.matchAll(SPECIFIER_RE)].map((m) => m[1]);
const dangling = dtsImports.filter((spec) => {
  if (spec.startsWith(".")) return true; // a sibling chunk that is never vendored
  return !builtins.has(spec.startsWith("node:") ? spec.slice(5) : spec);
});
if (dangling.length) {
  console.error("check-vendorable: scripts/engine.d.mts imports files that consumers never receive:");
  for (const d of [...new Set(dangling)].sort()) console.error(`  - ${d}`);
  console.error("\n  Every type must be inlined. If tsup split them into a chunk, narrow `dts` to the library entry.");
  process.exit(1);
}

console.log(`check-vendorable: ${seen.size} import(s), all Node builtins; declarations self-contained (${dts.split("\n").length} lines) — vendorable.`);
