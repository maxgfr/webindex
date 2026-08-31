// Starting the ninth skill without copy-pasting the eighth.
//
// Every skill in this family began as a copy of its predecessor, which is how
// eight repositories came to share ~600 lines of packaging code that then
// drifted apart in each. Scaffolding the shape rather than copying a tree means
// the next one starts from the current answer instead of from whatever the last
// one happened to have when it was cloned.
//
// Deliberately small. It emits the files whose CONTENT is genuinely the same in
// every skill — the engine shim, the config, the packaging gates in CI, the
// package layout — and nothing that is the skill's own product. A generator
// that writes a src/ tree would be writing someone's tool for them.

import { join } from "node:path";
import { ensureDir, writeArtifact } from "../no-write.js";
import { SKILL_CONFIG } from "./config.js";

export interface ScaffoldResult {
  written: string[];
  errors: string[];
}

const enginesJson = (engine: string, repo: string, minRef: string) =>
  JSON.stringify(
    {
      _comment:
        "The packaging contract for this skill, read by `skill vendor|check|bundle`. `forks` is a ratchet: entries may leave, never arrive — so the next declaration shadowing an engine export is an argued decision rather than a quiet copy. `usageFloor` goes up when a layer lands and never down to make a red run pass.",
      name: engine,
      engines: { webindex: { repo, minRef, meta: "webindex.meta.json" } },
      usageFloor: 0,
      forks: {},
      allowedForeignFlags: [],
    },
    null,
    2,
  );

const engineShim = (name: string, prefix: string) => `// The vendored engine, configured for this skill.
//
// Everything in src/ reaches the engine through THIS module, never through
// src/vendor/ directly. That is the whole point: you cannot obtain an engine
// function without first importing the module that configures it, so there is
// no ordering hazard to remember and no entry point that can forget — a new CLI
// command, a new MCP handler and a test all get a configured engine for free.
//
// The engine reads \`${prefix}_*\` at CALL time, so every variable a user has
// already exported keeps working. \`cli\` names this tool inside engine-emitted
// notes, and \`contactUrl\` goes into the polite User-Agent rate-limited APIs
// see — it must identify ${name}, not the shared engine underneath.
import { configure } from "./vendor/webindex-engine.mjs";

configure({
  name: "${name}",
  envPrefix: "${prefix}",
  cli: "${name}",
  contactUrl: "https://github.com/maxgfr/${name}",
});

export * from "./vendor/webindex-engine.mjs";
`;

const ci = () => `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run typecheck
      - run: pnpm run lint
      - run: pnpm test

  # The packaging gates. Each one has caught a real defect in a sibling skill:
  # a pin nine releases stale, a re-forked engine layer running beside the
  # vendored one, and a SKILL.md at the repo root that would have installed
  # alone without its engine.
  packaging:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
      - run: npx webindex skill check
      - run: npx webindex skill bundle
      - run: npx webindex skill vendor --check
`;

const gitignore = `node_modules/
coverage/
*.tsbuildinfo
`;

/**
 * Write the shape a skill repository needs, into `root`.
 *
 * Never overwrites: an existing file is reported and left alone, because the
 * plausible reason to run this in a populated directory is to add a missing
 * piece, and silently replacing a configured `skill.json` would be the worst
 * possible interpretation of that.
 */
export function scaffoldSkill(
  root: string,
  name: string,
  opts: { engineRepo?: string; minRef?: string; exists?: (path: string) => boolean } = {},
): ScaffoldResult {
  const errors: string[] = [];
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return { written: [], errors: [`"${name}" is not a usable skill name — lower-case letters, digits and hyphens, starting with a letter.`] };
  }

  const prefix = name.toUpperCase().replace(/-/g, "_");
  const files: Record<string, string> = {
    [SKILL_CONFIG]: `${enginesJson(name, opts.engineRepo ?? "maxgfr/webindex", opts.minRef ?? "v1.15.0")}\n`,
    [join("src", "engine.ts")]: engineShim(name, prefix),
    [join("skills", name, "SKILL.md")]:
      `---\nname: ${name}\ndescription: TODO — one sentence saying WHEN to use this skill, under 1000 characters.\n---\n\n# ${name}\n\nTODO\n`,
    [join(".github", "workflows", "ci.yml")]: ci(),
    ".gitignore": gitignore,
  };

  const written: string[] = [];
  const exists = opts.exists;
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    if (exists?.(path)) {
      errors.push(`${rel} already exists — left alone.`);
      continue;
    }
    ensureDir(join(path, ".."));
    written.push(writeArtifact(path, content));
  }
  return { written, errors };
}
