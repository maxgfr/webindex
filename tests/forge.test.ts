import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envName } from "../src/brand.js";
import { sh } from "../src/exec.js";
import {
  apiBase,
  canonicalRepo,
  forgeAuthHeaders,
  forgeKind,
  forgeRef,
  listReleases,
  listTags,
  mapGithubIssues,
  repoFacts,
  repoFactsResult,
  resetCanonicalRepoCache,
  searchIssues,
} from "../src/forge.js";
import { lookupPackage, lookupPackageResult, normalizeRepoUrl, resolvePackage, resolvePackageResult } from "../src/registry.js";
import { resolveRepo } from "../src/repo.js";
import { slugify } from "../src/text.js";
import { installFetchMock } from "./fetchmock.js";

afterEach(() => vi.unstubAllGlobals());

// A rename is resolved once per (host, owner, repo) and remembered for the
// process — right for a run, wrong across cases, where the second test using a
// ref would be answered by the first test's mock instead of its own.
beforeEach(() => resetCanonicalRepoCache());

describe("resolveRepo", () => {
  it("parses every identifier shape onto the same repository", () => {
    const shapes = [
      "https://github.com/expressjs/express",
      "https://github.com/expressjs/express.git",
      "https://github.com/expressjs/express/",
      "git@github.com:expressjs/express.git",
      "github.com/expressjs/express",
      "expressjs/express",
    ];
    const slugs = new Set(shapes.map((s) => resolveRepo(s).slug));
    expect(slugs.size).toBe(1);
    for (const s of shapes) {
      const r = resolveRepo(s);
      expect(r.owner, s).toBe("expressjs");
      expect(r.repo, s).toBe("express");
      expect(r.webUrl, s).toBe("https://github.com/expressjs/express");
      expect(r.cloneUrl!.endsWith(".git"), s).toBe(true);
    }
  });

  it("parses the URL schemes one copy of this used to reject", () => {
    // The two forks diverged exactly here: one accepted any scheme, the other
    // stopped at https and silently fell through to "generic".
    for (const s of [
      "ssh://git@github.com/expressjs/express.git",
      "git://github.com/expressjs/express.git",
      "https://user:pw@github.com:8443/expressjs/express",
    ]) {
      const r = resolveRepo(s);
      expect(r.host, s).toBe("github.com");
      expect(r.owner, s).toBe("expressjs");
      expect(r.repo, s).toBe("express");
    }
  });

  it("keeps GitLab subgroups in the owner", () => {
    const r = resolveRepo("https://gitlab.com/group/subgroup/thing");
    expect(r.owner).toBe("group/subgroup");
    expect(r.repo).toBe("thing");
  });

  it("prefers a local directory, and never lets an empty seed mean the cwd", () => {
    const here = resolveRepo(process.cwd());
    expect(here.isLocal).toBe(true);
    expect(here.host).toBe("local");
    // The guard the other fork lacked.
    expect(resolveRepo("").isLocal).toBe(false);
    expect(resolveRepo("   ").isLocal).toBe(false);
  });

  it("refuses to invent a URL for free text", () => {
    const r = resolveRepo("some words a user typed");
    expect(r.host).toBe("generic");
    expect(r.cloneUrl).toBeUndefined();
    expect(r.webUrl).toBeUndefined();
  });

  it("does not produce the un-cloneable '/.git' from a trailing slash", () => {
    expect(resolveRepo("https://github.com/a/b/").cloneUrl).toBe("https://github.com/a/b.git");
  });

  it("reads the repository out of a URL copied from a browser", () => {
    // Everything after owner/repo is a page INSIDE the repository. Taking the
    // last segment as the repo named a file, an issue number or a branch, and
    // the clone URL became `…/tree/main/src.git`.
    for (const s of [
      "https://github.com/maxgfr/webindex/tree/main/src",
      "https://github.com/maxgfr/webindex/blob/main/README.md",
      "https://github.com/maxgfr/webindex/issues/12",
      "https://github.com/maxgfr/webindex/pull/3",
      "https://github.com/maxgfr/webindex?tab=readme-ov-file",
      "https://github.com/maxgfr/webindex#readme",
      "https://www.github.com/maxgfr/webindex",
      "github.com/maxgfr/webindex/tree/main",
    ]) {
      const r = resolveRepo(s);
      expect({ host: r.host, owner: r.owner, repo: r.repo }, s).toEqual({ host: "github.com", owner: "maxgfr", repo: "webindex" });
      expect(r.cloneUrl, s).toBe("https://github.com/maxgfr/webindex.git");
      expect(r.webUrl, s).toBe("https://github.com/maxgfr/webindex");
      expect(r.slug, s).toBe(resolveRepo("maxgfr/webindex").slug);
    }
    // www. is the browser's, not a GitHub Enterprise install at www.github.com.
    expect(apiBase(resolveRepo("https://www.github.com/maxgfr/webindex"))).toBe("https://api.github.com");
  });

  it("ends a GitLab path at '/-/', and a Gitea one after owner/repo", () => {
    expect(resolveRepo("https://gitlab.com/gitlab-org/gitlab/-/tree/master/app")).toMatchObject({ owner: "gitlab-org", repo: "gitlab" });
    expect(resolveRepo("https://gitlab.com/group/subgroup/thing/-/issues/3")).toMatchObject({
      owner: "group/subgroup",
      repo: "thing",
      cloneUrl: "https://gitlab.com/group/subgroup/thing.git",
    });
    expect(resolveRepo("https://codeberg.org/forgejo/forgejo/src/branch/forgejo")).toMatchObject({ owner: "forgejo", repo: "forgejo" });
  });

  it("refuses '.' and '..' as a path segment, which a URL parser would resolve away", () => {
    // `/repos/../../user` is `/user` by the time it is requested — an
    // authenticated GET of an endpoint nobody asked for.
    for (const s of ["github.com/../../user", "https://github.com/%2e%2e/%2E%2e/user", "github.com/a/..", "https://gitlab.com/g/./p"]) {
      const r = resolveRepo(s);
      expect(r.host, s).toBe("generic");
      expect(r.cloneUrl, s).toBeUndefined();
    }
  });

  it("keeps the ssh transport a private repository needs", () => {
    // Rebuilt as https, a repository reachable only over SSH on a custom port
    // failed for lack of credentials.
    expect(resolveRepo("ssh://git@gitlab.company.com:2222/g/r.git")).toMatchObject({
      host: "gitlab.company.com",
      owner: "g",
      repo: "r",
      cloneUrl: "ssh://git@gitlab.company.com:2222/g/r.git",
      webUrl: "https://gitlab.company.com/g/r",
    });
    // A user other than `git` is still the scp form.
    expect(resolveRepo("org-123@github.com:org/repo.git")).toMatchObject({
      host: "github.com",
      owner: "org",
      repo: "repo",
      cloneUrl: "org-123@github.com:org/repo.git",
    });
    // git:// has no auth to keep; https is the transport that works everywhere.
    expect(resolveRepo("git://github.com/a/b.git").cloneUrl).toBe("https://github.com/a/b.git");
  });

  it("parses adversarial identifiers in linear time", () => {
    // A repository string can arrive from a prompt; every pattern here must stay
    // linear on it. The bound is loose enough that only a superlinear scan fails.
    const n = 200_000;
    const started = Date.now();
    for (const s of [
      `https://${"a".repeat(n)}`,
      `https://${"a@".repeat(n)}`,
      `${"a".repeat(n)}@`,
      `${"a@".repeat(n)}x`,
      `git@${"a".repeat(n)}`,
      `github.com/${"a/".repeat(n)}`,
      `github.com/a/b${"?".repeat(n)}`,
    ]) {
      resolveRepo(s);
    }
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("never lets a user or host that git would read as an option through", () => {
    for (const s of ["-oProxyCommand=touch%20x@github.com:a/b", "git@-oProxyCommand=x:a/b", "ssh://-oProxyCommand=x/a/b", "ssh://-u@host.example/a/b"]) {
      const r = resolveRepo(s);
      expect(r.cloneUrl, s).toBeUndefined();
    }
  });
});

describe("slugify", () => {
  it("collapses every spelling of one repository to one cache key", () => {
    const keys = new Set(["https://github.com/a/b", "git@github.com:a/b.git", "github.com/a/b.git", "github.com/a/b"].map((s) => slugify(s)));
    expect(keys).toEqual(new Set(["github.com-a-b"]));
  });

  it("takes a length and a fallback, because the two uses want different ones", () => {
    expect(slugify("x".repeat(200)).length).toBe(120);
    expect(slugify("x".repeat(200), { max: 80 }).length).toBe(80);
    expect(slugify("???", { fallback: "run" })).toBe("run");
    expect(slugify("???")).toBe("");
  });

  it("tells apart inputs it has to drop characters from or cut, with a hash of what it dropped", () => {
    // Both became "file-srv-git", and the second repository was handed the
    // first one's checkout.
    const a = resolveRepo("file:///srv/git/项目").slug;
    const b = resolveRepo("file:///srv/git/文档").slug;
    expect(a).not.toBe(b);
    expect(a).toMatch(/^file-srv-git-[0-9a-f]{8}$/);
    const long = `/srv/${"x".repeat(130)}`;
    expect(resolveRepo(`file://${long}/alpha`).slug).not.toBe(resolveRepo(`file://${long}/beta`).slug);
    expect(slugify("x".repeat(200)).length).toBe(120);
    expect(slugify("日本語")).toMatch(/^[0-9a-f]{8}$/);
    // An ASCII slug that fits keeps its readable name, unsuffixed.
    expect(slugify("github.com/expressjs/express")).toBe("github.com-expressjs-express");
    expect(slugify("What is the C++ memory model?")).toBe("what-is-the-c-memory-model");
  });
});

describe("forge routing", () => {
  it("recognises the three forges and declines anything else", () => {
    expect(forgeKind("github.com")).toBe("github");
    expect(forgeKind("gitlab.example.org")).toBe("gitlab");
    expect(forgeKind("codeberg.org")).toBe("gitea");
    expect(forgeKind("example.com")).toBeUndefined();
  });

  it("sends GitHub Enterprise to /api/v3 and github.com to api.github.com", () => {
    // Getting this wrong is a 404 that reads like "no such repository".
    expect(apiBase(resolveRepo("github.com/a/b"))).toBe("https://api.github.com");
    expect(apiBase(resolveRepo("github.acme.corp/a/b"))).toBe("https://github.acme.corp/api/v3");
    expect(apiBase(resolveRepo("gitlab.acme.corp/a/b"))).toBe("https://gitlab.acme.corp/api/v4");
    expect(apiBase(resolveRepo("github.com/a/b"), { apiBase: "https://pinned.test/api" })).toBe("https://pinned.test/api");
  });

  it("queries a self-hosted forge whose name does not say what it runs", async () => {
    // salsa.debian.org, invent.kde.org, git.company.example: every call used to
    // stop at "not a forge this engine knows" before it looked at any option.
    vi.stubEnv("GITLAB_TOKEN", "glpat-SECRET");
    const seen: { url: string; auth?: string }[] = [];
    installFetchMock((url, init) => {
      seen.push({ url, auth: ((init?.headers ?? {}) as Record<string, string>).authorization });
      return { body: JSON.stringify({ path_with_namespace: "debian/dpkg", star_count: 1 }), contentType: "application/json" };
    });
    expect(forgeKind("salsa.debian.org")).toBeUndefined();
    expect(forgeKind("salsa.debian.org", { kind: "gitlab" })).toBe("gitlab");
    const f = await repoFacts(resolveRepo("salsa.debian.org/debian/dpkg"), { kind: "gitlab" });
    expect(f?.fullName).toBe("debian/dpkg");
    // Naming the kind is not naming the host as trusted: no token rides along.
    expect(seen[0]).toEqual({ url: "https://salsa.debian.org/api/v4/projects/debian%2Fdpkg?license=true", auth: undefined });

    vi.stubEnv(envName("FORGE_HOSTS"), "invent.kde.org=gitlab");
    expect(forgeKind("invent.kde.org")).toBe("gitlab");
    await repoFacts(resolveRepo("invent.kde.org/plasma/kwin"));
    expect(seen[1]).toEqual({ url: "https://invent.kde.org/api/v4/projects/plasma%2Fkwin?license=true", auth: "Bearer glpat-SECRET" });
    vi.unstubAllEnvs();
  });

  it("cuts a browser URL at owner/repo once it knows the host is a GitHub", () => {
    expect(resolveRepo("https://git.corp.example/team/app/tree/main")).toMatchObject({ owner: "team/app/tree", repo: "main" });
    expect(resolveRepo("https://git.corp.example/team/app/tree/main", { kind: "github" })).toMatchObject({ owner: "team", repo: "app" });
  });
});

describe("a local checkout, as far as a forge is concerned", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wi-local-"));
    sh("git", ["-C", dir, "init", "-q"]);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("stands for its origin — with any credential in that URL left behind", async () => {
    // CI checkouts routinely carry a token in the remote URL, and this ref ends
    // up in MCP output.
    sh("git", ["-C", dir, "remote", "add", "origin", "https://x-access-token:ghs_SECRET@github.com/maxgfr/webindex.git"]);
    const ref = forgeRef(resolveRepo(dir));
    expect(ref).toMatchObject({ host: "github.com", owner: "maxgfr", repo: "webindex", isLocal: false });
    expect(JSON.stringify(ref)).not.toContain("SECRET");

    const seen: string[] = [];
    installFetchMock((url) => {
      seen.push(url);
      return { body: JSON.stringify({ full_name: "maxgfr/webindex" }), contentType: "application/json" };
    });
    expect((await repoFacts(resolveRepo(dir)))?.fullName).toBe("maxgfr/webindex");
    expect(seen[0]).toBe("https://api.github.com/repos/maxgfr/webindex");
  });

  it("says so when the checkout has no origin to stand for", async () => {
    const r = await repoFactsResult(resolveRepo(dir));
    expect(r.note).toMatch(/local directory with no origin remote/);
    expect(forgeRef(resolveRepo(dir)).isLocal).toBe(true);
  });
});

describe("where a token is sent", () => {
  // Every case sets all three tokens, so a header that reaches the wrong host is
  // a real leak and not an artefact of which variables the machine had.
  beforeEach(() => {
    vi.stubEnv("GITHUB_TOKEN", "ghp_SECRET");
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITLAB_TOKEN", "glpat-SECRET");
    vi.stubEnv("GITEA_TOKEN", "gitea-SECRET");
  });
  afterEach(() => vi.unstubAllEnvs());

  /** The credential headers each request carried, keyed by URL. */
  function recordAuth() {
    const seen: { url: string; auth?: string; privateToken?: string }[] = [];
    installFetchMock((url, init) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url, auth: h.authorization, privateToken: h["private-token"] });
      return { body: JSON.stringify({ full_name: "o/r" }), contentType: "application/json" };
    });
    return seen;
  }

  it("never sends a token to a host that only looks like its forge", async () => {
    // A prompt-injected link is enough to route an agent here, and the forge
    // KIND was all it took to hand over the user's token.
    const seen = recordAuth();
    for (const host of ["github.attacker.example", "notgitlab.attacker.example", "gitea-lookalike.attacker.example", "codeberg.evil.example"]) {
      await repoFacts(resolveRepo(`https://${host}/o/r`));
      await listReleases(resolveRepo(`https://${host}/o/r`));
    }
    expect(seen.length).toBeGreaterThanOrEqual(8);
    for (const s of seen) {
      expect(s.auth, s.url).toBeUndefined();
      expect(s.privateToken, s.url).toBeUndefined();
    }
  });

  it("sends each token to its own public forge", async () => {
    const seen = recordAuth();
    await repoFacts(resolveRepo("github.com/o/r"));
    await repoFacts(resolveRepo("gitlab.com/o/r"));
    expect(seen[0]).toMatchObject({ url: "https://api.github.com/repos/o/r", auth: "Bearer ghp_SECRET" });
    // As an Authorization header: that is the one a runtime strips on a
    // cross-origin redirect. GitLab accepts a personal token either way.
    expect(seen[1]!.url).toMatch(/^https:\/\/gitlab\.com\/api\/v4\/projects\/o%2Fr/);
    expect(seen[1]!.auth).toBe("Bearer glpat-SECRET");
    expect(seen[1]!.privateToken).toBeUndefined();
  });

  it("sends a token to a self-hosted forge only once the user has declared it", async () => {
    let seen = recordAuth();
    await repoFacts(resolveRepo("github.corp.example/o/r"));
    expect(seen[0]!.auth).toBeUndefined();

    vi.stubEnv(envName("FORGE_HOSTS"), "github.corp.example=github, git.corp.example=gitea");
    seen = recordAuth();
    await repoFacts(resolveRepo("github.corp.example/o/r"));
    await repoFacts(resolveRepo("git.corp.example/o/r"));
    expect(seen[0]).toMatchObject({ url: "https://github.corp.example/api/v3/repos/o/r", auth: "Bearer ghp_SECRET" });
    expect(seen[1]).toMatchObject({ url: "https://git.corp.example/api/v1/repos/o/r", auth: "token gitea-SECRET" });
  });

  it("trusts an API base the calling code named itself", async () => {
    const seen = recordAuth();
    await repoFacts(resolveRepo("github.acme.example/o/r"), { apiBase: "https://github.acme.example/api/v3" });
    expect(seen[0]!.auth).toBe("Bearer ghp_SECRET");
  });

  it("answers by host when asked by host, and by kind for a caller that names none", () => {
    expect(forgeAuthHeaders("github", "github.attacker.example")).toEqual({});
    expect(forgeAuthHeaders("github", "github.com")).toEqual({ authorization: "Bearer ghp_SECRET" });
    expect(forgeAuthHeaders("gitea", "codeberg.org")).toEqual({});
    // The pre-existing, host-less call: its caller decides where the header goes.
    expect(forgeAuthHeaders("github")).toEqual({ authorization: "Bearer ghp_SECRET" });
  });

  it("reads GH_TOKEN when GITHUB_TOKEN is exported but empty", () => {
    // `GITHUB_TOKEN: ${{ secrets.MISSING }}` exports an empty variable in CI,
    // and `??` took that empty string over the GH_TOKEN the user did set.
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "gho_FROMGH");
    expect(forgeAuthHeaders("github", "github.com")).toEqual({ authorization: "Bearer gho_FROMGH" });
    vi.stubEnv("GITHUB_TOKEN", "  ");
    expect(forgeAuthHeaders("github", "github.com")).toEqual({ authorization: "Bearer gho_FROMGH" });
  });

  it("drops the credential when the API redirects to another origin", async () => {
    // A GitLab behind a moved domain, or a proxy: the token is for the host it
    // was issued to, not for wherever that host points next.
    const seen: { url: string; auth?: string; privateToken?: string }[] = [];
    installFetchMock((url, init) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url, auth: h.authorization, privateToken: h["private-token"] });
      if (url.startsWith("https://gitlab.com/")) return { status: 302, headers: { location: "https://elsewhere.example/api/v4/projects/o%2Fr" } };
      if (url.startsWith("https://api.github.com/repos/old/")) return { status: 301, headers: { location: "https://api.github.com/repositories/42" } };
      return { body: JSON.stringify({ full_name: "o/r", path_with_namespace: "o/r" }), contentType: "application/json" };
    });
    expect(await repoFacts(resolveRepo("gitlab.com/o/r"))).toMatchObject({ fullName: "o/r" });
    expect(seen[1]).toMatchObject({ url: "https://elsewhere.example/api/v4/projects/o%2Fr", auth: undefined, privateToken: undefined });

    // A rename answers with a same-origin redirect, which keeps its token.
    await repoFacts(resolveRepo("github.com/old/name"));
    expect(seen[3]).toMatchObject({ url: "https://api.github.com/repositories/42", auth: "Bearer ghp_SECRET" });
  });
});

