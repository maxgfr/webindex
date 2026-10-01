import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { browserDeps, defaultBrowserDeps } from "../src/browser/deps.js";
import {
  appendNetwork,
  clearNetwork,
  clearRefs,
  clearSession,
  NETWORK_CAP,
  readNetwork,
  readRefs,
  readSession,
  type RefTable,
  type Session,
  withBrowserLock,
  writeRefs,
  writeSession,
} from "../src/browser/state.js";
import { resetNoWrite, setNoWrite, writeFileAtomic } from "../src/no-write.js";

const posix = process.platform !== "win32";
const mode = (p: string) => statSync(p).mode & 0o777;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "wi-state-"));
});
afterEach(() => {
  resetNoWrite();
  rmSync(home, { recursive: true, force: true });
});

const session: Session = { version: 1, port: 9222, launchedByUs: true, profile: "default", headless: false, targetId: "T1", updatedAt: 1 };
const table: RefTable = { loaderId: "L1", url: "https://x.test/", next: 3, refs: { e1: 10, e2: 11 } };
const files = (dir: string) => readdirSync(dir).sort();

describe("session", () => {
  it("round-trips and clears", () => {
    expect(readSession({ home })).toBeNull();
    writeSession(session, { home });
    expect(readSession({ home })).toEqual(session);
    clearSession({ home });
    expect(readSession({ home })).toBeNull();
    clearSession({ home }); // idempotent
  });

  it("treats corrupt or wrong-shaped JSON as no session", () => {
    writeFileSync(join(home, "session.json"), "{not json");
    expect(readSession({ home })).toBeNull();
    writeFileSync(join(home, "session.json"), JSON.stringify({ version: 2 }));
    expect(readSession({ home })).toBeNull();
    writeFileSync(join(home, "session.json"), "null");
    expect(readSession({ home })).toBeNull();
  });

  it("writes private files in a private dir and leaves no temp file", () => {
    const h = join(home, "fresh");
    writeSession(session, { home: h });
    expect(files(h)).toEqual(["session.json"]);
    if (posix) {
      expect(mode(h)).toBe(0o700);
      expect(mode(join(h, "session.json"))).toBe(0o600);
    }
  });

  it("uses the browser home by default", () => {
    writeSession(session);
    expect(readSession()).toEqual(session);
    clearSession();
  });
});

describe("atomic write", () => {
  it("keeps the original when the rename fails and cleans the temp file", () => {
    const target = join(home, "t.json");
    mkdirSync(join(target, "sub"), { recursive: true }); // rename onto a non-empty dir fails
    expect(() => writeFileAtomic(target, "new", 0o600)).toThrow();
    expect(files(home)).toEqual(["t.json"]);
    expect(statSync(target).isDirectory()).toBe(true);
  });

  it("applies the mode", () => {
    const target = join(home, "m.txt");
    writeFileAtomic(target, "x", 0o600);
    if (posix) expect(mode(target)).toBe(0o600);
    expect(readFileSync(target, "utf8")).toBe("x");
  });
});

describe("refs", () => {
  it("round-trips per target and clears one or all", () => {
    expect(readRefs("T1", { home })).toBeNull();
    writeRefs("T1", table, { home });
    writeRefs("T2", { ...table, loaderId: "L2" }, { home });
    expect(readRefs("T1", { home })).toEqual(table);
    clearRefs("T1", { home });
    expect(readRefs("T1", { home })).toBeNull();
    expect(readRefs("T2", { home })?.loaderId).toBe("L2");
    clearRefs(undefined, { home });
    expect(readRefs("T2", { home })).toBeNull();
    clearRefs(undefined, { home }); // nothing there
  });

  it("returns null on corrupt content and on a bad shape", () => {
    mkdirSync(join(home, "refs"));
    writeFileSync(join(home, "refs", "T1.json"), "oops");
    expect(readRefs("T1", { home })).toBeNull();
    writeFileSync(join(home, "refs", "T1.json"), JSON.stringify({ loaderId: 1 }));
    expect(readRefs("T1", { home })).toBeNull();
  });

  it("rejects target ids that would escape the directory", () => {
    expect(() => writeRefs("../evil", table, { home })).toThrow(/target id/);
    expect(() => readRefs("a/b", { home })).toThrow(/target id/);
    expect(() => appendNetwork("", [{}], { home })).toThrow(/target id/);
  });

  it("keeps the files private", () => {
    writeRefs("T1", table, { home });
    if (posix) {
      expect(mode(join(home, "refs"))).toBe(0o700);
      expect(mode(join(home, "refs", "T1.json"))).toBe(0o600);
    }
    expect(files(join(home, "refs"))).toEqual(["T1.json"]);
  });
});

