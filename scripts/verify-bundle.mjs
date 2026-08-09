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
import { fileURLToPath } from "node:url";

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
const cli = readFileSync(join(root, "src", "cli.ts"), "utf8");
const help = /const HELP = `([\s\S]*?)`;/.exec(cli)?.[1] ?? "";
check(help.length > 0, "HELP block found in src/cli.ts");

// Commands the dispatch actually handles: `cmd === "x"` and the STACK_SERVICES
// route. Derived from the source so a new command cannot be added invisibly.
const dispatched = new Set();
for (const m of cli.matchAll(/cmd === "([a-z-]+)"/g)) dispatched.add(m[1]);

// The stack services are routed by table (`STACK_SERVICES.includes(cmd)`), not
// by a literal comparison — which is exactly how `semantic` stayed undocumented
// in the CLI for four releases. Read the table too, or this gate has the same
// blind spot the code had. `all` is excluded: the CLI spells it `stack`.
const stackSrc = readFileSync(join(root, "src", "stack.ts"), "utf8");
const stacksBlock = /const STACKS: Record<string, StackSpec> = \{([\s\S]*?)\n\};/.exec(stackSrc)?.[1] ?? "";
const services = [...stacksBlock.matchAll(/^ {2}([a-z-]+): \{/gm)].map((m) => m[1]).filter((s) => s !== "all");
check(services.length > 0, `stack services read from the engine's own table (${services.join(", ")})`);
for (const s of services) dispatched.add(s);

// The help and version aliases are the ONE thing a usage block should not list
// five times over. They are handled in the same branch and documented by the
// block existing at all.
const ALIASES = new Set(["--help", "-h", "help", "--version", "-v"]);
const helpCommands = new Set([...help.matchAll(/^\s+webindex ([a-z-]+)/gm)].map((m) => m[1]));
for (const cmd of dispatched) {
  if (ALIASES.has(cmd)) continue;
  check(helpCommands.has(cmd), `HELP documents \`webindex ${cmd}\``);
}

// Flags: the CLI reads them through flag(argv,"x") and argv.includes("--x").
const cliFlags = new Set([...cli.matchAll(/flag\(argv, "([a-z-]+)"\)/g)].map((m) => m[1]));
for (const m of cli.matchAll(/argv\.includes\("--([a-z-]+)"\)/g)) cliFlags.add(m[1]);

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
]);
for (const { f, text } of docs) {
  for (const m of text.matchAll(/(?<![\w-])--([a-z][a-z0-9-]*)/g)) {
    const name = m[1];
    if (ALLOWED_FOREIGN.has(name)) continue;
    check(cliFlags.has(name), `${f}: --${name} exists in the CLI`);
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
