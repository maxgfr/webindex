import { afterEach, describe, expect, it, vi } from "vitest";
import { envName } from "../src/brand.js";
import { fetchAndExtract, httpGet, httpJson, metaDescriptionOf, rescueViaWayback } from "../src/fetch.js";
import { installFetchMock } from "./fetchmock.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("response byte accounting", () => {
  it("counts retained UTF-8 bytes and distinguishes exact caps from truncation", async () => {
    installFetchMock(() => ({ body: "é🙂", contentType: "text/plain" }));
    expect(await httpGet("https://x.test/text", { maxBytes: 6 })).toMatchObject({ body: "é🙂", bytesRead: 6, truncated: false });
    expect(await httpGet("https://x.test/text", { maxBytes: 2 })).toMatchObject({ body: "é", bytesRead: 2, truncated: true });
  });

  it("reports JSON bytes and refuses an incomplete JSON response", async () => {
    installFetchMock(() => ({ body: '{"v":"é"}', contentType: "application/json" }));
    expect(await httpJson("GET", "https://x.test/json", undefined, { maxBytes: 10 })).toMatchObject({ ok: true, bytesRead: 10, truncated: false });
    expect(await httpJson("GET", "https://x.test/json", undefined, { maxBytes: 9 })).toMatchObject({ ok: false, bytesRead: 9, truncated: true });
  });
});

