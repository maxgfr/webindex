# The semantic layer — embeddings, vectors, and why fuse

`semantic up` has started Ollama and Qdrant and pulled `nomic-embed-text` since
v1.11. Until v1.15 nothing in the engine could call either: the containers were
provisioned and unreachable.

Everything here is **local and keyless**. No account, no API key, and no text
leaves the machine — which is what makes it usable on a private repository or an
unpublished draft, where a hosted embedding API is simply not an option.

## Getting the stack up

```bash
webindex semantic up     # Qdrant :6333, Ollama :11434, and the model pulled once
webindex doctor          # both should say "answering at …"
webindex embed "hello"
webindex embed --docs passages.json --json   # a JSON array of texts, one run, input order
```

`WEBINDEX_OLLAMA=off` and `WEBINDEX_QDRANT=off` disable each half for a sandbox
or an air-gapped run.

## Embedding

```ts
const { vectors, model, note } = await embed(texts);
```

One vector per input, **in input order**. That order is the whole contract: a
vector carries no identity, so a race-ordered result attaches every one to the
wrong text, silently. A failed batch invalidates the whole call rather than
returning a result with holes — a caller indexing by position would attach the
wrong vector to every text after the gap, and nothing downstream could detect
it.

Absent is not an error: `vectors` comes back empty with a `note` naming the
command that starts the service. A "not answering" verdict is asked again after
30 seconds, so a server started mid-run — under a long-lived `webindex mcp` —
is found without a restart. Once one batch has failed, the batches still queued
are not sent: the result is void either way. A failure's note quotes what the
server said, and suggests `ollama pull <model>` only when the model is missing.

`cosine(a, b)` returns **0**, not NaN, for a zero-magnitude vector. NaN compares
false whichever way a comparator is written, so one degenerate embedding would
sort to the bottom of one ranking and the top of another.

## The vector store

`ensureCollection` · `upsert` · `searchVectors` · `deleteCollection`, over plain
HTTP. `size` must match the model's dimension — derive it from a real embedding
rather than hardcoding a number that changes with the model. `ensureCollection`
refuses, by name, an existing collection of another size or distance (built by
another model) instead of letting every later upsert fail with a 400. `upsert`
waits for the write, or an index-then-query in one run finds nothing, and sends
the points in chunks of `WEBINDEX_QDRANT_UPSERT_BATCH` (256): one request of a
few thousand vectors is over Qdrant's 32 MB request cap.

## Hybrid retrieval, and why RRF

```ts
const { hits, note } = await hybridSearch(question, docs, { limit: 10 });
```

The two retrievers fail in **opposite directions**:

- BM25F cannot find a page that never uses the question's words.
- A dense index cannot tell near-identical paraphrases apart, and cannot match
  an exact identifier — a version string, an error code, a symbol name.

Fused by reciprocal rank, not by a weighted sum of scores. A cosine and a BM25
score share no scale, and any normalisation between them is a constant someone
tunes per corpus and gets wrong on the next one. Fusing by RANK needs no such
constant.

Each hit reports `lexicalRank` and `denseRank`, so "why did this rank" has an
answer. Fusion is by position in `docs`, so two documents sharing an id (one URL
from two engines) keep their own ranks.

The dense lane needs no vector store: it embeds the question and the documents
in one batch and sorts by cosine, which keeps the common case — a candidate pool
already in memory — free of any indexing step. A corpus too large to embed per
query goes into Qdrant and uses `searchVectors` directly.

With no embedding server, `hybridSearch` degrades to exactly the lexical ranking
`bm25Score` alone would have given, plus a note. It never throws and never
returns fewer documents than it was given.

`webindex rank --dense` (and `webindex_rank` with `dense: true`) fuses this dense
lane into the full ranking pipeline, before the near-duplicate collapse and MMR
that `hybrid` skips.

## Task prefixes

Most local embedding models were trained with a task prefix, and
`nomic-embed-text` — the default — requires one: `search_query: ` before a
question, `search_document: ` before a passage. Without them both sides are
embedded as the same task and the dense lane quietly under-performs.
`embedPrefixes(model)` holds a small table (nomic, mxbai, snowflake-arctic, e5;
none for a model it does not know), overridden by `WEBINDEX_EMBED_QUERY_PREFIX`
and `WEBINDEX_EMBED_DOC_PREFIX` (`none` for no prefix). `hybridSearch` applies
them — `queryPrefix` / `docPrefix` override them per call — and embeds at most
`WEBINDEX_EMBED_MAX_CHARS` (8000) of each document: the model truncates to its
context window anyway. `embed` itself never adds a prefix; a caller indexing
into Qdrant applies the same pair when it indexes and when it queries.
