# Ranking: a candidate pool becomes a reading order

`webindex rank` and the `rank.js` exports. Deterministic — no model, no network,
same inputs give the same order.

Every function is generic over the caller's own item type: anything with a `url`
and a `score` satisfies `Ranked`, keeps its own fields, and comes back unchanged.
The engine decides reading order; it never sees an evidence model.

## The three passes, and what each is for

**BM25F** — lexical relevance with TF saturation, IDF over the pool, and field
weighting (title ×3, headings ×2, body ×1). Preferred over binary keyword
coverage because a repeated term saturates instead of dominating, so covering
more DISTINCT query terms is what wins.

Below three documents IDF is too noisy to mean anything and degrades to uniform.
A three-result pool where one term happens to be missing from two of them would
otherwise assign that term an enormous weight on no evidence.

Terms are the excerpt matcher's terms: the same folding and stopwords, and an
identifier counts as itself AND its words (`RateLimiter`, `rate_limiter` also
match "rate limiter"). Combining marks stay inside their word, so Devanagari,
Thai or Tamil words survive whole. Chinese and Japanese, written without spaces,
are read as overlapping character bigrams (a lone ideograph as itself) — no
dictionary, still deterministic.

**SimHash collapse** — the same CONTENT syndicated across different URLs:
mirrors, scraper copies, a press release reprinted verbatim. Identity dedup
(`dedupeByUrl`, DOI/arXiv) catches the same *resource*; this catches the same
*words*. Texts under `minChars` are never collapsed — too little signal. Each
dropped copy is reported in `duplicates` with the URL it duplicated: a mirror is
an alternate citation, and the evidence when a collapse was wrong.

**MMR diversification** — the pass that is easiest to misread. It does not remove
redundancy in the near-duplicate sense: eight independent pages can each restate
one argument in their own words, each be genuinely on topic, and collectively
bury the one source saying something else. Relevance ranking has no defence
against that, because every one of them really is relevant.

λ = 0.75 keeps relevance dominant. Diversity breaks ties and demotes redundancy;
it does not promote an off-topic page: every candidate with a positive score is
placed before any candidate scoring zero, and diversity reorders within each
group. And it **reorders only** — every input comes back exactly once. This
changes what you read first, never what you have.

MMR is quadratic in what it diversifies, and diversity is read at the top of a
list. `diversify(items, tokensOf, λ, { window })` diversifies only the `window`
most relevant items and appends the rest in relevance order; `webindex rank`
uses a window of max(5 × limit, 100), which ranks 2 000 documents in about a
second. Without a window the pass is exact.

## The relevance floor

`applyRelevanceFloor` drops candidates whose query-term overlap is empty, or is
only numeric — the false friend where a page's sole connection to the question is
a PR number sharing digits with a year.

It never drops below `floor`. A genuinely thin pool has to survive its own
filter, so the best-ranked "off-topic" candidates are re-admitted until the floor
is met. Inactive on a query with fewer than two terms, or none alphabetic: too
little signal to filter on.

## Fusion

`rrf` merges ranked lists that have no comparable scores — a keyless engine's
"score" and a scholarly API's "relevance" are not the same quantity and cannot be
added. RRF reads POSITION only, so it needs no calibration, and `k` damps the
tail so a rank-40 cannot outvote a couple of top-tens. An item counts once per
list, at its best rank: one engine repeating a URL (a tracking-param variant, a
pagination overlap) is not two engines agreeing on it.

## Deterministic means on every machine

Ties are broken by comparing URLs code unit by code unit, never with the
locale's collation — `localeCompare` reads `LANG`, and two machines would
disagree on the order and on which near-duplicate survives.

## Lanes fused into the ranking

A document may carry its own `score` — its search engine's relevance, say.
`webindex rank` fuses that order with BM25F's by reciprocal rank, with ties in
one lane left for the other to break, so two documents BM25F cannot separate
follow the engine's opinion. It never lifts a document sharing no term with the
question: without a lane that reads meaning, that document stays at zero.

`--dense` (`dense: true` over MCP) is that lane: the dense order `hybridSearch`
computes is fused in the same way before the collapse and MMR, so a page that
never uses the question's words can still rank. With no embedding server the
ranking is BM25F's, plus a note. Off by default, which keeps the ranking
deterministic and offline.

When no document contains any term of the question, `webindex rank` says so on
stderr (and in `note`): the order is then a tie-break, not a ranking.

## Scores are pool-relative

`webindex rank` normalises to the pool maximum, so `0.7` means "70% as relevant
as the best thing here" rather than an uncalibrated BM25 magnitude that cannot be
compared across runs. `recencyScore` is relative to the result set rather than to
wall-clock for the same reason: a score computed against "now" changes daily, and
two runs over identical inputs would rank differently.
