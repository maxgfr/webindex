import { describe, expect, it } from "vitest";
import { detectBrowserBinary } from "../src/browser/detect.js";

const MAC = (app: string, bin = app) => `/Applications/${app}.app/Contents/MacOS/${bin}`;
const only =
  (...present: string[]) =>
  (p: string) =>
    present.includes(p);

describe("detectBrowserBinary: macOS", () => {
  const base = { platform: "darwin" as const, home: "/Users/me", env: () => undefined };

  it.each([
    ["chrome", MAC("Google Chrome")],
    ["brave", MAC("Brave Browser")],
    ["chromium", MAC("Chromium")],
    ["edge", MAC("Microsoft Edge")],
  ] as const)("finds %s in /Applications", (kind, path) => {
    expect(detectBrowserBinary({ ...base, exists: only(path) })).toEqual({ kind, path });
  });

  it("also looks in ~/Applications", () => {
    const path = "/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    expect(detectBrowserBinary({ ...base, exists: only(path) })).toEqual({ kind: "chrome", path });
  });

  it("prefers Chrome, then Brave, Chromium, Edge", () => {
    const all = [MAC("Google Chrome"), MAC("Brave Browser"), MAC("Chromium"), MAC("Microsoft Edge")];
    expect(detectBrowserBinary({ ...base, exists: only(...all) })?.kind).toBe("chrome");
    expect(detectBrowserBinary({ ...base, exists: only(...all.slice(1)) })?.kind).toBe("brave");
    expect(detectBrowserBinary({ ...base, exists: only(...all.slice(2)) })?.kind).toBe("chromium");
  });

  it("honours `prefer`, and falls back when the preferred one is absent", () => {
    const both = [MAC("Google Chrome"), MAC("Brave Browser")];
    expect(detectBrowserBinary({ ...base, prefer: "brave", exists: only(...both) })?.kind).toBe("brave");
    expect(detectBrowserBinary({ ...base, prefer: "edge", exists: only(...both) })?.kind).toBe("chrome");
  });

  it("returns null when nothing is installed", () => {
    expect(detectBrowserBinary({ ...base, exists: () => false })).toBeNull();
  });
});

describe("detectBrowserBinary: Linux", () => {
  const base = { platform: "linux" as const, env: () => undefined, processEnv: { PATH: "/usr/local/bin:/usr/bin" } };

  it.each([
    ["google-chrome", "chrome"],
    ["google-chrome-stable", "chrome"],
    ["chromium", "chromium"],
    ["chromium-browser", "chromium"],
    ["brave-browser", "brave"],
    ["microsoft-edge", "edge"],
  ] as const)("finds %s on PATH", (name, kind) => {
    const path = `/usr/bin/${name}`;
    expect(detectBrowserBinary({ ...base, exists: only(path) })).toEqual({ kind, path });
  });

  it("searches PATH directories in order", () => {
    const r = detectBrowserBinary({ ...base, exists: only("/usr/local/bin/chromium", "/usr/bin/chromium") });
    expect(r?.path).toBe("/usr/local/bin/chromium");
  });

  it("returns null with an empty PATH or nothing installed", () => {
    expect(detectBrowserBinary({ ...base, processEnv: {}, exists: () => true })).toBeNull();
    expect(detectBrowserBinary({ ...base, exists: () => false })).toBeNull();
  });
});

describe("detectBrowserBinary: Windows", () => {
  const pf = "C:\\Program Files";
  const pf86 = "C:\\Program Files (x86)";
  const local = "C:\\Users\\me\\AppData\\Local";
  const base = {
    platform: "win32" as const,
    env: () => undefined,
    processEnv: { ProgramFiles: pf, "ProgramFiles(x86)": pf86, LOCALAPPDATA: local },
  };

  it.each([
    ["chrome", `${pf}\\Google\\Chrome\\Application\\chrome.exe`],
    ["chrome", `${pf86}\\Google\\Chrome\\Application\\chrome.exe`],
    ["chrome", `${local}\\Google\\Chrome\\Application\\chrome.exe`],
    ["brave", `${pf}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`],
    ["chromium", `${local}\\Chromium\\Application\\chrome.exe`],
    ["edge", `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`],
  ] as const)("finds %s at %s", (kind, path) => {
    expect(detectBrowserBinary({ ...base, exists: only(path) })).toEqual({ kind, path });
  });

  it("returns null when none of the roots hold a browser, or the roots are unset", () => {
    expect(detectBrowserBinary({ ...base, exists: () => false })).toBeNull();
    expect(detectBrowserBinary({ ...base, processEnv: {}, exists: () => true })).toBeNull();
  });
});

describe("detectBrowserBinary: explicit override", () => {
  const base = { platform: "linux" as const, processEnv: { PATH: "/usr/bin" } };

  it("BROWSER_BIN wins over everything installed", () => {
    const r = detectBrowserBinary({
      ...base,
      env: (s) => (s === "BROWSER_BIN" ? "/opt/brave/brave" : undefined),
      exists: only("/opt/brave/brave", "/usr/bin/google-chrome"),
    });
    expect(r).toEqual({ kind: "brave", path: "/opt/brave/brave" });
  });

  it.each([
    ["/x/msedge", "edge"],
    ["/x/chromium", "chromium"],
    ["/x/some-binary", "chrome"],
  ] as const)("infers the kind of %s", (path, kind) => {
    const r = detectBrowserBinary({ ...base, env: () => path, exists: only(path) });
    expect(r?.kind).toBe(kind);
  });

  it("resolves a bare command name on PATH", () => {
    const r = detectBrowserBinary({ ...base, env: () => "brave-browser", exists: only("/usr/bin/brave-browser") });
    expect(r).toEqual({ kind: "brave", path: "/usr/bin/brave-browser" });
  });

  it("refuses an override that points at nothing, instead of silently using another browser", () => {
    expect(() => detectBrowserBinary({ ...base, env: () => "/nope/chrome", exists: only("/usr/bin/google-chrome") })).toThrow(/BROWSER_BIN.*\/nope\/chrome/);
  });

  it("reads the override from the brand env at call time by default", () => {
    process.env.WEBINDEX_TEST_BROWSER_BIN = "/opt/c/chrome";
    expect(detectBrowserBinary({ ...base, exists: only("/opt/c/chrome") })?.path).toBe("/opt/c/chrome");
  });
});

describe("detectBrowserBinary: real defaults", () => {
  it("runs against the real filesystem without throwing", () => {
    const r = detectBrowserBinary();
    expect(r === null || typeof r.path === "string").toBe(true);
  });
});
