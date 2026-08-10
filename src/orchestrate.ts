// Turning a run's CURRENT worklists into a launchable multi-agent fan-out.
//
// Eight skills in this family emit one of these, and until now each carried its
// own copy: the same PhaseInfo, the same OrchestrateOptions, the same
// orchestrateRun body, differing only in the table of phases. The copies had
// already drifted in ways that matter — one wrote its artifacts with a raw
// writeFileSync and so escaped the no-write gate entirely, and two passed
// different constants to the same template parameter.
//
// What is shared is the SHAPE, and it is genuinely the same everywhere:
//
//   a phase is ready when its worklist parses  →  its ids are the fan-out units
//   →  batch them  →  emit one workflow script per phase, the dispatch
//   contracts it references, and a sequential RUNBOOK as the fallback.
//
// Per-phase emission is not a detail. Each worklist only exists after its own
// engine step has run, so a whole-pipeline script emitted up front could only
// carry placeholders — which is exactly what every check gate in this family
// exists to prevent.
//
// What stays with the skill: the table of phases, the contract prose, and the
// output schemas its subagents must satisfy. Those are its product. This module
// never knows what a claim is, what an evidence item is, or what its agents are
// being asked to decide.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { brand } from "./brand.js";
import { ensureDir, writeArtifact } from "./no-write.js";
import { readJsonSafe } from "./run.js";
import { emitWorkflowScript, runbookMd, type PhaseEmission } from "./orchestrate/templates.js";

export { oneWriterFooter, toBatches, emitWorkflowScript, runbookMd, WORKFLOW_FORBIDDEN } from "./orchestrate/templates.js";
export type { PhaseEmission } from "./orchestrate/templates.js";

/**
 * Below this many items a fan-out does not pay for itself, and `orchestrate`
 * says so rather than emitting a workflow nobody should launch.
 *
 * A default, not a rule: each phase overrides it through `collapseFloor`,
 * because the units differ in weight. One heavy per-sub-question gather is
 * worth its own agent at any count above one; one cheap claim↔source judgment
 * is not.
 */
export const SMALL_WORKLIST = 3;

/** One agent per batch of at most this many items, unless a phase says otherwise. */
export const BATCH_SIZE = 8;

/**
 * A phase, as the SKILL declares it.
 *
 * `T` is whatever that phase's worklist file parses to — the skill's own type.
 * This module reads it only through the two callbacks below, so it never has to
 * know the shape.
 */
export interface PhaseDefinition<T = unknown> extends PhaseEmission {
  /** Phase name, used for `--phase`, the script filename and the progress group. */
  name: string;
  /** The worklist filename, relative to the run directory. */
  worklist: string;
  /**
   * The fan-out ids for this phase, or undefined when it is not ready.
   *
   * Returning undefined is how a file that exists but is half-written stays
   * "not ready" instead of producing a workflow over garbage — which is why
   * every consumer's version of this tested `Array.isArray(...)` before
   * trusting the parse.
   *
   * `run` and `engineAbs` come along because a phase's units are not always a
   * field of one file: one consumer derives its research gaps by ANALYSING the
   * whole run, and needs the engine path to write each unit's drill command
   * into the id itself. A callback that only ever saw the parsed worklist
   * forced that phase to stay forked.
   */
  ids(parsed: T | undefined, run: string, engineAbs: string): string[] | undefined;
  /** The engine command that produces this worklist. Shown when it is missing. */
  prerequisite(run: string, engineAbs: string, parsed?: T): string;
}

/** A phase, as this module resolved it against a run directory. */
export interface PhaseInfo<T = unknown> {
  name: string;
  ready: boolean;
  /** Absolute path of the worklist this phase fans out over. */
  worklist: string;
  items: number;
  ids: string[];
  /** The command that produces the worklist when it is missing. */
  prerequisite: string;
  /** The parsed worklist, when ready — a phase's own emitters may need it. */
  parsed?: T;
}

export interface OrchestrateOptions {
  /** Emit only this phase. Exit code 2 when its worklist does not exist yet. */
  phase?: string;
  /** Emit only the RUNBOOK and the contracts — the explicit low-token path. */
  eco?: boolean;
  /** Override the default collapse floor. */
  smallWorklist?: number;
  /** Lines the skill wants at the top of RUNBOOK.md, above the phase list. */
  runbookPreamble?: string[];
  /**
   * Extra `const NAME = <json>` lines in every emitted workflow.
   *
   * For run-specific data a subagent must receive rather than fetch: a judge
   * handed the decision and its evidence verbatim never has to open the run
   * folder it is judging. Values are JSON-serialised, so the harness's
   * pure-literal rule still holds.
   */
  constants?: Record<string, unknown>;
}

