import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envName } from "../src/brand.js";
import { apiBase, forgeAuthHeaders, forgeKind, listReleases, mapGithubIssues, repoFacts, resetCanonicalRepoCache, searchIssues } from "../src/forge.js";
import { lookupPackage, normalizeRepoUrl, resolvePackage } from "../src/registry.js";
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
