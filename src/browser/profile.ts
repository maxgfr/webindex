// The dedicated browser profile.
//
// The browser we drive never runs on the user's own profile: that one is theirs,
// is locked by their running browser, and every command would act inside it. It
// gets a profile of its own under the browser home, which holds logins and is
// therefore private (0700, 0600) and never under the temp dir. Signing in once
// by hand, or copying an existing session in once with importProfile, is what
// makes later runs authenticated.

import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { brand, env } from "../brand.js";
import { UsageError } from "../cli-kit.js";
import { type BrowserKind, isBrowserKind } from "./detect.js";

/**
 * Where the browser keeps its state: `<PREFIX>_BROWSER_DIR`, then the brand's
 * declared `browserDir`, then `~/.<name>/browser`.
 */
export function browserHome(): string {
  return env("BROWSER_DIR") ?? brand().browserDir ?? join(homedir(), `.${brand().name}`, "browser");
}

const PROFILE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

function checkName(name: string): void {
  if (!PROFILE_NAME.test(name) || name === "." || name === "..") {
    throw new UsageError(`invalid profile name ${JSON.stringify(name)} (1-64 of letters, digits, ".", "_", "-")`);
  }
}

/** `<home>/profiles/<name>`. Nothing is created: the browser does that on first launch. */
export function profileDir(name = "default"): string {
  checkName(name);
  return join(browserHome(), "profiles", name);
}

// --- the kind of browser a profile belongs to ----------------------------------
//
// A profile's logins are encrypted with a key of the browser that wrote them
// (the "Chrome Safe Storage" or "Brave Safe Storage" keychain item): another
// kind of browser opens it logged out, and may write over it. So the kind is
// recorded in the profile on its first launch, and another kind is refused.

/** `<profile>/.<name>-kind`: the kind of browser the profile belongs to. */
export function profileKindFile(name = "default"): string {
  return join(profileDir(name), `.${brand().name}-kind`);
}

/** The kind recorded in the profile; undefined for one never launched, or made before the kind was recorded. */
export function readProfileKind(name = "default"): BrowserKind | undefined {
  try {
    const kind = readFileSync(profileKindFile(name), "utf8").trim();
    return isBrowserKind(kind) ? kind : undefined;
  } catch {
    return undefined;
  }
}

/** Record the kind of browser the profile belongs to. The profile directory must exist. */
export function writeProfileKind(name: string, kind: BrowserKind): void {
  ensurePrivateDir(profileDir(name));
  writeFileSync(profileKindFile(name), `${kind}\n`, { mode: 0o600 });
}

/**
 * mkdir -p, every directory made 0700 and never through a link. One that
 * already exists must be ours, a real directory and not writable by others; one
 * of ours that others could read is made private, since what it holds is a login.
 */
export function ensurePrivateDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // inspected below
  }
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new Error(`${path} is a symbolic link`);
  if (!st.isDirectory()) throw new Error(`${path} is not a directory`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error(`${path} belongs to another user`);
  }
  if (process.platform === "win32") return; // no POSIX modes to hold to
  if (st.mode & 0o022) throw new Error(`${path} is writable by other users`);
  if (st.mode & 0o077) chmodSync(path, 0o700);
}

/** The path with every link that exists resolved; the part not created yet is kept as written. */
function realish(path: string): string {
  const p = resolve(path);
  try {
    return realpathSync(p);
  } catch {
    const parent = resolve(p, "..");
    return parent === p ? p : join(realish(parent), basename(p));
  }
}

/** Throws unless `path` is strictly inside the browser home, links resolved. */
export function assertInsideHome(path: string): void {
  const home = browserHome();
  if (!realish(path).startsWith(realish(home) + sep)) {
    throw new Error(`refusing to touch ${path}: outside the browser home ${home}`);
  }
}

/** Delete the dedicated profile (a fresh login is needed afterwards). */
export function resetProfile(name = "default"): void {
  const dir = profileDir(name);
  if (!existsSync(dir)) return;
  assertInsideHome(dir);
  rmSync(dir, { recursive: true, force: true });
}

export type ImportSource = "chrome" | "brave" | "chromium" | "edge" | (string & {});

export interface ImportOptions {
  /** Target profile; `default` when unset. */
  name?: string;
  /** Import even if the source browser looks to be running, and replace a profile already there. */
  force?: boolean;
  platform?: NodeJS.Platform;
  homeDir?: string;
  localAppData?: string;
}

export interface ImportResult {
  from: string;
  to: string;
  files: number;
  bytes: number;
}

