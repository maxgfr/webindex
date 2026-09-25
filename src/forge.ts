import { resolve } from "node:path";
import { countFetch, env, envFlag, envInt, envName } from "./brand.js";
import { have, shAsync } from "./exec.js";
import { contactUa, parseRetryAfter, readCappedBytes, sleep } from "./fetch.js";
import { configuredForgeHosts, hostForgeKind, normalizeForgeHost } from "./forge-host.js";
import { originUrl, type RepoRef, resolveRepo } from "./repo.js";
import { rankedKeywords } from "./text.js";

// Forge APIs: asking a code host about a repository.
//
// Between them, two consumers hand-rolled GitHub issue search with a
// keyword-relaxation ladder, GitHub releases, GitLab v4, Gitea v1, and a
// GitHub-Enterprise base — the same algorithm typed twice, with capabilities on
// each side the other lacked (one followed repository renames, the other
// propagated rate-limit state). Neither ratchet could see it, because the engine
// exported nothing for those declarations to shadow.
//
// Everything here is KEYLESS by default. A token is read from the environment
// when present, because the anonymous quotas are small, but nothing requires
// one — and `rateLimited` is reported rather than retried, since retrying a
// quota you have already exhausted only exhausts it further.

export type ForgeKind = "github" | "gitlab" | "gitea";

export interface ForgeItem {
  kind: "issue" | "pr" | "release" | "tag" | "discussion";
  number?: number;
  title: string;
  url: string;
  state?: string;
  labels: string[];
  body: string;
  updatedAt?: string;
  /** Whatever the forge scored it, when it scores at all. */
  score?: number;
}

export interface ForgeResult {
  items: ForgeItem[];
  /** Why it came back thin, in words a caller can show. Never an exception. */
  note?: string;
  rateLimited?: boolean;
  /** The HTTP status of a request that failed — 0 when it got no answer at all. */
  status?: number;
  /** When a spent quota resets, as the forge stated it (ISO 8601). */
  resetAt?: string;
}

export interface ForgeOptions {
  /**
   * Override the API base — a self-hosted GitLab, or GitHub Enterprise. Naming
   * it is also what sends the forge's token there: the calling code chose this
   * host, which a repository string alone never proves.
   */
  apiBase?: string;
  /**
   * Which forge the host runs, for a self-hosted one whose name does not say
   * (salsa.debian.org is a GitLab). It picks the API to ask and nothing else: a
   * token still goes only where `forgeAuthHeaders` allows.
   */
  kind?: ForgeKind;
  limit?: number;
  timeoutMs?: number;
  /**
   * searchIssues: when every term together matches nothing, search once more
   * with the most distinctive half of them, and say so in the note. Default on;
   * `false` keeps a search to exactly one request.
   */
  relax?: boolean;
}

/**
 * Which forge a host is: `opts.kind` when the caller says, then a host declared
 * in `<PREFIX>_FORGE_HOSTS`, then the host's shape. Unknown hosts get no client.
 */
export function forgeKind(host: string, opts: Pick<ForgeOptions, "kind"> = {}): ForgeKind | undefined {
  return opts.kind ?? hostForgeKind(host);
}

/**
 * The ref a forge can answer for. A local checkout stands for its `origin`
 * remote — `webindex repo .` means the project this directory is a clone of —
 * with any credential in that URL dropped, since the ref travels into output. A
 * checkout with no origin, and every other ref, comes back as it was.
 */