describe("why a forge call failed", () => {
  const REF = resolveRepo("github.com/a/b");
  beforeEach(() => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  /** A forge that answers every request with one status, counting them. */
  function answer(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
    return installFetchMock(() => ({ status, body: JSON.stringify(body), contentType: "application/json", headers }));
  }

  it("tells 'no such repository' from every other failure", async () => {
    // Each of these read "is it public, and is github.com a forge?" — the
    // question a user asks about a typo, shown for an outage and a bad token.
    answer(404, { message: "Not Found" });
    const missing = await repoFactsResult(REF);
    expect(missing.status).toBe(404);
    expect(missing.facts).toBeUndefined();
    expect(missing.note).toMatch(/no such repository on github\.com, or it is private/);
    expect(await repoFacts(REF)).toBeUndefined();

    answer(502);
    expect((await repoFactsResult(REF)).note).toMatch(/status 502.*unavailable/);
    answer(500);
    expect((await repoFactsResult(REF)).note).toMatch(/status 500.*unavailable/);
  });

  it("names the token when the forge rejects it, and asks for one when it needs one", async () => {
    // GitHub answers 401 even for a PUBLIC repository when the token is bad.
    vi.stubEnv("GITHUB_TOKEN", "ghp_EXPIRED");
    answer(401, { message: "Bad credentials" });
    const rejected = await repoFactsResult(REF);
    expect(rejected.status).toBe(401);
    expect(rejected.note).toMatch(/rejected GITHUB_TOKEN/);
    expect((await listReleases(REF)).note).toMatch(/rejected GITHUB_TOKEN/);

    vi.stubEnv("GITHUB_TOKEN", "");
    answer(401, { message: "Requires authentication" });
    expect((await repoFactsResult(REF)).note).toMatch(/requires authentication.*GITHUB_TOKEN/);
  });

  it("reports a quota with the time it resets, and asks only once", async () => {
    const reset = Math.floor(Date.UTC(2030, 0, 2, 3, 4, 5) / 1000);
    const spy = answer(403, { message: "API rate limit exceeded for 1.2.3.4." }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) });
    const r = await repoFactsResult(REF);
    expect(r).toMatchObject({ status: 403, rateLimited: true, resetAt: "2030-01-02T03:04:05.000Z" });
    expect(r.note).toMatch(/rate-limited.*2030-01-02T03:04:05\.000Z.*GITHUB_TOKEN/);
    expect(spy).toHaveBeenCalledTimes(1);

    // A 429 is a quota too — and it is not retried, even when it says how long to wait.
    const again = answer(429, { message: "slow down" }, { "retry-after": "1" });
    const search = await searchIssues(resolveRepo("gitlab.com/g/p"), ["x"], "issue");
    expect(search).toMatchObject({ rateLimited: true, status: 429 });
    expect(search.resetAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(again).toHaveBeenCalledTimes(1);
  });

  it("says a network error is one, with its cause, instead of 'status 0'", async () => {
    const spy = vi.fn(async (_url: unknown) => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), { code: "ECONNREFUSED" }) });
    });
    vi.stubGlobal("fetch", spy);
    const r = await repoFactsResult(REF);
    expect(r.status).toBe(0);
    expect(r.note).toMatch(/network error.*api\.github\.com.*ECONNREFUSED/);
    // A refused connection may be a blip: one more try, no more.
    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockClear();
    const s = await searchIssues(REF, ["x"], "issue");
    expect(s.note).toMatch(/network error.*ECONNREFUSED/);
    expect(s.note).not.toMatch(/status 0/);
    // The rename lookup failed; the search that would have failed the same way is not sent.
    expect(spy.mock.calls.every(([u]) => String(u).includes("/repos/"))).toBe(true);
  });

  it("spends one timeout on a black-holed network, not one per request", async () => {
    const spy = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
        }),
    );
    vi.stubGlobal("fetch", spy);
    const s = await searchIssues(REF, ["x"], "issue", { timeoutMs: 30 });
    expect(s.note).toMatch(/timed out after 30 ms/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("still resolves a rename the next time after a failed lookup", async () => {
    // A failure is not an answer: caching it would pin a long-lived server to
    // the old name for the rest of its life.
    answer(503);
    await searchIssues(REF, ["x"], "issue");
    installFetchMock((url) =>
      url.includes("/repos/")
        ? { body: JSON.stringify({ full_name: "a/b-renamed" }), contentType: "application/json" }
        : { body: JSON.stringify({ items: [] }), contentType: "application/json" },
    );
    expect(await canonicalRepo(REF)).toBe("a/b-renamed");
  });
});

