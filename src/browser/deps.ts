import { type ChildProcess, type SpawnOptions, spawn as nodeSpawn } from "node:child_process";
import { type FileHandle, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { env as brandEnv } from "../brand.js";
import { CdpClient } from "./cdp.js";
import * as discovery from "./discovery.js";

// The seams later tasks fake in tests. Everything here is resolved lazily, in
// defaultBrowserDeps(), so importing this module has no side effect.

/** The slice of a child process the launcher uses. */
export interface SpawnedProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  unref(): void;
}

/** The slice of node:fs/promises the state and launch code use. */
export interface BrowserFs {
  readFile(path: string, encoding: BufferEncoding): Promise<string>;
  writeFile(path: string, data: string | Uint8Array, opts?: { mode?: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean; mode?: number }): Promise<unknown>;
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; mtimeMs: number; size: number }>;
  /** `open(path, "wx")` is how the lock file is created: it fails if the file exists. */
  open(path: string, flags: string, mode?: number): Promise<Pick<FileHandle, "writeFile" | "close">>;
}

export interface BrowserDeps {
  spawn(cmd: string, args: string[], opts: SpawnOptions): SpawnedProcess;
  fs: BrowserFs;
  now(): number;
  sleep(ms: number): Promise<void>;
  connectCdp(wsUrl: string): Promise<CdpClient>;
  discovery: typeof discovery;
  /** Reads `WEBINDEX_<name>` (brand-aware), like the rest of the library. */
  env(name: string): string | undefined;
  platform: NodeJS.Platform;
}

export function defaultBrowserDeps(): BrowserDeps {
  return {
    spawn: (cmd, args, opts): ChildProcess => nodeSpawn(cmd, args, opts),
    fs: { readFile, writeFile, rename, mkdir, rm, stat, open },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    connectCdp: (wsUrl) => CdpClient.connect(wsUrl),
    discovery,
    env: (name) => brandEnv(name),
    platform: process.platform,
  };
}
