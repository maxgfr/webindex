import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envName } from "../src/brand.js";
import { have, resetHaveCache, sh, shAsync } from "../src/exec.js";
import { fetchFeed, fetchSitemap } from "../src/feed.js";
import { listTags } from "../src/forge.js";
import { lookupPackage } from "../src/registry.js";
import { ensureClone, ensureHistoryDepth, headCommit, originUrl, repoCacheRoot, resetHistoryDepthCache, resolveRepo, sameCommit } from "../src/repo.js";
import { installFetchMock } from "./fetchmock.js";

afterEach(() => {
  vi.unstubAllGlobals();
  resetHaveCache();
  resetHistoryDepthCache();
});

// `node` is the one executable guaranteed present — this suite is running in it.
const NODE = process.execPath;

describe("running a command", () => {
  it("captures stdout and reports success", () => {
    const r = sh(NODE, ["-e", "process.stdout.write('hello')"]);
    expect(r).toMatchObject({ ok: true, status: 0, stdout: "hello" });
    expect(r.missing).toBeUndefined();
  });

  it("keeps stderr and the exit code on failure", () => {
    const r = sh(NODE, ["-e", "process.stderr.write('boom'); process.exit(3)"]);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("boom");
    // Failed, but PRESENT — the distinction the whole module exists for.
    expect(r.missing).toBeUndefined();
  });

  it("separates 'the command failed' from 'the command is not installed'", () => {
    const r = sh("definitely-not-a-real-binary-xyz", []);
    expect(r.ok).toBe(false);
    expect(r.missing).toBe(true);
    // A caller that cannot tell these apart tells the user to check their
    // network when they need to install something.
    expect(sh(NODE, ["-e", "process.exit(1)"]).missing).toBeUndefined();
  });

  it("passes stdin through", () => {
    const r = sh(NODE, ["-e", "process.stdin.pipe(process.stdout)"], { input: "piped" });
    expect(r.stdout).toBe("piped");
  });

  it("runs in a given directory", () => {
    const r = sh(NODE, ["-e", "process.stdout.write(process.cwd())"], { cwd: "/tmp" });
    expect(r.stdout).toContain("tmp");
  });

  it("answers `have` for a present and an absent binary, and memoises", () => {
    expect(have(process.platform === "win32" ? "cmd" : "sh")).toBe(true);
    expect(have("definitely-not-a-real-binary-xyz")).toBe(false);
    expect(have("definitely-not-a-real-binary-xyz")).toBe(false); // cached
  });
});

