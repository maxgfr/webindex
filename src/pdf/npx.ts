import { isAbsolute } from "node:path";
import { envInt, envName } from "../brand.js";
import { runWithInput, type RunResult } from "./exec.js";

// Running the ladders' npm-published rungs (pdf-inspector, anydoc) — and
// telling "this tool cannot run here" from "this tool rejected this input".
//
// The ladders remember an unavailable rung for the rest of the process, which
// is what spares a 40-source run the same failed discovery 40 times. That memo
// used to be fed by every failed run, and both tools exit 1 on inputs they
// cannot read: a truncated PDF, a login page served at a .pdf URL, any scan
// (anydoc). One bad document disabled the best rungs for every later one — for
// the MCP server, until it restarted. So a failure only counts against the
// TOOL when it says something about the tool: npx is missing, npm could not
// install the package, or a first run never finished.
//
// Internal to the ladders; not part of the public surface.

/** How long one npx run may take — the first use of a package includes its download. */
export function npxTimeoutMs(): number {
  return envInt("NPX_TIMEOUT_MS", 90_000, 1000, 600_000);
}

// npm's defaults are two retries backing off 10 s → 60 s, so an unreachable
// registry cost ~70 s per rung, twice per PDF, on every CLI invocation. One
// quick retry still rides out a blip. Only applied where the user has not set
// the same key in the environment (npm reads these case-insensitively).
const FAIL_FAST: Record<string, string> = {
  npm_config_fetch_retries: "1",
  npm_config_fetch_retry_mintimeout: "1000",
  npm_config_fetch_retry_maxtimeout: "2000",
  npm_config_fetch_timeout: "30000",
};

/** The environment an npx rung runs in: the caller's, with a fail-fast network policy for what it left unset. */
export function npxEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(FAIL_FAST)) {
    if (env[key] === undefined && env[key.toUpperCase()] === undefined) env[key] = value;
  }
  return env;
}

// `npm error code ECONNREFUSED` (npm ≥ 9) or `npm ERR! code …` (older).
const NPM_ERROR_RE = /^npm (?:ERR!|error) code (\S+)/m;
// Codes that mean the registry could not be reached at all — true for every
// package it serves, not just the one that asked.
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTCACHED",
  "ERR_SOCKET_TIMEOUT",
]);

// Specs that have run successfully in this process: installed, cached, working.
const proven = new Set<string>();
// The network code npm reported once the registry proved unreachable.
let registryDown: string | undefined;

/** Test seam: forget what npx runs have shown about this machine. */
export function resetNpxState(): void {
  proven.clear();
  registryDown = undefined;
  installed.clear();
}

export interface NpxRun extends RunResult {
  /**
   * Why the package cannot run in this process at all — set only for that,
   * never for an input the tool rejected.
   */
  unavailable?: string;
}

function unavailability(r: RunResult, spec: string): string | undefined {
  if (r.error === "not installed" || r.error === "exit 127") return "not installed";
  const stderr = r.stderr ?? "";
  const code = NPM_ERROR_RE.exec(stderr)?.[1];
  if (code) {
    if (!NETWORK_CODES.has(code)) return `could not be installed (npm error ${code})`;
    registryDown = code;
    return `could not be installed (npm error ${code} — offline?)`;
  }
  if (/could not determine executable to run/.test(stderr)) return "could not be installed (npm found no executable)";
  // A first run that never finished was as likely downloading as converting;
  // once the package has worked, a timeout belongs to the document.
  if (!proven.has(spec) && r.error?.startsWith("timed out")) return `${r.error} on first use (raise ${envName("NPX_TIMEOUT_MS")} on a slow network)`;
  return undefined;
}

