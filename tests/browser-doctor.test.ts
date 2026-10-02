import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envName } from "../src/brand.js";
import { type BrowserDoctorDeps, browserDoctor } from "../src/browser/doctor.js";
import type { Session } from "../src/browser/state.js";

const session: Session = { version: 1, port: 9333, launchedByUs: true, profile: "work", headless: false, targetId: "T1", updatedAt: 1 };

const deps = (over: Partial<BrowserDoctorDeps> = {}): BrowserDoctorDeps => ({
  detect: () => ({ kind: "chrome", path: "/usr/bin/chrome" }),
  home: () => "/h",
  profiles: () => ["default", "work"],
  session: () => null,
  alive: async () => false,
  fetchMode: () => "off",
  concurrency: () => 1,
  env: () => undefined,
  ...over,
});

describe("browserDoctor", () => {
  it("shows the browser kind asked for and the extensions to load, with the note branded Chrome needs", async () => {
    const ext = mkdtempSync(join(tmpdir(), "wi-doctor-ext-"));
    writeFileSync(join(ext, "manifest.json"), "{}");
    try {
      const vars: Record<string, string> = { BROWSER_KIND: "chrome", BROWSER_EXTENSIONS: ext };
      const b = await browserDoctor(
        deps({ detect: () => ({ kind: "chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }), env: (k) => vars[k] }),
      );
      expect(b.kind).toBe("chrome");
      expect(b.extensions).toEqual({
        paths: [ext],
        note: "Google Chrome ≥ 137 ignores unpacked extensions — use Brave (built-in ad/tracker blocking: WEBINDEX_TEST_BROWSER_KIND=brave), Chromium, Chrome for Testing or Edge",
      });
      // Brave loads them: no note.
      expect((await browserDoctor(deps({ detect: () => ({ kind: "brave", path: "/b/brave" }), env: (k) => vars[k] }))).extensions).toEqual({ paths: [ext] });
      // A path that is no extension is a problem shown, not a throw.
      const bad = await browserDoctor(deps({ env: (k) => (k === "BROWSER_EXTENSIONS" ? "/nowhere/x" : undefined) }));
      expect(bad.extensions).toMatchObject({ paths: [], error: expect.stringMatching(/no such directory: \/nowhere\/x/) });
      expect(bad.kind).toBeUndefined();
    } finally {
      rmSync(ext, { recursive: true, force: true });
    }
  });

  it("reports the binary, home, profiles and the fetch rung", async () => {
    const b = await browserDoctor(deps());
    expect(b).toEqual({
      binary: { state: "found", kind: "chrome", path: "/usr/bin/chrome" },
      home: "/h",
      profiles: ["default", "work"],
      session: { state: "none" },
      fetch: { mode: "off", concurrency: 1 },
    });
  });

  it("says what to install when no browser is found", async () => {
    const b = await browserDoctor(deps({ detect: () => null }));
    expect(b.binary.state).toBe("not found");
    expect(JSON.stringify(b.binary)).toMatch(/install Chrome\/Brave\/Chromium\/Edge or set .*BROWSER_BIN/);
  });

  it("reports a BROWSER_BIN pointing nowhere as a problem instead of throwing", async () => {
    const b = await browserDoctor(
      deps({
        detect: () => {
          throw new Error('BROWSER_BIN points at "/x", which is not an executable file');
        },
      }),
    );
    expect(b.binary).toEqual({ state: "error", error: 'BROWSER_BIN points at "/x", which is not an executable file' });
  });

  it("probes the saved session's port once", async () => {
    const seen: [number, string][] = [];
    const alive = await browserDoctor(
      deps({
        session: () => session,
        alive: async (p, h) => {
          seen.push([p, h]);
          return true;
        },
      }),
    );
    expect(alive.session).toEqual({ state: "alive", port: 9333, launchedByUs: true, profile: "work" });
    expect(seen).toEqual([[9333, "127.0.0.1"]]);
    const dead = await browserDoctor(deps({ session: () => ({ ...session, host: "::1", launchedByUs: false }) }));
    expect(dead.session).toEqual({ state: "dead", port: 9333, launchedByUs: false, profile: "work" });
  });

  it("treats a probe that throws as dead", async () => {
    const b = await browserDoctor(
      deps({
        session: () => session,
        alive: async () => {
          throw new Error("boom");
        },
      }),
    );
    expect(b.session).toMatchObject({ state: "dead" });
  });

  it.each(["off", "always", "fallback"] as const)("reports fetch mode %s and the concurrency", async (mode) => {
    expect((await browserDoctor(deps({ fetchMode: () => mode, concurrency: () => 3 }))).fetch).toEqual({ mode, concurrency: 3 });
  });

  describe("defaults", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "wi-bdoc-"));
      process.env[envName("BROWSER_DIR")] = join(dir, "home");
      process.env[envName("BROWSER_BIN")] = join(dir, "missing");
      delete process.env[envName("BROWSER_FETCH")];
      delete process.env[envName("BROWSER_CONCURRENCY")];
    });
    afterEach(() => {
      delete process.env[envName("BROWSER_DIR")];
      delete process.env[envName("BROWSER_BIN")];
      rmSync(dir, { recursive: true, force: true });
    });

    it("reads the real environment and creates nothing", async () => {
      const b = await browserDoctor();
      expect(b.home).toBe(join(dir, "home"));
      expect(b.profiles).toEqual([]);
      expect(b.binary.state).toBe("error");
      expect(b.session).toEqual({ state: "none" });
      expect(b.fetch).toEqual({ mode: "off", concurrency: 1 });
      expect(existsSync(join(dir, "home"))).toBe(false);
    });

    it("lists profile directories, sorted, and the saved session", async () => {
      const home = join(dir, "home");
      mkdirSync(join(home, "profiles", "b"), { recursive: true });
      mkdirSync(join(home, "profiles", "a"), { recursive: true });
      writeFileSync(join(home, "profiles", "stray.txt"), "");
      writeFileSync(join(home, "session.json"), JSON.stringify({ ...session, port: 1 }));
      process.env[envName("BROWSER_FETCH")] = "fallback";
      process.env[envName("BROWSER_CONCURRENCY")] = "2";
      const b = await browserDoctor();
      expect(b.profiles).toEqual(["a", "b"]);
      expect(b.session).toMatchObject({ port: 1, profile: "work" });
      expect(b.fetch).toEqual({ mode: "fallback", concurrency: 2 });
    });
  });
});
