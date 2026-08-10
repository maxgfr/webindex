import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configure } from "../src/brand.js";
import { ensureDir, resetNoWrite, setNoWrite, takeArtifacts } from "../src/no-write.js";
import { emitWorkflowScript, listPhases, oneWriterFooter, orchestrateRun, type PhaseDefinition, toBatches, WORKFLOW_FORBIDDEN } from "../src/orchestrate.js";

// Two phase tables, deliberately shaped like the two real ones this replaces:
// a heavy per-unit phase that fans out at any count above one (ultrasearch's
// `gather`), and a cheap per-pair phase that collapses under the floor
// (its `verify`). If one PhaseDefinition can express both, the extraction holds.

interface Plan {
  subQuestions: { id: string }[];
}
interface Todo {
  pairs: { claimId: string; sourceId: string }[];
}

const GATHER: PhaseDefinition<Plan> = {
  name: "gather",
  worklist: "PLAN.json",
  ids: (p) => (Array.isArray(p?.subQuestions) ? p.subQuestions.map((s) => s.id) : undefined),
  prerequisite: (run, engine) => `node ${engine} plan --run-root ${run}`,
  role: "gatherer",
  title: "Gather",
  schema: { type: "object", required: ["gathered"] },
  batchSize: 1,
  collapseFloor: () => 1,
  description: (n) => `Gather evidence for the ${n} sub-question(s)`,
  applyHint: (run, engine) => [`node ${engine} merge --master ${run}`],
};

const VERIFY: PhaseDefinition<Todo> = {
  name: "verify",
  worklist: "VERIFY.todo.json",
  ids: (t) => (Array.isArray(t?.pairs) ? t.pairs.map((p) => `${p.claimId}:${p.sourceId}`) : undefined),
  prerequisite: (run, engine) => `node ${engine} verify --run ${run}`,
  role: "skeptic",
  title: "Verify",
  schema: { type: "object", required: ["verdicts"] },
  batchSize: 8,
  description: (n) => `Verify the ${n} claim-source pair(s)`,
  applyHint: (run, engine) => [`node ${engine} verify --apply ${run}`],
};

// biome-ignore lint/suspicious/noExplicitAny: two differently-typed phase tables in one run, which is the real shape
const DEFS = [GATHER, VERIFY] as any;
const ENGINE = "/opt/skill/scripts/skill.mjs";
const contracts = () => ({ gatherer: "# gatherer\n", skeptic: "# skeptic\n" });

let run: string;

beforeEach(() => {
  run = mkdtempSync(join(tmpdir(), "webindex-orch-"));
  resetNoWrite();
  configure({ name: "reader", envPrefix: "READER", cli: "reader" });
});
afterEach(() => {
  resetNoWrite();
  rmSync(run, { recursive: true, force: true });
});

const plan = (n: number) => writeFileSync(join(run, "PLAN.json"), JSON.stringify({ subQuestions: Array.from({ length: n }, (_, i) => ({ id: `Q${i + 1}` })) }));
const todo = (n: number) =>
  writeFileSync(join(run, "VERIFY.todo.json"), JSON.stringify({ pairs: Array.from({ length: n }, (_, i) => ({ claimId: `C${i + 1}`, sourceId: "S1" })) }));

describe("listPhases", () => {
  it("reports a phase ready only once its worklist parses", () => {
    plan(2);
    const [gather, verify] = listPhases(run, ENGINE, DEFS);
    expect(gather).toMatchObject({ name: "gather", ready: true, items: 2, ids: ["Q1", "Q2"] });
    expect(verify).toMatchObject({ name: "verify", ready: false, items: 0 });
  });

  it("treats a half-written worklist as not ready, not as an error", () => {
    // The file exists but is mid-write or hand-edited. Failing hard would
    // strand a run the prerequisite command can simply regenerate.
    writeFileSync(join(run, "PLAN.json"), '{"subQuestions":[');
    expect(listPhases(run, ENGINE, DEFS)[0]).toMatchObject({ ready: false, items: 0 });
  });

  it("treats a parseable worklist of the wrong shape as not ready", () => {
    writeFileSync(join(run, "PLAN.json"), '{"somethingElse":true}');
    expect(listPhases(run, ENGINE, DEFS)[0]?.ready).toBe(false);
  });

  it("names the command that produces a missing worklist", () => {
    expect(listPhases(run, ENGINE, DEFS)[1]?.prerequisite).toBe(`node ${ENGINE} verify --run ${run}`);
  });

  it("hands the parsed worklist back, so a phase's own emitters can read it", () => {
    plan(1);
    expect(listPhases<Plan>(run, ENGINE, [GATHER])[0]?.parsed).toEqual({ subQuestions: [{ id: "Q1" }] });
  });
});

