import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envName } from "../src/brand.js";
import { cosine, embed, embedOne, embedPrefixes, normalize, ollamaBase, probeOllama, resetOllamaProbe } from "../src/embed.js";
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

  it("does not let a failed base mask a healthy Ollama base", async () => {
    installFetchMock((url) => (url.startsWith("http://dead.test") ? { status: 503, body: "down" } : json({ models: [] })));
    expect(await probeOllama("http://dead.test")).toBe(false);
    expect(await probeOllama(OLLAMA)).toBe(true);
  });

  it("stops sending batches once one has failed", async () => {
    // The result is already void after the first bad batch; issuing the rest
    // turned a wedged server into ten minutes of timeouts before the note.
    process.env[envName("EMBED_BATCH")] = "1";
    let calls = 0;
    installFetchMock((url) => {
      if (url.includes("/api/tags")) return json({ models: [] });
      if (url.includes("/api/embed")) {
        calls++;
        return { status: 500, body: JSON.stringify({ error: "boom" }), contentType: "application/json" };
      }
      return undefined;
    });
    const r = await embed(
      Array.from({ length: 20 }, (_, i) => `t${i}`),
      { base: OLLAMA, concurrency: 2 },
    );
    expect(r.vectors).toEqual([]);
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("says what the server said, and suggests a pull only when the model is missing", async () => {
    installFetchMock((url) =>
      url.includes("/api/tags")
        ? json({ models: [] })
        : { status: 404, body: JSON.stringify({ error: 'model "nomic-embed-text" not found, try pulling it first' }), contentType: "application/json" },
    );
    const missing = await embed(["a"], { base: OLLAMA });
    expect(missing.note).toContain('model "nomic-embed-text" not found');
    expect(missing.note).toContain("ollama pull nomic-embed-text");
    expect(missing.note).toContain("semantic up");

    resetOllamaProbe();
    installFetchMock((url) =>
      url.includes("/api/tags") ? json({ models: [] }) : { status: 500, body: JSON.stringify({ error: "boom" }), contentType: "application/json" },
    );
    const broken = await embed(["a"], { base: OLLAMA });
    expect(broken.note).toContain("boom");
    expect(broken.note).not.toMatch(/pull/);
  });

  it("re-probes a server that was down once that verdict is stale, and keeps a live one", async () => {
    // A long-lived MCP server used to keep answering "no embedding server"
    // after the server came up, without sending a single request.
    let up = false;
    const spy = installFetchMock((url) => {
      if (!up) return { status: 502, body: "down", contentType: "text/plain" };
      return url.includes("/api/tags") ? json({ models: [] }) : json({ embeddings: [[1, 0]] });
    });
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    expect((await embed(["a"], { base: OLLAMA })).note).toMatch(/no embedding server/);
    up = true;
    // Inside the window the verdict stands: no probe per call.
    expect((await embed(["a"], { base: OLLAMA })).note).toMatch(/no embedding server/);
    now.mockReturnValue(1_000_000 + 31_000);
    expect((await embed(["a"], { base: OLLAMA })).vectors).toEqual([[1, 0]]);
    // A positive verdict is kept for the process.
    now.mockReturnValue(1_000_000 + 10_000_000);
    await embed(["b"], { base: OLLAMA });
    expect(spy.mock.calls.filter((c) => String(c[0]).includes("/api/tags"))).toHaveLength(2);
  });

  it("sends one probe for callers that ask at the same time", async () => {
    const spy = ollamaUp();
    await Promise.all([embed(["a"], { base: OLLAMA }), embed(["b"], { base: OLLAMA }), probeOllama(OLLAMA)]);
    expect(spy.mock.calls.filter((c) => String(c[0]).includes("/api/tags"))).toHaveLength(1);
  });
});

