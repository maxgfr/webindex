// Turning text into vectors, with the local embedding server this package
// already ships.
//
// `webindex semantic up` has started Ollama and pulled `nomic-embed-text` since
// v1.11, and `embedModel()` has named the model in src/stack.ts since then —
// but nothing in this engine could ever call it. The container was provisioned
// and unreachable: a consumer wanting an embedding had to write its own client
// against a service webindex started for it.
//
// Local by default, and that is the point. No key, no account, and no text
// leaves the machine — which is what makes it usable on a private repository or
// an unpublished draft, where a hosted embedding API is simply not an option.
//
// Absent is not an error. Like Firecrawl and SearXNG before it, a missing
// service degrades to a note: the caller gets `vectors: []` and a sentence
// saying which command would start it, and decides for itself whether to fall
// back to lexical ranking.

import { brand, env, envInt } from "./brand.js";
import { httpJson } from "./fetch.js";
import { mapLimit } from "./pool.js";
import { embedModel } from "./stack.js";

/** Where the local Ollama answers. `off` disables the layer entirely. */
export function ollamaBase(): string {
  return env("OLLAMA") ?? "http://localhost:11434";
}

/** Whether the caller has turned embeddings off outright. */
export function embeddingsDisabled(): boolean {
  return ollamaBase().toLowerCase() === "off";
}

/** How many embedding requests may be in flight. Local, so a small number is right. */
function embedConcurrency(): number {
  return Math.max(1, envInt("EMBED_CONCURRENCY", 4));
}

/** How many texts go in one request. Ollama batches natively; this caps the payload. */
function embedBatch(): number {
  return Math.max(1, envInt("EMBED_BATCH", 16));
}

export interface EmbedResult {
  /** One vector per input, in input order. Empty when the service did not answer. */
  vectors: number[][];
  /** The model that produced them, for a caller that stores vectors alongside their model. */
  model: string;
  /** Why the result is empty, when it is. Never thrown — the layer is optional. */
  note?: string;
}

let probed: boolean | undefined;

/** Test seam, and the escape hatch for a server that came up mid-run. */
export function resetOllamaProbe(): void {
  probed = undefined;
}

/**
 * Whether the local embedding server answers.
 *
 * Cached for the process: a probe per call would double the request count of
 * every batch, and a server that goes away mid-run shows up as a failed embed
 * anyway.
 */
export async function probeOllama(base: string = ollamaBase()): Promise<boolean> {
  if (base.toLowerCase() === "off") return false;
  if (probed !== undefined) return probed;
  const r = await httpJson("GET", `${base.replace(/\/+$/, "")}/api/tags`, undefined, { timeoutMs: 2_000, retries: 0 });
  probed = r.ok;
  return probed;
}

/**
 * Embed a batch of texts.
 *
 * Order is preserved and matters: callers index their documents by position,
 * and a race-ordered result would attach every vector to the wrong text —
 * silently, since a vector carries no identity of its own. `mapLimit` gives that
 * guarantee.
 *
 * An empty input returns immediately without probing, so a caller need not
 * special-case it.
 */
export async function embed(texts: readonly string[], opts: { base?: string; model?: string; concurrency?: number } = {}): Promise<EmbedResult> {
  const model = opts.model ?? embedModel();
  if (texts.length === 0) return { vectors: [], model };

  const base = (opts.base ?? ollamaBase()).replace(/\/+$/, "");
  if (base.toLowerCase() === "off") return { vectors: [], model, note: "embeddings are disabled (OLLAMA=off)." };
  if (!(await probeOllama(base))) {
    return { vectors: [], model, note: `no embedding server at ${base} — \`${brand().cli} semantic up\` starts Ollama and pulls ${model}.` };
  }

  const batches: string[][] = [];
  const width = embedBatch();
  for (let i = 0; i < texts.length; i += width) batches.push(texts.slice(i, i + width) as string[]);

  let note: string | undefined;
  const results = await mapLimit(batches, opts.concurrency ?? embedConcurrency(), async (batch) => {
    const r = await httpJson("POST", `${base}/api/embed`, { model, input: batch }, { timeoutMs: 60_000 });
    const got = r.ok ? (r.data?.embeddings as number[][] | undefined) : undefined;
    if (!got || got.length !== batch.length) {
      note ??= `embedding failed at ${base} (${r.error ?? `status ${r.status}`}) — is \`${model}\` pulled? \`${brand().cli} semantic up\` pulls it.`;
      return undefined;
    }
    return got;
  });

  // One failed batch invalidates the whole call rather than yielding a result
  // with holes: a caller that indexed by position would attach the wrong vector
  // to every text after the gap, and nothing downstream could detect it.
  if (results.some((r) => r === undefined)) return { vectors: [], model, ...(note ? { note } : {}) };
  return { vectors: results.flat() as number[][], model };
}

/** Embed one text. Convenience over `embed`, same degradation. */
export async function embedOne(text: string, opts: { base?: string; model?: string } = {}): Promise<number[] | undefined> {
  const r = await embed([text], opts);
  return r.vectors[0];
}

// ── Vector arithmetic ───────────────────────────────────────────────────────

/**
 * Cosine similarity, in [-1, 1]. Zero whenever the answer would not be a number.
 *
 * Three ways that happens, and all three collapse to 0 rather than propagating:
 *
 *   - a zero-magnitude vector;
 *   - vectors of DIFFERENT length, which for embeddings means two different
 *     models. Scoring them over a shared prefix produces a plausible number for
 *     a comparison that has no meaning, which is worse than refusing;
 *   - a non-finite component — a NaN or an Infinity that reached the caller
 *     from a broken embedding response.
 *
 * NaN compares false whichever way a comparator is written, so one degenerate
 * vector would sort to the bottom of one ranking and the top of another
 * depending on how someone happened to spell the sort.
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    ma += x * x;
    mb += y * y;
  }
  if (ma === 0 || mb === 0) return 0;
  const r = dot / (Math.sqrt(ma) * Math.sqrt(mb));
  return Number.isFinite(r) ? r : 0;
}

/** A unit-length copy. A zero vector is returned unchanged, for the reason above. */
export function normalize(v: readonly number[]): number[] {
  let m = 0;
  for (const x of v) m += x * x;
  if (m === 0) return [...v];
  const len = Math.sqrt(m);
  return v.map((x) => x / len);
}