describe("authorized requests", () => {
  it("excludes authorization waits from the network timeout at every redirect", async () => {
    vi.useFakeTimers();
    const authorized: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        init.signal?.throwIfAborted();
        return url.endsWith("/start")
          ? new Response(null, { status: 302, headers: { location: "/final" } })
          : new Response("Ready", { headers: { "content-type": "text/plain" } });
      }),
    );
    const pending = httpGet("https://x.test/start", {
      timeoutMs: 10,
      retries: 0,
      authorizeUrl: async (url) => {
        authorized.push(url);
        await new Promise((resolve) => setTimeout(resolve, 40));
        return true;
      },
    });
    await vi.advanceTimersByTimeAsync(80);
    expect(await pending).toMatchObject({ ok: true, body: "Ready" });
    expect(authorized).toEqual(["https://x.test/start", "https://x.test/final"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"])("still bounds a stalled %s after authorization finishes", async (stage) => {
    vi.useFakeTimers();
    let startedWithLiveSignal = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const signal = init.signal!;
        signal.throwIfAborted();
        startedWithLiveSignal = true;
        if (stage === "headers")
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
          });
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                signal.addEventListener("abort", () => controller.error(new Error("body aborted")), { once: true });
              },
            }),
          ),
        );
      }),
    );
    const pending = httpGet("https://x.test/slow", {
      timeoutMs: 10,
      retries: 0,
      authorizeUrl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return true;
      },
    });
    await vi.advanceTimersByTimeAsync(40);
    expect(startedWithLiveSignal).toBe(true);
    await vi.advanceTimersByTimeAsync(11);
    expect(await pending).toMatchObject({ ok: false, status: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the cumulative network timeout across redirects while excluding both policy waits", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init.signal!;
          signal.throwIfAborted();
          const abort = () => {
            clearTimeout(timer);
            reject(new Error("request aborted"));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve(url.endsWith("/start") ? new Response(null, { status: 302, headers: { location: "/final" } }) : new Response("Too late"));
          }, 6);
          signal.addEventListener("abort", abort, { once: true });
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const pending = httpGet("https://x.test/start", {
      timeoutMs: 10,
      retries: 0,
      authorizeUrl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return true;
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ ok: false, status: 0 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("follows allowed relative redirects and removes credentials when the origin changes", async () => {
    const spy = installFetchMock((url) => {
      if (url === "https://x.test/start") return { status: 301, headers: { location: "/next" } };
      if (url === "https://x.test/next") return { status: 307, headers: { location: "https://other.test/final" } };
      return { body: "Allowed destination", contentType: "text/plain" };
    });
    const authorized: string[] = [];
    const result = await httpGet("https://x.test/start", {
      headers: { Authorization: "Bearer example", Cookie: "session=example" },
      authorizeUrl: async (url) => {
        authorized.push(url);
        return true;
      },
    });
    expect(result).toMatchObject({ ok: true, body: "Allowed destination", url: "https://other.test/final" });
    expect(authorized).toEqual(["https://x.test/start", "https://x.test/next", "https://other.test/final"]);
    expect(spy.mock.calls[2]?.[1]?.headers).not.toHaveProperty("authorization");
    expect(spy.mock.calls[2]?.[1]?.headers).not.toHaveProperty("cookie");
  });

  it("stops redirect loops after twenty hops without retrying the chain", async () => {
    const spy = installFetchMock(() => ({ status: 302, headers: { location: "/loop" } }));
    const result = await httpGet("https://x.test/loop", { authorizeUrl: async () => true });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/maximum 20/i);
    expect(spy).toHaveBeenCalledTimes(21);
  });

  it("checks every redirect destination before requesting it and never retries a denial", async () => {
    const spy = installFetchMock((url) => (url.endsWith("/start") ? { status: 302, headers: { location: "./blocked" } } : { body: "must not be fetched" }));
    const authorized: string[] = [];
    const result = await httpGet("https://x.test/start", {
      authorizeUrl: async (url) => {
        authorized.push(url);
        return !url.endsWith("/blocked");
      },
    });
    expect(result).toMatchObject({ ok: false, status: 0, url: "https://x.test/blocked" });
    expect(result.error).toMatch(/not authorized/i);
    expect(authorized).toEqual(["https://x.test/start", "https://x.test/blocked"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("denies the initial URL without a network call or Firecrawl fallback", async () => {
    const spy = installFetchMock(() => ({ body: "must not be fetched" }));
    const result = await fetchAndExtract("https://x.test/start", { firecrawl: "http://fc.test", authorizeUrl: async () => false });
    expect(result.text).toBe("");
    expect(result.note).toMatch(/not authorized/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not invoke archive rescue when a URL authorization policy is active", async () => {
    const spy = installFetchMock(() => ({ body: "{}", contentType: "application/json" }));
    expect(await rescueViaWayback("https://x.test/gone", { authorizeUrl: async () => true })).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(["pdf", "docx"])("does not send a guarded %s to the remote extractor", async (extension) => {
    process.env[envName(extension === "pdf" ? "PDF_ENGINE" : "DOC_ENGINE")] = "firecrawl";
    const spy = installFetchMock(() => ({ bytes: Buffer.from("unreadable document") }));
    const result = await fetchAndExtract(`https://x.test/file.${extension}`, { firecrawl: "http://fc.test", authorizeUrl: async () => true });
    expect(result.text).toBe("");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toBe(`https://x.test/file.${extension}`);
  });
});

describe("document response limits", () => {
  it("reads a five-megabyte PDF without an extension under the document cap", async () => {
    const pdf = Buffer.from(`%PDF-1.4\n${"% padding\n".repeat(500_000)}\nstream\nBT (TailMarker) Tj ET\nendstream\n`);
    const spy = installFetchMock(() => ({ bytes: pdf, contentType: "application/pdf", headers: { "content-length": String(pdf.length) } }));
    expect(await fetchAndExtract("https://x.test/download")).toMatchObject({ text: "TailMarker", documentType: "pdf" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await httpGet("https://x.test/download", { maxBytes: 64, maxDocumentBytes: 16 * 1024 * 1024 })).toMatchObject({ ok: false });
  });

  it.each([undefined, "5242880"])("reads a large CSV response when Content-Length is %s", async (length) => {
    const bytes = Buffer.alloc(5 * 1024 * 1024, 65);
    installFetchMock(() => ({ bytes, contentType: "text/csv", headers: length ? { "content-length": length } : undefined, chunkSize: 64 * 1024 }));
    const result = await fetchAndExtract("https://x.test/export");
    expect(result.documentType).toBe("doc");
    expect(result.text.length).toBe(5 * 1024 * 1024);
  });

  it("refuses a document exceeding sixteen megabytes even without a length header", async () => {
    installFetchMock(() => ({ bytes: Buffer.alloc(16 * 1024 * 1024 + 1, 65), contentType: "text/csv", chunkSize: 64 * 1024 }));
    const result = await fetchAndExtract("https://x.test/export");
    expect(result.text).toBe("");
    expect(result.note).toMatch(/size cap/i);
  });
});

describe("verbatim textual evidence", () => {
  it("decodes the CSV fallback using its declared encoding and BOM", async () => {
    installFetchMock(() => ({ bytes: Buffer.from("Nom,Ville\nAndr\xe9,Orl\xe9ans", "latin1"), contentType: "text/csv; charset=windows-1252" }));
    expect((await fetchAndExtract("https://x.test/data.csv")).text).toBe("Nom,Ville\nAndré,Orléans");
    installFetchMock(() => ({
      bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Nom,Ville\nAndré,Orléans", "utf16le")]),
      contentType: "text/csv",
    }));
    expect((await fetchAndExtract("https://x.test/data.csv")).text).toBe("Nom,Ville\nAndré,Orléans");
  });

  it.each(["text/plain", "text/markdown"])("preserves angle brackets in %s", async (contentType) => {
    const body = "<string> is the generic type\nKeep <T> and <U> placeholders.";
    installFetchMock(() => ({ body, contentType }));
    expect((await fetchAndExtract("https://x.test/readme")).text).toBe(body);
  });

  it("reads quoted descriptions without treating the opposite quote as an attribute boundary", () => {
    expect(metaDescriptionOf(`<meta name="description" content="L'article décrit la méthode">`)).toBe("L'article décrit la méthode");
    expect(metaDescriptionOf(`<meta content='The "quoted" method &amp; result' name='description'>`)).toBe('The "quoted" method & result');
    expect(metaDescriptionOf(`<meta content="L'article" property="og:description">`)).toBe("L'article");
  });
});
