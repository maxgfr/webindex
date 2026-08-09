import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { brand, env, envInt } from "./brand.js";
import { have, sh, shAsync } from "./exec.js";
import { slugify } from "./text.js";

// Naming a repository, and getting a working tree for it.
//
// Two consumers had this file, under the same names, and they had DIVERGED:
// one parsed any URL scheme (ssh://, git://, userinfo, ports), the other stopped
// at https. Same function, same purpose, different answers — which is what a
// fork does when nobody is watching, and neither ratchet could see it because
// the engine did not export a `resolveRepo` for them to shadow.

export interface RepoRef {
  /** Exactly what the caller passed. */
  raw: string;
  /** `github.com`, `local` for a directory, `generic` for unrecognisable text. */
  host: string;
  /** Owner, keeping GitLab subgroups intact ("group/subgroup"). */
  owner?: string;
  repo?: string;
  cloneUrl?: string;
  webUrl?: string;
  isLocal: boolean;
  /** Stable, filesystem-safe identity — the on-disk cache key. */
  slug: string;
}

/**
 * Where clones live: `<PREFIX>_REPO_DIR`, then the brand's declared `repoDir`,
 * then `<tmpdir>/<name>/repos`.
 *
 * The brand tier is what lets a consumer that already had a clone cache adopt
 * this module at all. Without it, adopting moves every checkout: the clones the
 * tool made yesterday are orphaned under the old path and re-fetched under the
 * new one, and the cache commands still reading the old path report an empty
 * cache that is not empty.
 */
export function repoCacheRoot(): string {
  return env("REPO_DIR") ?? brand().repoDir ?? join(tmpdir(), brand().name, "repos");
}

const cloneTimeoutMs = () => envInt("GIT_CLONE_TIMEOUT_MS", 300_000, 1000);
const fetchTimeoutMs = () => envInt("GIT_FETCH_TIMEOUT_MS", 120_000, 1000);
// Unshallowing a large repository is a full history transfer, so it gets its own
// (much larger) ceiling rather than the per-fetch one.
const historyTimeoutMs = () => envInt("GIT_HISTORY_TIMEOUT_MS", 300_000, 1000);

/**
 * Parse any repository identifier into a `RepoRef`. Accepts a local directory,
 * `https://host/owner/repo(.git)`, `ssh://`/`git://` URLs, `git@host:owner/repo`,
 * `host/owner/repo`, and the bare `owner/repo` shorthand (which means GitHub).
 *
 * An unrecognisable seed becomes a `generic` ref with NO synthesised clone URL.
 * That matters: minting `https://github.com/<free text>.git` would turn "some
 * words the user typed" into a plausible-looking URL that 404s later, far from
 * where the mistake was made.
 */
export function resolveRepo(raw: string): RepoRef {
  const trimmed = raw.trim();

  // A local directory wins, so a caller can point at a checkout they already
  // have and stay offline. Guarded on non-empty: `resolve("")` is the current
  // working directory, and an empty seed must not silently mean "here".
  if (trimmed) {
    const asPath = resolve(trimmed);
    if (existsSync(asPath) && statSync(asPath).isDirectory()) {
      return { raw: trimmed, host: "local", isLocal: true, slug: `local-${slugify(`${basename(asPath)}-${asPath}`)}` };
    }
  }

  // `file:///path` is a real git remote — `git clone file://…` works and is how
  // you clone locally without the in-place semantics above. It has no host, so
  // the URL pattern below cannot match it, and it is NOT `isLocal`: a bare path
  // means "use this tree", a file:// URL means "clone from this tree".
  const file = /^file:\/\/(\/.*)$/.exec(trimmed);
  if (file) {
    const p = file[1]!.replace(/\.git$/, "").replace(/\/+$/, "");
    return {
      raw: trimmed,
      host: "file",
      ...(basename(p) ? { repo: basename(p) } : {}),
      cloneUrl: trimmed,
      isLocal: false,
      slug: `file-${slugify(p)}`,
    };
  }

  let host: string;
  let path: string; // owner(/subgroups)/repo, no host, no .git

  const scp = /^git@([^:]+):(.+)$/.exec(trimmed); // git@github.com:owner/repo.git
  // Any URL scheme, case-insensitive, dropping userinfo and port.
  const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
  const hostPath = /^([a-z0-9.-]+\.[a-z]{2,})\/(.+)$/i.exec(trimmed);

  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else if (url) {
    host = url[1]!;
    path = url[2]!;
  } else if (hostPath) {
    host = hostPath[1]!;
    path = hostPath[2]!;
  } else if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    host = "github.com";
    path = trimmed;
  } else {
    return { raw: trimmed, host: "generic", isLocal: false, slug: slugify(trimmed) || "seed" };
  }

  host = host.toLowerCase();
  path = path.replace(/\.git$/, "").replace(/\/+$/, "");
  const segments = path.split("/").filter(Boolean);
  const repo = segments.length ? segments[segments.length - 1] : undefined;
  const owner = segments.length > 1 ? segments.slice(0, -1).join("/") : undefined;

  // Trailing slash stripped BEFORE the .git suffix, so a URL pasted as
  // ".../repo/" yields ".../repo.git" rather than the un-cloneable ".../repo/.git".
  const base = /^https?:\/\//i.test(trimmed) || scp ? trimmed.replace(/\/+$/, "") : `https://${host}/${path}.git`;

  return {
    raw: trimmed,
    host,
    ...(owner ? { owner } : {}),
    ...(repo ? { repo } : {}),
    cloneUrl: base.endsWith(".git") ? base : `${base}.git`,
    webUrl: `https://${host}/${path}`,
    isLocal: false,
    slug: slugify(`${host}/${path}`),
  };
}

