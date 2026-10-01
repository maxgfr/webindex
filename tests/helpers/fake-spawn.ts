import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpawnedProcess } from "../../src/browser/deps.js";

// A stand-in for spawning Chrome: the fake child writes <profile>/DevToolsActivePort
// (pointing at a fake CDP server) a tick after it starts, like a real browser does
// once its debugging port is bound. It can also exit early, or never write at all.

export interface SpawnCall {
  cmd: string;
  args: string[];
  opts: SpawnOptions;
  /** Whether a DevToolsActivePort was already in the profile when the browser started. */
  staleFileAtSpawn: boolean;
}

export class FakeChild extends EventEmitter implements SpawnedProcess {
  pid = 4242;
  readonly signals: (NodeJS.Signals | number | undefined)[] = [];
  unrefed = false;
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    return true;
  }
  unref(): void {
    this.unrefed = true;
  }
}

export interface FakeSpawnBehaviour {
  /** The port written to DevToolsActivePort. */
  port?: number;
  /** Raw file content instead of `<port>\n/devtools/browser/fake\n`. */
  content?: string;
  /** Exit with this code instead of writing the file. */
  exitCode?: number;
  /** Be killed by this signal instead of writing the file. */
  signal?: NodeJS.Signals;
  /** Emit a spawn error (binary missing) instead of starting. */
  error?: Error;
  /** Never write the file. */
  silent?: boolean;
  /** Write the file during spawn rather than a tick later. */
  immediate?: boolean;
}

export function fakeSpawn(behaviour: FakeSpawnBehaviour = {}) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn = (cmd: string, args: string[], opts: SpawnOptions): SpawnedProcess => {
    const dir = (args.find((a) => a.startsWith("--user-data-dir=")) ?? "").slice("--user-data-dir=".length);
    const file = join(dir, "DevToolsActivePort");
    calls.push({ cmd, args, opts, staleFileAtSpawn: existsSync(file) });
    const child = new FakeChild();
    children.push(child);
    const write = () => {
      try {
        writeFileSync(file, behaviour.content ?? `${behaviour.port}\n/devtools/browser/fake\n`);
      } catch {
        /* the test is over and its home is gone */
      }
    };
    if (behaviour.immediate) write();
    setTimeout(() => {
      if (behaviour.error) child.emit("error", behaviour.error);
      else if (behaviour.exitCode !== undefined || behaviour.signal) child.emit("exit", behaviour.exitCode ?? null, behaviour.signal ?? null);
      else if (!behaviour.silent && !behaviour.immediate) write();
    }, 5);
    return child;
  };
  return { spawn, calls, children };
}