describe("running a command without blocking", () => {
  it("resolves with stdout", async () => {
    const r = await shAsync(NODE, ["-e", "process.stdout.write('async hello')"]);
    expect(r).toMatchObject({ ok: true, status: 0, stdout: "async hello" });
  });

  it("reports a non-zero exit with its stderr", async () => {
    const r = await shAsync(NODE, ["-e", "process.stderr.write('nope'); process.exit(2)"]);
    expect(r).toMatchObject({ ok: false, status: 2 });
    expect(r.stderr).toContain("nope");
  });

  it("flags a missing binary rather than hanging", async () => {
    const r = await shAsync("definitely-not-a-real-binary-xyz", []);
    expect(r.missing).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("kills a command that outruns its timeout, and says so", async () => {
    const r = await shAsync(NODE, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 150 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(124);
    expect(r.stderr).toMatch(/timed out after 150ms/);
  });

  it("actually overlaps — that is the reason it exists", async () => {
    const started = Date.now();
    await Promise.all([1, 2, 3].map(() => shAsync(NODE, ["-e", "setTimeout(() => {}, 120)"])));
    // Serially this is ~360ms. A generous ceiling keeps the assertion about
    // overlap rather than about timer precision on a loaded machine.
    expect(Date.now() - started).toBeLessThan(320);
  });
});

describe("git helpers over a real repository", () => {
  it("reads HEAD and origin from a checkout, and nothing from a non-repo", () => {
    const head = headCommit(process.cwd());
    expect(head === undefined || /^[0-9a-f]{40}$/.test(head)).toBe(true);
    expect(headCommit("/tmp")).toBeUndefined();
    expect(originUrl("/tmp")).toBeUndefined();
  });

  it("compares commits, tolerating an absent side", () => {
    expect(sameCommit("abc", "abc")).toBe(true);
    expect(sameCommit("abc", "def")).toBe(false);
    expect(sameCommit(undefined, "abc")).toBe(false);
    expect(sameCommit(undefined, undefined)).toBe(false);
  });

  it("puts clones under the brand's own root", () => {
    expect(repoCacheRoot()).toMatch(/repos$/);
  });

  it("returns the directory itself for a local ref, with no network", async () => {
    expect(await ensureClone(resolveRepo(process.cwd()))).toBe(process.cwd());
  });

  it("refuses to clone something that does not name a repository", async () => {
    await expect(ensureClone(resolveRepo("some free text"))).rejects.toThrow(/does not name a repository/);
  });

  it("says history is unavailable rather than failing the whole call", async () => {
    // /tmp is not a working tree at all. The honest answer is a NOTE saying so,
    // not an exception — and not `{ ok: true }` either, which is what this
    // returned while it only looked for `.git/shallow`: a claim that a directory
    // with no history has all of it. A caller that walks commits needs to be able
    // to tell "nothing to deepen" from "nothing to walk".
    expect(await ensureHistoryDepth("/tmp")).toEqual({ ok: false, note: expect.stringMatching(/not a git working tree/i) });
  });
});

describe("the fetching half of feeds and sitemaps", () => {
  const RSS = `<rss><channel><title>B</title><item><title>One</title><link>https://ex.test/1</link></item></channel></rss>`;

  it("fetches and parses a feed", async () => {
    installFetchMock(() => ({ body: RSS, contentType: "application/rss+xml" }));
    const f = await fetchFeed("https://ex.test/feed.xml");
    expect(f?.items[0]).toMatchObject({ title: "One", url: "https://ex.test/1" });
  });

  it("returns undefined for a feed URL that answers with nothing usable", async () => {
    installFetchMock(() => ({ status: 404, body: "" }));
    expect(await fetchFeed("https://ex.test/feed.xml")).toBeUndefined();
    installFetchMock(() => ({ body: "<html>not a feed</html>" }));
    expect(await fetchFeed("https://ex.test/feed.xml")).toBeUndefined();
  });

  it("follows a sitemap index, bounded by max", async () => {
    installFetchMock((url) => {
      if (url.endsWith("/sitemap.xml"))
        return { body: `<sitemapindex><sitemap><loc>https://ex.test/a.xml</loc></sitemap><sitemap><loc>https://ex.test/b.xml</loc></sitemap></sitemapindex>` };
      return { body: `<urlset><url><loc>${url.replace(".xml", "/page")}</loc></url></urlset>` };
    });
    const s = await fetchSitemap("https://ex.test/anything", { max: 2 });
    // index + one child = the budget. Enumerating a site is the caller's spend.
    expect(s.urls).toHaveLength(1);
    expect(s.sitemaps).toEqual(["https://ex.test/a.xml", "https://ex.test/b.xml"]);
  });

  it("prefers the sitemaps robots.txt names", async () => {
    const seen: string[] = [];
    installFetchMock((url) => {
      seen.push(url);
      return { body: `<urlset><url><loc>https://ex.test/p</loc></url></urlset>` };
    });
    await fetchSitemap("https://ex.test/x", { sitemaps: ["https://ex.test/declared.xml"], max: 1 });
    expect(seen[0]).toBe("https://ex.test/declared.xml");
  });

  it("returns empty for a target that is not a URL", async () => {
    expect(await fetchSitemap("not a url")).toEqual({ urls: [], sitemaps: [] });
  });
});

describe("remaining forge and registry paths", () => {
  it("lists tags, which exist where releases do not", async () => {
    installFetchMock(() => ({ body: JSON.stringify([{ name: "v1.0.0" }, { name: "v1.1.0" }]), contentType: "application/json" }));
    const r = await listTags(resolveRepo("github.com/a/b"));
    expect(r.items.map((i) => i.title)).toEqual(["v1.0.0", "v1.1.0"]);
    expect(r.items[0]!.url).toContain("/releases/tag/v1.0.0");
  });

  it("declines tags for something that is not a repository", async () => {
    const r = await listTags(resolveRepo("free text"));
    expect(r.items).toEqual([]);
    expect(r.note).toMatch(/Cannot list tags/);
  });

  it("returns undefined for a registry that does not know the name", async () => {
    installFetchMock(() => ({ status: 404, body: "{}", contentType: "application/json" }));
    expect(await lookupPackage("npm", "nope-xyz")).toBeUndefined();
    expect(await lookupPackage("npm", "  ")).toBeUndefined();
  });

  it("reads a PyPI release whose files are all yanked as deprecated", async () => {
    installFetchMock(() => ({
      body: JSON.stringify({ info: { name: "x", version: "1" }, urls: [{ yanked: true }, { yanked: true }] }),
      contentType: "application/json",
    }));
    expect((await lookupPackage("pypi", "x"))?.deprecated).toMatch(/yanked/);
  });
});

describe("the branches a forge and a repo ref actually take", () => {
  const json = (o: unknown) => ({ body: JSON.stringify(o), contentType: "application/json" });

  it("handles a ref with an owner but no repo, and a bare host", () => {
    // `host/owner` with nothing after it: an owner and no repo. The forge calls
    // must decline rather than build `/repos/undefined`.
    const partial = resolveRepo("github.com/onlyowner");
    expect(partial.repo).toBe("onlyowner");
    expect(partial.owner).toBeUndefined();
  });

  it("declines every forge call for a ref that names no owner/repo", async () => {
    const bare = resolveRepo("github.com/onlyowner");
    const { searchIssues, listReleases, repoFacts, canonicalRepo } = await import("../src/forge.js");
    expect((await searchIssues(bare, ["x"], "issue")).note).toMatch(/does not name owner\/repo/);
    expect((await listReleases(bare)).note).toMatch(/Cannot list releases/);
    expect(await repoFacts(bare)).toBeUndefined();
    expect(await canonicalRepo(bare)).toBeUndefined();
  });

  it("falls back to owner/repo when the rename lookup fails", async () => {
    const { canonicalRepo } = await import("../src/forge.js");
    installFetchMock(() => ({ status: 500, body: "{}", contentType: "application/json" }));
    expect(await canonicalRepo(resolveRepo("github.com/a/b"))).toBe("a/b");
  });

  it("does not ask GitHub for a canonical name on other forges", async () => {
    const { canonicalRepo } = await import("../src/forge.js");
    const spy = installFetchMock(() => json({}));
    expect(await canonicalRepo(resolveRepo("gitlab.com/g/p"))).toBe("g/p");
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports a plain failure differently from a quota one", async () => {
    const { searchIssues } = await import("../src/forge.js");
    installFetchMock((url) => (url.includes("/repos/") ? json({ full_name: "a/b" }) : { status: 500, body: "{}", contentType: "application/json" }));
    const r = await searchIssues(resolveRepo("github.com/a/b"), ["x"], "issue");
    expect(r.rateLimited).toBeUndefined();
    expect(r.note).toMatch(/failed \(status 500\)/);
  });

  it("reads Gitea's shape too", async () => {
    const { searchIssues } = await import("../src/forge.js");
    installFetchMock(() => json([{ number: 4, title: "G", html_url: "u", state: "open", body: "b", labels: [{ name: "l" }] }]));
    const r = await searchIssues(resolveRepo("codeberg.org/a/b"), ["x"], "issue");
    expect(r.items[0]).toMatchObject({ number: 4, url: "u", labels: ["l"] });
  });

  it("uses a token when one is in the environment, and none when there is not", async () => {
    const { forgeAuthHeaders } = await import("../src/forge.js");
    vi.stubEnv("GITHUB_TOKEN", "");
    expect(forgeAuthHeaders("github")).toEqual({});
    vi.stubEnv("GITHUB_TOKEN", "tok");
    expect(forgeAuthHeaders("github")).toEqual({ authorization: "Bearer tok" });
    vi.stubEnv("GITLAB_TOKEN", "gl");
    expect(forgeAuthHeaders("gitlab")).toEqual({ "private-token": "gl" });
    vi.stubEnv("GITEA_TOKEN", "gt");
    expect(forgeAuthHeaders("gitea")).toEqual({ authorization: "token gt" });
    vi.unstubAllEnvs();
  });

  it("keeps a registry's own repository field when it is already a plain URL", async () => {
    installFetchMock(() => json({ crate: { name: "c", newest_version: "0.1.0", repository: "https://gitlab.com/a/b" } }));
    const p = await lookupPackage("crates", "c");
    // No max_stable_version — falls through to newest_version.
    expect(p).toMatchObject({ version: "0.1.0", repository: "https://gitlab.com/a/b" });
  });

  it("reads an npm package with no deprecation and no repository", async () => {
    installFetchMock(() => json({ name: "p", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { description: "d" } } }));
    const p = await lookupPackage("npm", "p");
    expect(p?.deprecated).toBeUndefined();
    expect(p?.repository).toBeUndefined();
    expect(p?.description).toBe("d");
  });

  it("resolves a large npm package through the compact latest-version endpoint", async () => {
    const seen: { url: string; range?: string }[] = [];
    installFetchMock((url, init) => {
      seen.push({ url, range: (init?.headers as Record<string, string> | undefined)?.range });
      if (url.endsWith("/typescript/latest"))
        return json({
          name: "typescript",
          version: "7.0.2",
          description: "TypeScript is a language for application scale JavaScript development",
          repository: { url: "git+https://github.com/microsoft/TypeScript.git" },
          license: "Apache-2.0",
        });
      if (url.endsWith("/typescript"))
        return json({
          ignored: "the response starts in the middle of the packument",
          time: { "7.0.2": "2026-07-08T15:55:18.431Z" },
          maintainers: [],
        });
      return { status: 413, body: "{}", contentType: "application/json" };
    });

    expect(await lookupPackage("npm", "typescript")).toMatchObject({
      registry: "npm",
      name: "typescript",
      version: "7.0.2",
      repository: "https://github.com/microsoft/TypeScript",
      license: "Apache-2.0",
      publishedAt: "2026-07-08T15:55:18.431Z",
    });
    expect(seen).toEqual([
      { url: "https://registry.npmjs.org/typescript/latest", range: undefined },
      { url: "https://registry.npmjs.org/typescript", range: "bytes=-2097152" },
    ]);
  });

  it("preserves npm publication time for an explicit scoped version", async () => {
    installFetchMock((url, init) => {
      if (url.endsWith("/@types%2Fnode/22.0.0")) return json({ name: "@types/node", version: "22.0.0", license: "MIT" });
      if (url.endsWith("/@types%2Fnode") && (init?.headers as Record<string, string> | undefined)?.range === "bytes=-2097152") {
        return json({ time: { "22.0.0": "2024-07-22T17:04:35.367Z" } });
      }
      return { status: 404, body: "{}", contentType: "application/json" };
    });

    expect(await lookupPackage("npm", "@types/node", "22.0.0")).toMatchObject({
      name: "@types/node",
      version: "22.0.0",
      publishedAt: "2024-07-22T17:04:35.367Z",
    });
  });

  it("does not retry optional npm publication-time recovery", async () => {
    let requests = 0;
    installFetchMock((url) => {
      requests++;
      if (url.endsWith("/left-pad/latest")) return json({ name: "left-pad", version: "1.3.0", license: "WTFPL" });
      if (url.endsWith("/left-pad")) return { status: 503, body: "{}", contentType: "application/json" };
      return { status: 404, body: "{}", contentType: "application/json" };
    });

    expect(await lookupPackage("npm", "left-pad")).toMatchObject({ name: "left-pad", version: "1.3.0" });
    expect(requests).toBe(2);
  });

  it("spends no suffix request when the response already carries the publication time", async () => {
    let requests = 0;
    installFetchMock((url) => {
      requests++;
      // What an embedder's own fetch adapter does: answer the version endpoint
      // with the whole packument, publication times included.
      if (url.endsWith("/left-pad/latest"))
        return json({
          name: "left-pad",
          "dist-tags": { latest: "1.3.0" },
          time: { "1.3.0": "2018-01-01T00:00:00.000Z" },
          versions: { "1.3.0": { license: "WTFPL" } },
        });
      return { status: 404, body: "{}", contentType: "application/json" };
    });

    expect(await lookupPackage("npm", "left-pad")).toMatchObject({
      name: "left-pad",
      version: "1.3.0",
      license: "WTFPL",
      publishedAt: "2018-01-01T00:00:00.000Z",
    });
    // The date was already in hand — buying it again costs a 2 MiB range read
    // against a 2.5s budget, for a value this document already stated.
    expect(requests).toBe(1);
  });

  // The publication-time suffix is the one request in this file whose input is a
  // PARTIAL document by construction: a byte range that opens mid-JSON, or — when
  // a registry or a corporate proxy ignores `Range` altogether — the capped head
  // of a document that was never meant to be cut. Both arrive as malformed JSON
  // whose shape a package author partly controls, since a packument carries that
  // package's own README and manifest fields verbatim. The contract on all of
  // them is the same: the timestamp is optional, the package facts are not.

  it("degrades to no timestamp when a proxy ignores Range and streams the whole packument", async () => {
    let pulled = 0;
    const CHUNK = 64 * 1024;
    // Six megabytes served whole, chunked and with no content-length — the shape
    // a proxy produces when it drops the Range header and re-encodes the body.
    // Nothing in it opens a `time` map, so no timestamp is the honest answer;
    // what matters is that the transfer stops at the cap instead of at the end.
    const oversized = `{"name":"wide","dist-tags":{"latest":"9.9.9"},"readme":"${"z".repeat(6 * 1024 * 1024)}"}`;
    installFetchMock((url, init) => {
      if (url.endsWith("/wide/latest")) return json({ name: "wide", version: "9.9.9", license: "MIT" });
      if (url.endsWith("/wide")) {
        // The header went out; this registry simply answers 200 with everything.
        expect((init?.headers as Record<string, string> | undefined)?.range).toBe("bytes=-2097152");
        return { body: oversized, contentType: "application/json", chunkSize: CHUNK, onPull: (n: number) => (pulled += n) };
      }
      return { status: 404, body: "{}", contentType: "application/json" };
    });

    const p = await lookupPackage("npm", "wide");
    expect(p).toMatchObject({ registry: "npm", name: "wide", version: "9.9.9", license: "MIT" });
    expect(p?.publishedAt).toBeUndefined();
    // At most the 2 MiB cap plus the chunk that crossed it — not the whole 6 MiB.
    expect(pulled).toBeLessThanOrEqual(2 * 1024 * 1024 + CHUNK);
  });

  it("degrades to no timestamp when a proxy declares a packument larger than the cap", async () => {
    let pulled = 0;
    installFetchMock((url) => {
      if (url.endsWith("/declared/latest")) return json({ name: "declared", version: "3.2.1", license: "MIT" });
      if (url.endsWith("/declared"))
        return {
          body: "{}",
          contentType: "application/json",
          headers: { "content-length": String(6 * 1024 * 1024) },
          onPull: (n: number) => (pulled += n),
        };
      return { status: 404, body: "{}", contentType: "application/json" };
    });

    const p = await lookupPackage("npm", "declared");
    expect(p).toMatchObject({ name: "declared", version: "3.2.1", license: "MIT" });
    expect(p?.publishedAt).toBeUndefined();
    // Refused on the declared length: not one byte of the body is read.
    expect(pulled).toBe(0);
  });

  it("survives a suffix whose time map is cut in half", async () => {
    installFetchMock((url) => {
      if (url.endsWith("/halved/latest")) return json({ name: "halved", version: "2.0.0", license: "MIT" });
      // A range that landed inside the `time` map: the key is there, the closing
      // brace never arrives. Parsing it is impossible; throwing is not allowed.
      if (url.endsWith("/halved")) return { body: '0.9.0":{}}},"time":{"1.0.0":"2020-01-01T00:00:00.000Z","2.0.0":"2021-0', contentType: "application/json" };
      return { status: 404, body: "{}", contentType: "application/json" };
    });

    const p = await lookupPackage("npm", "halved");
    expect(p).toMatchObject({ name: "halved", version: "2.0.0", license: "MIT" });
    expect(p?.publishedAt).toBeUndefined();
  });

  it("still reads the time map out of a suffix that opens mid-document", async () => {
    installFetchMock((url) => {
      if (url.endsWith("/mid/latest")) return json({ name: "mid", version: "4.1.0", license: "MIT" });
      // What a real `bytes=-N` range looks like: it starts in the middle of a
      // string, closes braces it never opened, and only then reaches `time`.
      if (url.endsWith("/mid"))
        return {
          body: 'ate":"2019-04-02T10:00:00.000Z"}},"5.0.0":{"dist":{"tarball":"https://r/x.tgz"}}},"time":{"4.1.0":"2020-05-06T07:08:09.000Z"},"users":{}}',
          contentType: "application/json",
        };
      return { status: 404, body: "{}", contentType: "application/json" };
    });

    expect(await lookupPackage("npm", "mid")).toMatchObject({ version: "4.1.0", publishedAt: "2020-05-06T07:08:09.000Z" });
  });

  it("still reads the time map out of a suffix that opens on an escaped character", async () => {
    installFetchMock((url) => {
      if (url.endsWith("/escaped/latest")) return json({ name: "escaped", version: "6.2.0", license: "MIT" });
      // The cut a `bytes=-N` range makes is a byte offset, so it can fall
      // BETWEEN the two bytes of a `\\` escape inside the README string that a
      // packument carries verbatim. The suffix then opens on a character that
      // the document says is escaped: read as an ordinary one it ends the
      // string here, which inverts every quote after it and hides the `time`
      // map that follows.
      if (url.endsWith("/escaped")) return { body: '\\","time":{"6.2.0":"2021-03-04T05:06:07.000Z"},"users":{}}', contentType: "application/json" };
      return { status: 404, body: "{}", contentType: "application/json" };
    });

    expect(await lookupPackage("npm", "escaped")).toMatchObject({ version: "6.2.0", publishedAt: "2021-03-04T05:06:07.000Z" });
  });

  it("scans a suffix full of unclosed time markers in linear time", async () => {
    // 256 KiB of `"time":{` and not one closing brace — every marker opens a
    // candidate object that runs to the end of the body without ever balancing.
    // A README is carried verbatim in a packument, so the bytes that land in
    // this window are partly the package author's to choose.
    //
    // Rescanning to the end per marker is quadratic: this input costs ~7s, and
    // the 2 MiB the cap actually permits costs minutes of a pinned event loop —
    // inside an enrichment step that is budgeted 2.5 seconds and whose whole
    // point is that it may be skipped.
    const decoys = '"time":{'.repeat((256 * 1024) / 8);
    installFetchMock((url) => {
      if (url.endsWith("/decoy/latest")) return json({ name: "decoy", version: "1.0.0", license: "MIT" });
      if (url.endsWith("/decoy")) return { body: decoys, contentType: "application/json" };
      return { status: 404, body: "{}", contentType: "application/json" };
    });

    const started = Date.now();
    const p = await lookupPackage("npm", "decoy");
    const elapsed = Date.now() - started;

    expect(p).toMatchObject({ name: "decoy", version: "1.0.0", license: "MIT" });
    // No timestamp is the honest answer for a body that never closes an object.
    expect(p?.publishedAt).toBeUndefined();
    // One pass over the body finishes in single-digit milliseconds; the bound is
    // loose enough that only a superlinear scan can cross it.
    expect(elapsed).toBeLessThan(1_000);
  }, 60_000);

  it("scans a full-cap suffix in linear time in every start phase", async () => {
    // The worst input the cap actually permits, aimed at the two places where a
    // scan could go superlinear: 2 MiB of `time` markers that DO balance — so
    // the candidate stack drains and every brace pays for the backwards walk
    // over the key — each one held away from its key by a whitespace run. The
    // leading backslash leaves the opening state genuinely ambiguous, so none of
    // the three phases finds a timestamp and all three run the body end to end.
    const CHUNK = `"time":${" ".repeat(55)}{}`;
    const adversarial = `\\${CHUNK.repeat((2 * 1024 * 1024 - 64) / CHUNK.length)}`;
    installFetchMock((url) => {
      if (url.endsWith("/adversarial/latest")) return json({ name: "adversarial", version: "1.0.0", license: "MIT" });
      if (url.endsWith("/adversarial")) return { body: adversarial, contentType: "application/json" };
      return { status: 404, body: "{}", contentType: "application/json" };
    });

    const started = Date.now();
    const p = await lookupPackage("npm", "adversarial");
    const elapsed = Date.now() - started;

    expect(p).toMatchObject({ name: "adversarial", version: "1.0.0", license: "MIT" });
    // Every `time` map here is empty, so no timestamp is the honest answer.
    expect(p?.publishedAt).toBeUndefined();
    // Three linear passes over 2 MiB are tens of milliseconds; the bound is
    // loose enough that only a superlinear scan can cross it.
    expect(elapsed).toBeLessThan(2_000);
  }, 60_000);

  it("gives up on the optional suffix after 2.5 seconds, without retrying", async () => {
    // Pinned on fake timers rather than by waiting: a registry that accepts the
    // connection and then says nothing is exactly what the budget is for, and
    // the clock says precisely when the enrichment abandoned it.
    const answer = installFetchMock(() => json({ name: "slow", version: "1.0.0", license: "MIT" }));
    let requests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        requests++;
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith("/slow/latest")) return answer(input, init);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })));
        });
      }),
    );

    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = lookupPackage("npm", "slow").then((p) => {
        settled = true;
        return p;
      });

      await vi.advanceTimersByTimeAsync(2_400);
      // Still waiting: the budget is 2.5s, not something shorter.
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      // Done: the budget is 2.5s, not httpGet's 20s default nor the 12s the
      // primary lookup uses — and the abort was not followed by a second try.
      expect(settled).toBe(true);

      const p = await pending;
      expect(p).toMatchObject({ name: "slow", version: "1.0.0", license: "MIT" });
      expect(p?.publishedAt).toBeUndefined();
      expect(requests).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats npm's boolean deprecation flag as a notice", async () => {
    installFetchMock(() => json({ name: "p", "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { deprecated: true } } }));
    expect((await lookupPackage("npm", "p"))?.deprecated).toBe("deprecated");
  });
});