describe("each forge's own field names and URLs", () => {
  const json = (o: unknown) => ({ body: JSON.stringify(o), contentType: "application/json" });

  it("asks Gitea for issues only, and searches its pull requests where it can search", async () => {
    // Gitea's /issues lists pull requests too unless `type` says otherwise, and
    // its /pulls endpoint has no `q` at all — the terms were silently dropped.
    const seen: string[] = [];
    installFetchMock((url) => {
      seen.push(url);
      return json([{ number: 9, title: "t", html_url: "https://codeberg.org/o/r/pulls/9", state: "open" }]);
    });
    await searchIssues(resolveRepo("codeberg.org/o/r"), ["memory", "leak"], "issue");
    await searchIssues(resolveRepo("codeberg.org/o/r"), ["memory", "leak"], "pr");
    expect(seen[0]).toMatch(/\/api\/v1\/repos\/o\/r\/issues\?.*type=issues/);
    expect(seen[1]).toMatch(/\/api\/v1\/repos\/o\/r\/issues\?.*type=pulls/);
    expect(seen[1]).toContain("q=memory%20leak");
  });

  it("reads Gitea's repository record by Gitea's names", async () => {
    installFetchMock(() =>
      json({
        full_name: "forgejo/forgejo",
        stars_count: 3000,
        forks_count: 5,
        website: "https://forgejo.org",
        updated_at: "2026-09-01T00:00:00Z",
        licenses: ["GPL-3.0-or-later"],
        default_branch: "forgejo",
      }),
    );
    expect(await repoFacts(resolveRepo("codeberg.org/forgejo/forgejo"))).toMatchObject({
      stars: 3000,
      homepage: "https://forgejo.org",
      pushedAt: "2026-09-01T00:00:00Z",
      license: "GPL-3.0-or-later",
    });
  });

  it("links a GitLab release to its page, not to '[object Object]'", async () => {
    installFetchMock(() =>
      json([
        { name: "v19.4.0", tag_name: "v19.4.0", description: "d", released_at: "2026-01-01", _links: { self: "https://gitlab.com/g/p/-/releases/v19.4.0" } },
      ]),
    );
    const r = await listReleases(resolveRepo("gitlab.com/g/p"));
    expect(r.items[0]!.url).toBe("https://gitlab.com/g/p/-/releases/v19.4.0");
  });

  it("links a tag where each forge serves it, with the name escaped", async () => {
    // GitLab's /releases/tag/<name> redirects to the sign-in page.
    installFetchMock(() => json([{ name: "release/1.0 rc" }]));
    expect((await listTags(resolveRepo("gitlab.com/gnutls/gnutls"))).items[0]!.url).toBe("https://gitlab.com/gnutls/gnutls/-/tags/release/1.0%20rc");
    expect((await listTags(resolveRepo("github.com/a/b"))).items[0]!.url).toBe("https://github.com/a/b/releases/tag/release/1.0%20rc");
  });

  it("asks GitLab for the licence, which it only includes when asked", async () => {
    const seen: string[] = [];
    installFetchMock((url) => {
      seen.push(url);
      return json({ path_with_namespace: "g/p", star_count: 4, license: { key: "mit", name: "MIT License" } });
    });
    const f = await repoFacts(resolveRepo("gitlab.com/g/p"));
    expect(seen[0]).toMatch(/\/projects\/g%2Fp\?license=true$/);
    expect(f).toMatchObject({ license: "MIT License", stars: 4 });
  });

  it("does not report GitHub's NOASSERTION as a licence, or an empty homepage as one", async () => {
    installFetchMock(() => json({ full_name: "a/b", homepage: "", license: { spdx_id: "NOASSERTION", name: "Other" } }));
    const f = await repoFacts(resolveRepo("github.com/a/b"));
    expect(f?.license).toBe("Other");
    expect(f?.homepage).toBeUndefined();
  });
});

