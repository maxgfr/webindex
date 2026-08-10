// The run directory: naming it, reading what is in it, writing back safely.
//
// Every skill built on this engine is file-mediated. A command lays down a
// directory, later commands read it, and an agent reads it alongside them. That
// shape is the product; the four things below are the plumbing it needs, and
// each of them existed once per skill before this module — including `shq`,
// which the orchestration emitter cannot be correct without, and which had one
// implementation per repo of a rule that has exactly one right answer.
//
// What is deliberately NOT here: the manifest's SHAPE. What a run records about
// itself — its question, its mode, its backends, its tiers — is the skill's
// model, and a schema here would dictate it. This module knows a run directory
// holds JSON and that reading it must never throw. It does not know what the
// JSON means.

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { writeArtifact } from "./no-write.js";

// Two-digit zero pad for the readable run id.
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The readable id a default output folder is named after: `run-YYYYMMDD-HHMMSS`.
 *
 * LOCAL time, not UTC, and that is the point: the person reading `ls` is the
 * person who started the run, and a folder stamped three hours off their clock
 * is a folder they cannot find. Sortable lexicographically, which is what makes
 * `ls` order runs chronologically for free.
 *
 * The Date is a parameter so tests can pin it. Callers pass nothing.
 */
export function runId(d: Date = new Date()): string {
  return `run-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Shell-single-quote a value for a command line this engine EMITS — the
 * free-text question and every path in an orchestration runbook.
 *
 * Single quotes are the only POSIX shell context with zero expansion: backticks,
 * `$`, `|`, `;`, `&&` and newlines all stay literal inside them. An embedded
 * single quote closes and reopens the quoting (' → '"'"'), which is the one
 * escape the form does not admit directly.
 *
 * Newlines collapse to spaces so an emitted command stays ONE line. A runbook
 * is copy-pasted by a human or a subagent; a command that wraps across lines is
 * a command that gets pasted half-executed.
 */
export function shq(s: string): string {
  return `'${s.replace(/\r?\n/g, " ").replaceAll("'", `'"'"'`)}'`;
}

/**
 * Read and parse a JSON file, or return undefined.
 *
 * Absent, unreadable and malformed collapse to the SAME answer on purpose. Every
 * caller of this in a run directory is asking "is this worklist ready?", and a
 * file that exists but does not parse is not ready — it is the half-written or
 * hand-edited state, and treating it as a hard error would strand a run that the
 * prerequisite command can simply regenerate.
 *
 * It does NOT validate the shape. The caller knows what it asked for; this
 * returns whatever parsed, typed as what the caller claimed. A caller that acts
 * on a field must still check the field is there — which is why every worklist
 * reader in the consuming skills tests `Array.isArray(...)` before trusting it.
 */
export function readJsonSafe<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Read a run's manifest. Same tolerance as readJsonSafe, and the same warning:
 * the type parameter is the caller's claim, not a guarantee.
 */
export function readManifest<T>(dir: string, file = "manifest.json"): T | undefined {
  return readJsonSafe<T>(join(dir, file));
}

/**
 * Write a run's manifest — atomically, and through the no-write gate.
 *
 * Atomic because this is the file most likely to be read while it is written:
 * an MCP server answering a tool call and a CLI in another terminal both reach
 * for it, and a torn read is a `JSON.parse` throw in whichever got there first.
 * Gated because a run under `--stdout` must leave the filesystem as it found it.
 *
 * Returns the path it wrote (or would have written) — so a caller that PRINTS
 * it must check `isNoWrite()` first, the same contract as `writeArtifact`.
 */
export function writeManifest(dir: string, value: unknown, file = "manifest.json"): string {
  return writeArtifact(join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
}
