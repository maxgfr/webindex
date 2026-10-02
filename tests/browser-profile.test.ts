import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configure } from "../src/brand.js";
import {
  assertInsideHome,
  browserHome,
  ensurePrivateDir,
  importProfile,
  profileDir,
  profileKindFile,
  readProfileKind,
  resetProfile,
  writeProfileKind,
} from "../src/browser/profile.js";
import { UsageError } from "../src/cli-kit.js";

const posix = process.platform !== "win32";
const mode = (p: string) => statSync(p).mode & 0o777;

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "webindex-profile-"));
  process.env.WEBINDEX_TEST_BROWSER_DIR = join(work, "home");
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function put(root: string, rel: string, body = "x"): void {
  const p = join(root, ...rel.split("/"));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

describe("browserHome", () => {
  it("is BROWSER_DIR when set", () => {
    expect(browserHome()).toBe(join(work, "home"));
  });

  it("falls back to the brand's browserDir", () => {
    delete process.env.WEBINDEX_TEST_BROWSER_DIR;
    configure({ name: "acme", envPrefix: "WEBINDEX_TEST", cli: "acme", browserDir: "/srv/acme-browser" });
    expect(browserHome()).toBe("/srv/acme-browser");
  });

  it("defaults to ~/.<brand>/browser, under the home dir and not tmp", () => {
    delete process.env.WEBINDEX_TEST_BROWSER_DIR;
    configure({ name: "acme", envPrefix: "WEBINDEX_TEST", cli: "acme" });
    expect(browserHome()).toBe(join(homedir(), ".acme", "browser"));
  });

  it("lets the env override beat the brand", () => {
    configure({ name: "acme", envPrefix: "WEBINDEX_TEST", cli: "acme", browserDir: "/srv/acme-browser" });
    expect(browserHome()).toBe(join(work, "home"));
  });
});

describe("profileDir", () => {
  it("is <home>/profiles/<name>, default 'default'", () => {
    expect(profileDir()).toBe(join(work, "home", "profiles", "default"));
    expect(profileDir("work.1_a-b")).toBe(join(work, "home", "profiles", "work.1_a-b"));
  });

  it.each(["", ".", "..", "a/b", "a\\b", "../x", "with space", "x".repeat(65), "é"])("rejects %j", (name) => {
    expect(() => profileDir(name)).toThrow(UsageError);
  });

  it("does not create anything", () => {
    profileDir();
    expect(existsSync(join(work, "home"))).toBe(false);
  });
});

describe("ensurePrivateDir", () => {
  it.skipIf(!posix)("creates nested dirs, each 0700", () => {
    const d = join(work, "a", "b", "c");
    ensurePrivateDir(d);
    for (const p of [join(work, "a"), join(work, "a", "b"), d]) expect(mode(p)).toBe(0o700);
  });

  it.skipIf(!posix)("tightens an existing dir of ours that is group/world readable", () => {
    const d = join(work, "loose");
    mkdirSync(d, { mode: 0o755 });
    chmodSync(d, 0o755);
    ensurePrivateDir(d);
    expect(mode(d)).toBe(0o700);
  });

  it.skipIf(!posix)("refuses a dir others can write to", () => {
    const d = join(work, "open");
    mkdirSync(d);
    chmodSync(d, 0o777);
    expect(() => ensurePrivateDir(d)).toThrow(/writable by other users/);
  });

  it.skipIf(!posix)("refuses a symlink", () => {
    const real = join(work, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = join(work, "link");
    symlinkSync(real, link);
    expect(() => ensurePrivateDir(link)).toThrow(/symbolic link/);
  });

  it("refuses a file", () => {
    const f = join(work, "file");
    writeFileSync(f, "");
    expect(() => ensurePrivateDir(f)).toThrow(/not a directory/);
  });

  it("is idempotent", () => {
    const d = join(work, "x");
    ensurePrivateDir(d);
    ensurePrivateDir(d);
    expect(lstatSync(d).isDirectory()).toBe(true);
  });
});

describe("importProfile", () => {
  let src: string;
  beforeEach(() => {
    src = join(work, "src");
    put(src, "Local State", '{"a":1}');
    put(src, "Default/Cookies", "cookies");
    put(src, "Default/Preferences", "prefs");
    put(src, "Default/Local Storage/leveldb/000003.log", "ls");
    put(src, "Default/Cache/data_0", "junk");
    put(src, "Default/Code Cache/js/a", "junk");
    put(src, "Default/GPUCache/a", "junk");
    put(src, "Default/Service Worker/CacheStorage/a", "junk");
    put(src, "Default/Service Worker/Database/a", "db");
    put(src, "Default/DevToolsActivePort", "9222");
    put(src, "ShaderCache/a", "junk");
    put(src, "GrShaderCache/a", "junk");
    put(src, "Profile 1/Cookies", "other profile, not copied");
    put(src, "SingletonSocket", "");
  });

  it("copies Local State and Default, skipping locks and caches", () => {
    const r = importProfile(src, { name: "t" });
    const to = profileDir("t");
    expect(r.from).toBe(src);
    expect(r.to).toBe(to);
    expect(readFileSync(join(to, "Local State"), "utf8")).toBe('{"a":1}');
    expect(readFileSync(join(to, "Default", "Cookies"), "utf8")).toBe("cookies");
    expect(existsSync(join(to, "Default", "Local Storage", "leveldb", "000003.log"))).toBe(true);
    expect(existsSync(join(to, "Default", "Service Worker", "Database", "a"))).toBe(true);
    for (const skipped of [
      "Default/Cache",
      "Default/Code Cache",
      "Default/GPUCache",
      "Default/Service Worker/CacheStorage",
      "Default/DevToolsActivePort",
      "ShaderCache",
      "GrShaderCache",
      "Profile 1",
      "SingletonSocket",
    ]) {
      expect(existsSync(join(to, ...skipped.split("/"))), skipped).toBe(false);
    }
    expect(r.files).toBe(5);
    // From a path, which browser made it is not known: the first launch says.
    expect(readProfileKind("t")).toBeUndefined();
    expect(r.bytes).toBe(23);
  });

  it.skipIf(!posix)("writes dirs 0700 and files 0600", () => {
    const { to } = importProfile(src, { name: "t" });
    expect(mode(to)).toBe(0o700);
    expect(mode(join(to, "Default"))).toBe(0o700);
    expect(mode(join(to, "Default", "Cookies"))).toBe(0o600);
    expect(mode(join(browserHome(), "profiles"))).toBe(0o700);
  });

  it("does not follow symlinks inside the source", () => {
    const secret = join(work, "secret.txt");
    writeFileSync(secret, "secret");
    if (posix) symlinkSync(secret, join(src, "Default", "link"));
    const { to } = importProfile(src, { name: "t" });
    expect(existsSync(join(to, "Default", "link"))).toBe(false);
  });

  it.skipIf(!posix)("refuses a source browser that is running, unless forced", () => {
    symlinkSync("host-1234", join(src, "SingletonLock")); // dangling, as Chrome leaves it
    expect(() => importProfile(src, { name: "t" })).toThrow(/appears to be running/);
    expect(existsSync(profileDir("t"))).toBe(false);
    expect(importProfile(src, { name: "t", force: true }).files).toBeGreaterThan(0);
    expect(existsSync(join(profileDir("t"), "SingletonLock"))).toBe(false);
  });

  it("refuses a non-empty target unless forced, and force replaces it", () => {
    importProfile(src, { name: "t" });
    put(profileDir("t"), "stale.txt");
    expect(() => importProfile(src, { name: "t" })).toThrow(/already holds a profile/);
    importProfile(src, { name: "t", force: true });
    expect(existsSync(join(profileDir("t"), "stale.txt"))).toBe(false);
    expect(existsSync(join(profileDir("t"), "Default", "Cookies"))).toBe(true);
  });

  it("refuses to force over an overlapping source and target, and leaves the source intact", () => {
    const to = profileDir("t");
    put(to, "Local State", "mine");
    put(to, "Default/Cookies", "mine");
    put(to, "Default/Local State", "inner");
    // source IS the target
    expect(() => importProfile(to, { name: "t", force: true })).toThrow(/overlap/);
    // source lies inside the target
    expect(() => importProfile(join(to, "Default"), { name: "t", force: true })).toThrow(/overlap/);
    expect(readFileSync(join(to, "Default", "Cookies"), "utf8")).toBe("mine");
    // target lies inside the source
    const outer = browserHome();
    put(outer, "Local State", "outer");
    expect(() => importProfile(outer, { name: "t", force: true })).toThrow(/overlap/);
    expect(readFileSync(join(to, "Local State"), "utf8")).toBe("mine");
  });

  it("treats a Windows `lockfile` as a running browser, unless forced", () => {
    put(src, "lockfile", "");
    expect(() => importProfile(src, { name: "w", platform: "win32", localAppData: "" })).toThrow(/appears to be running/);
    expect(importProfile(src, { name: "w", platform: "win32", force: true }).files).toBeGreaterThan(0);
    // on other platforms a lockfile alone means nothing
    expect(importProfile(src, { name: "x", platform: "linux" }).files).toBeGreaterThan(0);
  });

  it("treats a source named like an Object prototype member as a path", () => {
    expect(() => importProfile("constructor", { name: "t", platform: "linux", homeDir: work })).toThrow(/not found/);
    expect(() => importProfile("__proto__", { name: "t", platform: "linux", homeDir: work })).toThrow(/not found/);
  });

  it("accepts an existing but empty target", () => {
    ensurePrivateDir(profileDir("t"));
    expect(importProfile(src, { name: "t" }).files).toBeGreaterThan(0);
  });

  it("uses the 'default' name when none is given", () => {
    importProfile(src, {});
    expect(existsSync(join(profileDir(), "Local State"))).toBe(true);
  });

  it("copes with a source that has no Default dir or no Local State", () => {
    const bare = join(work, "bare");
    put(bare, "Local State", "{}");
    expect(importProfile(bare, { name: "a" }).files).toBe(1);
    const bare2 = join(work, "bare2");
    put(bare2, "Default/Cookies", "c");
    expect(importProfile(bare2, { name: "b" }).files).toBe(1);
  });

  it("refuses a source that does not exist or holds no profile", () => {
    expect(() => importProfile(join(work, "nope"), { name: "t" })).toThrow(/not found/);
    mkdirSync(join(work, "empty"));
    expect(() => importProfile(join(work, "empty"), { name: "t" })).toThrow(/no Local State or Default/);
  });

  it("validates the target name", () => {
    expect(() => importProfile(src, { name: "../x" })).toThrow(UsageError);
  });

  describe("named browsers", () => {
    const cases = [
      ["darwin", "chrome", ["Library", "Application Support", "Google", "Chrome"]],
      ["darwin", "brave", ["Library", "Application Support", "BraveSoftware", "Brave-Browser"]],
      ["darwin", "chromium", ["Library", "Application Support", "Chromium"]],
      ["darwin", "edge", ["Library", "Application Support", "Microsoft Edge"]],
      ["linux", "chrome", [".config", "google-chrome"]],
      ["linux", "brave", [".config", "BraveSoftware", "Brave-Browser"]],
      ["linux", "chromium", [".config", "chromium"]],
      ["linux", "edge", [".config", "microsoft-edge"]],
    ] as const;
    it.each(cases)("%s %s resolves to its user-data dir", (platform, kind, parts) => {
      const home = join(work, "fakehome");
      put(home, `${parts.join("/")}/Local State`, "{}");
      const r = importProfile(kind, { name: "n", platform, homeDir: home });
      expect(r.from).toBe(join(home, ...parts));
      // Its logins are encrypted for that browser: the profile is that browser's from now on.
      expect(readProfileKind("n")).toBe(kind);
    });

    it.each([
      ["chrome", ["Google", "Chrome", "User Data"]],
      ["brave", ["BraveSoftware", "Brave-Browser", "User Data"]],
      ["chromium", ["Chromium", "User Data"]],
      ["edge", ["Microsoft", "Edge", "User Data"]],
    ] as const)("win32 %s resolves under LOCALAPPDATA", (kind, parts) => {
      const local = join(work, "local");
      put(local, `${parts.join("/")}/Local State`, "{}");
      const r = importProfile(kind, { name: "n", platform: "win32", localAppData: local });
      expect(r.from).toBe(join(local, ...parts));
    });

    it("refuses win32 without LOCALAPPDATA", () => {
      expect(() => importProfile("chrome", { name: "n", platform: "win32", localAppData: "" })).toThrow(/LOCALAPPDATA/);
    });

    it("refuses an unsupported platform", () => {
      expect(() => importProfile("chrome", { name: "n", platform: "freebsd" as NodeJS.Platform })).toThrow(/unsupported platform/);
    });
  });
});

describe("the profile's browser kind", () => {
  it("is what writeProfileKind recorded, and nothing for a profile without one or with junk", () => {
    expect(readProfileKind("k")).toBeUndefined();
    writeProfileKind("k", "edge");
    expect(readProfileKind("k")).toBe("edge");
    writeFileSync(profileKindFile("k"), "netscape\n");
    expect(readProfileKind("k")).toBeUndefined();
  });
});

describe("resetProfile", () => {
  it("deletes the dedicated profile and only that", () => {
    ensurePrivateDir(profileDir("a"));
    put(profileDir("a"), "x");
    ensurePrivateDir(profileDir("b"));
    resetProfile("a");
    expect(existsSync(profileDir("a"))).toBe(false);
    expect(existsSync(profileDir("b"))).toBe(true);
  });

  it("is a no-op for a profile that does not exist", () => {
    expect(() => resetProfile("ghost")).not.toThrow();
  });

  it("validates the name", () => {
    expect(() => resetProfile("..")).toThrow(UsageError);
  });

  it.skipIf(!posix)("refuses a profile dir that is a symlink out of the home, and leaves the target alone", () => {
    const outside = join(work, "outside");
    put(outside, "keep.txt");
    ensurePrivateDir(join(browserHome(), "profiles"));
    symlinkSync(outside, profileDir("evil"));
    expect(() => resetProfile("evil")).toThrow(/outside/);
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });
});

describe("assertInsideHome", () => {
  it("keeps the whole name of a missing top-level path", () => {
    expect(() => assertInsideHome("/zz-missing-top-level")).toThrow(/zz-missing-top-level/);
  });

  it("accepts paths under the home and refuses everything else", () => {
    mkdirSync(browserHome(), { recursive: true });
    expect(() => assertInsideHome(join(browserHome(), "profiles", "x"))).not.toThrow();
    expect(() => assertInsideHome(browserHome())).toThrow(/outside/);
    expect(() => assertInsideHome(work)).toThrow(/outside/);
    expect(() => assertInsideHome(`${browserHome()}-sibling/x`)).toThrow(/outside/);
    expect(() => assertInsideHome(join(browserHome(), "..", "x"))).toThrow(/outside/);
  });
});