/** The executable a pinned spec installs: its name without scope or range (`@firecrawl/anydoc@0.1` → `anydoc`). */
export function npxBinName(spec: string): string {
  return spec.replace(/^@[^/]+\//, "").replace(/@.*$/, "");
}

// Where each package's executable lives once npx has installed it, found once
// per process. `npx <spec>` starts npm and re-resolves the range against the
// cached packument before the tool runs — ~0.6 s per document, twenty times
// what pdf-inspector then spends on a small PDF. Running the executable
// directly skips all of it, and concurrent first documents share one probe
// (so one install). The probe asks npm's script shell for `command -v <bin>`,
// which is POSIX: on Windows, and whenever the answer is not a path, the rungs
// keep running through npx as they always did.
interface Installed {
  path?: string;
  /** The probe showed the package cannot be installed here. */
  unavailable?: NpxRun;
}
const installed = new Map<string, Promise<Installed>>();

function findInstalled(spec: string): Promise<Installed> {
  let hit = installed.get(spec);
  if (!hit) {
    hit = (async (): Promise<Installed> => {
      if (process.platform === "win32") return {};
      const probe = ["-y", "--prefer-offline", "--package", spec, "-c", `command -v ${npxBinName(spec)}`];
      const r = await runWithInput("npx", probe, Buffer.alloc(0), npxTimeoutMs(), { env: npxEnv() });
      if (!r.ok) {
        const why = unavailability(r, spec);
        return why ? { unavailable: { ...r, unavailable: why } } : {};
      }
      const path = r.stdout.trim().split("\n").pop()?.trim();
      return path && isAbsolute(path) ? { path } : {};
    })();
    installed.set(spec, hit);
  }
  return hit;
}

/**
 * Whether npm already holds `spec` — for `doctor`, which must answer without
 * installing anything: under `--offline` npm refuses (ENOTCACHED) instead of
 * downloading. `unknown` on Windows, where the probe's `command -v` is not
 * available, and whenever npm answers something else.
 */
export async function npxCacheState(spec: string): Promise<"cached" | "not cached" | "no npx" | "unknown"> {
  if (process.platform === "win32") return "unknown";
  const probe = ["-y", "--offline", "--package", spec, "-c", `command -v ${npxBinName(spec)}`];
  const r = await runWithInput("npx", probe, Buffer.alloc(0), 30_000, { env: npxEnv() });
  if (r.ok) return "cached";
  if (r.error === "not installed") return "no npx";
  return NPM_ERROR_RE.exec(r.stderr ?? "")?.[1] === "ENOTCACHED" ? "not cached" : "unknown";
}

/**
 * Run `<spec>`'s executable with `args…` and `input` on stdin: directly once
 * npx has said where it is installed, else as `npx -y --prefer-offline <spec>`.
 *
 * `-y` stops npx asking to install; `--prefer-offline` keeps the steady state
 * at one local cache hit instead of a registry round-trip. No user input
 * reaches argv — the document travels on stdin.
 */
export async function runNpx(spec: string, args: string[], input: Buffer): Promise<NpxRun> {
  // pdf-inspector and anydoc come from the same registry. Once it is known to
  // be unreachable, a package this process never ran cannot be installed either.
  if (registryDown && !proven.has(spec) && !installed.has(spec)) {
    const why = `could not be installed (npm error ${registryDown} — offline?)`;
    return { ok: false, stdout: "", error: why, unavailable: why };
  }
  const found = await findInstalled(spec);
  if (found.unavailable) return found.unavailable;
  if (found.path) {
    const run = await runWithInput(found.path, args, input, npxTimeoutMs());
    if (run.ok) proven.add(spec);
    // Installed and found, so whatever went wrong — a timeout included — is
    // this document's. Unless the executable is gone (npm's cache was
    // cleaned): then this document goes through npx and the next looks again.
    if (run.error !== "not installed") return run;
    installed.delete(spec);
  }
  const r = await runWithInput("npx", ["-y", "--prefer-offline", spec, ...args], input, npxTimeoutMs(), { env: npxEnv() });
  if (r.ok) {
    proven.add(spec);
    return r;
  }
  const why = unavailability(r, spec);
  return why ? { ...r, unavailable: why } : r;
}

/** The way out when the npx rungs cannot be installed — said once, after them. */
export function skipNpxHint(): string {
  return `set ${envName("NO_NPX")}=1 to skip the rungs that install through npx`;
}

/**
 * The tool's own account of a failure: the first line of stderr that is not
 * npm's chatter, capped — else the exit status.
 */
export function failureDetail(r: RunResult): string {
  const line = (r.stderr ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !/^npm (?:warn|WARN|notice)\b/.test(l));
  return (line ?? r.error ?? "failed").slice(0, 200);
}
