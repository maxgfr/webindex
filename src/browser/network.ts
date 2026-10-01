// A passive recorder of the JSON a page fetches (XHR/fetch APIs), usually the
// cleanest data on a JS-heavy site. It never requests anything on the page's
// behalf: it listens to Network events and reads response bodies the browser
// already holds. Entries persist to network/<targetId>.jsonl.
//
// Privacy: request and response headers are never read, so no Authorization or
// Cookie value can reach the log. Query strings in URLs ARE kept (the agent may
// need them), so a token passed in a URL would be stored: do not record sessions
// where that matters.
//
// `Network.enable` is left on at stop(): waitFor/settle enable it too and other
// users of the same page session may rely on it, so disabling would break them.

import type { CdpHandler, CdpSession } from "./cdp.js";
import { appendNetwork, clearNetwork, readNetwork, type StateOptions } from "./state.js";

export interface NetworkEntry {
  /** 1-based and stable within the log file. */
  n: number;
  /** ISO time the response finished. */
  at: string;
  method: string;
  url: string;
  status: number;
  mime: string;
  resourceType: string;
  /** The request's postData, cut to 4 KiB. */
  requestBody?: string;
  /** Body size in bytes (the wire size when the body was not fetched). */
  size: number;
  json?: unknown;
  text?: string;
  bodyTruncated?: boolean;
  error?: string;
}

export interface NetworkFilter {
  urlIncludes?: string;
  /** "json" (default), "any", or a case-insensitive substring of the response mime. */
  mime?: "json" | "any" | string;
  /** Case-insensitive; every method when omitted. */
  methods?: string[];
}

export interface NetworkRecorderOptions {
  filter?: NetworkFilter;
  /** Kept in memory and persisted: the newest ones win. Default 200. */
  maxEntries?: number;
  /** Bigger bodies are not stored (`bodyTruncated`). Default 256 KiB. */
  maxBodyBytes?: number;
  /** Append to network/<targetId>.jsonl on stop(). Default true. */
  persist?: boolean;
  /** How long stop() waits for in-flight body fetches. Default 2000 ms. */
  drainMs?: number;
  /** State directory, as for the state functions. */
  home?: string;
}

/** The slice of BrowserSession the recorder needs. */
export interface NetworkTarget {
  readonly page: CdpSession;
  readonly targetId: string;
}

const REQUEST_BODY_CAP = 4096;
const DEFAULT_RESOURCE_TYPES = new Set(["XHR", "Fetch", "Document", "Other"]);
const JSON_MIME = /^(application\/(.+\+)?json|text\/json|application\/x-ndjson)\s*(;|$)/i;

interface Pending {
  method: string;
  url: string;
  status: number;
  mime: string;
  resourceType: string;
  requestBody?: string;
}

export class NetworkRecorder {
  private readonly page: CdpSession;
  private readonly targetId: string;
  private readonly filter: NetworkFilter;
  private readonly maxEntries: number;
  private readonly maxBodyBytes: number;
  private readonly persist: boolean;
  private readonly drainMs: number;
  private readonly state: StateOptions;
  private readonly requests = new Map<string, { method: string; url: string; resourceType?: string; postData?: string }>();
  private readonly pending = new Map<string, Pending>();
  private readonly inflight = new Set<Promise<void>>();
  private log: NetworkEntry[] = [];
  private next = 1;
  private active = false;
  private handlers: [string, CdpHandler][] = [];

  constructor(session: NetworkTarget, opts: NetworkRecorderOptions = {}) {
    this.page = session.page;
    this.targetId = session.targetId;
    this.filter = opts.filter ?? {};
    this.maxEntries = opts.maxEntries ?? 200;
    this.maxBodyBytes = opts.maxBodyBytes ?? 256 * 1024;
    this.persist = opts.persist ?? true;
    this.drainMs = opts.drainMs ?? 2000;
    this.state = { home: opts.home };
  }

  async start(): Promise<void> {
    if (this.active) return;
    // Continue numbering after what an earlier recorder left in the file.
    for (const e of readNetwork(this.targetId, this.state)) {
      const n = (e as { n?: unknown }).n;
      if (typeof n === "number" && n >= this.next) this.next = n + 1;
    }
    this.active = true;
    this.handlers = [
      ["Network.requestWillBeSent", (p) => this.onRequest(p)],
      ["Network.responseReceived", (p) => this.onResponse(p)],
      ["Network.loadingFinished", (p) => this.onFinished(p)],
      ["Network.loadingFailed", (p) => this.onFailed(p)],
    ];
    for (const [m, h] of this.handlers) this.page.on(m, h);
    await this.page.send("Network.enable");
  }

  /** The entries recorded so far, oldest first. */
  entries(): NetworkEntry[] {
    return [...this.log];
  }

