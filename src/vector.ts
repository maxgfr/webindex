// The vector store this package ships, and the fusion that makes it useful.
//
// Two halves, and only the second one is new work. `webindex semantic up` has
// started Qdrant on :6333 since v1.11, and the ranking layer has had RRF, BM25F
// and MMR since v1.13 — dense retrieval and lexical retrieval were both here,
// with nothing joining them. `hybridSearch` is that join, and it is small
// precisely because both sides already existed.
//
// Why fuse rather than pick: the two retrievers fail in opposite directions.
// BM25F cannot find a page that never uses the question's words, and a dense
// index cannot tell two near-identical paraphrases apart or match an exact
// identifier — a version string, an error code, a symbol name. Reciprocal-rank
// fusion needs no score calibration between them, which matters here because
// a cosine and a BM25 score are not on any common scale and normalising them
// against each other is guesswork that changes with every corpus.
//
// Optional, like every other service: no Qdrant means a note and a lexical-only
// ranking, never an exception.

import { brand, env, envInt } from "./brand.js";
import { cosine, embed } from "./embed.js";
import { httpJson } from "./fetch.js";
import { type Bm25Doc, bm25Score, buildBm25Index, rrf } from "./rank.js";

/** Where the local Qdrant answers. `off` disables the store. */
export function qdrantBase(): string {
  return env("QDRANT") ?? "http://localhost:6333";
}

const clean = (base: string) => base.replace(/\/+$/, "");

const probed = new Map<string, boolean>();

/** Test seam, and the escape hatch for a store that came up mid-run. */
export function resetQdrantProbe(): void {
  probed.clear();
}

/** Whether the local vector store answers. Cached per base for the process, like the Ollama probe. */
export async function probeQdrant(base: string = qdrantBase()): Promise<boolean> {
  const key = clean(base);
  if (key.toLowerCase() === "off") return false;
  const cached = probed.get(key);
  if (cached !== undefined) return cached;
  const r = await httpJson("GET", `${key}/collections`, undefined, { timeoutMs: 2_000, retries: 0 });
  probed.set(key, r.ok);
  return r.ok;
}

export interface VectorPoint {
  /** Qdrant accepts an unsigned integer or a UUID. A caller keying by URL should hash it. */
  id: string | number;
  vector: number[];
  /** Whatever the caller needs back with a hit. The engine never reads it. */
  payload?: Record<string, unknown>;
}

export interface VectorHit {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
}

/**
 * Create a collection if it is not already there.
 *
 * `size` must match the embedding model's dimension, and getting it wrong is
 * not a soft failure — Qdrant rejects every later upsert. Callers derive it from
 * a real embedding rather than hardcoding a number that changes with the model.
 *
 * Distance defaults to cosine because that is what `nomic-embed-text` is trained
 * for and what `cosine()` here computes; a caller using a dot-product model says
 * so explicitly.
 */
export async function ensureCollection(
  name: string,
  size: number,
  opts: { base?: string; distance?: "Cosine" | "Dot" | "Euclid" } = {},
): Promise<{ ok: boolean; note?: string }> {
  const base = clean(opts.base ?? qdrantBase());
  if (base.toLowerCase() === "off") return { ok: false, note: "the vector store is disabled (QDRANT=off)." };
  if (!(await probeQdrant(base))) return { ok: false, note: unreachable(base) };

  const existing = await httpJson("GET", `${base}/collections/${encodeURIComponent(name)}`, undefined, { retries: 0 });
  if (existing.ok) return { ok: true };

  const r = await httpJson("PUT", `${base}/collections/${encodeURIComponent(name)}`, { vectors: { size, distance: opts.distance ?? "Cosine" } });
  return r.ok ? { ok: true } : { ok: false, note: `could not create collection "${name}" at ${base}: ${r.error ?? `status ${r.status}`}` };
}

/** Insert or replace points. Waits for the write, so a search right after sees them. */
export async function upsert(name: string, points: readonly VectorPoint[], opts: { base?: string } = {}): Promise<{ ok: boolean; note?: string }> {
  if (points.length === 0) return { ok: true };
  const base = clean(opts.base ?? qdrantBase());
  if (base.toLowerCase() === "off") return { ok: false, note: "the vector store is disabled (QDRANT=off)." };
  if (!(await probeQdrant(base))) return { ok: false, note: unreachable(base) };

  // `wait=true` matters: without it Qdrant acknowledges before the write is
  // searchable, and an index-then-query in one run finds nothing at all.
  const r = await httpJson("PUT", `${base}/collections/${encodeURIComponent(name)}/points?wait=true`, { points });
  return r.ok ? { ok: true } : { ok: false, note: `upsert into "${name}" failed: ${r.error ?? `status ${r.status}`}` };
}

