# Orchestration — turning worklists into a fan-out

The engine emits a multi-agent orchestration from a run's **current** worklists.
It does not decide what the agents do; it decides how they are dispatched, and
it enforces the two constraints the harness imposes on the emitted script.

## The shape

```
a phase is ready when its worklist parses  →  its ids are the fan-out units
→  batch them  →  emit <phase>.workflow.mjs, the contracts it references,
   and a sequential RUNBOOK.md as the fallback
```

Per-phase emission is not a detail. Each worklist only exists **after** its own
engine step has run, so a whole-pipeline script emitted up front could only
carry placeholders — which is exactly what every citation gate in this family
exists to prevent.

## What you declare

A `PhaseDefinition[]`. The engine reads your worklist only through two
callbacks, so it never learns what a claim or an evidence item is.

```ts
const GATHER: PhaseDefinition<Plan> = {
  name: "gather",
  worklist: "PLAN.json",
  ids: (p) => (Array.isArray(p?.subQuestions) ? p.subQuestions.map((s) => s.id) : undefined),
  prerequisite: (run, engine) => `node ${engine} plan --run-root ${run}`,
  role: "gatherer",          // → orchestration/agents/gatherer.md
  title: "Gather",
  schema: GATHER_SCHEMA,     // handed to agent(…, { schema })
  batchSize: 1,
  collapseFloor: () => 1,
  description: (n) => `Gather evidence for the ${n} sub-question(s)`,
  applyHint: (run, engine) => [`node ${engine} merge --master ${run}`],
};

orchestrateRun(runDir, engineAbs, [GATHER, VERIFY], contracts, { phase, eco });
```

`ids` returning `undefined` is how a file that exists but is half-written stays
"not ready" instead of producing a workflow over garbage. Absent, unreadable and
malformed all collapse to the same answer, because the prerequisite command can
regenerate the file and failing hard would strand the run instead.

## Two rules the emitted script must obey

Both were carried as a comment in eight repositories. They are now asserted
against the emitter's own finished output, so a phase that interpolates a
timestamp into its description fails at emit time rather than at launch.

1. **`export const meta` must be a pure literal.** The harness parses it before
   executing anything — no variables, no calls, no interpolation.
2. **No emitted line may call `Date.now()`, `Math.random()` or `new Date()`.**
   They throw there, because a workflow has to stay resumable. A workflow that
   needs a timestamp takes one as an injected constant.

The assertion runs on the finished text rather than the inputs, because the ways
such a call can arrive are open-ended: a description, a fold hint, a schema's
own prose.

## Collapse floors

Below a floor, a fan-out does not pay for itself and `orchestrate` says so
rather than emitting a workflow nobody should launch. The floor is **per phase**
because units differ in weight: one heavy per-sub-question gather earns its own
agent at any count above one, while one cheap claim↔source judgment does not.

## The one-writer rule

Subagents return fragments; the orchestrator is the sole writer. One writer,
many readers — no races and no clobbered evidence. `oneWriterFooter(runAbs, {
sanctioned, writingCommands })` renders it, with the one exception a role may
have (a gatherer writing its own disjoint sub-dossier) as a parameter.

Every artifact goes through `writeArtifact`, so `--stdout` leaves the filesystem
exactly as it found it. That is not a refinement: one consuming skill wrote these
files with a bare `writeFileSync` and silently escaped its own gate.

## What stays yours

The phase table, the contract prose, and the output schemas your subagents must
satisfy. That is your product. The engine owns the emission, the batching, the
runbook and the harness constraints.