describe("mapGithubIssues", () => {
  it("survives the payload's edges: string labels, object labels, missing fields", () => {
    const items = mapGithubIssues(
      [
        { number: 1, title: "A", html_url: "u1", state: "open", labels: ["bug", { name: "p1" }], body: "b", updated_at: "2024-01-01", score: 3 },
        { number: 2, title: "B", html_url: "u2", draft: true, state: "open" },
        null,
        "not an object",
      ] as unknown[],
      "issue",
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ number: 1, labels: ["bug", "p1"], score: 3 });
    // draft stands in for the state, which is what the UI shows.
    expect(items[1]!.state).toBe("draft");
    expect(items[1]!.labels).toEqual([]);
  });
});

describe("searchIssues", () => {
  const REF = resolveRepo("github.com/expressjs/express");

  /** A GitHub whose search answers each query through `answer`, recording the terms it saw. */
  function github(answer: (q: string) => unknown[]) {
    const queries: string[] = [];
    const urls: string[] = [];
    installFetchMock((url) => {
      if (url.includes("/repos/")) return { body: JSON.stringify({ full_name: "expressjs/express" }), contentType: "application/json" };
      urls.push(url);
      const q = new URL(url).searchParams.get("q") ?? "";
      queries.push(q.replace(/^repo:\S+ is:\w+ ?/, ""));
      return { body: JSON.stringify({ items: answer(q) }), contentType: "application/json" };
    });
    return { queries, urls };
  }

  it("lets GitHub order a search by relevance, and a bare listing by recency", async () => {
    // An explicit sort REPLACES GitHub's best-match order, so every search came
    // back by last update while the docs promised relevance.
    const { urls } = github(() => []);
    await searchIssues(REF, ["memory", "leak"], "issue", { relax: false });
    await searchIssues(REF, [], "issue");
    expect(urls[0]).not.toMatch(/[?&]sort=/);
    expect(urls[1]).toMatch(/[?&]sort=updated&order=desc/);
  });

  it("retries once with the most distinctive terms when all of them match nothing", async () => {
    const { queries } = github((q) => (q.includes("the") ? [] : [{ number: 1, title: "Leak", html_url: "u", state: "open" }]));
    const r = await searchIssues(REF, ["the", "memory", "leak", "after", "upgrading", "express5", "label:bug"], "issue");
    expect(queries).toHaveLength(2);
    expect(queries[0]).toBe("the memory leak after upgrading express5 label:bug");
    // A qualifier is a filter the caller chose, not a keyword to trade away.
    expect(queries[1]!.split(" ").sort()).toEqual(["express5", "label:bug", "memory", "upgrading"]);
    expect(r.items).toHaveLength(1);
    expect(r.note).toMatch(/No match for all the terms; relaxed to "express5 upgrading memory label:bug"/);
  });

  it("keeps it to one request when asked to, or when there is nothing to relax", async () => {
    const { queries } = github(() => []);
    await searchIssues(REF, ["memory", "leak", "after", "upgrade"], "issue", { relax: false });
    await searchIssues(REF, ["memory", "leak"], "issue");
    expect(queries).toEqual(["memory leak after upgrade", "memory leak"]);
  });

  it("searches GitHub by canonical slug, following a rename", () => {
    const seen: string[] = [];
    installFetchMock((url) => {
      seen.push(url);
      if (url.includes("/repos/")) return { body: JSON.stringify({ full_name: "expressjs/express-renamed" }), contentType: "application/json" };
      return { body: JSON.stringify({ items: [{ number: 7, title: "Timeout", html_url: "u", state: "open" }] }), contentType: "application/json" };
    });
    return searchIssues(REF, ["timeout"], "issue").then((r) => {
      expect(r.items[0]).toMatchObject({ number: 7, kind: "issue" });
      // A repo that moved still answers on its old name, but every search keyed
      // on that name comes back empty — so the canonical one is used.
      expect(seen.some((u) => u.includes("expressjs%2Fexpress-renamed"))).toBe(true);
    });
  });

  it("reports a quota as rate-limited instead of as 'nothing found'", async () => {
    installFetchMock((url) =>
      url.includes("/repos/")
        ? { body: JSON.stringify({ full_name: "a/b" }), contentType: "application/json" }
        : { status: 403, body: JSON.stringify({ message: "API rate limit exceeded" }), contentType: "application/json" },
    );
    const r = await searchIssues(REF, ["x"], "issue");
    expect(r.rateLimited).toBe(true);
    expect(r.note).toMatch(/GITHUB_TOKEN/);
    expect(r.items).toEqual([]);
  });

  it("uses GitLab's project endpoint, and reports no score because it does not rank", async () => {
    installFetchMock(() => ({
      body: JSON.stringify([{ iid: 3, title: "MR", web_url: "w", state: "opened", description: "d" }]),
      contentType: "application/json",
    }));
    const r = await searchIssues(resolveRepo("gitlab.com/g/p"), ["x"], "pr");
    expect(r.items[0]).toMatchObject({ number: 3, kind: "pr", url: "w" });
    expect(r.items[0]!.score).toBeUndefined();
  });

  it("declines a host that is not a forge, rather than guessing", async () => {
    const r = await searchIssues(resolveRepo("https://example.com/a/b"), ["x"], "issue");
    expect(r.items).toEqual([]);
    expect(r.note).toMatch(/not a forge/);
  });
});

