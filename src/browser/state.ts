import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isNoWrite, writeFileAtomic } from "../no-write.js";
import type { BrowserDeps } from "./deps.js";
import { browserHome, ensurePrivateDir } from "./profile.js";

// On-disk state of the one browser session webindex drives, under the browser home:
//
//   session.json           where the browser is and which tab we work on
//   refs/<targetId>.json   snapshot refs (eN -> backendDOMNodeId) of that tab
//   network/<id>.jsonl     the tab's recent requests, one JSON entry per line
//   lock                   cross-process advisory lock
//
// Every file is 0600 in 0700 directories: the session names a browser that holds
// logins. Writes are atomic (a concurrent command never reads half a file).
//
// Under no-write mode the state degrades to READ-only, like the page cache:
// every write below is a silent no-op, reads still work. A browser that is
// launched under no-write still gets a profile dir; that is the browser's own
// data, not webindex's bookkeeping, so it is not gated here.

export interface Session {
  version: 1;
  /** Loopback address the DevTools port listens on; 127.0.0.1 when absent. */
  host?: string;
  port: number;
  wsBrowserUrl?: string;
  pid?: number;
  launchedByUs: boolean;
  profile: string;
  headless: boolean;
  targetId: string;
  /** Short tab ids (`t1`) handed to the agent, so they mean the same tab on the next call. */
  tabs?: Record<string, string>;
  updatedAt: number;
}

export interface RefTable {
  /** Document the refs belong to; a navigation changes it and makes them stale. */
  loaderId: string;
  url: string;
  /** The number the next new ref gets (`e<next>`). */
  next: number;
  refs: Record<string, number>;
}

/** Test seam: where the state lives. Defaults to the browser home. */
export interface StateOptions {
  home?: string;
}

/** Entries kept per tab in the network log. */
export const NETWORK_CAP = 500;

const FILE_MODE = 0o600;
const homeOf = (o?: StateOptions): string => o?.home ?? browserHome();

function checkTargetId(id: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(id)) throw new Error(`invalid target id: ${JSON.stringify(id)}`);
  return id;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null; // missing, unreadable or corrupt: all mean "no state"
  }
}

function writeJson(dir: string, name: string, value: unknown): void {
  ensurePrivateDir(dir);
  writeFileAtomic(join(dir, name), `${JSON.stringify(value)}\n`, FILE_MODE);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// --- session ---------------------------------------------------------------

export function readSession(o?: StateOptions): Session | null {
  const v = readJson(join(homeOf(o), "session.json"));
  if (!isObj(v) || v.version !== 1 || typeof v.port !== "number" || typeof v.targetId !== "string") return null;
  return v as unknown as Session;
}

export function writeSession(s: Session, o?: StateOptions): void {
  if (isNoWrite()) return;
  writeJson(homeOf(o), "session.json", s);
}

export function clearSession(o?: StateOptions): void {
  if (isNoWrite()) return;
  rmSync(join(homeOf(o), "session.json"), { force: true });
}

// --- refs ------------------------------------------------------------------

export function readRefs(targetId: string, o?: StateOptions): RefTable | null {
  const v = readJson(join(homeOf(o), "refs", `${checkTargetId(targetId)}.json`));
  if (!isObj(v) || typeof v.loaderId !== "string" || typeof v.url !== "string" || typeof v.next !== "number" || !isObj(v.refs)) return null;
  return v as unknown as RefTable;
}

export function writeRefs(targetId: string, table: RefTable, o?: StateOptions): void {
  const id = checkTargetId(targetId);
  if (isNoWrite()) return;
  writeJson(join(homeOf(o), "refs"), `${id}.json`, table);
}

/** One tab's refs, or all of them when no target is given. */
export function clearRefs(targetId?: string, o?: StateOptions): void {
  const id = targetId === undefined ? undefined : checkTargetId(targetId);
  if (isNoWrite()) return;
  const dir = join(homeOf(o), "refs");
  rmSync(id === undefined ? dir : join(dir, `${id}.json`), { recursive: true, force: true });
}

// --- network log -----------------------------------------------------------

const networkFile = (targetId: string, o?: StateOptions): string => join(homeOf(o), "network", `${checkTargetId(targetId)}.jsonl`);

export function readNetwork(targetId: string, o?: StateOptions): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(networkFile(targetId, o), "utf8");
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("invalid target id")) throw e;
    return [];
  }
  const out: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn or foreign line: skip it */
    }
  }
  return out;
}

