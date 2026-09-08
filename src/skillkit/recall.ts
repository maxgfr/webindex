/** Identity-preserving comparisons for regenerated fixtures; thresholds stay with the consumer. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface RecallPolicy {
  paths: string[];
  ignoreKeys?: string[];
  growing?: string[];
  shrinking?: string[];
}
/** Every old array member must survive in one distinct new member, including its evidence. */
export function preserves(before: unknown, after: unknown, policy: RecallPolicy, key = ""): boolean {
  if (Array.isArray(before)) {
    if (!Array.isArray(after)) return false;
    // Match the most constrained records first. Backtracking avoids a permissive
    // old record consuming the only candidate that can satisfy a specific one.
    const candidates = before.map((old) => after.flatMap((next, i) => (preserves(old, next, policy, key) ? [i] : [])));
    const owner = new Map<number, number>();
    const assign = (row: number, seen: Set<number>): boolean => {
      for (const candidate of candidates[row] ?? []) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        const previous = owner.get(candidate);
        if (previous === undefined || assign(previous, seen)) {
          owner.set(candidate, row);
          return true;
        }
      }
      return false;
    };
    return candidates.every((_, row) => assign(row, new Set()));
  }
  if (before !== null && typeof before === "object") {
    if (after === null || typeof after !== "object" || Array.isArray(after)) return false;
    return Object.entries(before).every(([k, value]) => policy.ignoreKeys?.includes(k) || preserves(value, (after as Record<string, unknown>)[k], policy, k));
  }
  if (typeof before === "number" && typeof after === "number") {
    if (policy.growing?.includes(key)) return after >= before;
    if (policy.shrinking?.includes(key)) return after <= before;
  }
  return Object.is(before, after);
}

/** Changed prose/snapshots are reviewed explicitly; byte/line counts cannot prove meaning. */
export function checkArtifactRecall(root: string, ref = "HEAD"): string[] {
  const config = JSON.parse(readFileSync(join(root, "skill.json"), "utf8"));
  const policy: RecallPolicy | undefined = config.repin?.recall;
  if (!policy) return [];
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // Enumerate the BASE tree, so deleting a whole directory cannot erase its baseline.
  const files = git(["ls-tree", "-r", "--name-only", ref, "--", ...policy.paths])
    .trim()
    .split("\n")
    .filter(Boolean);
  if (!files.length) throw new Error("No baseline artifacts matched the declared recall paths");
  const lost: string[] = [];
  for (const file of files) {
    const before = git(["show", `${ref}:${file}`]);
    let after: string;
    try {
      after = readFileSync(join(root, file), "utf8");
    } catch {
      lost.push(`${file}: deleted`);
      continue;
    }
    if (before === after) continue;
    if (file.endsWith(".json")) {
      try {
        if (preserves(JSON.parse(before), JSON.parse(after), policy)) continue;
      } catch {
        /* malformed output fails */
      }
    }
    lost.push(`${file}: baseline content changed or disappeared; review the semantic difference`);
  }
  return lost;
}