describe("releases and repo facts", () => {
  it("lists releases newest-first with their notes", async () => {
    installFetchMock(() => ({
      body: JSON.stringify([{ name: "v2.0.0", tag_name: "v2.0.0", html_url: "u", body: "notes", published_at: "2024-05-01", prerelease: false }]),
      contentType: "application/json",
    }));
    const r = await listReleases(resolveRepo("github.com/a/b"));
    expect(r.items[0]).toMatchObject({ kind: "release", title: "v2.0.0", body: "notes", state: "released" });
  });

  it("builds no request from a hand-made ref whose names would walk out of the repository", async () => {
    const spy = installFetchMock(() => ({ body: JSON.stringify({ full_name: "x" }), contentType: "application/json" }));
    const base = resolveRepo("github.com/a/b");
    expect(await repoFacts({ ...base, owner: "../..", repo: "user" })).toBeUndefined();
    expect(await repoFacts({ ...base, owner: "%2e%2E", repo: "user" })).toBeUndefined();
    expect((await listReleases({ ...base, owner: "a", repo: ".." })).items).toEqual([]);
    expect((await searchIssues({ ...base, owner: "..", repo: "b" }, ["x"], "issue")).items).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    // A name is one path segment on GitHub: a slash or a query character is
    // sent as data, never as structure.
    await repoFacts({ ...base, owner: "a?b", repo: "c/d" });
    expect(spy.mock.calls[0]![0]).toBe("https://api.github.com/repos/a%3Fb/c%2Fd");
  });

  it("answers 'is this maintained' from the record, not from the README", async () => {
    installFetchMock(() => ({
      body: JSON.stringify({ full_name: "a/b", archived: true, pushed_at: "2019-02-02", stargazers_count: 900, license: { spdx_id: "MIT" }, topics: ["x"] }),
      contentType: "application/json",
    }));
    const f = await repoFacts(resolveRepo("github.com/a/b"));
    expect(f).toMatchObject({ archived: true, pushedAt: "2019-02-02", stars: 900, license: "MIT", topics: ["x"] });
  });
});

