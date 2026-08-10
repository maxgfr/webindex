// What `orchestrate` actually writes: a Workflow script per phase, and the
// sequential runbook that replaces it when a fan-out is not worth launching.
//
// Everything here is emitted by string concatenation with the run's constants
// injected as JSON literals, because the harness that runs the result imposes
// two rules a generated file can very easily break:
//
//   1. `export const meta` must be a PURE literal — no variables, no calls,
//      no template interpolation. The harness parses it before executing
//      anything.
//   2. No emitted line may call Date.now(), Math.random() or new Date().
//      They THROW in that harness, because a workflow has to be resumable and
//      those three make a run unreproducible.
//
// Both rules were carried as a comment in eight files. Here they are asserted
// against the emitter's own output (see assertWorkflowSafe), so a skill that
// interpolates a timestamp into a phase description finds out at emit time
// rather than when someone launches the workflow.

import { join } from "node:path";
import { brand } from "./../brand.js";
import { shq } from "./../run.js";
import type { PhaseInfo } from "./../orchestrate.js";

/**
 * The three calls that throw inside the workflow harness.
 *
 * `new Date()` with arguments is fine — it is the ARGLESS form that reads the
 * clock — but the emitter refuses both, because distinguishing them by regex
 * invites exactly the mistake the rule exists to stop. A workflow that needs a
 * timestamp takes one as an injected constant.
 */
export const WORKFLOW_FORBIDDEN = ["Date.now(", "Math.random(", "new Date("] as const;

/** The half of a phase that describes how it is EMITTED, as the skill declares it. */
export interface PhaseEmission {
  /** Contract filename under `orchestration/agents/<role>.md`, and the agent's role. */
  role: string;
  /** Progress-group title in the emitted workflow. */
  title: string;
  /** JSON Schema handed to `agent(…, { schema })`, so a fragment is validated on return. */
  schema: unknown;
  /** One agent per batch of at most this many items. */
  batchSize: number;
  /** Collapse to a single batch at or under this count. Defaults to the caller's floor. */
  collapseFloor?(smallWorklist: number): number;
  /** `meta.description` of the emitted workflow. */
  description(items: number): string;
  /** The orchestrator's fold step, rendered as comment lines in the script and in the runbook. */
  applyHint(run: string, engineAbs: string, phase: PhaseInfo): string[];
}

/**
 * The family-standard footer for a dispatch contract: subagents return
 * fragments, the orchestrator is the sole writer.
 *
 * One writer, many readers — no races and no clobbered evidence. Every skill
 * here had a copy; they differed only in whether a role gets a sanctioned
 * write of its own, so that is the parameter.
 *
 * @param runAbs      the run directory, for the oversized-prose escape hatch
 * @param sanctioned  the ONE write this role may perform, if any
 * @param writingCommands  engine commands the subagent must not run
 */
export function oneWriterFooter(runAbs: string, opts: { sanctioned?: string; writingCommands?: readonly string[] } = {}): string {
  const forbidden = opts.writingCommands?.length
    ? ` Do not run any engine command that writes (${opts.writingCommands.map((c) => `\`${c}\``).join(", ")}).`
    : "";
  return `
## Return, don't write (the one-writer rule)

Return ONLY the structured output specified above. Do NOT write, edit, or delete any file in the run folder.${forbidden} The orchestrator is the sole writer: it folds your returned fragments in serially and runs the gates itself.${opts.sanctioned ? `\n\nOne sanctioned exception: ${opts.sanctioned}` : ""}

Exception for oversized prose: if a note is too large to return, write ONLY to \`${join(runAbs, "orchestration", "out")}/<role>-<batch>.md\` — a file namespaced to you alone — and return its path.
`;
}

/** Chunk ids into batches, one subagent per batch. Order-preserving and deterministic. */
export function toBatches(ids: readonly string[], batchSize: number): string[][] {
  const width = Math.max(1, Math.floor(batchSize));
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += width) out.push(ids.slice(i, i + width));
  return out;
}

/**
 * Refuse to emit a script the harness would reject.
 *
 * The check is on the FINISHED text, not on the inputs, because the ways a
 * forbidden call can arrive are open-ended: a phase description, a fold hint, a
 * schema's `description` field. Checking the output catches all of them and
 * cannot be routed around.
 */
function assertWorkflowSafe(script: string, phaseName: string): void {
  for (const bad of WORKFLOW_FORBIDDEN) {
    if (script.includes(bad)) {
      throw new Error(
        `orchestrate: the emitted workflow for phase "${phaseName}" contains ${bad}) — it throws in the workflow harness, which must stay resumable. ` +
          `Inject the value as a constant at emit time instead.`,
      );
    }
  }
}

/**
 * The launchable Workflow script for one ready phase.
 *
 * The worklist is the source of truth: the batches are frozen into the script
 * at emit time, so a worklist that changes needs a re-emit before launching.
 * Saying so in the file itself is cheaper than the confusion of a stale run.
 */
