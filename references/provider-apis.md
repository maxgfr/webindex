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
- **Only GitHub ranks.** GitLab and Gitea have no search endpoint, so their
  results are recency-ordered and carry **no score** — deliberately, rather than
  inventing one a caller might rank on.
- **`archived` and `pushedAt`** answer "is this maintained" from the record. A
  README that says the project is active is not evidence.

## Quotas

A quota answer is reported as `rateLimited`, never retried. Retrying a quota you
have already exhausted only exhausts it further, and the two failures need
opposite handling: "wait" versus "this request is wrong".

GitHub's anonymous search quota is small. Set `GITHUB_TOKEN` (or
`WEBINDEX_GITHUB_TOKEN`) to raise it; `GITLAB_TOKEN` and `GITEA_TOKEN` work the
same way.

## Getting the source itself

`resolveRepo` parses every identifier shape — a URL in any scheme, `git@host:…`,
`host/owner/repo`, the bare `owner/repo` shorthand, or a local directory — onto
one ref with a stable slug, so all of them share one on-disk clone.

`ensureClone` is shallow and blobless (`--depth 1 --filter=blob:none`): reading a
repository's current state needs neither its history nor every past version of
every file. `ensureHistoryDepth` deepens it when a caller genuinely needs to walk
history, and returns a note rather than throwing when it cannot — a shallow clone
still answers every question about the present.
