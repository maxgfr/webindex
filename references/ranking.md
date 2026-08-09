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

**SimHash collapse** — the same CONTENT syndicated across different URLs:
mirrors, scraper copies, a press release reprinted verbatim. Identity dedup
(`dedupeByUrl`, DOI/arXiv) catches the same *resource*; this catches the same
*words*. Texts under `minChars` are never collapsed — too little signal.

**MMR diversification** — the pass that is easiest to misread. It does not remove
redundancy in the near-duplicate sense: eight independent pages can each restate
one argument in their own words, each be genuinely on topic, and collectively
bury the one source saying something else. Relevance ranking has no defence
against that, because every one of them really is relevant.

λ = 0.75 keeps relevance dominant. Diversity breaks ties and demotes redundancy;
it does not promote an off-topic page. And it **reorders only** — every input
comes back exactly once. This changes what you read first, never what you have.

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
tail so a rank-40 cannot outvote a couple of top-tens.

## Scores are pool-relative

`webindex rank` normalises to the pool maximum, so `0.7` means "70% as relevant
as the best thing here" rather than an uncalibrated BM25 magnitude that cannot be
compared across runs. `recencyScore` is relative to the result set rather than to
wall-clock for the same reason: a score computed against "now" changes daily, and
two runs over identical inputs would rank differently.
