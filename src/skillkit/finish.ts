import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Run {
  databaseId: number;
  headSha: string;
  conclusion: string;
  status: string;
  event: string;
}
/** Resume publication even when every pin already matches. Green means CI/publication completed. */
export async function finishRepin(root: string): Promise<void> {
  const config = JSON.parse(readFileSync(join(root, "skill.json"), "utf8"));
  const workflows: string[] = config.repin?.workflows ?? ["ci.yml", "release.yml"];
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const repo = githubRepoForRemote(git(["remote", "get-url", "origin"]));
  const env = { ...process.env, GH_REPO: repo };
  const gh = (args: string[]) => execFileSync("gh", args, { cwd: root, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const sha = git(["rev-parse", "HEAD"]);
  for (const workflow of workflows) {
    const runs = () =>
      JSON.parse(
        gh(["run", "list", "--workflow", workflow, "--commit", sha, "--limit", "30", "--json", "databaseId,headSha,conclusion,status,event"]),
      ) as Run[];
    let existing = runs();
    if (existing.some((r) => r.conclusion === "success")) continue;
    let run = existing.find((r) => r.status !== "completed");
    if (!run) {
      if (gh(["api", `repos/${repo}/commits/main`, "--jq", ".sha"]).trim() !== sha)
        throw new Error("main moved before workflow dispatch; retry from its new HEAD");
      const previous = new Set(existing.map((r) => r.databaseId));
      gh(["workflow", "run", workflow, "--ref", "main"]);
      for (let attempt = 0; attempt < 30 && !run; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        existing = runs();
        run = existing.find((r) => !previous.has(r.databaseId) && r.event === "workflow_dispatch");
      }
    }
    if (!run) throw new Error(`No ${workflow} run appeared for ${sha}`);
    process.stdout.write(`Waiting for ${workflow}: ${run.databaseId}\n`);
    execFileSync("gh", ["run", "watch", String(run.databaseId), "--exit-status", "--interval", "15"], {
      cwd: root,
      env,
      stdio: "inherit",
      timeout: 25 * 60_000,
    });
  }
}

/** A fork must dispatch its own workflows, irrespective of gh's preferred upstream. */
export function githubRepoForRemote(remote: string): string {
  const match = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote);
  if (!match) throw new Error("origin must be a GitHub repository");
  return match[1]!;
}