  /**
   * Waits (bounded) for in-flight body fetches, detaches, persists and returns the entries.
   * appendNetwork is a read-modify-write: run this under `withBrowserLock` (the CLI's `withPage` does).
   */
  async stop(): Promise<NetworkEntry[]> {
    if (this.inflight.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<void>((r) => {
        timer = setTimeout(r, this.drainMs);
      });
      await Promise.race([Promise.allSettled([...this.inflight]), bound]);
      clearTimeout(timer);
    }
    this.active = false;
    for (const [m, h] of this.handlers) this.page.off(m, h);
    this.handlers = [];
    this.requests.clear();
    this.pending.clear();
    if (this.persist && this.log.length > 0) appendNetwork(this.targetId, this.log, this.state);
    return this.entries();
  }

  private onRequest(p: any): void {
    if (!this.active || typeof p?.requestId !== "string") return;
    this.requests.set(p.requestId, {
      method: String(p.request?.method ?? "GET"),
      url: String(p.request?.url ?? ""),
      resourceType: p.type,
      postData: p.request?.postData,
    });
  }

  private onResponse(p: any): void {
    if (!this.active || typeof p?.requestId !== "string") return;
    const req = this.requests.get(p.requestId);
    const r = p.response ?? {};
    const rec: Pending = {
      method: req?.method ?? "GET",
      url: String(r.url ?? req?.url ?? ""),
      status: Number(r.status ?? 0),
      mime: String(r.mimeType ?? ""),
      resourceType: String(p.type ?? req?.resourceType ?? "Other"),
      requestBody: typeof req?.postData === "string" ? req.postData.slice(0, REQUEST_BODY_CAP) : undefined,
    };
    if (this.keep(rec)) this.pending.set(p.requestId, rec);
  }

  private onFailed(p: any): void {
    this.requests.delete(p?.requestId);
    this.pending.delete(p?.requestId);
  }

  private onFinished(p: any): void {
    if (!this.active) return;
    const rec = this.pending.get(p?.requestId);
    this.requests.delete(p?.requestId);
    if (!rec) return;
    this.pending.delete(p.requestId);
    const job = this.finish(p.requestId, rec, Number(p.encodedDataLength ?? 0)).finally(() => this.inflight.delete(job));
    this.inflight.add(job);
  }

  private keep(r: Pending): boolean {
    const f = this.filter;
    const mime = f.mime ?? "json";
    if (f.urlIncludes && !r.url.includes(f.urlIncludes)) return false;
    if (f.methods && !f.methods.some((m) => m.toUpperCase() === r.method.toUpperCase())) return false;
    if (mime === "any") return true;
    if (mime === "json") return JSON_MIME.test(r.mime) && DEFAULT_RESOURCE_TYPES.has(r.resourceType);
    return r.mime.toLowerCase().includes(mime.toLowerCase());
  }

  private async finish(requestId: string, r: Pending, wireSize: number): Promise<void> {
    const entry: NetworkEntry = {
      n: 0,
      at: new Date().toISOString(),
      method: r.method,
      url: r.url,
      status: r.status,
      mime: r.mime,
      resourceType: r.resourceType,
      size: wireSize,
    };
    if (r.requestBody !== undefined) entry.requestBody = r.requestBody;
    if (wireSize > this.maxBodyBytes) {
      entry.bodyTruncated = true;
    } else {
      try {
        const res = await this.page.send<{ body: string; base64Encoded?: boolean }>("Network.getResponseBody", { requestId });
        const text = res.base64Encoded ? Buffer.from(res.body, "base64").toString("utf8") : res.body;
        entry.size = Buffer.byteLength(text);
        if (entry.size > this.maxBodyBytes) {
          entry.bodyTruncated = true;
        } else {
          try {
            entry.json = JSON.parse(text);
          } catch {
            entry.text = text;
          }
        }
      } catch (e) {
        // Evicted or redirected bodies cannot be read: say so, keep the metadata.
        entry.error = e instanceof Error ? e.message : String(e);
      }
    }
    if (!this.active) return; // stop() gave up waiting
    entry.n = this.next++;
    this.log.push(entry);
    if (this.log.length > this.maxEntries) this.log.splice(0, this.log.length - this.maxEntries);
  }
}

// --- log helpers for the CLI and MCP -------------------------------------------

export interface NetworkSummary {
  n: number;
  method: string;
  status: number;
  url: string;
  mime: string;
  size: number;
}

function stored(targetId: string, o?: StateOptions): NetworkEntry[] {
  return readNetwork(targetId, o).filter((e): e is NetworkEntry => typeof e === "object" && e !== null && typeof (e as NetworkEntry).n === "number");
}

export function listNetwork(targetId: string, o?: StateOptions): NetworkSummary[] {
  return stored(targetId, o).map(({ n, method, status, url, mime, size }) => ({ n, method, status, url, mime, size }));
}

export function getNetworkEntry(targetId: string, n: number, o?: StateOptions): NetworkEntry | null {
  return stored(targetId, o).find((e) => e.n === n) ?? null;
}

export function clearNetworkLog(targetId: string, o?: StateOptions): void {
  clearNetwork(targetId, o);
}
