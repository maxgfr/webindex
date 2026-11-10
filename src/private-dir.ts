import { chmodSync, lstatSync, mkdirSync, type Stats } from "node:fs";
import { dirname } from "node:path";
import { isNoWrite } from "./no-write.js";

// A directory of ours under the system temp dir: `<tmp>/<brand>-<uid>/<name>`.
//
// The temp dir is shared, and that path is one any local user can predict and
// create first. So before anything is read from it or written to it, the
// directory and the per-user one above it must each be a real directory — no
// symbolic link — that belongs to the caller and that no other user may write.
// Whoever can write either one can plant a file at the path we compute, and it
// is served as ours: a cached page, or a clone of a repository. Nobody else can
// move a directory of ours out of the sticky temp dir, or write inside one of
// ours once it is private, so what is checked here stays true.
//
// Internal on purpose: the fetch cache and the clone cache share the rule, and
// a consumer names its own directories.

/**
 * Open `dir` (`<tmp>/<brand>-<uid>/<name>`), creating it and its parent when
 * `create` is set, and say why it may not be used when it may not.
 *
 * Created one level at a time, 0700 whatever the umask (mkdir only ever takes
 * bits away from the mode it is given), and never through a link: `mkdir -p`
 * follows a planted `<brand>-<uid>` symlink and makes `<name>` wherever it
 * points. One of the caller's own that others may only READ — what an earlier
 * engine made with the umask's mode — is made private rather than refused.
 *
 * `{}` (neither field) means it does not exist yet and `create` was not set.
 * Check on every use rather than once per process: a tmp sweeper can remove the
 * directory under a long-lived server, and whoever creates it next must not
 * inherit the verdict.
 */
export function openPrivateTmpDir(dir: string, create: boolean): { dir?: string; refused?: string } {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (create) mkdirSync(dirname(dirname(dir)), { recursive: true }); // the temp dir itself
  for (const p of [dirname(dir), dir]) {
    if (create) mkdirPrivate(p);
    let st: Stats;
    try {
      st = lstatSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; // nothing there yet
      return { refused: `${p} cannot be inspected (${(e as Error).message})` };
    }
    if (st.isSymbolicLink()) return { refused: `${p} is a symbolic link` };
    if (!st.isDirectory()) return { refused: `${p} is not a directory` };
    if (st.uid !== uid) return { refused: `${p} belongs to another user` };
    if (st.mode & 0o022) return { refused: `${p} is writable by other users` };
    if (st.mode & 0o077 && !isNoWrite()) {
      try {
        chmodSync(p, 0o700);
      } catch {
        /* still writable by nobody else, so still usable */
      }
    }
  }
  return { dir };
}

/** mkdir, private, and never through whatever already has the name. */
function mkdirPrivate(p: string): void {
  try {
    mkdirSync(p, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}
