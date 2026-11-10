# Code audit — 2026-11-10

Scope: all of `src/` (37k lines), the hand-written scripts, the test and bench suites, CI and
release configuration, at `ce2c2f4` (v1.37.0). 25 commits, `d605b3b`..`897d625`.

## Summary

1. The codebase is in good shape: strict TypeScript, no runtime dependency, 3509 tests green at
   baseline with 94.8 % statement coverage, a reproducible committed bundle, and no known
   vulnerability (`pnpm audit`). It had been audited once already (`docs/verification.md`).
2. No critical defect was found. 21 bugs were fixed, each with a regression test seen failing
   first; three of them are local-security issues (clone cache permissions, a credential in
   error text, an irreversibility guard that could be read past).
3. Two optimizations were measured: a browser snapshot was quadratic in its refs (5000 refs:
   1472 ms → 3.7 ms), and the two availability probes read a whole answer to look at 4 KiB.
4. The suite ends at 3542 tests, coverage 94.9 / 89.1 / 96.4 / 96.9, typecheck, lint and
   `check:build` green, and the browser changes pass the end-to-end suite on a real Chrome.
5. What is left is design-level and yours to decide: 7 important items and 8 open questions
   below, the first being that any `localhost` page can drive the HTTP MCP server's browser tools.

## Baseline

Run on the untouched tree, Node 24.22.2, pnpm 11.24.0:

| Command | Result |
|---|---|
| `pnpm run typecheck` | pass |
| `pnpm run lint` | pass (220 files) |
| `pnpm test` | 3509 passed, 27 skipped (85 files, 1 skipped) |
| `pnpm run test:coverage` | statements 94.79, branches 88.89, functions 96.28, lines 96.86 |
| `pnpm run check:build` | pass (bundle byte-identical, 289 doc/CLI checks) |
| `pnpm run bench` | ran; numbers used below |
| `pnpm audit` | no known vulnerabilities |

Nothing failed at baseline. One thing was unstable during the work: four tests assert a
wall-clock bound and missed it several times while the machine was heavily loaded (load average
20–49 from unrelated work), each time passing when rerun alone. They are listed under "Minor";
none was changed.

## Bugs fixed

Every row has a test that failed before the fix and passes after, unless the last column says
otherwise.

