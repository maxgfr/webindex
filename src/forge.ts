import { env, envFlag } from "./brand.js";
import { have, shAsync } from "./exec.js";
import { contactUa, httpJson } from "./fetch.js";
import type { RepoRef } from "./repo.js";

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
}

export interface ForgeOptions {
  /** Override the API base — a self-hosted GitLab, or GitHub Enterprise. */
  apiBase?: string;
  limit?: number;
  timeoutMs?: number;
}

/** Which forge a host is, by its shape. Unknown hosts get no client. */
export function forgeKind(host: string): ForgeKind | undefined {
  const h = host.toLowerCase();
  if (h === "github.com" || h.endsWith(".github.com") || h.startsWith("github.")) return "github";
  if (h === "gitlab.com" || h.includes("gitlab")) return "gitlab";
  if (h.includes("gitea") || h.includes("codeberg")) return "gitea";
  return undefined;
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
  const host = typeof ref === "string" ? ref : ref.host;
  const kind = forgeKind(host);
  if (kind === "github") return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  if (kind === "gitlab") return `https://${host}/api/v4`;
  return `https://${host}/api/v1`;
}

/** Auth headers when a token is in the environment; none when it is not. */
export function forgeAuthHeaders(kind: ForgeKind): Record<string, string> {
  if (kind === "github") {
    const t = env("GITHUB_TOKEN") ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    return t ? { authorization: `Bearer ${t}` } : {};
  }
  if (kind === "gitlab") {
    const t = env("GITLAB_TOKEN") ?? process.env.GITLAB_TOKEN;
    return t ? { "private-token": t } : {};
  }
  const t = env("GITEA_TOKEN") ?? process.env.GITEA_TOKEN;
  return t ? { authorization: `token ${t}` } : {};
}