export interface OrchestrateResult {
  exitCode: number;
  written: string[];
  notices: string[];
  errors: string[];
  phases: PhaseInfo[];
}

/**
 * Resolve every declared phase against a run directory.
 *
 * Reading is tolerant by design (see readJsonSafe): absent, unreadable and
 * malformed all mean "not ready", because the prerequisite command can simply
 * regenerate the file and failing hard would strand the run instead.
 */
export function listPhases<T>(runDir: string, engineAbs: string, defs: readonly PhaseDefinition<T>[]): PhaseInfo<T>[] {
  const run = resolve(runDir);
  return defs.map((def) => {
    const worklist = join(run, def.worklist);
    const parsed = readJsonSafe<T>(worklist);
    const ids = def.ids(parsed, run, engineAbs);
    const ready = ids !== undefined;
    return {
      name: def.name,
      ready,
      worklist,
      items: ids?.length ?? 0,
      ids: ids ?? [],
      prerequisite: def.prerequisite(run, engineAbs, parsed),
      ...(ready ? { parsed } : {}),
    };
  });
}

/**
 * Emit the run's orchestration from its current worklists.
 *
 * Writes, in `<run>/orchestration/`:
 *   agents/<role>.md      the dispatch contracts, every role, every call
 *   <phase>.workflow.mjs  one launchable Workflow script per ready phase
 *   RUNBOOK.md            the sequential fallback
 *
 * The contracts are rewritten on every call, including under `--eco`: they
 * double as the RUNBOOK's self-pass checklists, so the sequential path needs
 * them just as much as the fan-out does.
 *
 * Every write goes through `writeArtifact`, so `--stdout` leaves the filesystem
 * exactly as it found it. That is not a refinement — one consuming skill wrote
 * these files with a bare writeFileSync and silently escaped its own gate.
 */
export function orchestrateRun<T>(
  runDir: string,
  engineAbs: string,
  defs: readonly PhaseDefinition<T>[],
  contracts: (run: string, engineAbs: string, phases: PhaseInfo<T>[]) => Record<string, string>,
  opts: OrchestrateOptions = {},
): OrchestrateResult {
  const run = resolve(runDir);
  // A run directory that does not exist is a typo, not an empty run. Without
  // this the `ensureDir` below would CREATE it and the command would report a
  // successful orchestration of nothing — which is how a mistyped --run comes
  // to look like a run with no work in it.
  if (!existsSync(run)) {
    return { exitCode: 2, written: [], notices: [], errors: [`run dir not found: ${run}`], phases: [] };
  }
  const phases = listPhases(run, engineAbs, defs);
  const byName = new Map(defs.map((d) => [d.name, d]));
  const small = opts.smallWorklist ?? SMALL_WORKLIST;

  let selected = phases.filter((p) => p.ready);
  if (opts.phase !== undefined) {
    const ph = phases.find((p) => p.name === opts.phase);
    if (!ph) {
      return {
        exitCode: 2,
        written: [],
        notices: [],
        errors: [`unknown phase "${opts.phase}" — expected one of: ${defs.map((d) => d.name).join(", ")}.`],
        phases,
      };
    }
    if (!ph.ready) {
      return {
        exitCode: 2,
        written: [],
        notices: [],
        errors: [`phase "${ph.name}" is not ready — its worklist ${ph.worklist} does not exist yet. Produce it first: ${ph.prerequisite}`],
        phases,
      };
    }
    selected = [ph];
  }

  const orchDir = join(run, "orchestration");
  const agentsDir = join(orchDir, "agents");
  ensureDir(join(orchDir, "out"));
  ensureDir(agentsDir);

  const written: string[] = [];
  const notices: string[] = [];

  for (const [name, content] of Object.entries(contracts(run, engineAbs, phases))) {
    written.push(writeArtifact(join(agentsDir, `${name}.md`), content));
  }

  if (!opts.eco) {
    for (const ph of selected) {
      const def = byName.get(ph.name);
      if (!def) continue;
      if (ph.items === 0) {
        notices.push(`phase "${ph.name}": worklist is empty — nothing to orchestrate.`);
        continue;
      }
      const floor = def.collapseFloor ? def.collapseFloor(small) : small;
      if (ph.items <= floor) {
        notices.push(`phase "${ph.name}": only ${ph.items} item(s) — the sequential --eco path is equivalent and cheaper.`);
      }
      written.push(writeArtifact(join(orchDir, `${ph.name}.workflow.mjs`), emitWorkflowScript(ph, def, run, engineAbs, small, opts.constants)));
    }
  }

  written.push(writeArtifact(join(orchDir, "RUNBOOK.md"), runbookMd(phases, defs, run, engineAbs, brand().cli, opts.runbookPreamble)));

  return { exitCode: 0, written, notices, errors: [], phases };
}