/** Nearest neighbours of a vector. Empty with a note when the store is absent. */
export async function searchVectors(
  name: string,
  vector: readonly number[],
  opts: { base?: string; limit?: number; filter?: unknown } = {},
): Promise<{ hits: VectorHit[]; note?: string }> {
  const base = clean(opts.base ?? qdrantBase());
  if (base.toLowerCase() === "off") return { hits: [], note: "the vector store is disabled (QDRANT=off)." };
  if (!(await probeQdrant(base))) return { hits: [], note: unreachable(base) };

  const body = { vector: [...vector], limit: opts.limit ?? 10, with_payload: true, ...(opts.filter ? { filter: opts.filter } : {}) };
  const r = await httpJson("POST", `${base}/collections/${encodeURIComponent(name)}/points/search`, body);
  if (!r.ok) return { hits: [], note: `search in "${name}" failed: ${r.error ?? `status ${r.status}`}` };
  const raw = (r.data?.result ?? []) as { id: string | number; score: number; payload?: Record<string, unknown> }[];
  return { hits: raw.map((h) => ({ id: h.id, score: h.score, ...(h.payload ? { payload: h.payload } : {}) })) };
}

/** Drop a collection. Used by a caller that re-indexes from scratch. */
export async function deleteCollection(name: string, opts: { base?: string } = {}): Promise<{ ok: boolean; note?: string }> {
  const base = clean(opts.base ?? qdrantBase());
  if (base.toLowerCase() === "off") return { ok: false, note: "the vector store is disabled (QDRANT=off)." };
  const r = await httpJson("DELETE", `${base}/collections/${encodeURIComponent(name)}`, undefined, { retries: 0 });
  return r.ok ? { ok: true } : { ok: false, note: `could not delete "${name}": ${r.error ?? `status ${r.status}`}` };
}

function unreachable(base: string): string {
  return `no vector store at ${base} — \`${brand().cli} semantic up\` starts Qdrant.`;
}

// ── Hybrid retrieval ────────────────────────────────────────────────────────

/**
 * A document both lanes can read. Deliberately `Bm25Doc` itself rather than a
 * new shape: it already carries the identity (`id`) the fusion keys on and the
 * three fields the lexical lane weights, and inventing a parallel type would
 * make every caller map between two descriptions of one document.
 */
export type HybridDoc = Bm25Doc;

export interface HybridHit<D extends HybridDoc> {
  doc: D;
  /** The fused score. Comparable WITHIN one call and meaningless across calls. */
  score: number;
  /** 1-based rank in each lane, when that lane returned the document at all. */
  lexicalRank?: number;
  denseRank?: number;
}

/**
 * Rank documents against a question with both retrievers, fused.
 *
 * The dense lane needs no vector store: it embeds the question and the
 * documents in one batch and sorts by cosine. That keeps the common case — a
 * pool of candidates already in memory, which is what a research run has —
 * free of any indexing step. A caller with a corpus too large to embed per
 * query indexes it in Qdrant and calls `searchVectors` directly.
 *
 * RRF rather than a weighted sum of scores: a cosine and a BM25 score share no
 * scale, and any normalisation between them is a constant someone has to tune
 * per corpus and will get wrong on the next one. Fusing by RANK needs no such
 * constant, which is why it is the standard answer.
 *
 * With the embedding server absent, this degrades to exactly the lexical
 * ranking the caller would have got from `bm25Score` alone, plus a note. It
 * never throws and never returns fewer documents than it was given.
 */
export async function hybridSearch<D extends HybridDoc>(
  question: string,
  docs: readonly D[],
  opts: { limit?: number; base?: string; model?: string; k?: number } = {},
): Promise<{ hits: HybridHit<D>[]; note?: string }> {
  if (docs.length === 0) return { hits: [] };

  const index = buildBm25Index(question, docs);
  const lexical = [...docs].sort((a, b) => bm25Score(index, b) - bm25Score(index, a));

  const embedded = await embed([question, ...docs.map((d) => [d.title, d.headings, d.body].filter(Boolean).join("\n"))], {
    ...(opts.base !== undefined ? { base: opts.base } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  });

  let dense: D[] = [];
  let note = embedded.note;
  if (embedded.vectors.length === docs.length + 1) {
    const q = embedded.vectors[0] as number[];
    const scored = docs.map((doc, i) => ({ doc, sim: cosine(q, embedded.vectors[i + 1] as number[]) }));
    dense = scored.sort((a, b) => b.sim - a.sim).map((s) => s.doc);
  } else if (!note) {
    note = "the dense lane returned an unexpected number of vectors — ranking lexically only.";
  }

  const lists = dense.length ? [lexical, dense] : [lexical];
  const fused = rrf<D>(lists, (d) => d.id, opts.k ?? envInt("RRF_K", 60));

  const lexRank = new Map(lexical.map((d, i) => [d.id, i + 1]));
  const denseRank = new Map(dense.map((d, i) => [d.id, i + 1]));

  const hits = [...docs]
    .map((doc) => ({
      doc,
      score: fused.get(doc.id) ?? 0,
      ...(lexRank.has(doc.id) ? { lexicalRank: lexRank.get(doc.id) as number } : {}),
      ...(denseRank.has(doc.id) ? { denseRank: denseRank.get(doc.id) as number } : {}),
    }))
    .sort((a, b) => b.score - a.score);

  return { hits: opts.limit ? hits.slice(0, opts.limit) : hits, ...(note ? { note } : {}) };
}
