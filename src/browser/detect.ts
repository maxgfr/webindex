// Which Chromium-family browser to drive.
//
// Only the binary is found here, never started: a separate instance with its
// own dedicated profile is launched elsewhere, from this path. Everything the
// answer depends on (platform, environment, the filesystem) is a parameter, so
// the per-OS tables are tested on whatever machine runs the suite.

import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { env } from "../brand.js";

export type BrowserKind = "chrome" | "brave" | "chromium" | "edge";

export interface BrowserBinary {
  kind: BrowserKind;
  path: string;
}

export interface DetectOptions {
  /** Tried first, before the usual order. */
  prefer?: BrowserKind;
  /** Reads `<PREFIX>_<suffix>`; defaults to the brand's own environment. */
  env?: (suffix: string) => string | undefined;
  /** The system environment (`PATH`, `ProgramFiles`, `LOCALAPPDATA`); defaults to `process.env`. */
  processEnv?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** The home directory `~/Applications` is looked up in. */
  home?: string;
  /** Whether a path is a launchable file. */
  exists?: (path: string) => boolean;
}

const ORDER: readonly BrowserKind[] = ["chrome", "brave", "chromium", "edge"];

const MAC_APPS: Record<BrowserKind, string> = {
  chrome: "Google Chrome",
  brave: "Brave Browser",
  chromium: "Chromium",
  edge: "Microsoft Edge",
};

const LINUX_NAMES: Record<BrowserKind, string[]> = {
  chrome: ["google-chrome", "google-chrome-stable"],
  brave: ["brave-browser"],
  chromium: ["chromium", "chromium-browser"],
  edge: ["microsoft-edge"],
};

const WINDOWS_PATHS: Record<BrowserKind, string> = {
  chrome: "Google\\Chrome\\Application\\chrome.exe",
  brave: "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  chromium: "Chromium\\Application\\chrome.exe",
  edge: "Microsoft\\Edge\\Application\\msedge.exe",
};

function isLaunchable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where `kind` would be installed on `platform`, most likely first. */
function candidates(kind: BrowserKind, platform: NodeJS.Platform, sys: Record<string, string | undefined>, home: string): string[] {
  if (platform === "darwin") {
    const app = MAC_APPS[kind];
    return ["/Applications", posix.join(home, "Applications")].map((dir) => posix.join(dir, `${app}.app`, "Contents", "MacOS", app));
  }
  if (platform === "win32") {
    const roots = [sys.ProgramFiles, sys["ProgramFiles(x86)"], sys.LOCALAPPDATA].filter((r): r is string => !!r);
    return roots.map((root) => win32.join(root, WINDOWS_PATHS[kind]));
  }
  const dirs = (sys.PATH ?? "").split(":").filter(Boolean);
  return LINUX_NAMES[kind].flatMap((name) => dirs.map((dir) => posix.join(dir, name)));
}

/** Which family a binary belongs to, by its file name alone (a directory called "knowledge" is not Edge). */
function kindOf(path: string): BrowserKind {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (name.includes("brave")) return "brave";
  if (name.includes("edge")) return "edge";
  if (name.includes("chromium")) return "chromium";
  return "chrome";
}

/**
 * The browser to launch: `<PREFIX>_BROWSER_BIN` if set, then `prefer`, then
 * Chrome, Brave, Chromium, Edge. `null` when none is installed.
 *
 * An explicit path that does not exist throws rather than falling through: a
 * user who named a binary and was handed a different one would drive the wrong
 * browser without knowing it.
 */
export function detectBrowserBinary(opts: DetectOptions = {}): BrowserBinary | null {
  const platform = opts.platform ?? process.platform;
  const sys = opts.processEnv ?? process.env;
  const exists = opts.exists ?? isLaunchable;
  const home = opts.home ?? homedir();

  const explicit = opts.env ? opts.env("BROWSER_BIN") : env("BROWSER_BIN");
  if (explicit) {
    const bare = !/[\\/]/.test(explicit);
    const options = bare
      ? (sys.PATH ?? "")
          .split(":")
          .filter(Boolean)
          .map((d) => posix.join(d, explicit))
      : [explicit];
    const found = options.find(exists);
    if (!found) throw new Error(`BROWSER_BIN points at "${explicit}", which is not an executable file`);
    return { kind: kindOf(found), path: found };
  }

  const kinds = opts.prefer ? [opts.prefer, ...ORDER.filter((k) => k !== opts.prefer)] : ORDER;
  for (const kind of kinds) {
    const path = candidates(kind, platform, sys, home).find(exists);
    if (path) return { kind, path };
  }
  return null;
}
