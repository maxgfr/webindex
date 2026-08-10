import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { envFlag } from "./brand.js";

// The no-write gate.
//
// Every command worth running persists something: a run lays down a directory
// of evidence, a render writes an index.html/index.md pair. That is the right
// default — the workflow is file-mediated, and what the model writes lives
// beside the material it cites.
//
// It is also unusable in a read-only phase: a planning phase, a sandbox, any
// harness that forbids writes. There the caller wants one thing — real sources,
// read — and no report folder at all.
//
// So: one switch that every write in src/ passes through. Under it, an artifact
// is collected in memory instead of written, and the CLI streams what it would
// have written to stdout. The guarantee is a property of THIS module, not a
// promise each command has to keep individually — which is why even the writes
// belonging to commands that refuse to run in this mode (merge, fetch, verify,
// orchestrate) are routed here too.
//
// Note what this is NOT: a sandbox. It stops the writes the consuming skill
// performs; it cannot stop a caller redirecting stdout into a file. The point is
// that a plain invocation leaves the filesystem exactly as it found it.

export interface Artifact {
  /** Path the artifact WOULD have been written to. */
  path: string;
  content: string;
}

// Set by the CLI from --stdout. The env var is checked separately on every call
// so a host can set it once (it is the only lever the MCP server has — it never
// parses CLI flags). Module state with a reset seam mirrors src/run-lock.ts.
let flagged = false;

export function setNoWrite(on: boolean): void {
  flagged = on;
}

export function isNoWrite(): boolean {
  return flagged || envFlag("NO_WRITE");
}

const collected: Artifact[] = [];

/** mkdirSync -p, or nothing at all under no-write. */
export function ensureDir(dir: string): void {
  if (isNoWrite()) return;
  mkdirSync(dir, { recursive: true });
}

/**
 * Write a file, or collect it under no-write. Returns the path either way — so
 * callers keep their existing shape — which means a caller that PRINTS the
 * returned path must check `isNoWrite()` first, or it advertises a file that
 * does not exist. The CLI does exactly that.
 *
 * The write is ATOMIC (see writeFileAtomic). Every artifact this engine and its
 * consumers produce is read back by something — a manifest by the next command,
 * an index by a concurrent MCP tool call, a report by the agent that cited it —
 * and a plain writeFileSync leaves a window where a reader sees a truncated
 * file and `JSON.parse` throws on it. Only one of the eight consuming skills
 * had noticed and written its own atomic helper; making it the default here
 * means none of the other seven has to.
 */
export function writeArtifact(path: string, content: string): string {
  if (isNoWrite()) {
    // Last write wins, as on a real filesystem: `enrich` rewrites DOSSIER.md
    // after `gather` already produced one, and a stale copy in the stream would
    // contradict the fresh one.
    const at = collected.findIndex((a) => a.path === path);
    if (at !== -1) collected[at] = { path, content };
    else collected.push({ path, content });
    return path;
  }
  writeFileAtomic(path, content);
  return path;
}

// A monotonic suffix so two writers in ONE process cannot collide on the temp
// name itself. Combined with the pid it is unique across processes too.
let tmpCounter = 0;

/**
 * Write a file so a concurrent reader sees either the old bytes or the new
 * ones, never a half-written file. `rename` is atomic within a filesystem, and
 * the temp file is a SIBLING so it always is one — a temp in os.tmpdir() would
 * cross a mount point and silently degrade to a copy.
 *
 * Bypasses the no-write gate on purpose: this is the durability primitive, and
 * `writeArtifact` above is the gated caller. A caller holding a path of its own
 * that must not be written under `--stdout` calls `writeArtifact`, not this.
 */
export function writeFileAtomic(path: string, content: string | Uint8Array): void {
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* the temp file may never have been created */
    }
    throw e;
  }
}

/** Drain the collected artifacts. Empty when writes actually went to disk. */
export function takeArtifacts(): Artifact[] {
  return collected.splice(0, collected.length);
}

/** Test seam: clear both the switch and anything collected under it. */
export function resetNoWrite(): void {
  flagged = false;
  collected.length = 0;
}
