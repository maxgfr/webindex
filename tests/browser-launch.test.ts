import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envName } from "../src/brand.js";
import { UsageError } from "../src/cli-kit.js";
import type { BrowserDeps } from "../src/browser/deps.js";
import { resolveEndpoint } from "../src/browser/launch.js";
import { profileDir } from "../src/browser/profile.js";
import { readSession, type Session, writeSession } from "../src/browser/state.js";
import { FakeCdp } from "./helpers/fake-cdp.js";
import { fakeSpawn } from "./helpers/fake-spawn.js";

let fake: FakeCdp;
let home: string;

beforeEach(async () => {
  fake = await FakeCdp.start();
  home = mkdtempSync(join(tmpdir(), "wi-launch-"));
  process.env[envName("BROWSER_DIR")] = home;
});
afterEach(async () => {
  await fake.close();
  rmSync(home, { recursive: true, force: true });
});

const chrome = { kind: "chrome" as const, path: "/fake/chrome" };
const saved = (over: Partial<Session> = {}): Session => ({
  version: 1,
  port: fake.port,
  pid: 777,
  launchedByUs: true,
  profile: "default",
  headless: false,
  targetId: "T1",
  updatedAt: 1,
  ...over,
});
// A port nothing listens on: bind one, then let it go.
const deadPort = async () => {
  const f = await FakeCdp.start();
  const port = f.port;
  await f.close();
  return port;
};
const launchDeps = (spawn: BrowserDeps["spawn"], over: Partial<BrowserDeps> = {}): Partial<BrowserDeps> => ({
  spawn,
  detectBrowser: () => chrome,
  ...over,
});