describe("network log", () => {
  it("appends and reads back in order", () => {
    expect(readNetwork("T1", { home })).toEqual([]);
    appendNetwork("T1", [{ n: 1 }, { n: 2 }], { home });
    appendNetwork("T1", [{ n: 3 }], { home });
    appendNetwork("T1", [], { home });
    expect(readNetwork("T1", { home })).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    if (posix) expect(mode(join(home, "network", "T1.jsonl"))).toBe(0o600);
    clearNetwork("T1", { home });
    expect(readNetwork("T1", { home })).toEqual([]);
    clearNetwork("T1", { home });
  });

  it("clears every tab's log when no target is given", () => {
    appendNetwork("T1", [{ n: 1 }], { home });
    appendNetwork("T2", [{ n: 2 }], { home });
    clearNetwork(undefined, { home });
    expect(readNetwork("T1", { home })).toEqual([]);
    expect(readNetwork("T2", { home })).toEqual([]);
    clearNetwork(undefined, { home });
  });

  it("skips corrupt lines", () => {
    mkdirSync(join(home, "network"));
    writeFileSync(join(home, "network", "T1.jsonl"), '{"a":1}\nnot json\n\n{"a":2}\n');
    expect(readNetwork("T1", { home })).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("keeps only the last NETWORK_CAP entries", () => {
    appendNetwork(
      "T1",
      Array.from({ length: NETWORK_CAP - 10 }, (_, i) => ({ i })),
      { home },
    );
    appendNetwork(
      "T1",
      Array.from({ length: 30 }, (_, i) => ({ i: NETWORK_CAP - 10 + i })),
      { home },
    );
    const got = readNetwork("T1", { home }) as { i: number }[];
    expect(got).toHaveLength(NETWORK_CAP);
    expect(got.at(-1)?.i).toBe(NETWORK_CAP + 19);
    expect(got[0]?.i).toBe(20);
    expect(files(join(home, "network"))).toEqual(["T1.jsonl"]);
  });

  it("truncates a single oversized batch", () => {
    appendNetwork(
      "T1",
      Array.from({ length: NETWORK_CAP + 5 }, (_, i) => ({ i })),
      { home },
    );
    const got = readNetwork("T1", { home }) as { i: number }[];
    expect(got).toHaveLength(NETWORK_CAP);
    expect(got[0]?.i).toBe(5);
  });
});

describe("no-write mode", () => {
  it("makes every write a no-op while reads still work", () => {
    writeSession(session, { home });
    writeRefs("T1", table, { home });
    appendNetwork("T1", [{ a: 1 }], { home });
    setNoWrite(true);
    const h = join(home, "ro");
    writeSession({ ...session, port: 1 }, { home: h });
    writeRefs("T9", table, { home: h });
    appendNetwork("T9", [{ a: 1 }], { home: h });
    clearSession({ home });
    clearRefs("T1", { home });
    clearNetwork("T1", { home });
    expect(existsSync(h)).toBe(false);
    expect(readSession({ home })).toEqual(session);
    expect(readRefs("T1", { home })).toEqual(table);
    expect(readNetwork("T1", { home })).toEqual([{ a: 1 }]);
  });

  it("still runs the function under the lock without touching disk", async () => {
    setNoWrite(true);
    const h = join(home, "ro");
    await expect(withBrowserLock(async () => 7, { home: h })).resolves.toBe(7);
    expect(existsSync(h)).toBe(false);
  });
});

describe("withBrowserLock", () => {
  const lockPath = () => join(home, "lock");

  it("acquires, runs and releases", async () => {
    const seen = await withBrowserLock(
      async () => {
        const held = JSON.parse(readFileSync(lockPath(), "utf8"));
        expect(held.pid).toBe(process.pid);
        return "done";
      },
      { home },
    );
    expect(seen).toBe("done");
    expect(existsSync(lockPath())).toBe(false);
  });

  it("releases when fn throws", async () => {
    await expect(
      withBrowserLock(
        async () => {
          throw new Error("boom");
        },
        { home },
      ),
    ).rejects.toThrow("boom");
    expect(existsSync(lockPath())).toBe(false);
  });

  it("makes a second caller wait, then run", async () => {
    const order: string[] = [];
    const first = withBrowserLock(
      async () => {
        order.push("a-start");
        await new Promise((r) => setTimeout(r, 80));
        order.push("a-end");
      },
      { home },
    );
    await new Promise((r) => setTimeout(r, 10));
    const second = withBrowserLock(async () => void order.push("b"), { home, pollMs: 10 });
    await Promise.all([first, second]);
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("steals a lock older than staleMs", async () => {
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 }));
    await expect(withBrowserLock(async () => "ok", { home, staleMs: 30_000 })).resolves.toBe("ok");
  });

  it("steals a lock whose owner is dead", async () => {
    writeFileSync(lockPath(), JSON.stringify({ pid: 2_147_483_000, at: Date.now() }));
    await expect(withBrowserLock(async () => "ok", { home })).resolves.toBe("ok");
  });

  it("steals an unreadable lock only once it is stale by file age", async () => {
    writeFileSync(lockPath(), "garbage");
    await expect(withBrowserLock(async () => "ok", { home, waitMs: 60, pollMs: 10 })).rejects.toThrow(/busy/);
    await expect(withBrowserLock(async () => "ok", { home, staleMs: -1 })).resolves.toBe("ok");
  });

  it("times out with a clear message when the owner is alive", async () => {
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, at: Date.now() }));
    await expect(withBrowserLock(async () => "x", { home, waitMs: 60, pollMs: 10 })).rejects.toThrow(/browser busy/i);
    expect(existsSync(lockPath())).toBe(true); // not ours: left alone
  });

  it("does not remove a lock somebody else took over meanwhile", async () => {
    await withBrowserLock(
      async () => {
        writeFileSync(lockPath(), JSON.stringify({ pid: 1, at: Date.now() }));
      },
      { home },
    );
    expect(JSON.parse(readFileSync(lockPath(), "utf8")).pid).toBe(1);
  });

  it("uses injected clock and sleep", async () => {
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, at: 1000 }));
    let t = 1000;
    const sleeps: number[] = [];
    const deps = {
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
    };
    await expect(withBrowserLock(async () => "x", { home, waitMs: 500, staleMs: 10_000, pollMs: 100, deps })).rejects.toThrow(/busy/);
    expect(sleeps.length).toBeGreaterThan(0);
    t = 20_000;
    await expect(withBrowserLock(async () => "x", { home, staleMs: 10_000, deps })).resolves.toBe("x");
  });
});