/**
 * A working tree for `ref`, cloned if needed, returned as an absolute path.
 *
 * Shallow and blobless by default (`--depth 1 --filter=blob:none`): reading a
 * repository's current state does not need its history or every past version of
 * every file, and on a large project that is the difference between seconds and
 * minutes. `ensureHistoryDepth` deepens it when a caller genuinely needs history.
 *
 * Never throws for a reason the caller cannot act on — a missing `git` says so
 * rather than reporting a clone failure.
 */
export async function ensureClone(ref: RepoRef, opts: { refresh?: boolean; branch?: string } = {}): Promise<string> {
  if (ref.isLocal) return resolve(ref.raw);
  if (!ref.cloneUrl) throw new Error(`"${ref.raw}" does not name a repository that can be cloned`);
  if (!have("git")) throw new Error(`git is not installed or not on PATH — cannot clone ${ref.cloneUrl}`);

  const dir = join(repoCacheRoot(), ref.slug);
  const cloned = existsSync(join(dir, ".git"));
  if (cloned && !opts.refresh) return dir;

  if (cloned && opts.refresh) {
    await shAsync("git", ["-C", dir, "fetch", "--depth", "1", "origin"], { timeoutMs: fetchTimeoutMs() });
    await shAsync("git", ["-C", dir, "reset", "--hard", "FETCH_HEAD"], { timeoutMs: fetchTimeoutMs() });
    return dir;
  }

  mkdirSync(repoCacheRoot(), { recursive: true });
  const args = ["clone", "--depth", "1", "--filter=blob:none", ...(opts.branch ? ["--branch", opts.branch] : []), ref.cloneUrl, dir];
  const first = await shAsync("git", args, { timeoutMs: cloneTimeoutMs() });

  if (!first.ok) {
    // A failed clone can leave a partial, non-empty directory, and git refuses
    // to clone into one — so the retry would fail for the wrong reason and the
    // error would name the wrong problem.
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (e) {
        throw new Error(`could not remove the partial clone at ${dir} before retrying: ${(e as Error).message} — delete it and re-run`);
      }
    }
    // Some servers reject partial-clone filters outright. Retry without.
    const retry = await shAsync("git", ["clone", "--depth", "1", ...(opts.branch ? ["--branch", opts.branch] : []), ref.cloneUrl, dir], {
      timeoutMs: cloneTimeoutMs(),
    });
    if (!retry.ok) {
      // Both attempts can fail differently. Report each, labelled, instead of
      // whichever stderr happened to be non-empty.
      throw new Error(
        [
          `git clone failed for ${ref.cloneUrl}`,
          `  attempt 1 (--filter=blob:none): ${first.stderr.trim() || `exit ${first.status}`}`,
          `  attempt 2 (no filter):          ${retry.stderr.trim() || `exit ${retry.status}`}`,
        ].join("\n"),
      );
    }
  }
  if (!existsSync(dir) || readdirSync(dir).length === 0) throw new Error(`clone produced an empty tree at ${dir}`);
  return dir;
}

// One verdict per working tree, per process: the probe and the fetch behind it
// are expensive, and a `drill` that asks three times must not re-run them.
const deepened = new Map<string, { ok: boolean; note?: string }>();

/** Test seam: forget which working trees were deepened. */
export function resetHistoryDepthCache(): void {
  deepened.clear();
}