describe("launch policy order", () => {
  it("an explicit port wins over a live saved session and spawns nothing", async () => {
    const other = await FakeCdp.start();
    writeSession(saved({ port: other.port }));
    const { spawn, calls } = fakeSpawn();
    const ep = await resolveEndpoint({ cdp: fake.port, deps: launchDeps(spawn) });
    expect(ep).toMatchObject({ host: "127.0.0.1", port: fake.port, launchedByUs: false });
    expect(ep.pid).toBeUndefined();
    expect(calls).toHaveLength(0);
    await other.close();
  });

  it("accepts an explicit URL, and maps localhost to 127.0.0.1", async () => {
    const ep = await resolveEndpoint({ cdp: `http://localhost:${fake.port}`, deps: launchDeps(fakeSpawn().spawn) });
    expect(ep).toMatchObject({ host: "127.0.0.1", port: fake.port, launchedByUs: false });
  });

  it("refuses a non-loopback --cdp with a usage error", async () => {
    const err = await resolveEndpoint({ cdp: "http://10.0.0.5:9222", deps: launchDeps(fakeSpawn().spawn) }).catch((e) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toMatch(/non-loopback/);
  });

  it("refuses an explicit port nothing answers on", async () => {
    const port = await deadPort();
    const { spawn, calls } = fakeSpawn();
    await expect(resolveEndpoint({ cdp: port, deps: launchDeps(spawn) })).rejects.toThrow(new RegExp(`nothing answers DevTools on 127.0.0.1:${port}`));
    expect(calls).toHaveLength(0);
  });

  it("reuses a saved session that is still alive, with its ownership", async () => {
    writeSession(saved({ launchedByUs: false, pid: undefined, profile: "work", headless: true }));
    const { spawn, calls } = fakeSpawn();
    const ep = await resolveEndpoint({ deps: launchDeps(spawn) });
    expect(ep).toEqual({ host: "127.0.0.1", port: fake.port, launchedByUs: false, profile: "work", headless: true });
    expect(calls).toHaveLength(0);
  });

  it("reuses a saved session's pid when we launched it", async () => {
    writeSession(saved());
    const ep = await resolveEndpoint({ profile: "default", deps: launchDeps(fakeSpawn().spawn) });
    expect(ep).toMatchObject({ port: fake.port, launchedByUs: true, pid: 777 });
  });

  it("spawns a new browser when the saved session is for another profile", async () => {
    writeSession(saved({ profile: "work" }));
    const { spawn, calls } = fakeSpawn({ port: fake.port });
    const ep = await resolveEndpoint({ profile: "other", deps: launchDeps(spawn) });
    expect(calls).toHaveLength(1);
    expect(ep).toMatchObject({ port: fake.port, launchedByUs: true, pid: 4242, profile: "other" });
  });

  it("spawns when the saved port is dead, and forgets the dead session", async () => {
    writeSession(saved({ port: await deadPort() }));
    const { spawn, calls } = fakeSpawn({ port: fake.port });
    const ep = await resolveEndpoint({ deps: launchDeps(spawn) });
    expect(calls).toHaveLength(1);
    expect(ep).toEqual({ host: "127.0.0.1", port: fake.port, launchedByUs: true, pid: 4242, profile: "default", headless: false });
    expect(readSession()).toBeNull();
  });
});

describe("spawning a separate browser", () => {
  it("passes exactly the dedicated-profile flags, detached, and no automation flag", async () => {
    const { spawn, calls, children } = fakeSpawn({ port: fake.port });
    await resolveEndpoint({ profile: "work", deps: launchDeps(spawn) });
    const dir = profileDir("work");
    expect(calls[0]?.cmd).toBe("/fake/chrome");
    expect(calls[0]?.args).toEqual(["--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check", "about:blank"]);
    expect(calls[0]?.args.join(" ")).not.toMatch(/automation|disable-blink-features|headless|remote-allow-origins/);
    expect(calls[0]?.opts).toMatchObject({ detached: true, stdio: "ignore" });
    expect(children[0]?.unrefed).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, "profiles")).mode & 0o777).toBe(0o700);
    }
  });

  it("adds --headless=new only when headless is asked", async () => {
    const { spawn, calls } = fakeSpawn({ port: fake.port });
    const ep = await resolveEndpoint({ headless: true, deps: launchDeps(spawn) });
    expect(calls[0]?.args).toEqual([
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir("default")}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--headless=new",
      "about:blank",
    ]);
    expect(ep.headless).toBe(true);
  });

  it("prefers an explicit binary over detection", async () => {
    const { spawn, calls } = fakeSpawn({ port: fake.port });
    await resolveEndpoint({ binary: "/opt/brave", deps: launchDeps(spawn, { detectBrowser: () => null }) });
    expect(calls[0]?.cmd).toBe("/opt/brave");
  });

  it("explains how to name a browser when none is installed", async () => {
    const { spawn, calls } = fakeSpawn({ port: fake.port });
    await expect(resolveEndpoint({ deps: launchDeps(spawn, { detectBrowser: () => null }) })).rejects.toThrow(/WEBINDEX_TEST_BROWSER_BIN/);
    expect(calls).toHaveLength(0);
  });

  it("removes a stale DevToolsActivePort before starting the browser", async () => {
    const dir = profileDir("default");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "DevToolsActivePort"), `${await deadPort()}\n/devtools/browser/stale\n`);
    const { spawn, calls } = fakeSpawn({ port: fake.port });
    const ep = await resolveEndpoint({ deps: launchDeps(spawn) });
    expect(calls[0]?.staleFileAtSpawn).toBe(false);
    expect(ep.port).toBe(fake.port);
  });

  it("reuses the browser still running on the profile instead of launching a second one", async () => {
    // Chrome hands a second launch on a busy profile to the running instance and exits 0.
    const dir = profileDir("work");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "DevToolsActivePort"), `${fake.port}\n/devtools/browser/fake\n`);
    const { spawn, calls } = fakeSpawn({ exitCode: 0 });
    const ep = await resolveEndpoint({ profile: "work", deps: launchDeps(spawn) });
    expect(calls).toHaveLength(0);
    expect(ep).toEqual({ host: "127.0.0.1", port: fake.port, launchedByUs: true, profile: "work", headless: false });
  });

  it("says the profile may be busy when the browser exits at once with code 0", async () => {
    const { spawn } = fakeSpawn({ exitCode: 0 });
    await expect(resolveEndpoint({ deps: launchDeps(spawn) })).rejects.toThrow(/code 0.*already running on the profile/);
  });

  it("fails with the exit code when the browser exits before exposing its port", async () => {
    const { spawn } = fakeSpawn({ exitCode: 21 });
    await expect(resolveEndpoint({ deps: launchDeps(spawn) })).rejects.toThrow(/exited.*code 21/);
    const killed = fakeSpawn({ signal: "SIGKILL" });
    await expect(resolveEndpoint({ deps: launchDeps(killed.spawn) })).rejects.toThrow(/exited.*signal SIGKILL/);
  });

  it("fails clearly when the binary cannot be started", async () => {
    const { spawn } = fakeSpawn({ error: Object.assign(new Error("spawn /fake/chrome ENOENT"), { code: "ENOENT" }) });
    await expect(resolveEndpoint({ deps: launchDeps(spawn) })).rejects.toThrow(/could not start \/fake\/chrome: spawn \/fake\/chrome ENOENT/);
  });

  // A clock that only moves when the launcher sleeps: the 20 s deadline costs nothing.
  const fakeClock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it("gives up after ~20 s without a DevToolsActivePort, and kills what it started", async () => {
    const { spawn, children } = fakeSpawn({ silent: true });
    const clock = fakeClock();
    await expect(resolveEndpoint({ deps: launchDeps(spawn, clock) })).rejects.toThrow(/did not expose a DevTools port within 20 s/);
    expect(clock.now()).toBeGreaterThanOrEqual(20_000);
    expect(children[0]?.signals).toEqual(["SIGTERM"]);
  });

  it("keeps polling past a malformed or not-yet-live DevToolsActivePort", async () => {
    for (const content of ["garbage\n/devtools/browser/x\n", "9222", "70000\n/devtools/browser/x\n"]) {
      const malformed = fakeSpawn({ content, immediate: true });
      await expect(resolveEndpoint({ deps: launchDeps(malformed.spawn, fakeClock()) })).rejects.toThrow(/within 20 s/);
    }
    const notLive = fakeSpawn({ port: await deadPort(), immediate: true });
    await expect(resolveEndpoint({ deps: launchDeps(notLive.spawn, fakeClock()) })).rejects.toThrow(/within 20 s/);
  });
});