| Commit | File | Issue | Fix | Test |
|---|---|---|---|---|
| `d605b3b` | `src/text.ts` | A question holding one very long capitalised word held `buildMatcher` for 36 s (200k capitals; `subtokens` backtracks quadratically), and past ~50k characters became a pattern V8 refuses to compile, thrown from `matchLine`. The second half was found by the test written for the first. | `subtokens` leaves a word over 64 characters whole; `expandTokens` skips a keyword over 256. | `tests/text-url.test.ts` |
| `5493de1` | `src/cli.ts` | `webindex_sitemap` passed `max` as given: a client could ask for a million documents of up to 50 MB each. `limit` of search / issues / releases / tags went out raw (`per_page=2.5`). | `max` is a whole number ≤ 50, `limit` ≤ 100, through the existing `toolLimit`. | `tests/cli.test.ts` |
| `cd70ae3` | `src/rank.ts` | `push(...tokens)` on a title or headings field of a few hundred thousand words threw "Maximum call stack size exceeded" and failed the whole ranking. | Tokens appended one by one. | `tests/rank.test.ts` |
| `c75f127` | `src/doc/office.ts` | An `.odt` with `text:c="-1"` or a negative outline level reached `String.repeat` with a negative count; the whole document was refused. A document over the output cap with no line break before it was cut one character short instead of at the cap. | Both counts clamped to ≥ 1; cut at the cap when there is no line break. | `tests/doc-office.test.ts` (the cap case has none: it needs 24 MB of text) |
| `0c797f0` | `src/fetch.ts` | On a video URL a throwing `authorizeUrl` rejected `fetchAndExtract`, and a whole crawl with it; the refusal note always said "not a public address". | Caught and reported as on a page; neutral note. | `tests/fetch-http.test.ts` |
| `3260f77` | `src/fetch.ts` | A PDF or video declared over its cap, behind a URL that does not name one, was taken for a thin page and sent to the browser fallback to be rendered. | Such an answer is not marked as a page. | `tests/fetch-browser.test.ts` |
| `d8c7533` | `src/fetch.ts` | When the retry under the other User-Agent got no answer, its status 0 replaced the anti-bot challenge and the note lost it. | Only an actual answer replaces the challenge. | `tests/challenge.test.ts` |
| `5a37661` | `src/search.ts`, `src/engines.ts`, `src/forge.ts` | `pages` or `limit` = `NaN` ran the page loop zero times: nothing sent, reported as "searched, nothing found"; forge listings sent `per_page=NaN`. | New internal `countOption` (`src/brand.ts`): a whole number ≥ 1, else the default. | `tests/search.test.ts`, `tests/engines.test.ts`, `tests/forge.test.ts` |
| `2a04f3f` | `src/repo.ts` | **Security.** A clone URL's userinfo (`https://user:token@host/…`) was printed in every clone and refresh error, which reach tool output and logs. | The URL is shown without userinfo, and taken out of git's own stderr. | `tests/exec-repo.test.ts` |
| `8496385` | `src/repo.ts`, `src/cache.ts`, new `src/private-dir.ts` | **Security.** The default clone cache (`<tmp>/<brand>-<uid>/repos`) had none of the checks the fetch cache applies: clones of private repositories were created with the umask's mode (0755), a tree planted under a slug was returned as the repository with git then run inside it, and a symlink above it was followed. A hand-built `RepoRef.slug` of `../x` cloned, and ran `rmSync`, outside the root. | The cache's check moved to a shared helper and applied to the clone cache: 0700, no link, owner and mode verified, refused with the reason otherwise. A slug must be one path segment. | `tests/exec-repo.test.ts` (4 cases) |
| `0ef5148` | `src/browser/risk.ts` | **Security (guard).** The irreversibility guard matched a label the page-side collector had cut at 200 characters, so a long `title` or `aria-label` pushed "Delete" out of it; a soft hyphen, a zero-width character or full-width letters inside the word defeated the match. | Collector returns up to 4000 characters; the label is NFKD-folded and its format characters removed before matching. | `tests/browser-risk.test.ts`; end-to-end suite on Chrome |
| `aa2d761` | `src/browser/detect.ts` | A bare `BROWSER_BIN` was looked up by splitting `PATH` on `:` and joining with `/` on every platform, so never found on Windows. | `;`, `\`, `Path` and `.exe` on Windows. | `tests/browser-detect.test.ts` |
| `2c27284` | `src/cli.ts` | Four commands printed a result and then called `process.exit`: `fetch <urls…> --json` with every URL failing sent a pipe 65 536 of 476 673 bytes — truncated JSON. Also `video list`, and the `--json` failures of `video fetch` and `video frames`. | They set the exit code and return (`failAfterOutput`). | `tests/mcp-cli-process.test.ts` (subprocess, piped) |
| `0b42b20` | `src/rank.ts`, `src/video/run.ts` | `fuse()` and `searchVideoRuns` broke ties with `localeCompare`, which depends on `LANG` — the reason `byCodeUnit` exists in the same file. | Code-unit order. | `tests/fuse-coverage.test.ts`, `tests/video-run.test.ts` |
| `379f4d2` | `src/skillkit/usage.ts` | `skill check` crashed on a dangling symlink under `src/`, and recursed on `src/loop -> ..`. | `lstat` first; linked directories not entered. | `tests/skillkit.test.ts` |
| `42e4439` | `src/skillkit/scaffold.ts` | `scaffoldSkill` documents "never overwrites" but only checked through an optional callback; without it a configured `skill.json` was replaced. | Asks the disk by default. | `tests/skillkit.test.ts` |
| `8dd4cd4` | `src/feed.ts` | An XML sitemap's `<loc>` was kept whatever its scheme (`javascript:`, `file:`), unlike a plain-text sitemap's lines; a `file:` child was queued. | Same http(s) test for both forms. | `tests/webprimitives.test.ts` |
| `a30ed13` | `src/cli.ts` | Under a policy, a video directory named `..cache` was refused as "leading outside the root" once it existed (`startsWith("..")`). | Outside is `..`, a path through it, or an absolute path. | `tests/mcp-video.test.ts` |
| `b7ac6d0` | `src/orchestrate/templates.ts` | A caller constant's name was pasted into the emitted workflow as code; a path or hint with a line break escaped its `//` comment. | Names must be identifiers other than the script's own; comment text is kept on one line. | `tests/orchestrate.test.ts` |
| `350ef6c` | `src/video/run.ts` | `--out=` (blank) resolved to the current directory, and video runs were written there. | A blank value is none. | `tests/video-run.test.ts` |
| `40bfd59` | `src/browser/snapshot.ts` | A plain container with a few hundred thousand children could not be snapshotted (`push(...items)`, same failure as in `rank.ts`). Found while benchmarking the renderer. | Items appended one by one. | `tests/browser-snapshot.test.ts` |

