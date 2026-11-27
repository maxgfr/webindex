// The repin dispatch contract, checked before the cron finds out.
//
// `webindex skill finish` dispatches every workflow in `skill.json >
// repin.workflows` (default ci.yml and release.yml), because a push made with
// GITHUB_TOKEN does not fire another workflow's `on: push`. A workflow without
// a `workflow_dispatch` trigger answers that with HTTP 422, so a skill whose
// ci.yml lacked it went red every night while every PR stayed green: the gap
// only surfaced on the scheduled run. This gate moves it to the PR.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_REPIN_WORKFLOWS = ["ci.yml", "release.yml"];
export const REPIN_WORKFLOW = "engine-repin.yml";

export interface RepinWorkflowCheck {
  /** False when the repo has no engine-repin.yml: nothing dispatches, nothing to check. */
  applies: boolean;
  workflows: string[];
  missing: string[];
  undispatchable: string[];
}

/** The workflows `skill finish` will dispatch, as it resolves them. */
export function repinWorkflows(root: string): string[] {
  const raw = JSON.parse(readFileSync(join(root, "skill.json"), "utf8")) as { repin?: { workflows?: unknown } };
  const listed = raw.repin?.workflows;
  if (listed === undefined) return DEFAULT_REPIN_WORKFLOWS;
  if (!Array.isArray(listed) || !listed.every((w) => typeof w === "string" && w.length > 0))
    throw new Error("skill.json repin.workflows must be an array of workflow file names");
  return listed as string[];
}

/** Whether a workflow file's top-level `on:` declares `workflow_dispatch`. */
export function hasDispatchTrigger(yaml: string): boolean {
  const lines = yaml.split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, ""));
  const start = lines.findIndex((l) => /^["']?on["']?\s*:/.test(l));
  if (start === -1) return false;
  const block = [lines[start]!.replace(/^["']?on["']?\s*:/, "")];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    block.push(line);
  }
  return /(^|[\s[,{])workflow_dispatch\s*(:|,|\]|}|$)/m.test(block.join("\n"));
}

export function auditRepinWorkflows(root: string): RepinWorkflowCheck {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(join(dir, REPIN_WORKFLOW))) return { applies: false, workflows: [], missing: [], undispatchable: [] };
  const workflows = repinWorkflows(root);
  const missing: string[] = [];
  const undispatchable: string[] = [];
  for (const workflow of workflows) {
    const path = join(dir, workflow);
    if (!existsSync(path)) missing.push(workflow);
    else if (!hasDispatchTrigger(readFileSync(path, "utf8"))) undispatchable.push(workflow);
  }
  return { applies: true, workflows, missing, undispatchable };
}