describe("embedPrefixes", () => {
  it("knows the task prefixes the common local models were trained with", () => {
    expect(embedPrefixes("nomic-embed-text")).toEqual({ query: "search_query: ", doc: "search_document: " });
    expect(embedPrefixes("nomic-embed-text:v1.5")).toEqual({ query: "search_query: ", doc: "search_document: " });
    expect(embedPrefixes("mxbai-embed-large")).toEqual({ query: "Represent this sentence for searching relevant passages: ", doc: "" });
    expect(embedPrefixes("snowflake-arctic-embed:335m").query).toBe("Represent this sentence for searching relevant passages: ");
    expect(embedPrefixes("snowflake-arctic-embed2")).toEqual({ query: "query: ", doc: "" });
    expect(embedPrefixes("jeffh/intfloat-multilingual-e5-large")).toEqual({ query: "query: ", doc: "passage: " });
    expect(embedPrefixes("all-minilm")).toEqual({ query: "", doc: "" });
  });

  it("defaults to the configured model, and lets the environment override either side", () => {
    expect(embedPrefixes().query).toBe("search_query: ");
    process.env[envName("EMBED_QUERY_PREFIX")] = "query:";
    process.env[envName("EMBED_DOC_PREFIX")] = "none";
    expect(embedPrefixes("nomic-embed-text")).toEqual({ query: "query: ", doc: "" });
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

  it("does not let a failed base mask a healthy Qdrant base", async () => {
    installFetchMock((url) => (url.startsWith("http://dead.test") ? { status: 503, body: "down" } : json({ result: { collections: [] } })));
    expect(await probeQdrant("http://dead.test")).toBe(false);
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

  it("re-probes a store that was down once that verdict is stale", async () => {
    let up = false;
    installFetchMock(() => (up ? json({ result: { collections: [] } }) : { status: 502, body: "down", contentType: "text/plain" }));
    const now = vi.spyOn(Date, "now").mockReturnValue(5_000_000);
    expect(await probeQdrant(QDRANT)).toBe(false);
    up = true;
    expect(await probeQdrant(QDRANT)).toBe(false);
    now.mockReturnValue(5_000_000 + 31_000);
    expect(await probeQdrant(QDRANT)).toBe(true);
  });

  it("refuses a collection built for another model's dimension, or another distance", async () => {
    // After EMBED_MODEL changes (768 → 1024), every later upsert failed with an
    // opaque 400 while this said ok.
    installFetchMock((url, init) => {
      if (url.endsWith("/collections")) return json({ result: {} });
      if (url.endsWith("/collections/docs") && (init?.method ?? "GET") === "GET")
        return json({ result: { status: "green", config: { params: { vectors: { size: 768, distance: "Cosine" } } } } });
      return json({ result: true });
    });
    const wrongSize = await ensureCollection("docs", 1024, { base: QDRANT });
    expect(wrongSize.ok).toBe(false);
    expect(wrongSize.note).toMatch(/exists with size 768, not 1024/);
    expect(wrongSize.note).toMatch(/deleteCollection/);
    const wrongDistance = await ensureCollection("docs", 768, { base: QDRANT, distance: "Dot" });
    expect(wrongDistance.ok).toBe(false);
    expect(wrongDistance.note).toMatch(/Cosine/);
    expect(await ensureCollection("docs", 768, { base: QDRANT })).toEqual({ ok: true });
  });

  it("upserts in chunks, so a large index stays under the store's request cap", async () => {
    // One request of 3 000 × 768 floats is ~47 MB; Qdrant refuses above 32 MB.
    process.env[envName("QDRANT_UPSERT_BATCH")] = "2";
    const sizes: number[] = [];
    qdrantUp((url, init) => {
      if (url.includes("/points?wait=true")) sizes.push(JSON.parse(String(init?.body)).points.length);
      return undefined;
    });
    const points = Array.from({ length: 5 }, (_, i) => ({ id: i, vector: [1, 0] }));
    expect(await upsert("docs", points, { base: QDRANT })).toEqual({ ok: true });
    expect(sizes).toEqual([2, 2, 1]);
  });

  it("names the chunk that failed, and sends nothing after it", async () => {
    process.env[envName("QDRANT_UPSERT_BATCH")] = "2";
    let n = 0;
    installFetchMock((url) => {
      if (url.endsWith("/collections")) return json({ result: {} });
      n++;
      return n === 2 ? { status: 400, body: "bad", contentType: "text/plain" } : json({ result: true });
    });
    const r = await upsert(
      "docs",
      Array.from({ length: 6 }, (_, i) => ({ id: i, vector: [1, 0] })),
      { base: QDRANT },
    );
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/points 3–4 of 6/);
    expect(n).toBe(2);
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

  it("never drops a hit for a limit that is not positive", async () => {
    ollamaUp();
    expect((await hybridSearch("q", docs, { base: OLLAMA, limit: -1 })).hits).toHaveLength(3);
    expect((await hybridSearch("q", docs, { base: OLLAMA, limit: 0 })).hits).toHaveLength(3);
  });

  it("fuses by position, so two documents sharing an id do not share a score", async () => {
    // Merged results from several engines repeat URLs. Keyed by id, both copies
    // got the summed score and the later copy's rank, and "Cooking" outranked
    // a genuinely strong document.
    installFetchMock(() => ({ status: 502, body: "down", contentType: "text/plain" }));
    const dup = [
      { id: "a.test/same", title: "Token bucket rate limiting", headings: "", body: "token bucket rate limiting" },
      { id: "b.test/strong", title: "Token bucket", headings: "", body: "token bucket" },
      { id: "a.test/same", title: "Cooking", headings: "", body: "braising" },
      { id: "c.test", title: "Weather", headings: "", body: "rain" },
    ];
    const r = await hybridSearch("token bucket rate limiting", dup, { base: OLLAMA });
    expect(r.hits.map((h) => h.doc.title)).toEqual(["Token bucket rate limiting", "Token bucket", "Cooking", "Weather"]);
    expect(r.hits.map((h) => h.lexicalRank)).toEqual([1, 2, 3, 4]);
  });

  it("asks the model for its task prefixes, query and documents apart", async () => {
    // nomic-embed-text "must include a task instruction prefix"; without one
    // the question and the passages are embedded as the same task.
    const sent: string[] = [];
    installFetchMock((url, init) => {
      if (url.includes("/api/tags")) return json({ models: [] });
      const input = JSON.parse(String(init?.body)).input as string[];
      sent.push(...input);
      return json({ embeddings: input.map(() => [1, 0]) });
    });
    await hybridSearch("token bucket", docs, { base: OLLAMA });
    expect(sent[0]).toBe("search_query: token bucket");
    expect(sent.slice(1).every((t) => t.startsWith("search_document: "))).toBe(true);

    sent.length = 0;
    await hybridSearch("token bucket", docs, { base: OLLAMA, model: "all-minilm" });
    expect(sent[0]).toBe("token bucket");

    sent.length = 0;
    await hybridSearch("token bucket", docs, { base: OLLAMA, queryPrefix: "", docPrefix: "D: " });
    expect(sent[0]).toBe("token bucket");
    expect(sent[1]).toMatch(/^D: Token bucket rate limiting/);
  });

  it("sends at most EMBED_MAX_CHARS of each document — the model truncates the rest anyway", async () => {
    const sent: string[] = [];
    installFetchMock((url, init) => {
      if (url.includes("/api/tags")) return json({ models: [] });
      const input = JSON.parse(String(init?.body)).input as string[];
      sent.push(...input);
      return json({ embeddings: input.map(() => [1, 0]) });
    });
    const long = [{ id: "l", title: "", headings: "", body: "word ".repeat(10_000) }];
    await hybridSearch("q", long, { base: OLLAMA, model: "all-minilm" });
    expect(sent[1]!.length).toBe(8_000);

    sent.length = 0;
    process.env[envName("EMBED_MAX_CHARS")] = "100";
    await hybridSearch("q", long, { base: OLLAMA, model: "all-minilm" });
    expect(sent[1]!.length).toBe(100);

    sent.length = 0;
    process.env[envName("EMBED_MAX_CHARS")] = "0";
    await hybridSearch("q", long, { base: OLLAMA, model: "all-minilm" });
    expect(sent[1]!.length).toBe(50_000);
  });

  it("answers an empty pool without asking anything", async () => {
    const spy = ollamaUp();
    expect(await hybridSearch("q", [], { base: OLLAMA })).toEqual({ hits: [] });
    expect(spy).not.toHaveBeenCalled();
  });

  it("ranks a large pool of lexically tied documents in input order, and quickly", async () => {
    // Every document scores the same, so the lexical rank must be the input
    // order (stable sort), and 300 documents must not cost 2·n·log n scorings.
    installFetchMock(() => ({ status: 502, body: "down", contentType: "text/plain" }));
    const pool = Array.from({ length: 300 }, (_, i) => ({
      id: `d${i}`,
      title: "Token bucket",
      headings: "",
      body: `A token bucket smooths bursts. ${"Filler words about traffic shaping and request budgets. ".repeat(40)}`,
    }));
    const started = performance.now();
    const r = await hybridSearch("token bucket", pool, { base: OLLAMA });
    expect(performance.now() - started).toBeLessThan(500);
    expect(r.hits.map((h) => h.doc.id)).toEqual(pool.map((d) => d.id));
    expect(r.hits.map((h) => h.lexicalRank)).toEqual(pool.map((_, i) => i + 1));
  });
});