describe("cloning, against a real local repository", () => {
  // A file:// remote is a real git clone — same code path as a network one,
  // no network. This is the half of repo.ts that a pure-parsing test cannot
  // reach, and it is the half that shells out.
  let origin: string;
  let cacheDir: string;
  const PREV = process.env[envName("REPO_DIR")];

  beforeEach(() => {
    origin = mkdtempSync(join(tmpdir(), "wi-origin-"));
    cacheDir = mkdtempSync(join(tmpdir(), "wi-clones-"));
    process.env[envName("REPO_DIR")] = cacheDir;
    for (const args of [
      ["init", "-q", "-b", "main"],
      ["config", "user.email", "t@t.test"],
      ["config", "user.name", "T"],
    ])
      sh("git", ["-C", origin, ...args]);
    writeFileSync(join(origin, "README.md"), "# fixture\n");
    sh("git", ["-C", origin, "add", "-A"]);
    sh("git", ["-C", origin, "commit", "-q", "-m", "first"]);
  });

  afterEach(() => {
    if (PREV === undefined) delete process.env[envName("REPO_DIR")];
    else process.env[envName("REPO_DIR")] = PREV;
    rmSync(origin, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("clones into the cache and reuses the clone on the next call", async () => {
    const ref = resolveRepo(`file://${origin}`);
    const dir = await ensureClone(ref);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect(dir.startsWith(cacheDir)).toBe(true);

    // Second call must not re-clone — the marker proves it is the same tree.
    writeFileSync(join(dir, "MARKER"), "x");
    expect(await ensureClone(ref)).toBe(dir);
    expect(existsSync(join(dir, "MARKER"))).toBe(true);
  });

  it("leaves a clone that already has everything alone", async () => {
    expect(await ensureHistoryDepth(origin)).toEqual({ ok: true });
  });

  it("undoes a blobless FILTER, not just a shallow depth", async () => {
    const dir = await ensureClone(resolveRepo(`file://${origin}`));
    // Pinned explicitly rather than relying on what the local transport
    // negotiated: the state under test is a clone whose depth is fine and whose
    // object database is missing blob content. `ensureClone` produces exactly
    // that against a real remote.
    sh("git", ["-C", dir, "config", "remote.origin.partialclonefilter", "blob:none"]);

    expect(await ensureHistoryDepth(dir)).toEqual({ ok: true });
    // The filter is gone. Leaving it in place was the real failure of the
    // version that only looked for `.git/shallow`: history became walkable while
    // every `git log -S` comparison still fetched each blob over the wire, one
    // promisor request at a time.
    expect(sh("git", ["-C", dir, "config", "remote.origin.partialclonefilter"]).stdout.trim()).toBe("");
  });

  it("picks up new upstream commits with refresh", async () => {
    const ref = resolveRepo(`file://${origin}`);
    const dir = await ensureClone(ref);
    expect(existsSync(join(dir, "SECOND.md"))).toBe(false);

    writeFileSync(join(origin, "SECOND.md"), "more\n");
    sh("git", ["-C", origin, "add", "-A"]);
    sh("git", ["-C", origin, "commit", "-q", "-m", "second"]);

    await ensureClone(ref, { refresh: true });
    expect(existsSync(join(dir, "SECOND.md"))).toBe(true);
  });

  it("reads HEAD and origin back out of the clone", async () => {
    const dir = await ensureClone(resolveRepo(`file://${origin}`));
    expect(headCommit(dir)).toMatch(/^[0-9a-f]{40}$/);
    expect(originUrl(dir)).toContain(origin);
    expect(sameCommit(headCommit(dir), headCommit(origin))).toBe(true);
  });

  it("reports both attempts when a clone cannot succeed", async () => {
    const missing = resolveRepo(`file://${join(origin, "nope")}`);
    await expect(ensureClone(missing)).rejects.toThrow(/git clone failed[\s\S]*attempt 1[\s\S]*attempt 2/);
  });

  it("names a missing git binary instead of reporting a clone failure", async () => {
    // "there is no git on this machine" and "git could not clone that" want
    // completely different answers, and a caller told the second when the first
    // is true goes looking at their network.
    const PATH = process.env.PATH;
    process.env.PATH = mkdtempSync(join(tmpdir(), "wi-nopath-"));
    resetHaveCache();
    try {
      await expect(ensureClone(resolveRepo(`file://${origin}`))).rejects.toThrow(/git is not installed or not on PATH/);
    } finally {
      process.env.PATH = PATH;
      resetHaveCache();
    }
  });

  it("clones a named branch", async () => {
    sh("git", ["-C", origin, "checkout", "-q", "-b", "side"]);
    writeFileSync(join(origin, "SIDE.md"), "s\n");
    sh("git", ["-C", origin, "add", "-A"]);
    sh("git", ["-C", origin, "commit", "-q", "-m", "side"]);
    sh("git", ["-C", origin, "checkout", "-q", "main"]);

    const dir = await ensureClone(resolveRepo(`file://${origin}`), { branch: "side" });
    expect(existsSync(join(dir, "SIDE.md"))).toBe(true);
  });

  it("deepens a shallow clone so history can be walked", async () => {
    writeFileSync(join(origin, "b.md"), "b\n");
    sh("git", ["-C", origin, "add", "-A"]);
    sh("git", ["-C", origin, "commit", "-q", "-m", "second"]);

    const dir = await ensureClone(resolveRepo(`file://${origin}`));
    expect(existsSync(join(dir, ".git", "shallow"))).toBe(true);
    const r = await ensureHistoryDepth(dir);
    expect(r.ok).toBe(true);
    // Two commits reachable once it is no longer shallow.
    expect(sh("git", ["-C", dir, "rev-list", "--count", "HEAD"]).stdout.trim()).toBe("2");
  });
});
