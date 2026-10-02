// Unpacked extensions for the browser webindex launches: an ad and tracker
// blocker such as uBlock Origin Lite, unzipped somewhere on disk.
//
// `<PREFIX>_BROWSER_EXTENSIONS` lists their directories (absolute, comma
// separated). They are passed only when webindex spawns the browser: one it was
// attached to, or one already running, keeps what it has. Branded Google Chrome
// ignores them from version 137; Brave blocks ads and trackers on its own.

import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { envName } from "../brand.js";
import { UsageError } from "../cli-kit.js";

/**
 * The extension directories `raw` (the variable's value) lists, each checked:
 * absolute, a directory, with a manifest.json. A UsageError says which is not.
 */
export function extensionDirs(raw: string | undefined): string[] {
  const name = envName("BROWSER_EXTENSIONS");
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((dir) => {
      if (!isAbsolute(dir)) throw new UsageError(`${name} takes absolute paths, not ${JSON.stringify(dir)}`);
      let isDir = false;
      try {
        isDir = statSync(dir).isDirectory();
      } catch {
        /* not there */
      }
      if (!isDir) throw new UsageError(`${name}: no such directory: ${dir}`);
      if (!existsSync(join(dir, "manifest.json"))) {
        throw new UsageError(`${name}: ${dir} has no manifest.json — name the unpacked extension's own folder, the one that holds manifest.json`);
      }
      return dir;
    });
}

/** The launch flags that load exactly these extensions, and no other. */
export function extensionArgs(dirs: string[]): string[] {
  if (dirs.length === 0) return [];
  const list = dirs.join(",");
  return [`--load-extension=${list}`, `--disable-extensions-except=${list}`];
}

/** What to say when the browser is a branded Google Chrome, which drops unpacked extensions. */
export const unpackedIgnoredNote = (): string =>
  `Google Chrome ≥ 137 ignores unpacked extensions — use Brave (built-in ad/tracker blocking: ${envName("BROWSER_KIND")}=brave), Chromium, Chrome for Testing or Edge`;
