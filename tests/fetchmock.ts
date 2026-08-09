import { vi } from "vitest";

export interface MockResponse {
  status?: number;
  /** The response body as text. Optional only when `bytes` supplies it instead. */
  body?: string;
  contentType?: string;
  headers?: Record<string, string>; // extra response headers (e.g. retry-after)
  url?: string; // final URL after redirects (defaults to the requested URL)
  // Raw response bytes, for a body that is NOT valid UTF-8 (a .docx is a ZIP, a
  // .doc an OLE stream). Set this and `body` is ignored: `arrayBuffer()` hands
  // back these bytes and `text()` decodes them the way httpGet does, so a test
  // sees exactly the mojibake a real binary download produces.
  bytes?: Buffer;
  // Serve the body in chunks of this size through the ReadableStream, instead of
  // one chunk. Only needed to observe streaming behaviour — the cap has to cancel
  // the transfer partway, which a single-chunk body cannot show.
  chunkSize?: number;
  // Called with each chunk's length as the stream produces it. A body that is
  // capped must stop calling this well before the end.
  onPull?: (bytes: number) => void;
}

export type Router = (url: string, init?: RequestInit) => MockResponse | undefined;

// Stub globalThis.fetch with a router keyed by URL substring match. Backends go
// through src/backends/fetch.ts which only uses res.ok / status / url /
// arrayBuffer / text / headers.get — so a tiny fake Response is enough. The
// router may be stateful (close over a counter) to simulate 429-then-200.
// Returns the spy.
export function installFetchMock(router: Router) {
  const spy = vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const r = router(url, init);
    if (!r) {
      return makeResponse({ status: 404, body: "not found", contentType: "text/plain" }, url);
    }
    return makeResponse(r, url);
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function makeResponse(r: MockResponse, requestedUrl: string) {
  const status = r.status ?? 200;
  const body = r.body ?? "";
  const contentType = r.contentType ?? "text/html";
  const headers = r.headers ?? {};
  const payload = r.bytes ?? Buffer.from(body, "utf8");

  // A real Response exposes a readable body, and httpGet streams it so a huge
  // page is cancelled at the cap instead of being buffered whole. Serving one
  // here (rather than only arrayBuffer/text) is what puts the tests on the same
  // path as production — with only arrayBuffer, every case silently took the
  // no-stream fallback and the cap was never actually exercised.
  const stream = () =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const size = r.chunkSize ?? payload.length;
        const start = offset;
        if (start >= payload.length) {
          controller.close();
          return;
        }
        const chunk = payload.subarray(start, Math.min(start + Math.max(1, size), payload.length));
        offset = start + chunk.length;
        r.onPull?.(chunk.length);
        controller.enqueue(new Uint8Array(chunk));
      },
    });
  let offset = 0;

  return {
    ok: status >= 200 && status < 300,
    status,
    url: r.url ?? requestedUrl,
    headers: {
      get: (k: string) => {
        const key = k.toLowerCase();
        if (key in headers) return headers[key]!;
        if (key === "content-type") return contentType;
        return null;
      },
    },
    get body() {
      return stream();
    },
    async arrayBuffer() {
      // Counts as pulled, and counts WHOLE: arrayBuffer() materialises the
      // entire response no matter what the caller intends to keep. Reporting it
      // is what lets a test tell "streamed and cancelled at the cap" apart from
      // "downloaded everything, then trimmed".
      r.onPull?.(payload.length);
      return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    },
    async text() {
      return payload.toString("utf8");
    },
  } as unknown as Response;
}

// Build a map-style router from [substring, response] pairs (first match wins).
export function routes(pairs: [string, MockResponse][]): Router {
  return (url) => pairs.find(([frag]) => url.includes(frag))?.[1];
}