## Optimizations

| Commit | Change | Measured |
|---|---|---|
| `68a5372` | `src/browser/snapshot.ts`: a node's ref was found by scanning the whole ref table for every node, so a snapshot was quadratic in its refs — and a single-page app's table only grows. A map is built once per render. | `bench/snapshot.bench.ts` (new), fastest sample: 1000 refs 48.1 ms → 0.47 ms (first snapshot), 17.1 → 0.56 ms (later); 5000 refs 1472 ms → 3.7 ms and 2269 ms → 11.3 ms. Means were noisy (loaded machine); the order of magnitude is not. |
| `4dd9558` | `src/search.ts`, `src/firecrawl.ts`: the SearXNG and Firecrawl probes read the whole answer of whatever listens on `localhost:8888` / `:3002` to compare it with "OK" or look at 4096 characters. They read 4096 bytes and cancel. | Against an 8 MB answer: 8 388 608 bytes read → at most one 64 KiB chunk (asserted in `tests/search.test.ts`, `tests/firecrawl.test.ts`). |
| `d605b3b` | The matcher fix above is also the largest speed-up of the audit. | `buildMatcher` on a question holding a 200k-capital word, as timed by its test: 36 258 ms → 11 ms. |

The existing benches (`rank`, `extract`, `charset`) were rerun and show nothing left that is
worth changing: the hot paths are linear and were tuned in the previous audit. Two candidates
were looked at and deliberately not changed, see "Minor" (host schedule maps, robots.txt per crawl).

## Quality

| Commit | Change |
|---|---|
| `7b522b2` | `src/mcp/stdio.ts` kept its own slot counter and queue beside `src/mcp/slots.ts`. It now uses `toolSlots()`, which hands a freed slot to the head of the queue (the copy let a newly arrived call take it) and lets a cancelled queued call leave at once. Same ceiling, same tests. |
| `897d625` | `scripts/verify-bundle.mjs`: the header promised two checks the script does not make; it now states the ones it does. `scripts/live-check.mjs`: `--jobs abc` started no worker and crashed the report. |

## User-facing behavior changes

All follow from the fixes above; none changes a documented contract except where noted.

- **This push cuts a release** (`fix:` / `perf:` commits → 1.37.1), moves the `v1` tag, and
  consumer skills will repin. One push, one release, as agreed.
- MCP: `webindex_sitemap` `max` is capped at 50 and `limit` on search / issues / releases / tags
  at 100; fractions are truncated. README and the tool description say so.
- Library: `pages` / `limit` that are fractional are floored (`limit: 2.5` now returns 2 results,
  it returned 3).
- Browser: more clicks ask for `confirm` — a long label, hidden characters or full-width letters
  no longer hide an irreversible word.
- `ensureClone`: the **default** clone cache is refused when it, or `<tmp>/<brand>-<uid>`, is a
  symlink, another user's, or writable by others, and is made 0700 otherwise. A directory named
  by `WEBINDEX_REPO_DIR` or by the consumer is taken as given, as before. A slug that is not one
  path segment throws.
- `fetchAndExtract` on a video URL: the refusal note reads "the URL is not authorized" instead of
  "not a public address".
- Sitemaps: a `<loc>` that is not http(s), a relative one included, is dropped.
- Ties in `fuse()` and `video search` come out in code-unit order (upper case before lower)
  rather than the locale's.
- `scaffoldSkill()` without `opts.exists` no longer overwrites; `emitWorkflowScript()` throws on
  a constant name that is not an identifier; `videoRoot("")` is the default directory.
- `subtokens()` returns `[]` for a word over 64 characters.

## Not fixed

### Critical

None found.

### Important

