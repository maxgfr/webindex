# The semantic layer — embeddings, vectors, and why fuse

`semantic up` has started Ollama and Qdrant and pulled `nomic-embed-text` since
v1.11. Until v1.19 nothing in the engine could call either: the containers were
provisioned and unreachable.

Everything here is **local and keyless**. No account, no API key, and no text
leaves the machine — which is what makes it usable on a private repository or an
unpublished draft, where a hosted embedding API is simply not an option.

## Getting the stack up

```bash
webindex semantic up     # Qdrant :6333, Ollama :11434, and the model pulled once
webindex doctor          # both should say "answering at …"
webindex embed "hello"
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
command that starts the service.

`cosine(a, b)` returns **0**, not NaN, for a zero-magnitude vector. NaN compares
false whichever way a comparator is written, so one degenerate embedding would
sort to the bottom of one ranking and the top of another.

## The vector store

`ensureCollection` · `upsert` · `searchVectors` · `deleteCollection`, over plain
HTTP. `size` must match the model's dimension — derive it from a real embedding
rather than hardcoding a number that changes with the model. `upsert` waits for
the write, or an index-then-query in one run finds nothing.

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
answer.

The dense lane needs no vector store: it embeds the question and the documents
in one batch and sorts by cosine, which keeps the common case — a candidate pool
already in memory — free of any indexing step. A corpus too large to embed per
query goes into Qdrant and uses `searchVectors` directly.

With no embedding server, `hybridSearch` degrades to exactly the lexical ranking
`bm25Score` alone would have given, plus a note. It never throws and never
returns fewer documents than it was given.