describe("package registries", () => {
  it("normalises every shape a registry calls a repository", () => {
    for (const raw of [
      "git+https://github.com/a/b.git",
      "git://github.com/a/b.git",
      "git@github.com:a/b.git",
      "ssh://git@github.com/a/b.git",
      { url: "git+https://github.com/a/b.git" },
      "a/b",
    ]) {
      expect(normalizeRepoUrl(raw), JSON.stringify(raw)).toBe("https://github.com/a/b");
    }
    expect(normalizeRepoUrl("")).toBeUndefined();
    expect(normalizeRepoUrl("not a url")).toBeUndefined();
  });

  it("reads npm, including the deprecation that only lives on the version", async () => {
    installFetchMock(() => ({
      body: JSON.stringify({
        name: "left-pad",
        "dist-tags": { latest: "1.3.0" },
        time: { "1.3.0": "2018-01-01T00:00:00Z" },
        versions: {
          "1.3.0": {
            description: "pads",
            homepage: "https://h.test",
            repository: { url: "git+https://github.com/a/b.git" },
            license: "MIT",
            deprecated: "use String.padStart",
          },
        },
      }),
      contentType: "application/json",
    }));
    const p = await lookupPackage("npm", "left-pad");
    expect(p).toMatchObject({ registry: "npm", version: "1.3.0", repository: "https://github.com/a/b", license: "MIT", deprecated: "use String.padStart" });
  });

  it("reads PyPI project_urls, where the repository actually lives", async () => {
    installFetchMock(() => ({
      body: JSON.stringify({
        info: {
          name: "requests",
          version: "2.32.0",
          summary: "HTTP",
          project_urls: { Source: "https://github.com/psf/requests", Documentation: "https://docs.test" },
          license: "Apache-2.0",
        },
      }),
      contentType: "application/json",
    }));
    const p = await lookupPackage("pypi", "requests");
    expect(p).toMatchObject({ repository: "https://github.com/psf/requests", documentation: "https://docs.test", version: "2.32.0" });
  });

  it("reads crates.io", async () => {
    installFetchMock(() => ({
      body: JSON.stringify({ crate: { name: "serde", max_stable_version: "1.0.200", repository: "https://github.com/serde-rs/serde", downloads: 42 } }),
      contentType: "application/json",
    }));
    expect(await lookupPackage("crates", "serde")).toMatchObject({ registry: "crates", version: "1.0.200", downloads: 42 });
  });

  it("tries registries in turn and stops at the first that knows the name", async () => {
    const seen: string[] = [];
    installFetchMock((url) => {
      seen.push(new URL(url).hostname);
      if (url.includes("pypi.org")) return { body: JSON.stringify({ info: { name: "requests", version: "1" } }), contentType: "application/json" };
      return { status: 404, body: "{}", contentType: "application/json" };
    });
    const p = await resolvePackage("requests");
    expect(p?.registry).toBe("pypi");
    expect(seen).toEqual(["registry.npmjs.org", "pypi.org"]);
  });

  it("returns undefined for a name no registry has", async () => {
    installFetchMock(() => ({ status: 404, body: "{}", contentType: "application/json" }));
    expect(await resolvePackage("definitely-not-a-package-xyz")).toBeUndefined();
  });
});

