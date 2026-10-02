import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envName } from "../src/brand.js";
import { UsageError } from "../src/cli-kit.js";
import type { BrowserDeps } from "../src/browser/deps.js";
import { resolveEndpoint } from "../src/browser/launch.js";
import * as discovery from "../src/browser/discovery.js";
import { profileDir, profileKindFile, readProfileKind, writeProfileKind } from "../src/browser/profile.js";
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
  wsBrowserUrl: fake.browserWsUrl,
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
    // An attached browser may have been saved without its socket path (`browser attach`).
    writeSession(saved({ launchedByUs: false, pid: undefined, wsBrowserUrl: undefined, profile: "work", headless: true }));
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

  it("does not claim a browser that took over the saved port: another socket path means ours is gone", async () => {
    writeSession(saved({ wsBrowserUrl: `ws://127.0.0.1:${fake.port}/devtools/browser/our-dead-guid` }));
    const { spawn, calls } = fakeSpawn({ port: fake.port });
    const ep = await resolveEndpoint({ deps: launchDeps(spawn) });
    expect(calls).toHaveLength(1);
    expect(ep.pid).toBe(4242);
    expect(readSession()).toBeNull();
  });

  it("does not trust a saved browser of ours that recorded no socket path", async () => {
    writeSession(saved({ wsBrowserUrl: undefined }));
    const { spawn, calls } = fakeSpawn({ port: fake.port });
    const ep = await resolveEndpoint({ deps: launchDeps(spawn) });
    expect(calls).toHaveLength(1);
    expect(ep.pid).toBe(4242);
  });

  it("spawns a new browser when the saved session is for another profile", async () => {
    writeSession(saved({ profile: "work" }));
    const { spawn, calls } = fakeSpawn({ port: fake.port });
    const ep = await resolveEndpoint({ profile: "other", deps: launchDeps(spawn) });
    expect(calls).toHaveLength(1);
    expect(ep).toMatchObject({ port: fake.port, launchedByUs: true, pid: 4242, profile: "other" });
  });

  it("never takes an attached browser for a named profile, even default: it launches ours and keeps the attached session", async () => {
    const attached = await FakeCdp.start();
    const session = saved({ port: attached.port, launchedByUs: false, pid: undefined, wsBrowserUrl: undefined });
    writeSession(session);
    const { spawn, calls } = fakeSpawn({ port: fake.port });
    const ep = await resolveEndpoint({ profile: "default", deps: launchDeps(spawn) });
    expect(calls).toHaveLength(1);
    expect(ep).toMatchObject({ port: fake.port, launchedByUs: true, profile: "default" });
    expect(readSession()).toEqual(session);
    await attached.close();
  });

  it("skips an attached browser when asked for our own only, and still reuses one of ours", async () => {
    const attached = await FakeCdp.start();
    writeSession(saved({ port: attached.port, launchedByUs: false, pid: undefined, wsBrowserUrl: undefined }));
    const { spawn, calls } = fakeSpawn({ port: fake.port });
    expect(await resolveEndpoint({ ownOnly: true, deps: launchDeps(spawn) })).toMatchObject({ port: fake.port, launchedByUs: true });
    expect(calls).toHaveLength(1);
    await attached.close();
    writeSession(saved());
    expect(await resolveEndpoint({ ownOnly: true, deps: launchDeps(spawn) })).toMatchObject({ port: fake.port, launchedByUs: true, pid: 777 });
    expect(calls).toHaveLength(1);
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

  it("does not reuse a live port from DevToolsActivePort when another browser answers there", async () => {
    const dir = profileDir("work");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "DevToolsActivePort"), `${fake.port}\n/devtools/browser/our-dead-guid\n`);
    const { spawn, calls } = fakeSpawn({ port: fake.port });
    const ep = await resolveEndpoint({ profile: "work", deps: launchDeps(spawn) });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.staleFileAtSpawn).toBe(false);
    expect(ep).toMatchObject({ launchedByUs: true, pid: 4242 });
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

  it("keeps polling past a malformed, not-yet-live or foreign DevToolsActivePort", async () => {
    const foreign = `${fake.port}\n/devtools/browser/not-the-one-we-started\n`;
    for (const content of ["garbage\n/devtools/browser/x\n", "9222", "70000\n/devtools/browser/x\n", foreign]) {
      const malformed = fakeSpawn({ content, immediate: true });
      await expect(resolveEndpoint({ deps: launchDeps(malformed.spawn, fakeClock()) })).rejects.toThrow(/within 20 s/);
    }
    const notLive = fakeSpawn({ port: await deadPort(), immediate: true });
    await expect(resolveEndpoint({ deps: launchDeps(notLive.spawn, fakeClock()) })).rejects.toThrow(/within 20 s/);
  });
});