describe("defaultBrowserDeps", () => {
  it("wires the real implementations without side effects", async () => {
    const d = defaultBrowserDeps();
    expect(typeof d.spawn).toBe("function");
    expect(typeof d.connectCdp).toBe("function");
    expect(typeof d.discovery.getVersion).toBe("function");
    expect(typeof d.fs.readFile).toBe("function");
    expect(d.platform).toBe(process.platform);
    expect(Math.abs(d.now() - Date.now())).toBeLessThan(1000);
    const t = Date.now();
    await d.sleep(15);
    expect(Date.now() - t).toBeGreaterThanOrEqual(10);
    expect(d.env("NOPE_NOT_SET_XYZ")).toBeUndefined();
    const child = d.spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
    expect(typeof child.pid).toBe("number");
    await new Promise<void>((r) => child.on("exit", () => r()));
    const f = join(home, "x");
    await d.fs.writeFile(f, "hi");
    expect(await d.fs.readFile(f, "utf8")).toBe("hi");
    await d.fs.mkdir(join(home, "d"), { recursive: true });
    expect((await d.fs.stat(f)).isFile()).toBe(true);
    await d.fs.rename(f, join(home, "y"));
    const fh = await d.fs.open(join(home, "z"), "wx");
    await fh.close();
    await expect(d.fs.open(join(home, "z"), "wx")).rejects.toThrow();
    await d.fs.rm(join(home, "y"), { force: true });
  });

  it("kills by pid, detects a browser, and lets a caller replace any seam", async () => {
    const d = browserDeps({ platform: "aix" });
    expect(d.platform).toBe("aix");
    expect(typeof d.connectCdp).toBe("function");
    const found = d.detectBrowser();
    expect(found === null || typeof found.path === "string").toBe(true);
    const child = d.spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
    const exited = new Promise<NodeJS.Signals | null>((r) => child.on("exit", (_code, sig) => r(sig)));
    d.kill(child.pid as number, "SIGTERM");
    expect(await exited).toBe("SIGTERM");
  });
});