describe("a registry that could not answer is not a registry that said no", () => {
  const json = (o: unknown, status = 200) => ({ status, body: JSON.stringify(o), contentType: "application/json" });

  it("stops at an outage instead of answering from the next ecosystem", async () => {
    // npm down → `react` resolved to python-react on PyPI.
    const hosts: string[] = [];
    installFetchMock((url) => {
      hosts.push(new URL(url).hostname);
      return url.includes("npmjs") ? json({ error: "unavailable" }, 503) : json({ info: { name: "react", version: "4.3.0" } });
    });
    const r = await resolvePackageResult("react");
    expect(r.facts).toBeUndefined();
    expect(r.note).toMatch(/npm could not be asked \(status 503\)/);
    expect(hosts.every((h) => h === "registry.npmjs.org")).toBe(true);
    expect(await resolvePackage("react")).toBeUndefined();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND registry.npmjs.org"), { code: "ENOTFOUND" }) });
      }),
    );
    expect((await resolvePackageResult("react")).note).toMatch(/npm could not be asked: .*ENOTFOUND/);
    expect(await lookupPackageResult("npm", "react")).toMatchObject({ status: 0, error: expect.stringMatching(/ENOTFOUND/) });
  });

  it("still moves on after a definite 'no such package'", async () => {
    installFetchMock((url) => (url.includes("crates.io") ? json({ crate: { name: "x", max_stable_version: "1.0.0" } }) : json({}, 404)));
    const r = await resolvePackageResult("x");
    expect(r.facts?.registry).toBe("crates");
    expect(r.tried.map((t) => [t.registry, t.status])).toEqual([
      ["npm", 404],
      ["pypi", 404],
      ["crates", 200],
    ]);
  });

  it("declines a registry it does not know, rather than throwing", async () => {
    expect(await lookupPackage("maven" as never, "x")).toBeUndefined();
    expect((await resolvePackageResult("x", { registry: "maven" as never })).note).toMatch(/unknown registry "maven"/);
  });
});