export function emitWorkflowScript<T>(
  phase: PhaseInfo<T>,
  emission: PhaseEmission,
  runAbs: string,
  engineAbs: string,
  smallWorklist: number,
  constants: Record<string, unknown> = {},
): string {
  const cli = brand().cli;
  const scriptPath = join(runAbs, "orchestration", `${phase.name}.workflow.mjs`);
  const meta = { name: `${cli}-${phase.name}`, description: emission.description(phase.items), phases: [{ title: emission.title }] };

  // At or under the floor the fan-out does not amortize: one agent plays every
  // item. The notice nudging --eco fires alongside this in orchestrateRun.
  const floor = emission.collapseFloor ? emission.collapseFloor(smallWorklist) : smallWorklist;
  const batches = phase.items <= floor ? [phase.ids] : toBatches(phase.ids, emission.batchSize);
  const hint = emission.applyHint(runAbs, engineAbs, phase);

  const script = [
    `export const meta = ${JSON.stringify(meta)}`,
    ``,
    `// NOT a plain Node script: launch it with the Workflow tool —`,
    `// Workflow({ scriptPath: ${JSON.stringify(scriptPath)} }).`,
    `//`,
    `// Emitted by \`${cli} orchestrate\` from the CURRENT worklist. The worklist is the`,
    `// source of truth: if it changes, re-run \`${cli} orchestrate --phase ${phase.name}\``,
    `// before launching this.`,
    ``,
    `// Constants for THIS run, injected at emit time — the harness forbids reading`,
    `// the clock or a random source, so nothing here may compute them.`,
    `const RUN = ${JSON.stringify(runAbs)}`,
    `const ENGINE = ${JSON.stringify(engineAbs)}`,
    `const WORKLIST = ${JSON.stringify(phase.worklist)}`,
    `const AGENTS = RUN + '/orchestration/agents'`,
    `const BATCHES = ${JSON.stringify(batches)}`,
    `const SCHEMA = ${JSON.stringify(emission.schema)}`,
    // Run-specific data the caller wants pasted INTO the script rather than
    // read from disk by the subagent. A judge panel is the case that needs it:
    // each judge is handed the decision and its cited evidence verbatim,
    // precisely so it never has to open the run folder it is judging.
    ...Object.entries(constants).map(([name, value]) => `const ${name} = ${JSON.stringify(value)}`),
    ``,
    `function contract(role, extra) {`,
    `  return 'Read and follow the dispatch contract at ' + AGENTS + '/' + role + '.md VERBATIM.\\n'`,
    `    + 'Constants: RUN=' + RUN + '  ENGINE=' + ENGINE + '  WORKLIST=' + WORKLIST + '.\\n'`,
    `    + 'Invoke the engine only by its ABSOLUTE path: node ' + ENGINE + ' <cmd> — and stay within the contract write rules.'`,
    `    + (extra ? '\\n' + extra : '')`,
    `}`,
    ``,
    `log(${JSON.stringify(`${cli} ${phase.name}: ${phase.items} item(s) across `)} + BATCHES.length + ' agent(s)')`,
    ``,
    `phase(${JSON.stringify(emission.title)})`,
    `const results = await pipeline(BATCHES, (batch, _item, i) =>`,
    `  agent(contract(${JSON.stringify(emission.role)}, 'ITEMS=' + batch.join(',')), {`,
    `    label: ${JSON.stringify(`${phase.name}:`)} + (i + 1),`,
    `    phase: ${JSON.stringify(emission.title)},`,
    `    agentType: 'general-purpose',`,
    `    schema: SCHEMA,`,
    `  }))`,
    ``,
    `// One-writer rule: this workflow only COLLECTS the subagents' fragments.`,
    `// The main agent runs the fold itself:`,
    ...hint.map((l) => `//   ${l}`),
    `return { phase: ${JSON.stringify(phase.name)}, worklist: WORKLIST, results: results.filter(Boolean) }`,
    ``,
  ].join("\n");

  assertWorkflowSafe(script, phase.name);
  return script;
}

/**
 * The sequential fallback.
 *
 * Not a lesser path — it is the correct one for a small worklist, and the only
 * one when no subagent-capable harness is present. It lists every phase,
 * whether it is ready, and the exact command that makes it ready, so a reader
 * can walk the whole run by hand.
 */
export function runbookMd<T>(
  phases: readonly PhaseInfo<T>[],
  defs: readonly PhaseEmission[],
  runAbs: string,
  engineAbs: string,
  cli: string,
  preamble: readonly string[] = [],
): string {
  const lines: string[] = [`# ${cli} — orchestration runbook`, ``, `Run: \`${runAbs}\``, ``];
  if (preamble.length) lines.push(...preamble, ``);

  lines.push(
    `The subagents return fragments; **you** are the sole writer. Each phase below`,
    `either fans out through its \`*.workflow.mjs\` or runs sequentially here — the`,
    `fold at the end of a phase is yours either way.`,
    ``,
  );

  phases.forEach((ph, i) => {
    const emission = defs[i];
    lines.push(`## ${ph.name}`, ``);
    if (!ph.ready) {
      lines.push(`Not ready — \`${ph.worklist}\` does not exist yet. Produce it first:`, ``, `    ${ph.prerequisite}`, ``);
      return;
    }
    lines.push(`${ph.items} item(s) in \`${ph.worklist}\`.`, ``);
    if (ph.items === 0) {
      lines.push(`Nothing to do for this phase.`, ``);
      return;
    }
    if (emission) {
      const batches = toBatches(ph.ids, emission.batchSize);
      lines.push(
        `Fan out: \`Workflow({ scriptPath: "${join(runAbs, "orchestration", `${ph.name}.workflow.mjs`)}" })\``,
        `(${batches.length} agent(s) of at most ${emission.batchSize} item(s), contract \`agents/${emission.role}.md\`).`,
        ``,
        `Sequentially instead: play \`agents/${emission.role}.md\` yourself over ${shq(ph.ids.join(","))}.`,
        ``,
        `Then fold, as the sole writer:`,
        ``,
        ...emission.applyHint(runAbs, engineAbs, ph).map((l) => `    ${l}`),
        ``,
      );
    }
  });

  return `${lines.join("\n")}\n`;
}
