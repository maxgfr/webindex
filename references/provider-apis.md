# Forges and package registries

Everything here is **keyless by default**. A token raises the quota; nothing
requires one.

## Resolve the name first

`webindex package <name>` is the cheapest useful request in the engine. One
lookup gives the repository, homepage, documentation URL, current version,
licence and — the thing nothing else surfaces — whether the package is
**deprecated**.

Reach for it before searching the web for a library. `"<name> official
documentation"` is a guess that ranks a blog above a changelog, and it is how a
tool ends up documenting a fork, an abandoned mirror or a name-squat.

| Registry | Notes |
|---|---|
| npm | Deprecation lives on the **version**, not the package — a package whose latest release is deprecated looks healthy at the top level. |
| PyPI | The repository is in `project_urls`, not `home_page`, which is usually a docs site. |
| crates.io | Publishes download counts. |

Order without `--registry` is npm → PyPI → crates, because npm has the most
names. Pass `--registry` when you know the ecosystem.

## Forges

`repo`, `issues`, `prs`, `releases` work against GitHub, GitLab and Gitea.

- **Renames are followed.** A moved repository still answers on its old name, but
  every search keyed on that name returns nothing. The canonical `owner/repo` is
  resolved once and used for the search.
- **GitHub Enterprise** serves `<host>/api/v3`; github.com serves
  `api.github.com`. Getting this wrong is a 404 that reads like "no such repo".
- **Only GitHub ranks.** A search with terms comes back best match first, with
  GitHub's `score`; a listing with no terms, most recently updated first. GitLab
  and Gitea have no search endpoint, so their results are recency-ordered and
  carry **no score** — deliberately, rather than inventing one a caller might
  rank on.
- **Every term must match**, so a natural five-word description often matches
  nothing. Then the search runs once more with the most distinctive half of the
  words (qualifiers such as `label:bug` kept), and `note` says what it was
  relaxed to. `relax: false` keeps it to one request.
- **`archived` and `pushedAt`** answer "is this maintained" from the record. A
  README that says the project is active is not evidence.

## Quotas

A quota answer is reported as `rateLimited`, never retried, with `resetAt` when
the forge says when it ends. Retrying a quota you have already exhausted only
exhausts it further, and the two failures need opposite handling: "wait" versus
"this request is wrong". Only a gateway error (502/503/504) or a dropped
connection gets one more try; a timeout gets none, so a dead network costs one
timeout per command.

## When a call fails, it says which failure

`repo`, `issues`, `prs`, `releases` and `tags` name the cause, because each
wants a different response: **no such repository** (or a private one), a
**rejected token** (named — GitHub answers 401 even for a public repository when
the token is bad), a **quota** and when it resets, the forge **unavailable**, or
a **network error** with its cause. `repoFactsResult` and every `ForgeResult`
carry the same `note` and `status` for a library caller.

GitHub's anonymous search quota is small. Set `GITHUB_TOKEN` (or `GH_TOKEN`, or
`WEBINDEX_GITHUB_TOKEN`) to raise it; `GITLAB_TOKEN` and `GITEA_TOKEN` work the
same way.

## Where a token goes

A token is sent to **its own host only**: `GITHUB_TOKEN` to github.com
(`api.github.com`), `GITLAB_TOKEN` to gitlab.com. Never to a host that merely
looks like a forge — anyone can register `github.<anything>`, and a repository
string in a prompt is enough to point an agent at one.

A self-hosted forge receives its token once you declare it:

```bash
export WEBINDEX_FORGE_HOSTS="ghe.corp.example=github,salsa.debian.org=gitlab,codeberg.org=gitea"
```

Each listed host is queried as that forge (so a GitLab whose name does not say
"gitlab" works) and gets that forge's token. `GITEA_TOKEN` has no default host at
all: Codeberg is one Gitea among many. A library caller that passes `apiBase`
has named the host itself, so the token goes there too.

Every token travels in the `Authorization` header — GitLab's as a Bearer — and is
dropped the moment a redirect leaves the API's origin.

## Getting the source itself

`resolveRepo` parses every identifier shape — a URL in any scheme, `git@host:…`,
`host/owner/repo`, the bare `owner/repo` shorthand, or a local directory — onto
one ref with a stable slug, so all of them share one on-disk clone.

`ensureClone` is shallow and blobless (`--depth 1 --filter=blob:none`): reading a
repository's current state needs neither its history nor every past version of
every file. `ensureHistoryDepth` deepens it when a caller genuinely needs to walk
history, and returns a note rather than throwing when it cannot — a shallow clone
still answers every question about the present.