function reqOpts(kind: ForgeKind, opts: ForgeOptions) {
  return {
    timeoutMs: opts.timeoutMs ?? 15_000,
    userAgent: contactUa(),
    headers: { ...forgeAuthHeaders(kind), ...(kind === "github" ? { accept: "application/vnd.github+json" } : {}) },
  };
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

// A quota answer looks like a normal failure unless you check for it, and the
// two need opposite handling — one is "wait", the other is "this is wrong".
function limited(status: number, data: unknown): boolean {
  if (status === 429) return true;
  return status === 403 && /rate limit/i.test(JSON.stringify(data ?? ""));
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

// One answer per (host, owner, repo) per process. The lookup is a round-trip and
// every search of a run asks the same question.
const canonCache = new Map<string, Promise<{ owner: string; repo: string }>>();

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
export function canonicalRepoRef(ref: RepoRef, opts: ForgeOptions = {}): Promise<{ owner: string; repo: string }> {
  const fallback = { owner: ref.owner ?? "", repo: ref.repo ?? "" };
  if (!ref.owner || !ref.repo || forgeKind(ref.host) !== "github") return Promise.resolve(fallback);
  const key = `${ref.host}/${ref.owner}/${ref.repo}`;
  let hit = canonCache.get(key);
  if (!hit) {
    hit = (async () => {
      if (ghUsable(ref.host)) {
        const r = await shAsync("gh", ["api", `repos/${ref.owner}/${ref.repo}`, "--jq", ".full_name"], { timeoutMs: opts.timeoutMs ?? 15_000 });
        if (r.ok && r.stdout.includes("/")) return splitSlug(r.stdout.trim(), fallback);
      }
      const r = await httpJson("GET", `${apiBase(ref, opts)}/repos/${ref.owner}/${ref.repo}`, undefined, reqOpts("github", opts));
      const full = r.ok ? r.data?.full_name : undefined;
      return typeof full === "string" && full.includes("/") ? splitSlug(full, fallback) : fallback;
    })();
    canonCache.set(key, hit);
  }
  return hit;
}

/** The same answer as `canonicalRepoRef`, as an `owner/repo` slug. */
export async function canonicalRepo(ref: RepoRef, opts: ForgeOptions = {}): Promise<string | undefined> {
  if (!ref.owner || !ref.repo) return undefined;
  const { owner, repo } = await canonicalRepoRef(ref, opts);
  return `${owner}/${repo}`;
}

/**
 * Search a repository's issues or pull requests.
 *
 * GitHub gets its search API — the only one of the three that ranks by
 * relevance. GitLab and Gitea have no such endpoint, so they get a scoped list
 * filtered by search terms, which is why their `score` is absent: they are
 * ordered by recency and saying otherwise would be a lie the caller might rank on.
 */
export async function searchIssues(ref: RepoRef, terms: string[], kind: "issue" | "pr", opts: ForgeOptions = {}): Promise<ForgeResult> {
  const forge = forgeKind(ref.host);
  if (!forge) return { items: [], note: `${ref.host} is not a forge this engine knows how to query.` };
  if (!ref.owner || !ref.repo) return { items: [], note: `"${ref.raw}" does not name owner/repo.` };
  const limit = Math.max(1, opts.limit ?? 10);
  const q = terms.filter(Boolean).join(" ");

  if (forge === "github") {
    const slug = (await canonicalRepo(ref, opts)) ?? `${ref.owner}/${ref.repo}`;
    const filter = kind === "pr" ? "is:pr" : "is:issue";
    const url = `${apiBase(ref, opts)}/search/issues?q=${encodeURIComponent(`repo:${slug} ${filter} ${q}`)}&per_page=${limit}&sort=updated&order=desc`;
    const r = await httpJson("GET", url, undefined, reqOpts(forge, opts));
    if (limited(r.status, r.data))
      return { items: [], rateLimited: true, note: "GitHub rate-limited this search — set GITHUB_TOKEN to raise the anonymous quota." };
    if (!r.ok) return { items: [], note: `GitHub search failed (status ${r.status}).` };
    return { items: mapGithubIssues(r.data?.items ?? [], kind) };
  }

  if (forge === "gitlab") {
    const project = encodeURIComponent(`${ref.owner}/${ref.repo}`);
    const path = kind === "pr" ? "merge_requests" : "issues";
    const url = `${apiBase(ref, opts)}/projects/${project}/${path}?search=${encodeURIComponent(q)}&per_page=${limit}&order_by=updated_at`;
    const r = await httpJson("GET", url, undefined, reqOpts(forge, opts));
    if (limited(r.status, r.data)) return { items: [], rateLimited: true, note: "GitLab rate-limited this search." };
    if (!r.ok) return { items: [], note: `GitLab request failed (status ${r.status}).` };
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

  const path = kind === "pr" ? "pulls" : "issues";
  const url = `${apiBase(ref, opts)}/repos/${ref.owner}/${ref.repo}/${path}?state=all&limit=${limit}&q=${encodeURIComponent(q)}`;
  const r = await httpJson("GET", url, undefined, reqOpts(forge, opts));
  if (limited(r.status, r.data)) return { items: [], rateLimited: true, note: "Gitea rate-limited this request." };
  if (!r.ok) return { items: [], note: `Gitea request failed (status ${r.status}).` };
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
  const forge = forgeKind(ref.host);
  if (!forge || !ref.owner || !ref.repo) return { items: [], note: `Cannot list releases for "${ref.raw}".` };
  const limit = Math.max(1, opts.limit ?? 20);
  const url =
    forge === "gitlab"
      ? `${apiBase(ref, opts)}/projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}/releases?per_page=${limit}`
      : `${apiBase(ref, opts)}/repos/${ref.owner}/${ref.repo}/releases?per_page=${limit}&limit=${limit}`;
  const r = await httpJson("GET", url, undefined, reqOpts(forge, opts));
  if (limited(r.status, r.data)) return { items: [], rateLimited: true, note: `${forge} rate-limited the release list.` };
  if (!r.ok) return { items: [], note: `Could not list releases (status ${r.status}).` };
  const items: ForgeItem[] = (Array.isArray(r.data) ? r.data : []).map((it: Record<string, unknown>) => ({
    kind: "release" as const,
    title: String(it.name ?? it.tag_name ?? it.tag ?? "").trim() || String(it.tag_name ?? ""),
    url: String(it.html_url ?? it._links ?? it.web_url ?? ref.webUrl ?? ""),
    state: it.prerelease ? "prerelease" : "released",
    labels: [],
    body: clip(it.body ?? it.description),
    updatedAt: String(it.published_at ?? it.released_at ?? it.created_at ?? "") || undefined,
  }));
  return { items };
}

/** A repository's tags, which exist even where releases do not. */
export async function listTags(ref: RepoRef, opts: ForgeOptions = {}): Promise<ForgeResult> {
  const forge = forgeKind(ref.host);
  if (!forge || !ref.owner || !ref.repo) return { items: [], note: `Cannot list tags for "${ref.raw}".` };
  const limit = Math.max(1, opts.limit ?? 50);
  const url =
    forge === "gitlab"
      ? `${apiBase(ref, opts)}/projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}/repository/tags?per_page=${limit}`
      : `${apiBase(ref, opts)}/repos/${ref.owner}/${ref.repo}/tags?per_page=${limit}&limit=${limit}`;
  const r = await httpJson("GET", url, undefined, reqOpts(forge, opts));
  if (limited(r.status, r.data)) return { items: [], rateLimited: true, note: `${forge} rate-limited the tag list.` };
  if (!r.ok) return { items: [], note: `Could not list tags (status ${r.status}).` };
  const items: ForgeItem[] = (Array.isArray(r.data) ? r.data : []).map((it: Record<string, unknown>) => ({
    kind: "tag" as const,
    title: String(it.name ?? "").trim(),
    url: ref.webUrl ? `${ref.webUrl}/releases/tag/${String(it.name ?? "")}` : "",
    labels: [],
    body: "",
  }));
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

/**
 * The repository's own metadata — stars, licence, homepage, whether it is
 * archived.
 *
 * Worth having for a reason beyond curiosity: "is this project maintained" is
 * otherwise answered by reading a README that says it is. `archived` and
 * `pushedAt` answer it from the record.
 */
export async function repoFacts(ref: RepoRef, opts: ForgeOptions = {}): Promise<RepoFacts | undefined> {
  const forge = forgeKind(ref.host);
  if (!forge || !ref.owner || !ref.repo) return undefined;
  const url =
    forge === "gitlab"
      ? `${apiBase(ref, opts)}/projects/${encodeURIComponent(`${ref.owner}/${ref.repo}`)}`
      : `${apiBase(ref, opts)}/repos/${ref.owner}/${ref.repo}`;
  const r = await httpJson("GET", url, undefined, reqOpts(forge, opts));
  if (!r.ok || !r.data || typeof r.data !== "object") return undefined;
  const d = r.data as Record<string, any>;
  return {
    fullName: d.full_name ?? d.path_with_namespace,
    description: d.description ?? undefined,
    homepage: d.homepage ?? d.web_url ?? undefined,
    license: d.license?.spdx_id ?? d.license?.name ?? undefined,
    stars: d.stargazers_count ?? d.star_count,
    forks: d.forks_count,
    openIssues: d.open_issues_count,
    defaultBranch: d.default_branch,
    pushedAt: d.pushed_at ?? d.last_activity_at,
    archived: d.archived,
    topics: Array.isArray(d.topics) ? d.topics : Array.isArray(d.tag_list) ? d.tag_list : [],
  };
}