describe("orchestrateRun", () => {
  it("writes the contracts, a script per ready phase, and the runbook", () => {
    plan(4);
    todo(20);
    const r = orchestrateRun(run, ENGINE, DEFS, contracts);
    expect(r.exitCode).toBe(0);
    expect(readdirSync(join(run, "orchestration")).sort()).toEqual(["RUNBOOK.md", "agents", "gather.workflow.mjs", "out", "verify.workflow.mjs"]);
    expect(readdirSync(join(run, "orchestration", "agents")).sort()).toEqual(["gatherer.md", "skeptic.md"]);
  });

  it("writes the contracts even under --eco, because the runbook cites them", () => {
    plan(4);
    const r = orchestrateRun(run, ENGINE, DEFS, contracts, { eco: true });
    expect(existsSync(join(run, "orchestration", "agents", "gatherer.md"))).toBe(true);
    expect(existsSync(join(run, "orchestration", "gather.workflow.mjs"))).toBe(false);
    expect(r.written.some((p) => p.endsWith("RUNBOOK.md"))).toBe(true);
  });

  it("skips a phase whose worklist is not ready, and says nothing about it", () => {
    plan(4);
    orchestrateRun(run, ENGINE, DEFS, contracts);
    expect(existsSync(join(run, "orchestration", "verify.workflow.mjs"))).toBe(false);
  });

  it("refuses an unknown phase", () => {
    const r = orchestrateRun(run, ENGINE, DEFS, contracts, { phase: "gathr" });
    expect(r.exitCode).toBe(2);
    expect(r.errors[0]).toMatch(/unknown phase "gathr" — expected one of: gather, verify/);
  });

  it("refuses a phase that is not ready, and says how to make it ready", () => {
    const r = orchestrateRun(run, ENGINE, DEFS, contracts, { phase: "verify" });
    expect(r.exitCode).toBe(2);
    expect(r.errors[0]).toMatch(/verify --run/);
  });

  it("notices an empty worklist rather than emitting a workflow over nothing", () => {
    plan(0);
    const r = orchestrateRun(run, ENGINE, DEFS, contracts, { phase: "gather" });
    expect(r.notices[0]).toMatch(/worklist is empty/);
    expect(existsSync(join(run, "orchestration", "gather.workflow.mjs"))).toBe(false);
  });

  it("nudges --eco when a worklist is too small to amortize a fan-out", () => {
    todo(2); // under the default floor of 3
    const r = orchestrateRun(run, ENGINE, DEFS, contracts, { phase: "verify" });
    expect(r.notices[0]).toMatch(/only 2 item\(s\) — the sequential --eco path/);
    // Emitted anyway: the notice is advice, not a refusal.
    expect(existsSync(join(run, "orchestration", "verify.workflow.mjs"))).toBe(true);
  });

  it("honours a per-phase collapse floor over the shared one", () => {
    // Two heavy gather units are worth two agents; two cheap verify pairs are not.
    plan(2);
    todo(2);
    const r = orchestrateRun(run, ENGINE, DEFS, contracts);
    expect(r.notices).toEqual([`phase "verify": only 2 item(s) — the sequential --eco path is equivalent and cheaper.`]);
  });

  it("writes nothing at all under the no-write gate", () => {
    // The regression test for the real defect this extraction removes: one
    // consuming skill emitted its orchestration with a bare writeFileSync and
    // silently escaped its own --stdout gate.
    plan(4);
    todo(20);
    setNoWrite(true);
    const r = orchestrateRun(run, ENGINE, DEFS, contracts);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(run, "orchestration"))).toBe(false);
    const collected = takeArtifacts().map((a) => a.path.replace(`${run}/`, ""));
    expect(collected.sort()).toEqual([
      "orchestration/RUNBOOK.md",
      "orchestration/agents/gatherer.md",
      "orchestration/agents/skeptic.md",
      "orchestration/gather.workflow.mjs",
      "orchestration/verify.workflow.mjs",
    ]);
  });
});

