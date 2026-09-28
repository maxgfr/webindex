import { spawn } from "node:child_process";
import { killTree } from "../process-tree.js";

// Run an external extractor with the PDF on stdin and its text on stdout.
//
// stdin/stdout rather than a temp file: every tool in the ladder supports `-`,
// and it keeps this dependency-free module from having to manage (and clean up)
// files. `node:child_process` is built into Node, so nothing enters package.json.
//
// A separate process is also what makes an external extractor SAFE to use: it
// cannot take the run down with it. That matters — the WASM build of
// pdf-inspector reproducibly crashes V8's background wasm compiler
// ("Fatal process out of memory: Zone"), which would kill a whole research run
// from inside the process. A child that dies is just a rung that failed.

// The npm specs the extractor rungs run through `npx`, pinned to a COMPATIBLE
// RANGE rather than left floating. One place to change, so the ladders and the
// `doctor` probes can never disagree about which version they are talking about.
//
// The range is what semver says is safe, which differs by major:
//   pdf-inspector is 1.x — minor and patch releases are backwards compatible,
//   so `@1` keeps picking up improvements.
//   anydoc is 0.x — under semver a 0.MINOR bump is allowed to break, and this
//   package is days old, so `@0.1` takes patches only. Widen it deliberately
//   after checking a 0.2 against tests/bench-pdf.ts, not by accident.
//
// Floating on `latest` was the previous behaviour and is a silent-failure risk:
// a breaking release would change what every dossier is grounded on, and a rung
// that starts emitting something new degrades quietly — the quality gate only
// catches garbage, not a subtly different extraction.
export const PDF_INSPECTOR_SPEC = "@firecrawl/pdf-inspector@1";
export const ANYDOC_SPEC = "@firecrawl/anydoc@0.1";

export interface RunResult {
  ok: boolean;
  stdout: string;
  /** Short cause when `ok` is false: "not installed", "timed out", "exit 2"… */
  error?: string;
  /** What the tool wrote to stderr — its first and last ~1 KB — when `ok` is false and it wrote any. */
  stderr?: string;
}

// stdout is capped so a pathological tool can't balloon memory — the built-in
// reader has been observed emitting 16 MB of garbage for a 12 MB PDF, and an
// external one could do the same.
const MAX_STDOUT_BYTES = 24 * 1024 * 1024;
// stderr keeps its two ends: a tool states its error first, npm its error
// code last, and a verbose one must not cost memory for the middle.
const STDERR_END_CHARS = 1024;

/** Windows ships npx as a .cmd shim, which `spawn` won't resolve on its own. */
export function binaryName(name: string): string {
  return process.platform === "win32" && name === "npx" ? "npx.cmd" : name;
}

/**
 * Spawn `cmd args…`, write `input` to its stdin, resolve with its stdout.
 * Never throws and never leaves a child behind: a missing binary, a non-zero
 * exit and a timeout all come back as `{ ok: false, error }` — with the tail
 * of stderr, when the tool wrote one, so a caller can say WHY.
 */
export function runWithInput(cmd: string, args: string[], input: Buffer, timeoutMs: number, opts: { env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      const bin = binaryName(cmd);
      // Since the CVE-2024-27980 fix (Node 18.20.2, 20.12.2, 22.x) spawn refuses
      // a .cmd or .bat without a shell — EINVAL, which cost Windows both npx
      // rungs. Through cmd.exe every argument is quoted; they are constants of
      // this engine (the document travels on stdin), never text from a URL.
      const viaShell = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(bin);
      const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
      child = spawn(viaShell ? quote(bin) : bin, viaShell ? args.map(quote) : args, {
        stdio: ["pipe", "pipe", "pipe"],
        ...(viaShell ? { shell: true, windowsHide: true } : {}),
        ...(opts.env ? { env: opts.env } : {}),
      });
    } catch (e) {
      resolve({ ok: false, stdout: "", error: (e as Error).message });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let stderrHead = "";
    let stderrTail = "";
    let stderrCut = false;
    const withStderr = (r: RunResult): RunResult => {
      const stderr = (stderrCut ? `${stderrHead}\n…\n${stderrTail}` : stderrHead + stderrTail).trim();
      return stderr ? { ...r, stderr } : r;
    };
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      // The whole tree: npx runs the real tool as a grandchild, copyable-pdf
      // spawns pdftoppm and tesseract (see ../process-tree.ts).
      killTree(child);
      done(withStderr({ ok: false, stdout: "", error: `timed out after ${Math.round(timeoutMs / 1000)}s` }));
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      if (size >= MAX_STDOUT_BYTES) return;
      size += d.length;
      chunks.push(d);
    });
    // Drained so a chatty tool can't deadlock on a full pipe, and its tail kept:
    // an exit code says THAT a tool failed, and its stderr says why — "PDF has
    // no extractable text", "malformed document", `npm error code ENOTFOUND`.
    // The difference between those is the difference between "this input" and
    // "this tool", which the ladders must not confuse.
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      let rest = chunk;
      if (stderrHead.length < STDERR_END_CHARS) {
        const room = STDERR_END_CHARS - stderrHead.length;
        stderrHead += rest.slice(0, room);
        rest = rest.slice(room);
      }
      const tail = stderrTail + rest;
      if (tail.length > STDERR_END_CHARS) stderrCut = true;
      stderrTail = tail.slice(-STDERR_END_CHARS);
    });

    child.on("error", (e: NodeJS.ErrnoException) => {
      done({ ok: false, stdout: "", error: e.code === "ENOENT" ? "not installed" : e.message });
    });

    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(chunks).subarray(0, MAX_STDOUT_BYTES).toString("utf8");
      if (code === 0) done({ ok: true, stdout });
      else done(withStderr({ ok: false, stdout, error: code === null ? `killed by ${signal}` : `exit ${code}` }));
    });

    // EPIPE is normal here: a tool that rejects the input closes stdin early.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}
