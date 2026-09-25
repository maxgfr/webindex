# Discovery: turning a question into candidate URLs

`webindex search` is a **cascade**, not a fan-out. Rungs are tried in order and
the first with hits wins. Querying five engines at once and fusing the pools is a
ranking decision, and ranking belongs to the caller — `webindex rank` has the
parts.

## The rungs, in order

| Rung | Needs | Why it sits here |
|---|---|---|
| **SearXNG** | the local container (`webindex searxng up`) | Cheapest, and aggregates many upstreams in one request. Reports `unresponsive_engines`, so "throttled" and "nothing found" stay distinguishable. |
| **DuckDuckGo** (`ddg`) | nothing | Keyless HTML. Broad, and the markup moves. |
| **DuckDuckGo Lite** (`ddglite`) | nothing | A flat table with far simpler markup — it tends to survive layout changes the main endpoint does not. |
| **Mojeek** (`mojeek`) | nothing | Its **own crawler and index**, not a Bing/Google reseller. It answers when the DDG family has nothing. |
| **Firecrawl** | the local container | Last, because its keyless `/search` delegates to SearXNG anyway — reaching for it early pays for a browser stack to arrive at the same index. |

`--engine <name>` restricts the keyless rung to that one engine; SearXNG and
Firecrawl still run before and after it. `--engine off` (or
`WEBINDEX_ENGINES=off`) disables the keyless rungs entirely.

Firecrawl's `/search` is held to the same rules as the other rungs: the limit is
kept inside the 1–100 it accepts, its hits are deduped and trimmed, and `--lang`
and `--region` are sent as its `lang` and `country` (without them it answers in
US English). An instance that only serves `/v1` is asked without the v2-only
`sources` field, and a request it rejects says so, with its reason, instead of
calling it unreachable.

SearXNG and Firecrawl are probed before they are asked. On the localhost
defaults the probe checks it is really them — SearXNG's `/healthz` answers `OK`,
so a notebook server on 8888 is not taken for it; a base you name with
`--searxng`/`--firecrawl` only has to answer. A "down" verdict is remembered for
30 seconds and an "up" one for the process, so a long-running `webindex mcp`
finds a stack started after its first search. A SearXNG that answers `/search`
with a 403 has `format: json` switched off, and the note says so.

## What "no results" means

Different facts, kept separate on purpose:

- **Nothing found** — a rung answered and the query genuinely has no hits.
- **Nothing searched** — every rung that was tried refused or failed: blocked as
  a bot, rate-limited, offline, timed out, a 5xx. Each engine's note is kept, and
  the closing note says nothing was searched rather than "no results".
- **Nothing running** — no local stack, and the keyless rungs are off. The note
  names the container and how to start it, and names the switch that turned a
  rung off (`--searxng off`, a misspelt `WEBINDEX_ENGINES`).

A caller that collapses these reports the wrong one, and a model told "no results"
learns the answer does not exist.

The same facts come back as data. `--json` (and `search()` in the library) adds
`rungs` — each rung's `outcome`: `hits`, `empty`, `throttled`, `blocked`,
`unreachable` (nothing answered), `error` (something answered, but not with
results), `disabled` or `not-tried` — and `searched`, true only when some rung
answered (`hits` or `empty`). `webindex_search` ends its text with the same as
one line: `rungs: searxng=unreachable ddg=blocked ddglite=hits(10) firecrawl=not-tried`.

## The parsers rot

DDG, DDG Lite and Mojeek are scraped from HTML, so their layout is somebody
else's decision and changes without warning. Each parser BLOCK-MATCHES from one
result anchor to the next rather than zipping two parallel lists by index —
because when a row is skipped (an ad, the engine's own domain), an index-zip
shifts every snippet onto the wrong result and the output still looks plausible.

Real result pages captured from each engine (`tests/fixtures/engines/`, trimmed
to a few results) are the canary in `tests/engines.test.ts`. When an engine
changes its markup, that suite fails loudly instead of the engine quietly
returning nothing. They have to be real captures: a hand-written DDG Lite
fixture quoted `class="result-snippet"` with double quotes, the live page uses
single ones, and every Lite snippet came back empty while the suite stayed green.

## Politeness, and how long it takes

- No rung retries a request: in a cascade the next rung is the retry, and asking
  an engine that just answered 429 again is how a throttle becomes a block.
- `--timeout <ms>` (`timeoutMs` in the library, 45 s under `webindex_search`)
  bounds the whole search. No rung or page starts after it, each request's own
  timeout is capped to what is left, and the note names the rungs never reached.
  A library caller can also pass an `AbortSignal`, checked before every rung and
  page.
- `WEBINDEX_PAGE_DELAY_MS` (350) between result pages.
- DuckDuckGo's next page is the one its own "Next" form names (offset `s`, `dc`
  and the `vqd` token), and a page without one is the last. Mojeek's offset is
  arithmetic (1-based, 10 a page).
- Pagination stops as soon as a page adds no NEW canonical URL — an engine that
  ignores the offset parameter costs one extra request, not one per page.
- With no `--lang` or `--region`, DuckDuckGo is asked for `kl=wt-wt` (all
  regions) and Mojeek for no locale: nothing is biased toward one country.
- `webindex robots <url>` before enumerating a site. It is advisory and `fetch`
  does not consult it: following a citation is not crawling.
