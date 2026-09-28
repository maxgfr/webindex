import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

// Stopping a command AND everything it started.
//
// `child.kill()` reaches the direct child only, and the commands this engine
// runs are mostly wrappers: npx runs the real tool as a grandchild (npx → sh →
// node), copyable-pdf spawns pdftoppm and tesseract, `git clone` its transport.
// After a timeout the work carried on without us — and because those
// descendants inherited the pipes, Node's handles stayed open and the process
// could not exit until they finished (measured: the answer printed at +181 s,
// the process gone at +241 s).
//
// Why walk the tree rather than start the child in its own process group and
// kill the group? Because a child in another group no longer receives the
// terminal's Ctrl-C: an OCR run would grind on for minutes after the user gave
// up. Finding the descendants at kill time keeps them in our group, where
// terminal signals still reach them. Internal: not part of the public surface.

function addChild(tree: Map<number, number[]>, parent: number, child: number): void {
  const siblings = tree.get(parent);
  if (siblings) siblings.push(child);
  else tree.set(parent, [child]);
}

/** Parent → children, read from /proc: Linux, and present even where `ps` is not installed. */
function treeFromProc(): Map<number, number[]> | undefined {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return undefined;
  }
  const tree = new Map<number, number[]>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "latin1");
    } catch {
      continue; // exited while we looked
    }
    // "pid (comm) state ppid …" — comm may hold spaces and parentheses, so the
    // fields are read after the LAST ')'.
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (ppid > 0) addChild(tree, ppid, Number(entry));
  }
  return tree;
}

/** Parent → children, from `ps` (macOS and the BSDs). */
function treeFromPs(): Map<number, number[]> | undefined {
  const r = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0 || !r.stdout) return undefined;
  const tree = new Map<number, number[]>();
  for (const line of r.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid) addChild(tree, ppid, pid);
  }
  return tree;
}

function descendants(pid: number): number[] {
  const tree = (process.platform === "linux" ? treeFromProc() : undefined) ?? treeFromPs();
  if (!tree) return [];
  const found = new Set<number>();
  const queue = [pid];
  while (queue.length) {
    for (const child of tree.get(queue.shift()!) ?? []) {
      if (found.has(child) || child === pid) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return [...found];
}

/**
 * SIGKILL a child and all its descendants, then let go of its pipes. Never
 * throws: a process that already exited is simply not there to kill.
 */
export function killTree(child: ChildProcess): void {
  try {
    if (process.platform === "win32" && child.pid) {
      // taskkill /T is Windows' own tree walk.
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill("SIGKILL"));
    } else {
      // Listed BEFORE the kill: once the child dies its children are
      // re-parented, and nothing links them to it any more.
      const pids = child.pid ? descendants(child.pid) : [];
      child.kill("SIGKILL");
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  } catch {
    child.kill("SIGKILL");
  }
  // A descendant that escaped (or outlived a Windows taskkill) still holds our
  // end of the pipes; dropping them is what lets this process exit on time.
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}
