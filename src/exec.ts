import { spawn, spawnSync } from "node:child_process";

// Running a local command and reading what it said.
//
// `pdf/exec.ts` already had one of these, but only the shape the extraction
// ladders need: bytes on stdin, stdout back, no argument-level result. Every
// consumer then grew its own `sh` / `have` pair for git, `gh` and the rest —
// with slightly different timeout handling and slightly different ideas about
// what "the command is missing" means.
//
// That distinction is the reason this exists rather than being inlined. "git
// exited 128" and "there is no git on this machine" want completely different
// messages, and a caller that cannot tell them apart tells a user to check their
// network when they need to install something.

export interface ShResult {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
  /** The executable itself was not found — not a failure OF the command. */
  missing?: boolean;
}

const STDOUT_CAP = 24 * 1024 * 1024;

function toResult(status: number | null, stdout: string, stderr: string, err?: NodeJS.ErrnoException): ShResult {
  const missing = err?.code === "ENOENT";
  return {
    ok: !missing && status === 0,
    status: status ?? (missing ? 127 : 1),
    stdout,
    stderr: stderr || (err ? err.message : ""),
    ...(missing ? { missing: true } : {}),
  };
}

/** Is this executable on PATH? Cheap, memoised per process. */
const havePresence = new Map<string, boolean>();
export function have(cmd: string): boolean {
  let hit = havePresence.get(cmd);
  if (hit === undefined) {
    const probe = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
    hit = probe.status === 0;
    havePresence.set(cmd, hit);
  }
  return hit;
}

/** Test seam: forget which executables were found. */
export function resetHaveCache(): void {
  havePresence.clear();
}

/** Run a command synchronously. Never throws — a missing binary is a result. */
export function sh(cmd: string, args: string[], opts: { cwd?: string; input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): ShResult {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    input: opts.input,
    timeout: opts.timeoutMs ?? 60_000,
    encoding: "utf8",
    maxBuffer: STDOUT_CAP,
    env: opts.env ?? process.env,
  });
  return toResult(r.status, r.stdout ?? "", r.stderr ?? "", r.error as NodeJS.ErrnoException | undefined);
}

/**
 * Run a command without blocking the event loop.
 *
 * Preferred wherever several commands could overlap — a synchronous `git clone`
 * freezes everything else in the process for the whole transfer, which is the
 * difference between three clones taking as long as the slowest and taking as
 * long as all of them put together. SIGKILL on timeout, and never an orphan.
 */
export function shAsync(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<ShResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: ShResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      if (stdout.length < STDOUT_CAP) stdout += String(d);
    });
    // Drained even when nobody reads it: a full stderr pipe blocks the child.
    child.stderr?.on("data", (d) => {
      if (stderr.length < STDOUT_CAP) stderr += String(d);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, status: 124, stdout, stderr: stderr || `timed out after ${opts.timeoutMs ?? 60_000}ms` });
    }, opts.timeoutMs ?? 60_000);
    child.on("error", (e) => done(toResult(null, stdout, stderr, e as NodeJS.ErrnoException)));
    child.on("close", (code) => done(toResult(code, stdout, stderr)));
  });
}
