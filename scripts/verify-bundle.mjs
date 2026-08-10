#!/usr/bin/env node
// The docs↔CLI drift gate.
//
// The three consuming skills all have one of these; webindex did not, and it
// showed. `webindex semantic up|down|status` sat in the README for four releases
// while the CLI dispatch knew three commands and not that one — documented,
// reachable from the library, and simply absent from the program. Nothing was
// looking, so nothing said so.
//
// Two assertions, in both directions:
//   A. every `--flag` and `webindex <cmd>` named in the docs exists in the CLI
//   B. every command the CLI dispatches is named in HELP
//
// Plus the MCP surface, which is the part an agent actually sees: every declared
// tool needs a required argument and a capAdvice, because an oversized response
// is WITHHELD rather than truncated and the replacement has to name the argument
// to narrow.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const ok = [];

function check(cond, message) {
  (cond ? ok : problems).push(message);
}

// ── The docs ────────────────────────────────────────────────────────────────
const docFiles = ["SKILL.md", "README.md"];
const refDir = join(root, "references");
const refs = existsSync(refDir) ? readdirSync(refDir).filter((f) => f.endsWith(".md")) : [];
for (const r of refs) docFiles.push(join("references", r));

check(existsSync(join(root, "SKILL.md")), "SKILL.md exists (served as skill://SKILL.md over MCP)");
check(refs.length > 0, `references/ present (${refs.length} document(s))`);

const docs = docFiles.filter((f) => existsSync(join(root, f))).map((f) => ({ f, text: readFileSync(join(root, f), "utf8") }));

// Every references/*.md must be mentioned by SKILL.md, and every one mentioned
// must exist — a reference nobody links is a reference nobody reads, and a link
// to a missing file is a broken promise served over MCP.
const skill = docs.find((d) => d.f === "SKILL.md")?.text ?? "";
for (const r of refs) check(skill.includes(`references/${r}`), `SKILL.md mentions references/${r}`);
for (const m of skill.matchAll(/references\/([\w.-]+\.md)/g)) {
  check(refs.includes(m[1]), `mentioned references/${m[1]} exists`);
}

// ── The CLI ─────────────────────────────────────────────────────────────────
// Read from the BUILT artifacts, not scraped out of the source.
//
// This gate used to recover the flag surface with `/flag\(argv, "([a-z-]+)"\)/`
// over src/cli.ts — it inferred what the CLI accepted by pattern-matching the
// call sites that read each flag. That worked only for as long as every flag
// was read exactly that way: the moment the CLI adopted the engine's own
// parser, the regex matched nothing, the flag set was empty, and all thirty
// documented flags reported as drift at once. An inference that fragile is
// itself the drift risk.
//
// Both artifacts export what the gate needs, so it can simply ask:
// scripts/webindex.mjs declares the tables and HELP, scripts/engine.mjs owns the
// matchers — the same ones tests/cli.test.ts uses at the source layer, so the
// two halves of this gate cannot disagree about what "covered" means.
//
// Importing is safe: main() is behind isInvokedDirectly(), which is false here.
const bundlePath = join(root, "scripts", "webindex.mjs");
check(existsSync(bundlePath), "scripts/webindex.mjs is built (run `pnpm run build`)");
const cliBundle = await import(pathToFileURL(bundlePath).href);
const { helpCoversFlag, documentedFlags } = await import(pathToFileURL(join(root, "scripts", "engine.mjs")).href);

const { VALUE_FLAGS, BOOL_FLAGS, COMMANDS, HELP: help } = cliBundle;
check(
  Array.isArray(VALUE_FLAGS) && Array.isArray(BOOL_FLAGS) && Array.isArray(COMMANDS) && typeof help === "string",
  "the CLI bundle exports VALUE_FLAGS / BOOL_FLAGS / COMMANDS / HELP for this gate",
);
check(help.length > 0, "HELP block exported by the CLI bundle");

const cliFlags = new Set([...VALUE_FLAGS, ...BOOL_FLAGS]);
const cli = readFileSync(join(root, "src", "cli.ts"), "utf8");

// A. Every command the parser accepts is named in HELP. COMMANDS is the table
// the parser itself validates against, so a command missing from HELP is a
// command no reader can find — which is how `semantic` stayed invisible for
// four releases.
const helpCommands = new Set([...help.matchAll(/^\s+webindex ([a-z-]+)/gm)].map((m) => m[1]));
for (const cmd of COMMANDS) check(helpCommands.has(cmd), `HELP documents \`webindex ${cmd}\``);

// B. And the inverse, which the old scrape could not ask: a `cmd === "x"`
// branch for a name COMMANDS does not carry is unreachable, because the parser
// rejects that word before dispatch ever sees it. Dead code that reads as a
// feature.
for (const m of cli.matchAll(/cmd === "([a-z-]+)"/g)) {
  check(COMMANDS.includes(m[1]), `dispatch branch \`cmd === "${m[1]}"\` is a declared command (otherwise unreachable)`);
}

// C. HELP names every flag the CLI accepts. SKILL.md tells agents `--help` is
// the full surface; this is the artifact-layer half of keeping that true.
for (const f of cliFlags) check(helpCoversFlag(help, f), `HELP names --${f}`);

// Flags a doc claims. `--foo` inside a fenced example counts: an example that
// does not run is worse than no example.
// Flags that belong to something else the docs legitimately show: the vendoring
// script, docker compose, npx, git, tsc. Named explicitly so the gate stays a
// gate — an unknown `--flag` is a drift until someone says otherwise here.
const ALLOWED_FOREIGN = new Set([
  "ref", // scripts/sync-engine.mjs
  "check", // scripts/sync-engine.mjs
  "url", // an example of a CONSUMER's own CLI, not webindex's
  "profile",
  "prefer-offline",
  "layout",
  "format",
  "noEmit",
  "write",
  "depth",
  "filter",
  "unshallow",
  "deepen",
  // A CONSUMER's flags, quoted in references/orchestration.md's worked example.
  // The document shows a skill declaring its own phases, so the commands it
  // emits are that skill's, not this engine's.
  "run-root",
  "master",
  "stdout",
]);
// `--help` and `--version` are answered by the parser rather than declared as
// flags, so they are legitimately documented and legitimately absent from the
// tables.
const universe = new Set([...cliFlags, "help", "version"]);
for (const { f, text } of docs) {
  for (const name of documentedFlags(text)) {
    if (ALLOWED_FOREIGN.has(name) || universe.has(name)) continue;
    check(false, `${f}: --${name} does not exist in the CLI`);
  }
}

// ── The MCP surface ─────────────────────────────────────────────────────────
const toolNames = [...cli.matchAll(/name: "(webindex_[a-z_]+)"/g)].map((m) => m[1]);
check(toolNames.length > 0, `${toolNames.length} MCP tools declared`);
const advice = /capAdvice: \{([\s\S]*?)\n {4}\}/.exec(cli)?.[1] ?? "";
for (const t of toolNames) {
  check(advice.includes(`${t}:`), `${t} has capAdvice (a capped response must name what to narrow)`);
}

// ── Report ──────────────────────────────────────────────────────────────────
for (const line of ok) console.log(`  ok   ${line}`);
if (problems.length) {
  console.error("");
  for (const p of problems) console.error(`  FAIL ${p}`);
  console.error(`\nverify-bundle: ${problems.length} drift(s) between the docs and the CLI.`);
  process.exit(1);
}
console.log(`\nverify-bundle: ok — ${ok.length} check(s), docs and CLI agree.`);