/**
 * Make a clone usable for history-walking commands (`git log -S/-G`, blame).
 *
 * There are TWO things to undo, and missing either one leaves the caller with a
 * repository that answers slowly and wrongly:
 *
 *   --depth 1          no history to walk
 *   --filter=blob:none no blob CONTENT to diff
 *
 * `ensureClone` above sets both. An earlier version of this function only looked
 * for `.git/shallow` and only passed `--unshallow`, which produced the worst
 * case of all: a full commit graph over a blobless object database, where every
 * pickaxe comparison triggers a per-blob promisor fetch over the network. So the
 * filter is cleared and `--refetch` re-pulls the objects in one transfer.
 *
 * Shallowness is read from `git rev-parse --is-shallow-repository` rather than
 * from the presence of `.git/shallow`, which is git's private bookkeeping and not
 * a contract.
 *
 * Returns a note rather than throwing when it cannot: a shallow clone still
 * answers every question about the CURRENT state, so failing the whole call
 * because history is unavailable would refuse the answers that are available.
 */
export async function ensureHistoryDepth(dir: string, opts: { deepen?: number } = {}): Promise<{ ok: boolean; note?: string }> {
  const cached = deepened.get(dir);
  if (cached) return cached;
  const out = await computeHistoryDepth(dir, opts);
  deepened.set(dir, out);
  return out;
}

async function computeHistoryDepth(dir: string, opts: { deepen?: number }): Promise<{ ok: boolean; note?: string }> {
  if (!have("git")) return { ok: false, note: "git is not installed — no commit history available." };
  const probe = await shAsync("git", ["-C", dir, "rev-parse", "--is-shallow-repository"], { timeoutMs: 10_000 });
  if (!probe.ok) return { ok: false, note: "Not a git working tree — no commit history available." };
  // `git config <key>` exits 1 when the key is simply absent. That is "no filter
  // configured", not a failure, which is why this reads `ok` rather than status.
  const filter = await shAsync("git", ["-C", dir, "config", "remote.origin.partialclonefilter"], { timeoutMs: 10_000 });
  const shallow = probe.stdout.trim() === "true";
  const partial = filter.ok && filter.stdout.trim() !== "";
  if (!shallow && !partial) return { ok: true };

  if (partial) await shAsync("git", ["-C", dir, "config", "remote.origin.partialclonefilter", ""], { timeoutMs: 10_000 });
  const full = await shAsync("git", ["-C", dir, "fetch", "--quiet", ...(partial ? ["--refetch"] : []), ...(shallow ? ["--unshallow"] : []), "origin"], {
    timeoutMs: historyTimeoutMs(),
  });
  if (full.ok) return { ok: true };

  // A partial refetch has no cheaper fallback — there is no "half the blobs"
  // option — so only the purely-shallow case is worth a second, bounded attempt.
  if (shallow && !partial) {
    const deepen = await shAsync("git", ["-C", dir, "fetch", "--quiet", `--deepen=${opts.deepen ?? 500}`, "origin"], { timeoutMs: fetchTimeoutMs() });
    return deepen.ok
      ? { ok: true, note: `History deepened to ~${opts.deepen ?? 500} commits (full unshallow failed); older changes may be missing.` }
      : { ok: false, note: "Shallow clone could not be deepened (offline?); history is limited to the latest commit." };
  }
  return { ok: false, note: "Could not fetch full history (offline, or the repo is too large); history results may be incomplete." };
}

/** The commit a working tree is on, or undefined when it is not a repo. */
export function headCommit(dir: string): string | undefined {
  const r = sh("git", ["-C", dir, "rev-parse", "HEAD"], { timeoutMs: 10_000 });
  return r.ok ? r.stdout.trim() || undefined : undefined;
}

/** Its `origin` remote, or undefined when it has none. */
export function originUrl(dir: string): string | undefined {
  const r = sh("git", ["-C", dir, "remote", "get-url", "origin"], { timeoutMs: 10_000 });
  return r.ok ? r.stdout.trim() || undefined : undefined;
}

// git's default abbreviation is 7 characters. Below that, a shared prefix is a
// coincidence rather than an identity, so a 1-character "SHA" must not match
// every commit in the repository.
const MIN_ABBREV = 7;

/**
 * Two commits are the same, tolerating one being absent — and tolerating either
 * being an ABBREVIATION of the other.
 *
 * The abbreviation half is load-bearing, not politeness. A stored artifact
 * records the commit it was built against, and git abbreviates a SHA almost
 * everywhere it prints one, so strict equality answers "different" to a full SHA
 * compared against its own 7-character prefix. Downstream, that means every
 * stored citation silently stops being re-validated against the working tree —
 * a check that reports success while checking nothing.
 */
export function sameCommit(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= MIN_ABBREV && long.startsWith(short);
}