describe("unpacked extensions and the browser kind", () => {
  /** An unpacked extension: a directory holding a manifest.json. */
  const extension = (name: string): string => {
    const dir = join(home, "ext", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), '{"manifest_version":3,"name":"x","version":"1"}');
    return dir;
  };
  const envOf =
    (vars: Record<string, string>) =>
    (k: string): string | undefined =>
      vars[k];
  const branded = { kind: "chrome" as const, path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" };
  const versioned = (browser: string) => ({ ...discovery, getVersion: async () => ({ Browser: browser, webSocketDebuggerUrl: fake.browserWsUrl }) });

  it("loads the extensions BROWSER_EXTENSIONS lists, and keeps every other extension off", async () => {
    const a = extension("ubol");
    const b = extension("other");
    const { spawn, calls } = fakeSpawn({ port: fake.port });
    const chromium = { kind: "chromium" as const, path: "/fake/chromium" };
    const ep = await resolveEndpoint({ deps: launchDeps(spawn, { detectBrowser: () => chromium, env: envOf({ BROWSER_EXTENSIONS: ` ${a} , ${b}` }) }) });
    expect(calls[0]?.args).toEqual([
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir("default")}`,
      "--no-first-run",
      "--no-default-browser-check",
      `--load-extension=${a},${b}`,
      `--disable-extensions-except=${a},${b}`,
      "about:blank",
    ]);
    // Chromium loads them: nothing to say.
    expect(ep.notes).toBeUndefined();
  });

  it.each([
    ["a relative path", "ext/ubol", /absolute paths, not "ext\/ubol"/],
    ["a directory that does not exist", "/nowhere/ubol", /no such directory: \/nowhere\/ubol/],
  ])("refuses %s as a usage error, before anything is started", async (_what, value, message) => {
    const { spawn, calls } = fakeSpawn({ port: fake.port });
    const err = await resolveEndpoint({ deps: launchDeps(spawn, { env: envOf({ BROWSER_EXTENSIONS: value }) }) }).catch((e) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toMatch(/WEBINDEX_TEST_BROWSER_EXTENSIONS/);
    expect(err.message).toMatch(message);
    expect(calls).toHaveLength(0);
  });

  it("refuses a directory that holds no manifest.json", async () => {
    const dir = join(home, "ext", "empty");
    mkdirSync(dir, { recursive: true });
    const { spawn, calls } = fakeSpawn({ port: fake.port });
    const err = await resolveEndpoint({ deps: launchDeps(spawn, { env: envOf({ BROWSER_EXTENSIONS: dir }) }) }).catch((e) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toMatch(/has no manifest\.json/);
    expect(calls).toHaveLength(0);
  });

  it("passes no extension flag to a branded Google Chrome, which drops them, and says so", async () => {
    const a = extension("ubol");
    for (const version of ["Chrome/140.0.7339.80", "Chrome/136.0.1"]) {
      const { spawn, calls } = fakeSpawn({ port: fake.port });
      const ep = await resolveEndpoint({
        profile: version.replace(/\W/g, ""),
        deps: launchDeps(spawn, { detectBrowser: () => branded, env: envOf({ BROWSER_EXTENSIONS: a }), discovery: versioned(version) }),
      });
      // --disable-extensions-except would only turn off the profile's own extensions.
      expect(calls[0]?.args.join(" ")).not.toMatch(/extension/);
      expect(ep.notes).toEqual([
        "Google Chrome ≥ 137 ignores unpacked extensions — use Brave (built-in ad/tracker blocking: WEBINDEX_TEST_BROWSER_KIND=brave), Chromium or Chrome for Testing",
      ]);
    }
    // With no extension asked for there is nothing to say.
    const none = await resolveEndpoint({
      profile: "none",
      deps: launchDeps(fakeSpawn({ port: fake.port }).spawn, { detectBrowser: () => branded, env: envOf({}), discovery: versioned("Chrome/140.0.1") }),
    });
    expect(none.notes).toBeUndefined();
  });

  it.each([
    ["the flag", { kind: "brave" as const }, {}],
    ["BROWSER_KIND", {}, { BROWSER_KIND: "brave" }],
  ])("refuses to launch another browser when %s names one that is not installed", async (_what, opts, vars) => {
    const { spawn, calls } = fakeSpawn({ port: fake.port });
    const err = await resolveEndpoint({ ...opts, deps: launchDeps(spawn, { detectBrowser: (k) => (k ? null : chrome), env: envOf(vars) }) }).catch((e) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toMatch(/no brave found: install it, or name its executable with WEBINDEX_TEST_BROWSER_BIN/);
    expect(calls).toHaveLength(0);
  });

  it("refuses to launch another browser on a profile whose own kind is not installed", async () => {
    writeProfileKind("work", "brave");
    const { spawn, calls } = fakeSpawn({ port: fake.port });
    const err = await resolveEndpoint({ profile: "work", deps: launchDeps(spawn, { detectBrowser: (k) => (k ? null : chrome), env: envOf({}) }) }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toMatch(/no brave found/);
    expect(calls).toHaveLength(0);
  });

  it("launches all the same when the profile's kind cannot be recorded", async () => {
    mkdirSync(profileKindFile("ro"), { recursive: true }); // a directory where the file goes: the write fails
    const ep = await resolveEndpoint({ profile: "ro", deps: launchDeps(fakeSpawn({ port: fake.port }).spawn) });
    expect(ep).toMatchObject({ launchedByUs: true, profile: "ro" });
  });

  it("does not suggest --browser-kind when BROWSER_BIN names the binary", async () => {
    writeProfileKind("work", "brave");
    const err = await resolveEndpoint({
      profile: "work",
      binary: undefined,
      deps: launchDeps(fakeSpawn({ port: fake.port }).spawn, { detectBrowser: () => chrome, env: envOf({ BROWSER_BIN: "/fake/chrome" }) }),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toMatch(/belongs to brave/);
    expect(err.message).not.toMatch(/--browser-kind/);
    expect(err.message).toMatch(/WEBINDEX_TEST_BROWSER_BIN/);
  });

  it("asks detection for the kind the caller names, else BROWSER_KIND, else the profile's own", async () => {
    const asked: (string | undefined)[] = [];
    const detectBrowser = (prefer?: string) => {
      asked.push(prefer);
      return { kind: (prefer ?? "chrome") as "chrome", path: `/fake/${prefer ?? "chrome"}` };
    };
    await resolveEndpoint({
      profile: "a",
      kind: "edge",
      deps: launchDeps(fakeSpawn({ port: fake.port }).spawn, { detectBrowser, env: envOf({ BROWSER_KIND: "brave" }) }),
    });
    await resolveEndpoint({ profile: "b", deps: launchDeps(fakeSpawn({ port: fake.port }).spawn, { detectBrowser, env: envOf({ BROWSER_KIND: "brave" }) }) });
    // Profile "a" was made with Edge: launched again with nothing named, it asks for Edge.
    await resolveEndpoint({ profile: "a", deps: launchDeps(fakeSpawn({ port: fake.port }).spawn, { detectBrowser, env: envOf({}) }) });
    expect(asked).toEqual(["edge", "brave", "edge"]);
  });

  it("refuses a BROWSER_KIND it does not know as a usage error", async () => {
    const { spawn, calls } = fakeSpawn({ port: fake.port });
    const err = await resolveEndpoint({ deps: launchDeps(spawn, { env: envOf({ BROWSER_KIND: "netscape" }) }) }).catch((e) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toMatch(/WEBINDEX_TEST_BROWSER_KIND is "netscape"/);
    expect(calls).toHaveLength(0);
  });

  it("records the kind a profile was first launched with, and refuses another kind on it", async () => {
    await resolveEndpoint({
      profile: "work",
      deps: launchDeps(fakeSpawn({ port: fake.port }).spawn, { detectBrowser: () => ({ kind: "brave", path: "/fake/brave" }) }),
    });
    expect(readProfileKind("work")).toBe("brave");
    const { spawn, calls } = fakeSpawn({ port: fake.port });
    rmSync(join(profileDir("work"), "DevToolsActivePort"), { force: true });
    const err = await resolveEndpoint({ profile: "work", deps: launchDeps(spawn, { detectBrowser: () => chrome }) }).catch((e) => e);
    expect(err).toBeInstanceOf(UsageError);
    expect(err.message).toMatch(/the profile "work" belongs to brave/);
    expect(err.message).toMatch(/--profile chrome/);
    expect(calls).toHaveLength(0);
  });

  it("lets a profile made before the kind was recorded adopt the first kind launched on it", async () => {
    mkdirSync(profileDir("old"), { recursive: true, mode: 0o700 });
    writeFileSync(join(profileDir("old"), "Local State"), "{}");
    expect(readProfileKind("old")).toBeUndefined();
    await resolveEndpoint({ profile: "old", deps: launchDeps(fakeSpawn({ port: fake.port }).spawn) });
    expect(readProfileKind("old")).toBe("chrome");
  });

  it("takes the kind of an explicit binary from its name", async () => {
    await resolveEndpoint({
      profile: "bin",
      binary: "/opt/brave-browser",
      deps: launchDeps(fakeSpawn({ port: fake.port }).spawn, { detectBrowser: () => null }),
    });
    expect(readProfileKind("bin")).toBe("brave");
  });
});