/** Append entries; when the log outgrows NETWORK_CAP it is rewritten with the last NETWORK_CAP. */
export function appendNetwork(targetId: string, entries: unknown[], o?: StateOptions): void {
  const file = networkFile(targetId, o);
  if (isNoWrite() || entries.length === 0) return;
  ensurePrivateDir(join(homeOf(o), "network"));
  const lines = entries.map((e) => JSON.stringify(e));
  const existing = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  if (existing.length + lines.length <= NETWORK_CAP) {
    appendFileSync(file, `${lines.join("\n")}\n`, { mode: FILE_MODE });
    return;
  }
  const kept = [...existing, ...lines].slice(-NETWORK_CAP);
  writeFileAtomic(file, `${kept.join("\n")}\n`, FILE_MODE);
}

/** One tab's network log, or all of them when no target is given. */
export function clearNetwork(targetId?: string, o?: StateOptions): void {
  const path = targetId === undefined ? join(homeOf(o), "network") : networkFile(targetId, o);
  if (isNoWrite()) return;
  rmSync(path, { recursive: true, force: true });
}

// --- cross-process lock ----------------------------------------------------

export interface LockOptions extends StateOptions {
  /**
   * A lock whose holder has not refreshed it for this long is taken over. A
   * live holder refreshes it every third of this (at least every second), so
   * only a hung or vanished one goes stale, however long its command runs.
   */
  staleMs?: number;
  /** How long to wait for a live holder before giving up. */
  waitMs?: number;
  pollMs?: number;
  deps?: Pick<BrowserDeps, "now" | "sleep">;
}

const realDeps: Pick<BrowserDeps, "now" | "sleep"> = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, just not ours
  }
}

/** Why the lock may be taken over, or null while its holder is legitimately working. */
function staleReason(path: string, staleMs: number, now: number): string | null {
  let at: number;
  let pid: unknown;
  try {
    const held = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; at?: unknown };
    pid = held.pid;
    at = typeof held.at === "number" ? held.at : Number.NaN;
  } catch {
    at = Number.NaN;
  }
  if (Number.isNaN(at)) {
    // Unreadable content (a holder caught between create and write): judge by file age.
    try {
      at = statSync(path).mtimeMs;
    } catch {
      return "gone";
    }
  }
  if (now - at > staleMs) return "old";
  if (typeof pid === "number" && !pidAlive(pid)) return "dead";
  return null;
}

/** Whether the lock file is still the one this holder wrote (`token` tells two holders in one process apart). */
function holds(path: string, token: string): boolean {
  try {
    const held = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; token?: unknown };
    return held.pid === process.pid && held.token === token;
  } catch {
    return false;
  }
}

/**
 * Run `fn` while holding the browser lock, so two webindex processes do not
 * drive the same tab at once. (src/run-lock.ts only serialises inside ONE
 * process.) The lock is a file created exclusively (`wx`) holding
 * `{pid, at, token}`, and its holder rewrites `at` on a heartbeat while `fn`
 * runs: a `wait --clear` of five minutes keeps it. One whose `at` is older than
 * `staleMs` (a hung holder, or a pid reused by another process), or whose
 * owner is dead, is taken over. A live holder is waited for up to `waitMs`,
 * then it is a "browser busy" error.
 */
export async function withBrowserLock<T>(fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  if (isNoWrite()) return fn(); // nothing is written, so there is nothing to protect
  const { staleMs = 30_000, waitMs = 10_000, pollMs = 50 } = opts;
  const { now, sleep } = opts.deps ?? realDeps;
  const dir = homeOf(opts);
  ensurePrivateDir(dir);
  const path = join(dir, "lock");
  const token = randomUUID();
  const stamp = () => JSON.stringify({ pid: process.pid, at: now(), token });
  const deadline = now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(path, "wx", FILE_MODE);
      try {
        writeSync(fd, stamp());
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (staleReason(path, staleMs, now())) {
      try {
        unlinkSync(path);
      } catch {
        /* someone else took it over first */
      }
      continue;
    }
    if (now() >= deadline) throw new Error(`browser busy: another webindex command holds ${path} (waited ${waitMs} ms)`);
    await sleep(pollMs);
  }
  // Unreferenced: a heartbeat never keeps the process alive on its own.
  const beat = setInterval(
    () => {
      // Only refresh what is still ours: a lock taken over is someone else's now.
      if (!holds(path, token)) return;
      try {
        writeFileAtomic(path, stamp(), FILE_MODE);
      } catch {
        /* the next beat retries */
      }
    },
    Math.max(1000, staleMs / 3),
  );
  beat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    // Only remove what is still ours: after a takeover the file is someone else's.
    try {
      if (holds(path, token)) unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
}
