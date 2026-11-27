import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditRepinWorkflows, hasDispatchTrigger } from "../src/skillkit/workflows.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(skill: object, workflows: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "repin-workflows-"));
  roots.push(root);
  writeFileSync(join(root, "skill.json"), JSON.stringify(skill));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  for (const [name, body] of Object.entries(workflows)) writeFileSync(join(root, ".github/workflows", name), body);
  return root;
}

const DISPATCHABLE = "name: X\non:\n  push:\n    branches: [main]\n  workflow_dispatch: {}\njobs: {}\n";
const PUSH_ONLY = "name: X\non:\n  push:\n    branches: [main]\n  pull_request:\njobs: {}\n";

describe("hasDispatchTrigger", () => {
  it("accepts the block, flow and scalar forms", () => {
    expect(hasDispatchTrigger(DISPATCHABLE)).toBe(true);
    expect(hasDispatchTrigger("on:\n  workflow_dispatch:\n")).toBe(true);
    expect(hasDispatchTrigger("on: [push, workflow_dispatch]\n")).toBe(true);
    expect(hasDispatchTrigger("on: workflow_dispatch\n")).toBe(true);
    expect(hasDispatchTrigger('"on":\n  workflow_dispatch:\n    inputs: {}\n')).toBe(true);
  });
  it("ignores mentions outside the on: block and in comments", () => {
    expect(hasDispatchTrigger(PUSH_ONLY)).toBe(false);
    expect(hasDispatchTrigger("on:\n  push:\n  # workflow_dispatch: {}\njobs: {}\n")).toBe(false);
    expect(hasDispatchTrigger("on:\n  push:\njobs:\n  a:\n    if: github.event_name == 'workflow_dispatch'\n")).toBe(false);
    expect(hasDispatchTrigger("on:\n  push:\n  repository_dispatch:\n")).toBe(false);
  });
});

describe("auditRepinWorkflows", () => {
  it("does not apply to a repo without engine-repin.yml", () => {
    const root = repo({ name: "s" }, { "ci.yml": PUSH_ONLY });
    expect(auditRepinWorkflows(root).applies).toBe(false);
  });
  it("flags the default ci.yml when it cannot be dispatched", () => {
    const root = repo({ name: "s" }, { "engine-repin.yml": DISPATCHABLE, "ci.yml": PUSH_ONLY, "release.yml": DISPATCHABLE });
    expect(auditRepinWorkflows(root)).toEqual({ applies: true, workflows: ["ci.yml", "release.yml"], missing: [], undispatchable: ["ci.yml"] });
  });
  it("follows repin.workflows and reports missing files", () => {
    const root = repo({ name: "s", repin: { workflows: ["ci.yml", "evals.yml"] } }, { "engine-repin.yml": DISPATCHABLE, "ci.yml": DISPATCHABLE });
    expect(auditRepinWorkflows(root)).toMatchObject({ workflows: ["ci.yml", "evals.yml"], missing: ["evals.yml"], undispatchable: [] });
  });
  it("passes when every dispatched workflow has the trigger", () => {
    const root = repo({ name: "s" }, { "engine-repin.yml": DISPATCHABLE, "ci.yml": DISPATCHABLE, "release.yml": DISPATCHABLE });
    expect(auditRepinWorkflows(root)).toMatchObject({ missing: [], undispatchable: [] });
  });
  it("refuses a malformed repin.workflows", () => {
    const root = repo({ name: "s", repin: { workflows: "ci.yml" } }, { "engine-repin.yml": DISPATCHABLE });
    expect(() => auditRepinWorkflows(root)).toThrow(/repin.workflows/);
  });
});
