import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envName } from "../src/brand.js";
import { cosine, embed, embedOne, normalize, ollamaBase, probeOllama, resetOllamaProbe } from "../src/embed.js";
import { deleteCollection, ensureCollection, hybridSearch, probeQdrant, qdrantBase, resetQdrantProbe, searchVectors, upsert } from "../src/vector.js";
import { installFetchMock } from "./fetchmock.js";

const OLLAMA = "http://ollama.test";
const QDRANT = "http://qdrant.test";

beforeEach(() => {
  resetOllamaProbe();
  resetQdrantProbe();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetOllamaProbe();
  resetQdrantProbe();
});

const json = (body: unknown) => ({ status: 200, body: JSON.stringify(body), contentType: "application/json" });

/** A server that answers the probe and returns one vector per input. */
function ollamaUp(vectorFor: (text: string) => number[] = () => [1, 0, 0]) {
  return installFetchMock((url, init) => {
    if (url.includes("/api/tags")) return json({ models: [] });
    if (url.includes("/api/embed")) {
      const input = JSON.parse(String(init?.body ?? "{}")).input as string[];
      return json({ embeddings: input.map(vectorFor) });
    }
    return undefined;
  });
}

describe("where the services live", () => {
  it("defaults to the ports the shipped stack binds", () => {
    expect(ollamaBase()).toBe("http://localhost:11434");
    expect(qdrantBase()).toBe("http://localhost:6333");
  });

  it("reads the consumer's own prefix, not webindex's", () => {
    process.env[envName("OLLAMA")] = "http://elsewhere.test";
    expect(ollamaBase()).toBe("http://elsewhere.test");
  });
});