1. **Any page on a `localhost` origin can drive the HTTP MCP server, browser tools included.**
   `src/mcp/protocol.ts:191` accepts every `http://localhost:<port>` origin (a test pins this),
   and `mcp --transport http --browser` needs no token: a page served by any local dev server
   can call `webindex_browser_eval` in the logged-in browser. *Recommendation:* with `--browser`,
   accept only requests with no `Origin` or require `WEBINDEX_MCP_TOKEN`.
2. **`resolveRepo` drops an http(s) port everywhere but the clone URL** (`src/repo.ts:114,163`).
   `https://git.corp:8443/g/r` gets `webUrl`, API base and slug for port 443, and a
   `FORGE_HOSTS` entry with the port never matches, so the token is withheld — or, declared
   without the port, sent to the service on 443. A real bug, not fixed because the fix changes
   the public `RepoRef.host` / slug contract and moves existing clone directories.
   *Recommendation:* carry the port in `host` for http(s) transports, in a minor release with a
   legacy-slug fallback like the one `legacySlugs` already provides.
3. **Queued browser calls hold the server-wide tool slots.** A slot (limit 4) is taken before
   `Host.call` queues on its single run lock (`src/browser/mcp.ts:459`): one
   `webindex_browser_wait` of five minutes plus three more browser calls stall `webindex_fetch`.
   *Recommendation:* exempt the browser tools from the slots (they are already serialised) or
   take the run lock first.
