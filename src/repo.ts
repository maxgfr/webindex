import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { brand, env, envInt } from "./brand.js";
import { have, sh, shAsync } from "./exec.js";
import type { ForgeKind } from "./forge.js";
import { hostForgeKind, normalizeForgeHost } from "./forge-host.js";
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
 * A URL copied from a browser names its repository, not the page within it.
 * `opts.kind` says which forge a self-hosted host runs, where its name does not.
 * `opts.local: false` reads the string as a remote only, without asking the
 * filesystem whether it names a directory — for a caller (a server others can
 * reach) whose answer must not say what exists on the machine.
 *
 * An unrecognisable seed becomes a `generic` ref with NO synthesised clone URL.
 * That matters: minting `https://github.com/<free text>.git` would turn "some
 * words the user typed" into a plausible-looking URL that 404s later, far from
 * where the mistake was made.
 */
export function resolveRepo(raw: string, opts: { kind?: ForgeKind; local?: boolean } = {}): RepoRef {
  const trimmed = raw.trim();

  // A local directory wins, so a caller can point at a checkout they already
  // have and stay offline. Guarded on non-empty: `resolve("")` is the current
  // working directory, and an empty seed must not silently mean "here".
  if (trimmed && opts.local !== false) {
    const asPath = resolve(trimmed);
    if (existsSync(asPath) && statSync(asPath).isDirectory()) {
      return { raw: trimmed, host: "local", isLocal: true, slug: `local-${slugify(`${basename(asPath)}-${asPath}`)}` };
    }
  }

  // `file:///path` is a real git remote — `git clone file://…` works and is how
  // you clone locally without the in-place semantics above. It has no host, so
  // the URL pattern below cannot match it, and it is NOT `isLocal`: a bare path
  // means "use this tree", a file:// URL means "clone from this tree".
  const p = filePath(trimmed);
  if (p !== undefined) {
    return {
      raw: trimmed,
      host: "file",
      ...(basename(p) ? { repo: basename(p) } : {}),
      cloneUrl: trimmed,
      isLocal: false,
      slug: `file-${repoSlug(p)}`,
    };
  }

  const generic = (): RepoRef => ({ raw: trimmed, host: "generic", isLocal: false, slug: slugify(trimmed) || "seed" });

  // How the clone URL is rebuilt: an http(s) or ssh remote keeps its transport
  // (userinfo and port included — a private repository may be reachable no
  // other way), the scp form keeps its user, and anything else becomes https.
  let transport:
    | { kind: "scp"; user: string; absolute: boolean }
    | { kind: "url"; scheme: "http" | "https" | "ssh"; userinfo?: string; port?: string }
    | { kind: "https" };
  let host: string;
  let rest: string; // everything after the host, not yet normalised

  // `user@host:path` — git's scp-like syntax, for any user (not only `git`).
  const scp = /^([\w.-]+)@([^:/]+):(.+)$/.exec(trimmed);
  // Any URL scheme, case-insensitive: scheme, userinfo, host, port, path.
  const url = /^([a-z][a-z0-9+.-]*):\/\/(?:([^@/]+)@)?([^/:?#]+)(?::(\d+))?\/(.+)$/i.exec(trimmed);
  const hostPath = /^([a-z0-9.-]+\.[a-z]{2,})\/(.+)$/i.exec(trimmed);

  if (scp) {
    // An absolute path (`git@host:/srv/git/p.git`) is not the same path read
    // from the ssh user's home (`git@host:srv/git/p.git`): the "/" is kept.
    transport = { kind: "scp", user: scp[1]!, absolute: scp[3]!.startsWith("/") };
    host = scp[2]!;
    rest = scp[3]!;
  } else if (url) {
    const scheme = url[1]!.toLowerCase();
    transport = /^(?:https?|ssh|git\+ssh|ssh\+git)$/.test(scheme)
      ? { kind: "url", scheme: scheme.startsWith("http") ? (scheme as "http" | "https") : "ssh", userinfo: url[2], port: url[4] }
      : { kind: "https" };
    host = url[3]!;
    rest = url[5]!;
  } else if (hostPath) {
    transport = { kind: "https" };
    host = hostPath[1]!;
    rest = hostPath[2]!;
  } else if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    transport = { kind: "https" };
    host = "github.com";
    rest = trimmed;
  } else {
    return generic();
  }

  // git reads a user or host that begins with "-" as an OPTION to ssh
  // (`-oProxyCommand=…`), which is command execution. git itself refuses a
  // host like that; a user is refused here, before a clone URL can carry it.
  const user = transport.kind === "scp" ? transport.user : transport.kind === "url" ? transport.userinfo : undefined;
  if (host.startsWith("-") || user?.startsWith("-")) return generic();

  host = normalizeForgeHost(host);
  const segments = repoSegments(host, rest, opts.kind ?? hostForgeKind(host));
  if (!segments) return generic();
  const path = segments.join("/");
  const repo = segments[segments.length - 1];
  const owner = segments.length > 1 ? segments.slice(0, -1).join("/") : undefined;

  const cloneUrl =
    transport.kind === "scp"
      ? `${transport.user}@${host}:${transport.absolute ? "/" : ""}${path}.git`
      : transport.kind === "url"
        ? `${transport.scheme}://${transport.userinfo ? `${transport.userinfo}@` : ""}${host}${transport.port ? `:${transport.port}` : ""}/${path}.git`
        : `https://${host}/${path}.git`;

  return {
    raw: trimmed,
    host,
    ...(owner ? { owner } : {}),
    ...(repo ? { repo } : {}),
    cloneUrl,
    webUrl: `https://${host}/${path}`,
    isLocal: false,
    slug: repoSlug(`${host}/${path}`),
  };
}

/** The repository path of a `file:///path(.git)` remote, or undefined for anything else. */
function filePath(url: string): string | undefined {
  const file = /^file:\/\/(\/.*)$/.exec(url);
  return file ? trimRuns(file[1]!.replace(/\.git$/, ""), "/", false) : undefined;
}

// `s` without `ch` at either end. By hand: /^-+|-+$/g and /\/+$/ retry at every
// character of a run that does not end the string, so a prompt-supplied name
// with a long run of dashes or slashes took seconds (quadratic).
function trimRuns(s: string, ch: string, start = true): string {
  const code = ch.charCodeAt(0);
  let a = 0;
  let b = s.length;
  while (start && a < b && s.charCodeAt(a) === code) a++;
  while (b > a && s.charCodeAt(b - 1) === code) b--;
  return s.slice(a, b);
}

// A key as slugify spells it before cutting or hashing anything: every run of
// characters it does not keep becomes one "-".
const fold = (k: string): string => trimRuns(k.replace(/[^a-z0-9._-]+/g, "-"), "-");
const sha256Hex = (k: string): string => createHash("sha256").update(k).digest("hex");

/**
 * The cache key for a repository path — one directory per repository.
 *
 * `slugify` folds "/" and "-" into the same "-", strips a `.git`, and cuts or
 * hashes what it cannot render, so two repositories — one of them possibly a
 * squatter's — could get one slug, and the second was handed the first one's
 * checkout. So the slugs come in two spaces that cannot meet. A key slugify
 * renders exactly (nothing folded but "/", nothing cut, hashed or stripped)
 * keeps its readable slug, which never holds "--": such a key has no "-", and a
 * run of "/" folds to one. Every other key is a readable prefix, "--", and a
 * hash of its exact spelling. The 1.21.0 suffix was one "-" and eight hex
 * characters, which a readable path ending in those eight could spell exactly.
 */
function repoSlug(key: string): string {
  const k = key.toLowerCase();
  const folded = fold(k);
  if (/^[a-z0-9._/]+$/.test(k) && slugify(k) === folded) return folded;
  return `${folded.slice(0, 105).replace(/-+$/, "") || "repo"}--${sha256Hex(k).slice(0, 12)}`;
}

/**
 * The slugs earlier releases stored a clone of `ref` under, where they differ
 * from its own — so an existing checkout is found again rather than orphaned and
 * re-fetched: plain `slugify` before 1.21.0, then 1.21.0's eight-hex suffix.
 * One is adopted only when its origin says it is this repository.
 */
function legacySlugs(ref: RepoRef): string[] {
  const p = ref.cloneUrl ? filePath(ref.cloneUrl) : undefined;
  const key = ref.host === "file" ? p : ref.repo ? `${ref.host}/${[ref.owner, ref.repo].filter(Boolean).join("/")}` : undefined;
  if (key === undefined) return [];
  const k = key.toLowerCase();
  const before = slugify(k);
  const v121 = /^[a-z0-9._/]+$/.test(k) || before !== fold(k) ? before : `${slugify(k, { max: 111 })}-${sha256Hex(k).slice(0, 8)}`;
  const prefix = ref.host === "file" ? "file-" : "";
  return [...new Set([before, v121])].map((s) => `${prefix}${s}`).filter((s) => s !== ref.slug);
}

// A dot segment, spelled as a URL parser will read it: `%2e` is a dot to WHATWG
// URL, so `/repos/%2e%2e/%2e%2e/user` resolves to `/user` just as `..` does.
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

// Hosts whose repositories are exactly `owner/repo`, where anything after that
// is a page INSIDE the repository — `/tree/main/src`, `/issues/12`, `/src/branch/x`.
const TWO_SEGMENT_HOSTS: ReadonlySet<string> = new Set(["bitbucket.org"]);

/**
 * The repository's own path segments out of whatever followed the host: no
 * query or fragment, no page within the repository, no `.git`. Undefined when a
 * segment is `.` or `..`, which no forge allows and which a URL parser would
 * resolve into a different endpoint altogether.
 */
function repoSegments(host: string, rest: string, kind: ForgeKind | undefined): string[] | undefined {
  let segments = rest
    .replace(/[?#].*$/s, "")
    .split("/")
    .filter(Boolean);
  if (segments.some((s) => DOT_SEGMENT.test(s))) return undefined;
  // GitLab ends a project path at `/-/` — subgroups nest, so a segment count
  // cannot tell where it stops, but the separator is reserved everywhere.
  const dash = segments.indexOf("-");
  if (dash >= 0) segments = segments.slice(0, dash);
  if (kind === "github" || kind === "gitea" || TWO_SEGMENT_HOSTS.has(host)) segments = segments.slice(0, 2);
  const last = segments.length - 1;
  if (last >= 0) segments[last] = segments[last]!.replace(/\.git$/i, "");
  return segments.filter(Boolean).length ? segments.filter(Boolean) : undefined;
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
 * rather than reporting a clone failure, and a refresh that could not reach the
 * remote says so rather than returning the old tree as if it were fresh.
 *
 * Each `branch` gets its own directory beside the default one: the cache is
 * keyed by what was cloned, so asking for `v2` never answers with `main`.
 */
export async function ensureClone(ref: RepoRef, opts: { refresh?: boolean; branch?: string } = {}): Promise<string> {
  if (ref.isLocal) return resolve(ref.raw);
  if (!ref.cloneUrl) throw new Error(`"${ref.raw}" does not name a repository that can be cloned`);
  if (!have("git")) throw new Error(`git is not installed or not on PATH — cannot clone ${ref.cloneUrl}`);
  const branch = opts.branch?.trim() || undefined;
  // git reads an argument that begins with "-" as an option, and no ref name
  // may begin with one — so such a "branch" is refused before it reaches git.
  if (branch?.startsWith("-")) throw new Error(`"${branch}" is not a branch name`);

  const dir = join(repoCacheRoot(), branch ? `${ref.slug}@${branchSlug(branch)}` : ref.slug);
  // One clone per directory at a time, in this process: concurrent callers all
  // saw "not cloned yet", each ran `git clone` into the same directory, and the
  // losers deleted the winner's half-written tree before retrying.
  const pending = inflight.get(dir);
  if (pending && !opts.refresh) {
    // A plain caller wants the tree, fresh or not. Joining a refresh that could
    // not reach the remote, it still gets the cached tree that refresh left
    // unchanged — what it would have got a moment before, or after.
    return pending.catch((e: unknown) => {
      const tree = (e as { cachedTree?: unknown } | undefined)?.cachedTree;
      return typeof tree === "string" ? tree : Promise.reject(e);
    });
  }
  // A refresh must fetch after it was asked for: the call in flight may have
  // read the remote before the commit this caller wants, or not fetched at all.
  // So it runs once that call settles, never in place of it.
  const run = () => obtainClone(ref, dir, { refresh: opts.refresh, branch });
  const work = (pending ? pending.then(run, run) : run()).finally(() => {
    if (inflight.get(dir) === work) inflight.delete(dir);
  });
  inflight.set(dir, work);
  return work;
}

const inflight = new Map<string, Promise<string>>();

// A branch name is case-sensitive and may hold "/", so its slug always carries
// a hash of the exact name: `Feature/x`, `feature/x` and `feature-x` are three.
function branchSlug(branch: string): string {
  return `${slugify(branch, { max: 40, fallback: "branch" })}-${createHash("sha256").update(branch).digest("hex").slice(0, 8)}`;
}

async function obtainClone(ref: RepoRef, dir: string, opts: { refresh?: boolean; branch?: string }): Promise<string> {
  let target = dir;
  if (!existsSync(join(dir, ".git")) && !opts.branch) {
    // A clone made under a slug this repository had before is still this
    // repository's — when its origin says so. One whose origin names another
    // repository is exactly the collision the new slug exists to end.
    for (const old of legacySlugs(ref)) {
      const legacy = join(repoCacheRoot(), old);
      const origin = existsSync(join(legacy, ".git")) ? originUrl(legacy) : undefined;
      if (origin && resolveRepo(origin).slug === ref.slug) {
        target = legacy;
        break;
      }
    }
  }
  if (existsSync(join(target, ".git"))) return opts.refresh ? refreshClone(ref, target, opts.branch) : target;
  return freshClone(ref, dir, opts.branch);
}

async function refreshClone(ref: RepoRef, dir: string, branch: string | undefined): Promise<string> {
  // Whatever it was deepened to, the history verdict is about to be stale.
  deepened.delete(dir);
  // `--depth 1` only on a clone that is still shallow: on one ensureHistoryDepth
  // unshallowed, it cut the history back to a single commit while the verdict
  // above still said the full history was there.
  const probe = await shAsync("git", ["-C", dir, "rev-parse", "--is-shallow-repository"], { timeoutMs: 10_000 });
  const shallow = probe.stdout.trim() !== "false";
  // The ref is named rather than left to the configured refspec, so FETCH_HEAD
  // is unambiguously the one this directory holds: its branch, or the remote's HEAD.
  const fetched = await shAsync("git", ["-C", dir, "fetch", "--quiet", ...(shallow ? ["--depth", "1"] : []), "origin", branch ?? "HEAD"], {
    timeoutMs: fetchTimeoutMs(),
  });
  if (!fetched.ok) {
    // `cachedTree` is for a caller that joined this refresh without asking for one.
    throw Object.assign(
      new Error(`refresh failed for ${ref.cloneUrl}: ${fetched.stderr.trim() || `exit ${fetched.status}`} (the cached tree at ${dir} is unchanged)`),
      { cachedTree: dir },
    );
  }
  const reset = await shAsync("git", ["-C", dir, "reset", "--quiet", "--hard", "FETCH_HEAD"], { timeoutMs: fetchTimeoutMs() });
  if (!reset.ok) throw new Error(`refresh of ${dir} fetched ${ref.cloneUrl} but could not check it out: ${reset.stderr.trim() || `exit ${reset.status}`}`);
  return dir;
}

// A crashed clone leaves its staging directory behind. One this old is nobody's
// clone in progress.
const STALE_STAGING_MS = 24 * 60 * 60 * 1000;

// Removing a staging tree is cleanup: failing at it must not replace the error
// the caller needs (the clone's own) with one about housekeeping.
function discard(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* left for sweepStaging */
  }
}

function sweepStaging(staging: string): void {
  try {
    for (const name of readdirSync(staging)) {
      const at = join(staging, name);
      if (Date.now() - statSync(at).mtimeMs > STALE_STAGING_MS) rmSync(at, { recursive: true, force: true });
    }
  } catch {
    /* housekeeping only: a sweep that fails costs disk, not the clone */
  }
}

async function freshClone(ref: RepoRef, dir: string, branch: string | undefined): Promise<string> {
  // Cloned into a staging directory and renamed into place, so `dir` only ever
  // appears complete. That is what makes a second PROCESS safe too: it either
  // sees no clone yet, or a whole one — never a tree still being written.
  const staging = join(repoCacheRoot(), ".partial");
  mkdirSync(staging, { recursive: true });
  sweepStaging(staging);
  const attempt = async (filter: boolean) => {
    const tmp = join(staging, `${basename(dir)}-${process.pid}-${randomBytes(4).toString("hex")}`);
    const args = ["clone", "--depth", "1", ...(filter ? ["--filter=blob:none"] : []), ...(branch ? ["--branch", branch] : []), "--", ref.cloneUrl!, tmp];
    const r = await shAsync("git", args, { timeoutMs: cloneTimeoutMs() });
    if (!r.ok) discard(tmp);
    return { r, tmp };
  };

  let done = await attempt(true);
  if (!done.r.ok) {
    // Some servers reject partial-clone filters outright. Retry without.
    const first = done.r;
    done = await attempt(false);
    if (!done.r.ok) {
      // Both attempts can fail differently. Report each, labelled, instead of
      // whichever stderr happened to be non-empty.
      throw new Error(
        [
          `git clone failed for ${ref.cloneUrl}`,
          `  attempt 1 (--filter=blob:none): ${first.stderr.trim() || `exit ${first.status}`}`,
          `  attempt 2 (no filter):          ${done.r.stderr.trim() || `exit ${done.r.status}`}`,
        ].join("\n"),
      );
    }
  }
  if (!existsSync(done.tmp) || readdirSync(done.tmp).length === 0) throw new Error(`clone produced an empty tree for ${ref.cloneUrl}`);

  // A directory with no .git is what an interrupted clone of an older version
  // left behind — never a clone in progress, which now lives in staging.
  if (existsSync(dir) && !existsSync(join(dir, ".git"))) rmSync(dir, { recursive: true, force: true });
  try {
    renameSync(done.tmp, dir);
  } catch (e) {
    discard(done.tmp);
    // Another process finished the same clone first: theirs is as good as ours.
    if (!existsSync(join(dir, ".git"))) throw new Error(`could not move the clone of ${ref.cloneUrl} into ${dir}: ${(e as Error).message}`);
  }
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
