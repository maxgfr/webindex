import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The engine must not compete with the skills built on it.
//
// It is capable enough to LOOK like it answers a research question — it can
// search, crawl, fetch and rank — while having, by design, no evidence model,
// no citation gate and no report. If it ever entered the description-matching
// pool it would sometimes win against ultrasearch or ultradoc and deliver a
// worse answer: the ungrounded summary those tools exist to prevent.
//
// Nothing in the code can enforce that. These assertions can.

const root = join(import.meta.dirname, "..");
const skillMd = readFileSync(join(root, "SKILL.md"), "utf8");
const frontmatter = (/^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)?.[1] ?? "") as string;
const description = /^description:\s*([\s\S]*?)(?=\n\w+:|$)/m.exec(frontmatter)?.[1]?.trim() ?? "";
const cli = readFileSync(join(root, "src", "cli.ts"), "utf8");

describe("the engine stays out of the skill-matching pool", () => {
  it("has a frontmatter description at all", () => {
    // A negative control: every assertion below is vacuous if this is empty.
    expect(description.length).toBeGreaterThan(80);
  });

  it("describes itself without any trigger phrasing", () => {
    // Every installed skill in this family opens with "Use when the user…" and
    // carries a Triggers list. That shape is what makes a skill WIN a match.
    // This one describes what it is; it never tells an agent when to reach for
    // it, and that is the difference between a library and a competitor.
    for (const trigger of [/\buse when\b/i, /\btriggers?\s*:/i, /\buse this (skill|when)\b/i, /\binvoke (this|when)\b/i, /\bwhenever the user\b/i]) {
      expect(description, `description must not read as a trigger (${trigger})`).not.toMatch(trigger);
    }
  });

  it("keeps the root source canonical and exposes a complete Codex package", () => {
    // MCP continues serving the root document. Codex discovers a versioned
    // package made only of links to that source, its engine and references.
    expect(existsSync(join(root, "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "skills", "webindex", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "skills", "webindex", "scripts", "webindex.mjs"))).toBe(true);
    expect(existsSync(join(root, "skills", "webindex", "references"))).toBe(true);
    expect(existsSync(join(root, ".agents", "skills", "webindex", "SKILL.md"))).toBe(true);
  });

  it("declares explicit-only invocation through supported Codex metadata", () => {
    const metadata = readFileSync(join(root, "agents", "openai.yaml"), "utf8");
    expect(metadata).toMatch(/allow_implicit_invocation:\s*false/);
  });

  it("says plainly what it is not, and routes elsewhere", () => {
    // The document goes to every agent that connects to the MCP server, so it
    // is the right place to say "I am not the tool for that" — and to name the
    // one that is.
    expect(skillMd).toMatch(/## What this is not/);
    for (const skill of ["ultrasearch", "ultradoc", "construct"]) expect(skillMd).toContain(skill);
  });

  it("still fits the matching cap, in case it is ever read as one", () => {
    expect(description.length).toBeLessThanOrEqual(1024);
  });
});

describe("the MCP surface stays primitives, not pipelines", () => {
  const tools = [...cli.matchAll(/name: "(webindex_[a-z_]+)"/g)].map((m) => m[1] as string);

  it("declares tools", () => {
    expect(tools.length).toBeGreaterThan(10);
  });

  it("exposes no pipeline-shaped tool", () => {
    // The tri: one input, one output, no product decision. `hybrid_search`,
    // `orchestrate` and the `skill` toolchain are all reachable from the CLI
    // and deliberately absent here — each of them reads to an agent as "do the
    // whole job for me", which is how the engine would start eating the skills
    // built on it.
    for (const forbidden of ["webindex_hybrid_search", "webindex_hybrid", "webindex_orchestrate", "webindex_skill", "webindex_check"]) {
      expect(tools, `${forbidden} is pipeline-shaped and must stay CLI-only`).not.toContain(forbidden);
    }
  });

  it("keeps the crawl tool bounded, so enumerating a site is never accidental", () => {
    const decl = /name: "webindex_crawl"[\s\S]*?required: \[([^\]]*)\]/.exec(cli)?.[1] ?? "";
    expect(decl).toContain("max");
  });
});

describe("the vendored surface carries no dev-time tooling", () => {
  const index = readFileSync(join(root, "src", "index.ts"), "utf8");

  it("keeps the skill toolchain out of the library", () => {
    // Same triage as the MCP surface, for the same reason. `webindex skill …`
    // gates a repository from the outside; inlining it into eight skills'
    // runtime artifacts would be dead weight in every one of them. A skill that
    // wants the assertion inside its own suite shells out to
    // `webindex skill check --json`, which its CI runs anyway.
    expect(index).not.toMatch(/skillkit/);
  });

  it("still reaches it from the command line", () => {
    // The other half: absent from the library must not mean absent altogether.
    expect(cli).toMatch(/from "\.\/skillkit\/index\.js"/);
  });
});