4. **Network capture stores request bodies**, a login POST's password included, in
   `network/<id>.jsonl` (`src/browser/network.ts:191`). Documented ("request bodies up to 4 KiB
   are, as sent"), 0600, and not shown to the model — but it is a credential at rest.
   *Recommendation:* redact `password` / `token` / `secret` keys, or make request bodies opt-in.
5. **`WEBINDEX_FIRECRAWL_KEY` may follow a cross-origin redirect** (`src/firecrawl.ts:68` through
   `httpJson`, which lets `fetch` follow redirects). `src/forge.ts` walks redirects by hand for
   exactly this reason ("older runtimes kept them all"). Not reproduced; depends on the Node 18
   undici in use. *Recommendation:* `redirect: "manual"` and drop the header when the origin changes.
6. **`crawlSite` with `--cross-origin` transcribes every video link it meets**
   (`src/crawl.ts:590` passes no `video: false`): yt-dlp, possibly whisper, inside the crawl's
   worker slots. *Recommendation:* `video: false` in crawls, or an option.
7. **The default video directory has the same weakness the clone cache had.**
   `<tmp>/<brand>-<uid>/video` (`src/video/run.ts:22`) is created without the private-directory
   check. Lower stakes (transcripts of public videos), same planting risk.
   *Recommendation:* open it through `openPrivateTmpDir` (`src/private-dir.ts`), now shared.

### Minor

- **Four wall-clock tests flake on a loaded machine**: `tests/rank.test.ts` "hashes 200 KB of
  prose well under a tenth of a second" (< 100 ms), `tests/text-url.test.ts` "hashes a long
  string in linear time" (< 100 ms), `tests/changed.test.ts` "100k unclosed `<table>` openers"
  (< 2 s), `tests/doc-office.test.ts` "meters table rules for the whole document" (5 s timeout).
  CI is unaffected so far. Recommendation: a looser bound, or a ratio against a calibration loop.
- `src/crawl.ts:34`: `nextFree` / `holdUntil` keep an entry per host ever crawled, for the life
  of a server. About 100 bytes each; not changed because proving it needs a new exported test seam.
- `src/crawl.ts:418` + `src/robots.ts:320`: the robots.txt memo is keyed by authorizer, and each
  crawl builds its own, so robots.txt is fetched again per crawl. Arguably right (a fresh crawl
  re-reads it); one request per origin.
- `src/cache.ts:383`: body and metadata are each renamed atomically, the pair is not. Two
  processes writing one URL can pair A's validators with B's body. Suspected, not reproduced.
- `src/browser/mcp.ts`: the server's long-lived session overwrites what a CLI command wrote to
  `session.json` in between, and does not notice its current tab was closed (no
  `Target.detachedFromTarget` handling). Suspected.
- `src/browser/network.ts:233`: the body-size check uses the wire size; a compressed or cached
  response that decodes past 64 MiB closes the whole CDP connection. Suspected.
- `src/browser/wait.ts:117`: a `/regex/` URL wait compiles the caller's pattern in Node; a
  catastrophic one blocks the event loop.
- `src/browser/state.ts:287`: the cross-process lock is skipped under `NO_WRITE`, so two
  processes can race a launch. The comment says it is deliberate.
- `src/browser/session.ts:194`: `open "#fragment"` passes the URL check and is sent to
  `Page.navigate` unresolved; Chrome probably refuses it. Not verified.
- `src/embed.ts:42`: `EMBED_BATCH` has no upper bound while `httpJson` caps answers at 4 MB; a
  large batch fails with "response too large" and no hint at the cause.
- `src/cli.ts`: a non-URL argument to `fetch`, `robots`, `sitemap`, `feed`, `crawl` or `changed`
  exits 1; the documented taxonomy says a wrong invocation is 2 (open question 6).
- `MAX_IDENT = 64` now exists in both `src/text.ts` and `src/rank.ts`: every export of `text.ts`
  is public API (`export *`), and a test counts the 397 exports, so it was not shared.
- Duplicated helpers across modules: the probe memo (`firecrawl.ts`, `probe.ts`), the manual
  redirect walkers (`fetch.ts`, `forge.ts`), `REDIRECT_STATUS`, `DOT_SEGMENT`, `spentSlackMs`.
  Merging the walkers is a refactor of security-sensitive code; left as a recommendation.
- `src/browser/discovery.ts:135` `newTarget` and `BrowserSession.shutdown` are only called by tests.
- `tests/fetchmock.ts`: its `text()` answers without pulling the stream, so a test cannot see
  how much of a body was read through it (the probe tests use a real `Response` for that reason).
- Dev dependencies are several majors behind (TypeScript 7, vitest 5, tsup 9, `@types/node` 26,
  biome 2.6). No advisory. A tsup/esbuild bump changes the committed bundle's bytes, so it
  deserves its own change with `check:build` as the gate.
- Reported by the review as ambiguous and left alone: `cite.ts:561` treats a plain space as a
  digit-group separator ("In 2019 150 firms" → 2019150); `video/whisper.ts:102` does not refund
  the budget of a timed-out audio download; `pdf/exec.ts:70` assumes constant arguments on the
  Windows `cmd.exe` path; `cache.ts:797` `cache clean --all` removes files by name pattern alone.

## Open questions

1. **`browser close` takes no lock** (`src/browser/cli.ts:581`), unlike every other action, so it
   can shut the browser down under a command that is running. It is also documented as the way
   out of a frozen tab, and a `wait --clear` holds the lock for five minutes. Kill switch by
   design, or should it wait? I left it as it is.
2. **BM25 counts a stem twice when the question holds two of its forms** (`src/rank.ts:441`):
   "encoder encoding" scores `encod` twice and dilutes the proximity bonus, because query terms
   are de-duplicated before stemming (added in 1.34.3). Intended emphasis, or should the stems
   be de-duplicated? Changing it moves scores, so I did not.
3. **Localhost origins with `--browser`** (important #1): keep the any-port rule, or require a
   token / no `Origin` when the browser tools are on?
4. **Request bodies in the capture log** (important #4): keep as documented, redact, or opt-in?
5. **A port in `RepoRef.host`** (important #2): acceptable to change the contract in a minor?
6. **Exit code for a non-URL argument**: move from 1 to 2 to match the taxonomy? Scripts that
   test for 1 would see 2.
7. **Should a crawl read videos at all** (important #6)?
8. **The four wall-clock assertions**: loosen them, or keep them as a strict local ratchet?

## How this was verified

- Per commit: rebuild of the committed bundle, `tsc --noEmit`, `biome ci --error-on-warnings`,
  full `vitest run`. Every commit is GPG-signed.
- Final tree: `pnpm run typecheck`, `pnpm run lint`, `pnpm run test:coverage` (3542 passed, 27
  skipped; 94.86 / 89.05 / 96.38 / 96.90), `pnpm run check:build`.
- `WEBINDEX_E2E_BROWSER=1 pnpm vitest run tests/browser-e2e.test.ts`: 25 passed on a real
  headless Chrome (not part of CI).
- Not run: `pnpm live` (the network campaign), the Docker stack, and anything on Windows — the
  `BROWSER_BIN` fix is covered by its injected-platform test only.