describe("the emitted workflow script", () => {
  const emit = (n: number, def: PhaseDefinition<Plan> | PhaseDefinition<Todo> = VERIFY) => {
    def === VERIFY ? todo(n) : plan(n);
    const ph = listPhases(run, ENGINE, [def] as never)[0]!;
    return emitWorkflowScript(ph, def, run, ENGINE, 3);
  };

  it("opens with a pure `export const meta` literal", () => {
    // The harness parses it before executing anything, so an interpolation or a
    // call there is a workflow that cannot be launched at all.
    const first = emit(20).split("\n")[0]!;
    expect(first).toMatch(/^export const meta = \{/);
    expect(() => JSON.parse(first.replace("export const meta = ", ""))).not.toThrow();
  });

  it("names the consuming skill, not the engine", () => {
    expect(JSON.parse(emit(20).split("\n")[0]!.replace("export const meta = ", "")).name).toBe("reader-verify");
  });

  it("never reads the clock or a random source", () => {
    const script = emit(20);
    for (const bad of WORKFLOW_FORBIDDEN) expect(script).not.toContain(bad);
  });

  it("refuses to emit when a phase interpolates a forbidden call", () => {
    // The assertion is on the FINISHED text, so it catches the call however it
    // arrived — a description, a fold hint, a schema's own prose.
    todo(20);
    const ph = listPhases(run, ENGINE, [VERIFY] as never)[0]!;
    const poisoned = { ...VERIFY, description: (n: number) => `${n} pairs, stamped at Date.now()` };
    expect(() => emitWorkflowScript(ph, poisoned, run, ENGINE, 3)).toThrow(/contains Date\.now\(\)/);
  });

  it("freezes the batches at emit time, one agent per batchSize items", () => {
    const script = emit(20); // batchSize 8 → 8 + 8 + 4
    const batches = JSON.parse(/const BATCHES = (\[.*?\])\n/s.exec(script)![1]!);
    expect(batches.map((b: string[]) => b.length)).toEqual([8, 8, 4]);
  });

  it("collapses to a single batch under the floor", () => {
    const batches = JSON.parse(/const BATCHES = (\[.*?\])\n/s.exec(emit(2))![1]!);
    expect(batches).toHaveLength(1);
  });

  it("keeps a heavy phase fanned out at any count above its own floor", () => {
    const batches = JSON.parse(/const BATCHES = (\[.*?\])\n/s.exec(emit(2, GATHER))![1]!);
    expect(batches).toEqual([["Q1"], ["Q2"]]);
  });

  it("carries the fold as comments, because the workflow must not run it", () => {
    expect(emit(20)).toContain(`//   node ${ENGINE} verify --apply ${run}`);
  });

  it("tells the reader the worklist is the source of truth", () => {
    expect(emit(20)).toContain("re-run `reader orchestrate --phase verify`");
  });
});

describe("the runbook", () => {
  it("names the prerequisite for every phase that is not ready", () => {
    orchestrateRun(run, ENGINE, DEFS, contracts);
    const rb = readFileSync(join(run, "orchestration", "RUNBOOK.md"), "utf8");
    expect(rb).toContain("Not ready");
    expect(rb).toContain(`node ${ENGINE} plan --run-root ${run}`);
  });

  it("offers both the fan-out and the sequential path for a ready phase", () => {
    plan(4);
    orchestrateRun(run, ENGINE, DEFS, contracts);
    const rb = readFileSync(join(run, "orchestration", "RUNBOOK.md"), "utf8");
    expect(rb).toContain("gather.workflow.mjs");
    expect(rb).toContain("agents/gatherer.md");
    expect(rb).toContain("'Q1,Q2,Q3,Q4'");
  });

  it("carries the skill's own preamble above the phases", () => {
    orchestrateRun(run, ENGINE, DEFS, contracts, { runbookPreamble: ["Read the deep-research playbook first."] });
    expect(readFileSync(join(run, "orchestration", "RUNBOOK.md"), "utf8")).toContain("Read the deep-research playbook first.");
  });
});

describe("the shared pieces", () => {
  it("batches in order, and never with a zero width", () => {
    expect(toBatches(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
    expect(toBatches(["a", "b"], 0)).toEqual([["a"], ["b"]]);
  });

  it("states the one-writer rule, and the sanctioned exception when there is one", () => {
    expect(oneWriterFooter("/r")).toContain("sole writer");
    expect(oneWriterFooter("/r")).not.toContain("One sanctioned exception");
    expect(oneWriterFooter("/r", { sanctioned: "its own sub-dossier" })).toContain("One sanctioned exception: its own sub-dossier");
  });

  it("names the writing commands a subagent must not run", () => {
    expect(oneWriterFooter("/r", { writingCommands: ["gather", "merge"] })).toContain("`gather`, `merge`");
  });

  it("points oversized prose at a file namespaced to the one agent", () => {
    expect(oneWriterFooter("/r")).toContain(join("/r", "orchestration", "out"));
  });
});

describe("ensureDir under the gate", () => {
  it("creates the orchestration tree only when writes are allowed", () => {
    ensureDir(join(run, "orchestration", "out"));
    expect(existsSync(join(run, "orchestration", "out"))).toBe(true);
  });
});