export function forgeRef(ref: RepoRef, opts: Pick<ForgeOptions, "kind"> = {}): RepoRef {
  if (!ref.isLocal) return ref;
  const origin = originUrl(resolve(ref.raw));
  if (!origin) return ref;
  const remote = resolveRepo(origin.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1"), opts);
  return remote.host === "generic" || remote.isLocal ? ref : remote;
}

/**
 * The API base for a repo's host.
 *
 * GitHub Enterprise is the awkward one: github.com serves `api.github.com`,
 * while a self-hosted install serves `<host>/api/v3`. Getting this wrong is a
 * 404 that reads like "no such repository".
 *
 * Takes a bare host string as well as a ref, because a provider layer routinely
 * knows the host before it has resolved anything into a `RepoRef` — and having to
 * fabricate one just to ask this question is exactly why a second copy of this
 * function grew downstream.
 */
export function apiBase(ref: Pick<RepoRef, "host"> | string, opts: ForgeOptions = {}): string {
  if (opts.apiBase) return opts.apiBase.replace(/\/+$/, "");
  const host = normalizeForgeHost(typeof ref === "string" ? ref : ref.host);
  const kind = forgeKind(host, opts);
  if (kind === "github") return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  if (kind === "gitlab") return `https://${host}/api/v4`;
  return `https://${host}/api/v1`;
}

// The hosts each token is FOR, with no configuration. Deliberately not "every
// host that looks like one": the kind is read off the host's name, and anyone can
// register github.<anything>. A token goes to one of these, to a host the user
// declared in `<PREFIX>_FORGE_HOSTS`, or to an `apiBase` the calling code named —
// never to a host a repository string merely mentions. Gitea has no default at
// all: Codeberg is one instance among many, and a token belongs to one of them.
const TOKEN_HOSTS: Record<ForgeKind, readonly string[]> = {
  github: ["github.com", "api.github.com"],
  gitlab: ["gitlab.com"],
  gitea: [],
};

function tokenHostAllowed(kind: ForgeKind, host: string): boolean {
  const h = normalizeForgeHost(host);
  return TOKEN_HOSTS[kind].includes(h) || configuredForgeHosts().get(h) === kind;
}

const TOKEN_VARS: Record<ForgeKind, readonly string[]> = {
  github: ["GITHUB_TOKEN", "GH_TOKEN"],
  gitlab: ["GITLAB_TOKEN"],
  gitea: ["GITEA_TOKEN"],
};

/**
 * The token for `kind` and the variable it came from — `<PREFIX>_GITHUB_TOKEN`
 * first, then the conventional names. A blank variable is skipped: an
 * exported-but-empty one is how CI spells "no secret", and it must not shadow
 * the next variable the user did set.
 */
function forgeToken(kind: ForgeKind): { value: string; name: string } | undefined {
  const own = env(TOKEN_VARS[kind][0]!);
  if (own) return { value: own, name: envName(TOKEN_VARS[kind][0]!) };
  for (const name of TOKEN_VARS[kind]) {
    const value = process.env[name]?.trim();
    if (value) return { value, name };
  }
  return undefined;
}

/**
 * Auth headers when a token is in the environment; none when it is not.
 *
 * Given the `host` a request goes to, a token comes back only for a host it
 * belongs to (see `TOKEN_HOSTS`). Without one this answers by kind alone, as it
 * always has — for a caller that decides where the header goes itself.
 *
 * Every token travels in `Authorization`, GitLab's included (it accepts a
 * personal token as a Bearer): that is the header a runtime drops on a
 * cross-origin redirect, where a custom `private-token` sailed through.
 */
export function forgeAuthHeaders(kind: ForgeKind, host?: string): Record<string, string> {
  const t = forgeToken(kind);
  if (!t || (host !== undefined && !tokenHostAllowed(kind, host))) return {};
  return { authorization: kind === "gitea" ? `token ${t.value}` : `Bearer ${t.value}` };
}

interface ForgeResponse {
  ok: boolean;
  status: number;
  data: any;
  /** Why a request got no answer (status 0), or why its answer was unusable. */
  error?: string;
  timedOut?: boolean;
  /** A quota answer: an explicit 429, or GitHub's 403 with its quota spent. */
  rateLimited?: boolean;
  /** When that quota resets, as the forge stated it. */
  resetAt?: string;
  /** The variable whose token went out with the request, if one did. */
  tokenVar?: string;
}

// A quota answer looks like a normal failure unless you check for it, and the
// two need opposite handling — one is "wait", the other is "this is wrong".
function limited(status: number, headers: Headers, data: unknown): boolean {
  if (status === 429) return true;
  return status === 403 && (headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(JSON.stringify(data ?? "")));
}

// GitHub and Gitea state the reset as epoch seconds in `x-ratelimit-reset`,
// GitLab in `ratelimit-reset`; anything may send `retry-after` instead.
function resetTime(headers: Headers): string | undefined {
  const epoch = Number(headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset"));
  if (Number.isFinite(epoch) && epoch > 0) return new Date(epoch * 1000).toISOString();
  const wait = parseRetryAfter(headers, Number.POSITIVE_INFINITY);
  return wait === undefined ? undefined : new Date(Date.now() + wait).toISOString();
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
// The only answers a second try can change: a gateway that hiccuped. A quota —
// a 429, or GitHub's 403 — is never retried; waiting it out is the caller's call.
const RETRY_STATUS = new Set([502, 503, 504]);
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// Why a request failed, as specifically as the runtime says: undici reports
// every network failure as "fetch failed" and keeps the reason on `cause`.
function failureText(e: unknown): string {
  const err = e as { message?: unknown; cause?: { message?: unknown; code?: unknown } } | undefined;
  const code = typeof err?.cause?.code === "string" ? err.cause.code : undefined;
  const detail = typeof err?.cause?.message === "string" && err.cause.message ? err.cause.message : code;
  if (!detail) return typeof err?.message === "string" ? err.message : String(e);
  return code && !detail.includes(code) ? `${code}: ${detail}` : detail;
}

// One GET, following redirects BY HAND so a credential never outlives its
// origin. `fetch` decides for itself which headers survive a cross-origin hop,
// and older runtimes kept them all; here every header that can carry a secret is
// dropped the moment the target changes origin, whatever the runtime. One
// timeout covers the whole chain.
async function forgeGetOnce(url: string, headers: Record<string, string>, timeoutMs: number): Promise<ForgeResponse> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const sent = { ...headers };
  let target = url;
  try {
    for (let hop = 0; ; hop++) {
      const res = await fetch(target, { headers: sent, redirect: "manual", signal: ctrl.signal });
      const location = res.headers.get("location");
      if (REDIRECT_STATUS.has(res.status) && location) {
        await res.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) return { ok: false, status: 0, data: undefined, error: `more than ${MAX_REDIRECTS} redirects from ${url}` };
        const next = new URL(location, target);
        if (next.protocol !== "https:" && next.protocol !== "http:") return { ok: false, status: 0, data: undefined, error: `redirected to ${next.protocol}` };
        if (next.origin !== new URL(target).origin) {
          delete sent.authorization;
          delete sent["private-token"];
          delete sent.cookie;
        }
        target = next.href;
        continue;
      }
      const bytes = await readCappedBytes(res, MAX_BODY_BYTES + 1);
      countFetch(Math.min(bytes.length, MAX_BODY_BYTES), false);
      if (bytes.length > MAX_BODY_BYTES) return { ok: false, status: res.status, data: undefined, error: `response over the ${MAX_BODY_BYTES}-byte cap` };
      const text = bytes.toString("utf8");
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = text;
      }
      const quota = !res.ok && limited(res.status, res.headers, data);
      return { ok: res.ok, status: res.status, data, ...(quota ? { rateLimited: true, resetAt: resetTime(res.headers) } : {}) };
    }
  } catch (e) {
    return { ok: false, status: 0, data: undefined, error: timedOut ? `timed out after ${timeoutMs} ms` : failureText(e), timedOut };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A forge API GET: JSON, byte-capped, never throwing, and retried at most once —
 * for a gateway error or a dropped connection. A timeout has already spent the
 * whole budget the caller granted, so it is not retried either: a black-holed
 * network costs one timeout per call, not two.
 */
async function forgeGet(url: string, kind: ForgeKind, ref: RepoRef, opts: ForgeOptions): Promise<ForgeResponse> {
  const auth = opts.apiBase ? forgeAuthHeaders(kind) : forgeAuthHeaders(kind, ref.host);
  const headers = { "user-agent": contactUa(), accept: kind === "github" ? "application/vnd.github+json" : "application/json", ...auth };
  const tokenVar = auth.authorization ? forgeToken(kind)?.name : undefined;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let r = await forgeGetOnce(url, headers, timeoutMs);
  if (RETRY_STATUS.has(r.status) || (r.status === 0 && !r.timedOut)) {
    await sleep(envInt("RETRY_MS", 600, 0, 5000));
    r = await forgeGetOnce(url, headers, timeoutMs);
  }
  return tokenVar ? { ...r, tokenVar } : r;
}

const FORGE_NAME: Record<ForgeKind, string> = { github: "GitHub", gitlab: "GitLab", gitea: "Gitea" };

/** What a failed answer means, in words a caller can show — which failure it was is the whole point. */
interface Failure {
  note: string;
  status: number;
  rateLimited?: true;
  resetAt?: string;
}

/**
 * Describe a failed forge answer. `action` names what was being done ("GitHub
 * search", "Reading https://…"), so the note reads on its own.
 *
 * Each cause gets its own words because each wants a different response: a
 * missing repository is a typo, a rejected token is a stale secret, a quota is a
 * wait, an outage is a retry later, and a network error is the machine's own
 * connection. All of them used to read "is it public?".
 */
function failure(r: ForgeResponse, forge: ForgeKind, ref: RepoRef, action: string, opts: ForgeOptions): Failure {
  const host = ref.host;
  const tokenVar = TOKEN_VARS[forge][0]!;
  if (r.rateLimited) {
    const when = r.resetAt ? ` until ${r.resetAt}` : "";
    const advice = r.tokenVar
      ? `the quota for ${r.tokenVar} is spent`
      : opts.apiBase || tokenHostAllowed(forge, host)
        ? `set ${tokenVar} to raise the anonymous quota`
        : `list ${host} in ${envName("FORGE_HOSTS")} and set ${tokenVar} to raise the anonymous quota`;
    return {
      note: `${FORGE_NAME[forge]} rate-limited this request${when} — ${advice}.`,
      status: r.status,
      rateLimited: true,
      ...(r.resetAt ? { resetAt: r.resetAt } : {}),
    };
  }
  if (r.status === 0) {
    let apiHost = host;
    try {
      apiHost = new URL(apiBase(ref, opts)).host;
    } catch {
      /* an unparseable apiBase names itself in the error below */
    }
    return { note: `${action} failed: network error reaching ${apiHost} — ${r.error ?? "no response"}.`, status: 0 };
  }
  const why =
    r.status === 404
      ? `no such repository on ${host}, or it is private`
      : r.status === 401
        ? r.tokenVar
          ? `${host} rejected ${r.tokenVar} — refresh it, or unset it to read public repositories anonymously`
          : `${host} requires authentication — set ${tokenVar}`
        : r.status === 403
          ? `${host} refused access${r.tokenVar ? ` — ${r.tokenVar} may lack the scope this needs` : ""}`
          : r.status === 422 && forge === "github"
            ? "GitHub cannot search that repository — it does not exist, or it is private"
            : r.status >= 500
              ? `${host} is unavailable`
              : (r.error ?? `${host} answered with an error`);
  return { note: `${action} failed (status ${r.status}): ${why}.`, status: r.status };
}

/** A failed answer as the `ForgeResult` every list call returns. */
function failed(r: ForgeResponse, forge: ForgeKind, ref: RepoRef, action: string, opts: ForgeOptions): ForgeResult {
  return { items: [], ...failure(r, forge, ref, action, opts) };
}

// A dot segment as a URL parser reads one — `%2e` included, which WHATWG URL
// treats as a dot.
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * The repository's place in an API path: `owner/repo` for GitHub and Gitea, the
 * url-encoded project path for GitLab. Undefined when the ref names no
 * repository, or names one that would walk out of the path — resolveRepo
 * refuses `..`, but a RepoRef is a plain object any caller can build, and
 * `/repos/../../user` reaches `/user` with the user's token attached.
 *
 * Each name is encoded as ONE segment: a GitHub or Gitea owner never contains a
 * slash, so one arriving here is data, not structure.
 */
function repoPath(ref: RepoRef, forge: ForgeKind): string | undefined {
  if (!ref.owner || !ref.repo) return undefined;
  if ([...ref.owner.split("/"), ref.repo].some((s) => !s || DOT_SEGMENT.test(s))) return undefined;
  return forge === "gitlab"
    ? `projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}`
    : `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
}

function clip(s: unknown, n = 1200): string {
  return String(s ?? "")
    .replace(/\r/g, "")
    .trim()
    .slice(0, n);
}

function labelsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((l) => (typeof l === "string" ? l : ((l as { name?: string })?.name ?? ""))).filter(Boolean);
}

/**
 * Map GitHub's issue-search payload into `ForgeItem`s.
 *
 * Exported for the parsing edges it has to survive: labels arriving as strings
 * or as objects, the draft flag standing in for a state, missing fields. A null
 * element is filtered first so one bad entry cannot throw away the whole page.
 */
export function mapGithubIssues(raw: unknown[], kind: "issue" | "pr"): ForgeItem[] {
  return (raw ?? [])
    .filter((it): it is Record<string, unknown> => !!it && typeof it === "object")
    .map((it) => ({
      kind,
      number: typeof it.number === "number" ? it.number : undefined,
      title: String(it.title ?? "").trim(),
      url: String(it.html_url ?? ""),
      state: it.draft ? "draft" : String(it.state ?? ""),
      labels: labelsOf(it.labels),
      body: clip(it.body),
      updatedAt: it.updated_at ? String(it.updated_at) : undefined,
      score: typeof it.score === "number" ? it.score : undefined,
    }));
}

interface Canonical {
  owner: string;
  repo: string;
  /** The lookup's own failure — the names above are then the caller's, unconfirmed. */
  failed?: ForgeResponse;
}

// One answer per (host, owner, repo) per process. The lookup is a round-trip and
// every search of a run asks the same question. A FAILED lookup is not kept: it
// is not an answer, and a long-lived server would otherwise search under the
// old name for the rest of its life after one bad minute.
const canonCache = new Map<string, Promise<Canonical>>();

/** Test seam: forget which repositories were resolved. */
export function resetCanonicalRepoCache(): void {
  canonCache.clear();
}

// The `gh` CLI only talks to the host it is authenticated against, so it is
// worth reaching for on github.com and useless anywhere else.
//
// `<PREFIX>_NO_GH` turns it off. That switch is not a nicety: shelling out is
// the one path in this module that leaves the HTTP layer entirely, so a caller
// with a stubbed `fetch` — every test suite, every offline run — would otherwise
// find a real network call underneath a mock that appeared to control everything.
// It also gives a user who would rather not spend their `gh` quota a way to say so.
function ghUsable(host: string): boolean {
  return /(^|\.)github\.com$/i.test(host) && !envFlag("NO_GH") && have("gh");
}

function splitSlug(full: string, fallback: { owner: string; repo: string }): { owner: string; repo: string } {
  const i = full.indexOf("/");
  return i > 0 ? { owner: full.slice(0, i), repo: full.slice(i + 1) } : fallback;
}

/**
 * The repository's canonical owner and repo, following renames.
 *
 * A moved repository (calcom/cal.com → calcom/cal.diy) still answers on its old
 * name through a redirect, but every subsequent SEARCH keyed on the old name
 * fails with a 422 that reads like a malformed query. So this is resolved once
 * and the answer used everywhere after.
 *
 * Prefers the `gh` CLI when it is installed and the host is github.com: it is
 * already authenticated, so it resolves against a quota far above the anonymous
 * one this would otherwise spend. Falls back to the keyless REST call — `gh` is
 * a bonus, never a requirement.
 *
 * Returns the parts rather than a slug because a provider layer builds URLs from
 * them; `canonicalRepo` below joins them for the callers that want the string.
 */
export async function canonicalRepoRef(ref: RepoRef, opts: ForgeOptions = {}): Promise<{ owner: string; repo: string }> {
  const { owner, repo } = await canonicalLookup(forgeRef(ref, opts), opts);
  return { owner, repo };
}

// canonicalRepoRef, keeping the lookup's failure: a search after a lookup that
// could not reach the forge would only spend a second timeout reaching the same
// verdict, and a 404 here is the answer the search would have hidden in a 422.
function canonicalLookup(ref: RepoRef, opts: ForgeOptions): Promise<Canonical> {
  const fallback = { owner: ref.owner ?? "", repo: ref.repo ?? "" };
  const path = forgeKind(ref.host, opts) === "github" ? repoPath(ref, "github") : undefined;
  if (!path) return Promise.resolve(fallback);
  const key = `${ref.host}/${ref.owner}/${ref.repo}`;
  let hit = canonCache.get(key);
  if (!hit) {
    const lookup = (async (): Promise<Canonical> => {
      if (ghUsable(ref.host)) {
        const r = await shAsync("gh", ["api", path, "--jq", ".full_name"], { timeoutMs: opts.timeoutMs ?? 15_000 });
        if (r.ok && r.stdout.includes("/")) return splitSlug(r.stdout.trim(), fallback);
      }
      const r = await forgeGet(`${apiBase(ref, opts)}/${path}`, "github", ref, opts);
      if (!r.ok) return { ...fallback, failed: r };
      const full = r.data?.full_name;
      return typeof full === "string" && full.includes("/") ? splitSlug(full, fallback) : fallback;
    })();
    hit = lookup;
    canonCache.set(key, lookup);
    void lookup.then((c) => {
      if (c.failed && canonCache.get(key) === lookup) canonCache.delete(key);
    });
  }
  return hit;
}

/** The same answer as `canonicalRepoRef`, as an `owner/repo` slug. */
export async function canonicalRepo(ref: RepoRef, opts: ForgeOptions = {}): Promise<string | undefined> {
  ref = forgeRef(ref, opts);
  if (!ref.owner || !ref.repo) return undefined;
  const { owner, repo } = await canonicalRepoRef(ref, opts);
  return `${owner}/${repo}`;
}

const noOrigin = (ref: RepoRef) => `"${ref.raw}" is a local directory with no origin remote — name the repository it is a clone of.`;

/**
 * Search a repository's issues or pull requests.
 *
 * GitHub gets its search API — the only one of the three that ranks by
 * relevance, and it does so only when left to its default order: terms are
 * best-match first, a listing with no terms most recently updated first. GitLab
 * and Gitea have no such endpoint, so they get a scoped list filtered by search
 * terms, which is why their `score` is absent: they are ordered by recency and
 * saying otherwise would be a lie the caller might rank on.
 *
 * Every term must match, so a natural five-word description often matches
 * nothing. Then — unless `relax: false` — it searches once more with the most
 * distinctive half of the words (qualifiers such as `label:bug` kept), and the
 * note says so: a looser answer must never pass for the one asked for.
 */
export async function searchIssues(ref: RepoRef, terms: string[], kind: "issue" | "pr", opts: ForgeOptions = {}): Promise<ForgeResult> {
  ref = forgeRef(ref, opts);
  if (ref.isLocal) return { items: [], note: noOrigin(ref) };
  const forge = forgeKind(ref.host, opts);
  if (!forge) return { items: [], note: `${ref.host} is not a forge this engine knows how to query.` };
  const repoAt = repoPath(ref, forge);
  if (!repoAt) return { items: [], note: `"${ref.raw}" does not name owner/repo.` };
  const wanted = terms.map((t) => t.trim()).filter(Boolean);
  const first = await searchOnce(ref, forge, repoAt, wanted, kind, opts);
  if (first.items.length || first.note || opts.relax === false) return first;
  const relaxed = relaxTerms(wanted);
  if (!relaxed) return first;
  const second = await searchOnce(ref, forge, repoAt, relaxed, kind, opts);
  if (second.note) return second;
  return { ...second, note: `No match for all the terms; relaxed to "${relaxed.join(" ")}".` };
}

/**
 * The most distinctive half of the words, qualifiers kept — or undefined when
 * that would not change the query. Fewer than three words have nothing to
 * give up: two is where a search stops being specific.
 */
function relaxTerms(terms: string[]): string[] | undefined {
  const qualifiers = terms.filter((t) => t.includes(":"));
  const words = terms.filter((t) => !t.includes(":"));
  if (words.length < 3) return undefined;
  const best = rankedKeywords(words.join(" ")).slice(0, Math.max(2, Math.ceil(words.length / 2)));
  if (best.length < 2 || best.length >= words.length) return undefined;
  return [...best, ...qualifiers];
}

async function searchOnce(ref: RepoRef, forge: ForgeKind, repoAt: string, terms: string[], kind: "issue" | "pr", opts: ForgeOptions): Promise<ForgeResult> {
  const limit = Math.max(1, opts.limit ?? 10);
  const q = terms.join(" ");

  if (forge === "github") {
    const canon = await canonicalLookup(ref, opts);
    if (canon.failed) return failed(canon.failed, forge, ref, "GitHub search", opts);
    const filter = kind === "pr" ? "is:pr" : "is:issue";
    // Any explicit sort REPLACES best match, so terms get none.
    const order = q ? "" : "&sort=updated&order=desc";
    const url = `${apiBase(ref, opts)}/search/issues?q=${encodeURIComponent(`repo:${canon.owner}/${canon.repo} ${filter} ${q}`.trim())}&per_page=${limit}${order}`;
    const r = await forgeGet(url, forge, ref, opts);
    if (!r.ok) return failed(r, forge, ref, "GitHub search", opts);
    return { items: mapGithubIssues(r.data?.items ?? [], kind) };
  }

  if (forge === "gitlab") {
    const path = kind === "pr" ? "merge_requests" : "issues";
    const url = `${apiBase(ref, opts)}/${repoAt}/${path}?search=${encodeURIComponent(q)}&per_page=${limit}&order_by=updated_at`;
    const r = await forgeGet(url, forge, ref, opts);
    if (!r.ok) return failed(r, forge, ref, "GitLab search", opts);
    const items: ForgeItem[] = (Array.isArray(r.data) ? r.data : []).map((it: Record<string, unknown>) => ({
      kind,
      number: typeof it.iid === "number" ? it.iid : undefined,
      title: String(it.title ?? "").trim(),
      url: String(it.web_url ?? ""),
      state: String(it.state ?? ""),
      labels: labelsOf(it.labels),
      body: clip(it.description),
      updatedAt: it.updated_at ? String(it.updated_at) : undefined,
    }));
    return { items };
  }

  // Gitea's /issues lists pull requests as well unless `type` narrows it, and
  // its /pulls endpoint takes no `q` — so both kinds go through /issues, the one
  // endpoint that can actually filter by the terms.
  const url = `${apiBase(ref, opts)}/${repoAt}/issues?state=all&type=${kind === "pr" ? "pulls" : "issues"}&limit=${limit}&q=${encodeURIComponent(q)}`;
  const r = await forgeGet(url, forge, ref, opts);
  if (!r.ok) return failed(r, forge, ref, "Gitea search", opts);
  const items: ForgeItem[] = (Array.isArray(r.data) ? r.data : []).map((it: Record<string, unknown>) => ({
    kind,
    number: typeof it.number === "number" ? it.number : undefined,
    title: String(it.title ?? "").trim(),
    url: String(it.html_url ?? ""),
    state: String(it.state ?? ""),
    labels: labelsOf(it.labels),
    body: clip(it.body),
    updatedAt: it.updated_at ? String(it.updated_at) : undefined,
  }));
  return { items };
}

/** A repository's releases, newest first. */
export async function listReleases(ref: RepoRef, opts: ForgeOptions = {}): Promise<ForgeResult> {
  ref = forgeRef(ref, opts);
  if (ref.isLocal) return { items: [], note: noOrigin(ref) };
  const forge = forgeKind(ref.host, opts);
  const repoAt = forge && repoPath(ref, forge);
  if (!forge || !repoAt) return { items: [], note: `Cannot list releases for "${ref.raw}".` };
  const limit = Math.max(1, opts.limit ?? 20);
  const url = `${apiBase(ref, opts)}/${repoAt}/releases?per_page=${limit}${forge === "gitlab" ? "" : `&limit=${limit}`}`;
  const r = await forgeGet(url, forge, ref, opts);
  if (!r.ok) return failed(r, forge, ref, "Listing releases", opts);
  const items: ForgeItem[] = (Array.isArray(r.data) ? r.data : []).map((it: Record<string, unknown>) => ({
    kind: "release" as const,
    title: String(it.name ?? it.tag_name ?? it.tag ?? "").trim() || String(it.tag_name ?? ""),
    // GitLab has no html_url; its page is `_links.self`, an object's field.
    url: String(it.html_url ?? (it._links as { self?: unknown } | undefined)?.self ?? it.web_url ?? ref.webUrl ?? ""),
    state: it.prerelease ? "prerelease" : "released",
    labels: [],
    body: clip(it.body ?? it.description),
    updatedAt: String(it.published_at ?? it.released_at ?? it.created_at ?? "") || undefined,
  }));
  return { items };
}

/** A repository's tags, which exist even where releases do not. */
export async function listTags(ref: RepoRef, opts: ForgeOptions = {}): Promise<ForgeResult> {
  ref = forgeRef(ref, opts);
  if (ref.isLocal) return { items: [], note: noOrigin(ref) };
  const forge = forgeKind(ref.host, opts);
  const repoAt = forge && repoPath(ref, forge);
  if (!forge || !repoAt) return { items: [], note: `Cannot list tags for "${ref.raw}".` };
  const limit = Math.max(1, opts.limit ?? 50);
  const url =
    forge === "gitlab"
      ? `${apiBase(ref, opts)}/${repoAt}/repository/tags?per_page=${limit}`
      : `${apiBase(ref, opts)}/${repoAt}/tags?per_page=${limit}&limit=${limit}`;
  const r = await forgeGet(url, forge, ref, opts);
  if (!r.ok) return failed(r, forge, ref, "Listing tags", opts);
  // GitLab serves a tag at /-/tags/<name>; its /releases/tag/<name> redirects to
  // the sign-in page. A tag name may hold `/`, which stays a separator there.
  const tagPage = forge === "gitlab" ? "-/tags" : "releases/tag";
  const items: ForgeItem[] = (Array.isArray(r.data) ? r.data : []).map((it: Record<string, unknown>) => {
    const name = String(it.name ?? "").trim();
    const commit = it.commit as { created_at?: unknown; created?: unknown } | undefined;
    const at = commit?.created_at ?? commit?.created;
    return {
      kind: "tag" as const,
      title: name,
      url: ref.webUrl ? `${ref.webUrl}/${tagPage}/${name.split("/").map(encodeURIComponent).join("/")}` : "",
      labels: [],
      body: "",
      ...(typeof at === "string" ? { updatedAt: at } : {}),
    };
  });
  return { items };
}

export interface RepoFacts {
  fullName?: string;
  description?: string;
  homepage?: string;
  license?: string;
  stars?: number;
  forks?: number;
  openIssues?: number;
  defaultBranch?: string;
  pushedAt?: string;
  archived?: boolean;
  topics: string[];
}

/** `repoFacts`, with the reason when there are none. */
export interface RepoFactsResult {
  facts?: RepoFacts;
  /** Why there are no facts, in words a caller can show. */
  note?: string;
  /** The HTTP status of the answer — 0 when there was none; absent when nothing was asked. */
  status?: number;
  rateLimited?: boolean;
  /** When a spent quota resets, as the forge stated it (ISO 8601). */
  resetAt?: string;
}

/**
 * The repository's own metadata — stars, licence, homepage, whether it is
 * archived.
 *
 * Worth having for a reason beyond curiosity: "is this project maintained" is
 * otherwise answered by reading a README that says it is. `archived` and
 * `pushedAt` answer it from the record.
 *
 * Undefined for any failure; `repoFactsResult` says which one it was.
 */
export async function repoFacts(ref: RepoRef, opts: ForgeOptions = {}): Promise<RepoFacts | undefined> {
  return (await repoFactsResult(ref, opts)).facts;
}

/**
 * `repoFacts`, and when it has none, why: no such repository, a rejected token,
 * a quota (with its reset time), an outage, or no network at all. Each wants a
 * different response, and all of them used to arrive as the same `undefined`.
 */
export async function repoFactsResult(ref: RepoRef, opts: ForgeOptions = {}): Promise<RepoFactsResult> {
  ref = forgeRef(ref, opts);
  if (ref.isLocal) return { note: noOrigin(ref) };
  const forge = forgeKind(ref.host, opts);
  if (!forge) return { note: `${ref.host} is not a forge this engine knows how to query.` };
  const repoAt = repoPath(ref, forge);
  if (!repoAt) return { note: `"${ref.raw}" does not name owner/repo.` };
  // GitLab leaves the licence out of a project unless asked for it by name.
  const r = await forgeGet(`${apiBase(ref, opts)}/${repoAt}${forge === "gitlab" ? "?license=true" : ""}`, forge, ref, opts);
  if (!r.ok) return failure(r, forge, ref, `Reading ${ref.webUrl ?? ref.raw}`, opts);
  if (!r.data || typeof r.data !== "object") return { status: r.status, note: `${ref.host} answered with something other than a repository record.` };
  return { status: r.status, facts: mapRepoFacts(forge, r.data as Record<string, any>) };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

// Each forge names the same facts differently, and reading one forge's record by
// another's names does not fail — it quietly answers "—" for every field.
function mapRepoFacts(forge: ForgeKind, d: Record<string, any>): RepoFacts {
  const topics = (v: unknown) => (Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : []);
  const shared = {
    description: str(d.description),
    forks: num(d.forks_count),
    openIssues: num(d.open_issues_count),
    defaultBranch: str(d.default_branch),
    archived: typeof d.archived === "boolean" ? d.archived : undefined,
  };
  if (forge === "gitlab") {
    return {
      ...shared,
      fullName: str(d.path_with_namespace),
      // A project has no homepage field; its page is the closest thing it states.
      homepage: str(d.web_url),
      license: str(d.license?.name) ?? str(d.license?.key),
      stars: num(d.star_count),
      pushedAt: str(d.last_activity_at),
      topics: topics(d.topics).length ? topics(d.topics) : topics(d.tag_list),
    };
  }
  if (forge === "gitea") {
    return {
      ...shared,
      fullName: str(d.full_name),
      homepage: str(d.website),
      license: Array.isArray(d.licenses) ? str(d.licenses[0]) : undefined,
      stars: num(d.stars_count),
      pushedAt: str(d.updated_at),
      topics: topics(d.topics),
    };
  }
  // GitHub says NOASSERTION when it found a licence file it cannot classify;
  // that is not a licence, but "Other" (its name for the case) is honest.
  const spdx = str(d.license?.spdx_id);
  return {
    ...shared,
    fullName: str(d.full_name),
    homepage: str(d.homepage),
    license: spdx && spdx !== "NOASSERTION" ? spdx : str(d.license?.name),
    stars: num(d.stargazers_count),
    pushedAt: str(d.pushed_at),
    topics: topics(d.topics),
  };
}