const USER_DATA: Record<string, Record<string, string[]>> = {
  darwin: {
    chrome: ["Library", "Application Support", "Google", "Chrome"],
    brave: ["Library", "Application Support", "BraveSoftware", "Brave-Browser"],
    chromium: ["Library", "Application Support", "Chromium"],
    edge: ["Library", "Application Support", "Microsoft Edge"],
  },
  linux: {
    chrome: [".config", "google-chrome"],
    brave: [".config", "BraveSoftware", "Brave-Browser"],
    chromium: [".config", "chromium"],
    edge: [".config", "microsoft-edge"],
  },
  win32: {
    chrome: ["Google", "Chrome", "User Data"],
    brave: ["BraveSoftware", "Brave-Browser", "User Data"],
    chromium: ["Chromium", "User Data"],
    edge: ["Microsoft", "Edge", "User Data"],
  },
};

// Locks say "a browser is using this" and caches are rebuilt on their own;
// neither is worth copying and a stale lock would stop the copy from opening.
const SKIP_NAMES = new Set([
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
  "lockfile",
  "DevToolsActivePort",
  "Cache",
  "Code Cache",
  "GPUCache",
  "ShaderCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Crashpad",
]);
const SKIP_PATHS = new Set(["Service Worker/CacheStorage", "Service Worker/ScriptCache"]);

function userDataDir(source: string, opts: ImportOptions): string {
  const platform = opts.platform ?? process.platform;
  const table = USER_DATA[platform];
  if (!table) throw new Error(`unsupported platform "${platform}" for importing a browser profile`);
  const parts = Object.hasOwn(table, source) ? table[source] : undefined;
  if (!parts) return resolve(source);
  if (platform === "win32") {
    const local = opts.localAppData ?? process.env.LOCALAPPDATA;
    if (!local) throw new Error("LOCALAPPDATA is not set, so the browser profile cannot be located");
    return join(local, ...parts);
  }
  return join(opts.homeDir ?? homedir(), ...parts);
}

function copyTree(from: string, to: string, rel: string, tally: { files: number; bytes: number }): void {
  ensurePrivateDir(to);
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (SKIP_NAMES.has(entry.name) || SKIP_PATHS.has(childRel)) continue;
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(src, dst, childRel, tally);
    } else if (entry.isFile()) {
      copyFileSync(src, dst);
      chmodSync(dst, 0o600);
      tally.files++;
      tally.bytes += statSync(dst).size;
    } // links and sockets are never followed or copied
  }
}

/**
 * Copy an existing browser's session (cookies, local storage, preferences) into
 * the dedicated profile, once. `source` is `chrome`, `brave`, `chromium`,
 * `edge`, or the path of a user-data directory.
 *
 * Only `Local State` and the `Default` profile are taken, without locks or
 * caches. A source that looks to be running (its `SingletonLock` exists) is
 * refused: its files are mid-write and its cookies are encrypted with a key the
 * running process holds. A profile already at the target is refused too, unless
 * `force`, which replaces it.
 */
export function importProfile(source: ImportSource, opts: ImportOptions = {}): ImportResult {
  const to = profileDir(opts.name ?? "default");
  const from = userDataDir(source, opts);

  if (!existsSync(from)) throw new Error(`browser profile not found at ${from}`);
  const hasState = existsSync(join(from, "Local State"));
  const hasDefault = existsSync(join(from, "Default"));
  if (!hasState && !hasDefault) throw new Error(`${from} has no Local State or Default profile to import`);
  // Chrome leaves a SingletonLock link (dangling, so existsSync would miss it); on Windows it holds `lockfile`.
  const lockNames = (opts.platform ?? process.platform) === "win32" ? ["SingletonLock", "lockfile"] : ["SingletonLock"];
  const locked = lockNames.some((n) => {
    try {
      lstatSync(join(from, n));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return false;
    }
  });
  if (locked && !opts.force) {
    throw new Error(`the browser using ${from} appears to be running: close it, or pass force to import anyway`);
  }

  if (existsSync(to) && readdirSync(to).length > 0) {
    if (!opts.force) throw new Error(`${to} already holds a profile: pass force to replace it`);
    // Replacing deletes the target first: were the source in it, it would go too.
    const a = realish(from);
    const b = realish(to);
    if (a === b || a.startsWith(b + sep) || b.startsWith(a + sep)) {
      throw new Error(`${from} and ${to} overlap: refusing to replace the profile with itself`);
    }
    assertInsideHome(to);
    rmSync(to, { recursive: true, force: true });
  }

  ensurePrivateDir(join(browserHome(), "profiles"));
  const tally = { files: 0, bytes: 0 };
  ensurePrivateDir(to);
  if (hasState) {
    copyFileSync(join(from, "Local State"), join(to, "Local State"));
    chmodSync(join(to, "Local State"), 0o600);
    tally.files++;
    tally.bytes += statSync(join(to, "Local State")).size;
  }
  if (hasDefault) copyTree(join(from, "Default"), join(to, "Default"), "", tally);
  // Imported from a named browser: its logins are that browser's, and so is the profile now.
  const kind = String(source);
  if (Object.hasOwn(USER_DATA[opts.platform ?? process.platform] ?? {}, kind) && isBrowserKind(kind)) writeProfileKind(opts.name ?? "default", kind);
  return { from, to, ...tally };
}