describe("the version asked for is the version answered", () => {
  const json = (o: unknown, status = 200) => ({ status, body: JSON.stringify(o), contentType: "application/json" });

  it("asks PyPI and crates.io for that release, and 404s like npm when there is none", async () => {
    installFetchMock((url) => {
      if (url === "https://pypi.org/pypi/requests/2.0.0/json") return json({ info: { name: "requests", version: "2.0.0" } });
      if (url === "https://crates.io/api/v1/crates/serde/1.0.100")
        return json({ version: { num: "1.0.100", license: "MIT OR Apache-2.0", created_at: "2019-09-01T00:00:00Z" } });
      if (url.startsWith("https://crates.io/api/v1/crates/serde?"))
        return json({ crate: { name: "serde", default_version: "1.0.229", description: "ser/de" } });
      return json({ errors: [{ detail: "Not Found" }] }, 404);
    });
    expect(await lookupPackage("pypi", "requests", "2.0.0")).toMatchObject({ version: "2.0.0" });
    expect(await lookupPackage("crates", "serde", "1.0.100")).toMatchObject({
      version: "1.0.100",
      license: "MIT OR Apache-2.0",
      publishedAt: "2019-09-01T00:00:00Z",
      description: "ser/de",
    });
    expect(await lookupPackage("crates", "serde", "99.0.0")).toBeUndefined();
    expect(await lookupPackage("pypi", "requests", "99.0.0")).toBeUndefined();
  });

  it("does not answer a version from an ecosystem that never confirmed it", async () => {
    // `react --version ^18`: npm said no, and PyPI's latest python-react came back.
    // crates.io answers a version that cannot exist with a 400, which is a "no" too.
    installFetchMock((url) =>
      url.includes("pypi.org/pypi/react/json")
        ? json({ info: { name: "react", version: "4.3.0" } })
        : url.includes("crates.io") && url.includes("%5E18")
          ? json({ errors: [{ detail: "Invalid URL: unexpected character '^'" }] }, 400)
          : json({}, 404),
    );
    const r = await resolvePackageResult("react", { version: "^18" });
    expect(r.facts).toBeUndefined();
    expect(r.note).toMatch(/no registry knows a package called "react" at version \^18 \(a version range is not resolved/);
  });

  it("names the registry's own reason for a failure", async () => {
    installFetchMock(() => json({ errors: [{ detail: "crates.io is in read-only mode" }] }, 503));
    expect((await resolvePackageResult("serde", { registry: "crates" })).note).toMatch(
      /crates could not be asked \(status 503\): crates\.io is in read-only mode/,
    );
  });

  it("takes the default version, not the placeholders crates.io leaves beside it", async () => {
    installFetchMock(() =>
      json({ crate: { name: "serde", default_version: undefined, max_stable_version: null, newest_version: "0.0.0" }, versions: [{ num: "1.0.229" }] }),
    );
    expect((await lookupPackage("crates", "serde"))?.version).toBe("1.0.229");
  });

  it("reports the version a dist-tag stands for, with its date", async () => {
    installFetchMock((url, init) => {
      if (url.endsWith("/typescript/beta")) return json({ name: "typescript", version: "6.0.0-beta" });
      if (url.endsWith("/typescript") && (init?.headers as Record<string, string>)?.range) return json({ time: { "6.0.0-beta": "2026-01-01T00:00:00.000Z" } });
      return json({}, 404);
    });
    expect(await lookupPackage("npm", "typescript", "beta")).toMatchObject({ version: "6.0.0-beta", publishedAt: "2026-01-01T00:00:00.000Z" });
  });
});

describe("PyPI's modern metadata", () => {
  const pypi = (info: Record<string, unknown>) => installFetchMock(() => ({ body: JSON.stringify({ info }), contentType: "application/json" }));

  it("finds the repository under PEP 753's lower-case labels", async () => {
    pypi({
      name: "numpy",
      version: "2.3.0",
      project_urls: { homepage: "https://numpy.org", source: "https://github.com/numpy/numpy", documentation: "https://numpy.org/doc" },
    });
    expect(await lookupPackage("pypi", "numpy")).toMatchObject({
      repository: "https://github.com/numpy/numpy",
      homepage: "https://numpy.org",
      documentation: "https://numpy.org/doc",
    });
    pypi({ name: "pandas", version: "2.3.0", project_urls: { repository: "https://github.com/pandas-dev/pandas" } });
    expect((await lookupPackage("pypi", "pandas"))?.repository).toBe("https://github.com/pandas-dev/pandas");
  });

  it("does not take a documentation site for the repository", async () => {
    pypi({ name: "x", version: "1", home_page: "https://x.readthedocs.io" });
    expect((await lookupPackage("pypi", "x"))?.repository).toBeUndefined();
    pypi({ name: "x", version: "1", home_page: "https://github.com/o/x" });
    expect((await lookupPackage("pypi", "x"))?.repository).toBe("https://github.com/o/x");
  });

  it("reads the licence from PEP 639's expression, never a whole licence text", async () => {
    pypi({ name: "django", version: "5", license: "", license_expression: "BSD-3-Clause" });
    expect((await lookupPackage("pypi", "django"))?.license).toBe("BSD-3-Clause");
    pypi({
      name: "pandas",
      version: "2",
      license: `BSD 3-Clause License\n\n${"Copyright… ".repeat(6000)}`,
      classifiers: ["License :: OSI Approved :: BSD License"],
    });
    expect((await lookupPackage("pypi", "pandas"))?.license).toBe("BSD License");
    pypi({ name: "old", version: "1", license: "MIT" });
    expect((await lookupPackage("pypi", "old"))?.license).toBe("MIT");
  });

  it("says a project that declares itself inactive is", async () => {
    pypi({ name: "x", version: "1", classifiers: ["Development Status :: 7 - Inactive"] });
    expect((await lookupPackage("pypi", "x"))?.deprecated).toMatch(/Inactive/);
  });
});

describe("crates.io, without every version of the crate", () => {
  it("asks for the default version only, and reads its licence and date", async () => {
    // The full record embeds every version: 441 KB for serde, and over the 4 MiB
    // cap for web-sys, which then "did not exist".
    const seen: string[] = [];
    installFetchMock((url) => {
      seen.push(url);
      return {
        body: JSON.stringify({
          crate: { name: "web-sys", default_version: "0.3.77", repository: "https://github.com/rustwasm/wasm-bindgen", downloads: 9 },
          versions: [{ num: "0.3.77", license: "MIT OR Apache-2.0", created_at: "2025-01-01T00:00:00Z", yanked: false }],
        }),
        contentType: "application/json",
      };
    });
    expect(await lookupPackage("crates", "web-sys")).toMatchObject({ version: "0.3.77", license: "MIT OR Apache-2.0", publishedAt: "2025-01-01T00:00:00Z" });
    expect(seen).toEqual(["https://crates.io/api/v1/crates/web-sys?include=default_version"]);
  });
});

describe("normalizeRepoUrl, over the shapes npm still carries", () => {
  it("reads shorthands, any case, ssh forms and fragments", () => {
    expect(normalizeRepoUrl("github:facebook/react")).toBe("https://github.com/facebook/react");
    expect(normalizeRepoUrl("gitlab:gitlab-org/gitlab")).toBe("https://gitlab.com/gitlab-org/gitlab");
    expect(normalizeRepoUrl("bitbucket:o/r")).toBe("https://bitbucket.org/o/r");
    expect(normalizeRepoUrl("GIT+HTTPS://github.com/a/b.git")).toBe("https://github.com/a/b");
    expect(normalizeRepoUrl("git+ssh://git@github.com:npm/cli.git")).toBe("https://github.com/npm/cli");
    expect(normalizeRepoUrl("ssh://git@gitlab.company.com:2222/g/r.git")).toBe("https://gitlab.company.com/g/r");
    expect(normalizeRepoUrl("git+https://github.com/owner/repo.git#main")).toBe("https://github.com/owner/repo");
  });

  it("keeps where a monorepo package lives", async () => {
    installFetchMock(() => ({
      body: JSON.stringify({
        name: "@babel/core",
        version: "7.0.0",
        repository: { url: "https://github.com/babel/babel.git", directory: "packages/babel-core" },
      }),
      contentType: "application/json",
    }));
    expect(await lookupPackage("npm", "@babel/core", "7.0.0")).toMatchObject({
      repository: "https://github.com/babel/babel",
      repositoryDirectory: "packages/babel-core",
    });
  });
});