describe("embed", () => {
  it("returns one vector per input, in input order", async () => {
    // Order is the whole contract: a vector carries no identity, so a
    // race-ordered result attaches every one to the wrong text, silently.
    ollamaUp((t) => [t.length, 0, 0]);
    const r = await embed(["a", "bbb", "cc"], { base: OLLAMA });
    expect(r.vectors.map((v) => v[0])).toEqual([1, 3, 2]);
  });

  it("preserves order across several batches", async () => {
    process.env[envName("EMBED_BATCH")] = "2";
    ollamaUp((t) => [Number(t), 0]);
    const r = await embed(["1", "2", "3", "4", "5"], { base: OLLAMA });
    expect(r.vectors.map((v) => v[0])).toEqual([1, 2, 3, 4, 5]);
  });

  it("answers an empty input without asking the network anything", async () => {
    const spy = ollamaUp();
    const r = await embed([], { base: OLLAMA });
    expect(r.vectors).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("degrades to a note when nothing answers, naming the command that starts it", async () => {
    installFetchMock(() => ({ status: 502, body: "down", contentType: "text/plain" }));
    const r = await embed(["a"], { base: OLLAMA });
    expect(r.vectors).toEqual([]);
    expect(r.note).toMatch(/no embedding server at http:\/\/ollama\.test/);
    expect(r.note).toMatch(/semantic up/);
  });

  it("is off when the caller says off, without probing", async () => {
    const spy = ollamaUp();
    const r = await embed(["a"], { base: "off" });
    expect(r.note).toMatch(/disabled/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns nothing rather than a result with holes when a batch fails", async () => {
    // A partial result is worse than none: a caller indexing by position would
    // attach the wrong vector to every text after the gap, undetectably.
    process.env[envName("EMBED_BATCH")] = "1";
    let n = 0;
    installFetchMock((url) => {
      if (url.includes("/api/tags")) return json({ models: [] });
      if (url.includes("/api/embed")) {
        n++;
        return n === 2 ? { status: 500, body: "boom", contentType: "text/plain" } : json({ embeddings: [[1, 0]] });
      }
      return undefined;
    });
    const r = await embed(["a", "b", "c"], { base: OLLAMA });
    expect(r.vectors).toEqual([]);
    expect(r.note).toMatch(/embedding failed/);
  });

  it("refuses a response whose vector count does not match the batch", async () => {
    installFetchMock((url) => (url.includes("/api/tags") ? json({ models: [] }) : json({ embeddings: [[1, 0]] })));
    const r = await embed(["a", "b"], { base: OLLAMA });
    expect(r.vectors).toEqual([]);
  });

  it("embedOne hands back the single vector", async () => {
    ollamaUp(() => [0.5, 0.5]);
    expect(await embedOne("hello", { base: OLLAMA })).toEqual([0.5, 0.5]);
  });

  it("probes once per process, not once per call", async () => {
    const spy = ollamaUp();
    await embed(["a"], { base: OLLAMA });
    await embed(["b"], { base: OLLAMA });
    expect(spy.mock.calls.filter((c) => String(c[0]).includes("/api/tags"))).toHaveLength(1);
  });

  it("reports a server that is up", async () => {
    ollamaUp();
    expect(await probeOllama(OLLAMA)).toBe(true);
  });
});

describe("vector arithmetic", () => {
  it("scores identical directions at 1 and opposite at -1", () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 rather than NaN for a zero vector", () => {
    // NaN compares false whichever way a comparator is written, so one
    // degenerate embedding would sort to opposite ends in two rankings.
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(Number.isNaN(cosine([0, 0], [0, 0]))).toBe(false);
  });

  it("refuses vectors of different lengths rather than scoring a shared prefix", () => {
    // Different lengths means two different models. A prefix score is a
    // plausible number for a comparison that has no meaning.
    expect(cosine([1, 0, 99], [1, 0])).toBe(0);
    expect(cosine([], [])).toBe(0);
  });

  it("collapses a non-finite component to zero", () => {
    // A broken embedding response reaching a sort comparator.
    expect(cosine([Number.NaN, 1], [1, 1])).toBe(0);
    expect(cosine([Number.POSITIVE_INFINITY, 1], [1, 1])).toBe(0);
  });

  it("normalizes to unit length, and leaves a zero vector alone", () => {
    const n = normalize([3, 4]);
    expect(Math.hypot(...n)).toBeCloseTo(1);
    expect(normalize([0, 0])).toEqual([0, 0]);
  });
});

describe("the vector store", () => {
  const qdrantUp = (routes: (url: string, init?: RequestInit) => unknown = () => undefined) =>
    installFetchMock((url, init) => {
      if (url.endsWith("/collections")) return json({ result: { collections: [] } });
      const custom = routes(url, init);
      if (custom) return custom as never;
      return json({ result: true });
    });

  it("creates a collection only when it is not already there", async () => {
    const seen: string[] = [];
    installFetchMock((url, init) => {
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/collections")) return json({ result: {} });
      if (url.endsWith("/collections/docs")) return init?.method === "GET" ? json({ result: { status: "green" } }) : json({ result: true });
      return json({ result: true });
    });
    const r = await ensureCollection("docs", 768, { base: QDRANT });
    expect(r.ok).toBe(true);
    expect(seen.some((s) => s.startsWith("PUT"))).toBe(false);
  });

  it("waits for an upsert, so a search right after sees the points", async () => {
    const seen: string[] = [];
    qdrantUp((url) => {
      seen.push(url);
      return undefined;
    });
    await upsert("docs", [{ id: 1, vector: [1, 0] }], { base: QDRANT });
    expect(seen.some((u) => u.includes("/points?wait=true"))).toBe(true);
  });

  it("does not call out at all for an empty upsert", async () => {
    const spy = qdrantUp();
    expect(await upsert("docs", [], { base: QDRANT })).toEqual({ ok: true });
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps hits back with their payload", async () => {
    qdrantUp((url) => (url.includes("/points/search") ? json({ result: [{ id: 7, score: 0.9, payload: { url: "https://a.test" } }] }) : undefined));
    const r = await searchVectors("docs", [1, 0], { base: QDRANT });
    expect(r.hits).toEqual([{ id: 7, score: 0.9, payload: { url: "https://a.test" } }]);
  });

  it("degrades to a note when the store is absent", async () => {
    installFetchMock(() => ({ status: 503, body: "no", contentType: "text/plain" }));
    const r = await searchVectors("docs", [1, 0], { base: QDRANT });
    expect(r.hits).toEqual([]);
    expect(r.note).toMatch(/no vector store at http:\/\/qdrant\.test/);
    expect(r.note).toMatch(/semantic up/);
  });

  it("reports a store that is up", async () => {
    qdrantUp();
    expect(await probeQdrant(QDRANT)).toBe(true);
  });

  it("creates the collection when it is genuinely absent", async () => {
    const seen: string[] = [];
    installFetchMock((url, init) => {
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/collections")) return json({ result: {} });
      if (url.endsWith("/collections/docs") && init?.method === "GET") return { status: 404, body: "missing", contentType: "text/plain" };
      return json({ result: true });
    });
    expect(await ensureCollection("docs", 768, { base: QDRANT })).toEqual({ ok: true });
    expect(seen).toContain(`PUT ${QDRANT}/collections/docs`);
  });

  it("says why a collection could not be created", async () => {
    installFetchMock((url, init) => {
      if (url.endsWith("/collections")) return json({ result: {} });
      if (init?.method === "PUT") return { status: 400, body: "bad dim", contentType: "text/plain" };
      return { status: 404, body: "missing", contentType: "text/plain" };
    });
    const r = await ensureCollection("docs", 0, { base: QDRANT });
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/could not create collection "docs"/);
  });

  it("says why an upsert failed", async () => {
    installFetchMock((url) => (url.endsWith("/collections") ? json({ result: {} }) : { status: 500, body: "no", contentType: "text/plain" }));
    const r = await upsert("docs", [{ id: 1, vector: [1, 0] }], { base: QDRANT });
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/upsert into "docs" failed/);
  });

  it("says why a search failed once the store is reachable", async () => {
    installFetchMock((url) => (url.endsWith("/collections") ? json({ result: {} }) : { status: 500, body: "no", contentType: "text/plain" }));
    const r = await searchVectors("docs", [1, 0], { base: QDRANT });
    expect(r.hits).toEqual([]);
    expect(r.note).toMatch(/search in "docs" failed/);
  });

  it("drops a collection, and reports a drop that did not happen", async () => {
    installFetchMock((_url, init) => (init?.method === "DELETE" ? json({ result: true }) : json({ result: {} })));
    expect(await deleteCollection("docs", { base: QDRANT })).toEqual({ ok: true });

    installFetchMock(() => ({ status: 409, body: "busy", contentType: "text/plain" }));
    const r = await deleteCollection("docs", { base: QDRANT });
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/could not delete "docs"/);
  });

  it("does no network at all for every operation when the store is off", async () => {
    const spy = installFetchMock(() => json({ result: true }));
    expect((await ensureCollection("d", 8, { base: "off" })).note).toMatch(/disabled/);
    expect((await upsert("d", [{ id: 1, vector: [1] }], { base: "off" })).note).toMatch(/disabled/);
    expect((await searchVectors("d", [1], { base: "off" })).note).toMatch(/disabled/);
    expect((await deleteCollection("d", { base: "off" })).note).toMatch(/disabled/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("never probes a store the caller turned off", async () => {
    expect(await probeQdrant("off")).toBe(false);
  });
});

describe("hybridSearch", () => {
  const docs = [
    { id: "a", title: "Token bucket rate limiting", headings: "", body: "A token bucket smooths bursts." },
    { id: "b", title: "Unrelated cooking notes", headings: "", body: "Braising is a slow method." },
    { id: "c", title: "Throttling requests", headings: "", body: "Shaping traffic without the words used in the question." },
  ];

  it("falls back to the lexical ranking, with a note, when nothing embeds", async () => {
    installFetchMock(() => ({ status: 502, body: "down", contentType: "text/plain" }));
    const r = await hybridSearch("token bucket", docs, { base: OLLAMA });
    expect(r.note).toMatch(/no embedding server/);
    expect(r.hits).toHaveLength(3);
    expect(r.hits[0]?.doc.id).toBe("a");
    // No dense lane ran, so no document carries a dense rank.
    expect(r.hits.every((h) => h.denseRank === undefined)).toBe(true);
  });

  it("lets the dense lane lift a document the words never matched", async () => {
    // The failure BM25F cannot fix: "c" shares no term with the question. A
    // dense lane that ranks it first pulls it up through the fusion.
    ollamaUp((t) => (/question|Throttling/.test(t) ? [1, 0] : [0, 1]));
    const r = await hybridSearch("the question", docs, { base: OLLAMA });
    expect(r.note).toBeUndefined();
    expect(r.hits.find((h) => h.doc.id === "c")?.denseRank).toBe(1);
    expect(r.hits[0]?.doc.id).toBe("c");
  });

  it("reports each lane's rank, so a caller can see why something ranked", () => {
    ollamaUp();
    return hybridSearch("token bucket", docs, { base: OLLAMA }).then((r) => {
      for (const h of r.hits) {
        expect(h.lexicalRank).toBeGreaterThan(0);
        expect(h.denseRank).toBeGreaterThan(0);
      }
    });
  });

  it("returns every document it was given, and honours a limit", async () => {
    ollamaUp();
    expect((await hybridSearch("q", docs, { base: OLLAMA })).hits).toHaveLength(3);
    expect((await hybridSearch("q", docs, { base: OLLAMA, limit: 2 })).hits).toHaveLength(2);
  });

  it("answers an empty pool without asking anything", async () => {
    const spy = ollamaUp();
    expect(await hybridSearch("q", [], { base: OLLAMA })).toEqual({ hits: [] });
    expect(spy).not.toHaveBeenCalled();
  });
});
