import { type WsClient, connectWebSocket } from "./ws.js";

// A small Chrome DevTools Protocol client: id-correlated commands, events routed
// by flat-mode sessionId. It speaks over the in-house WebSocket client only.

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** The error answer of a CDP command. */
export class CdpError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(`CDP ${method} failed: ${message}${code ? ` (${code})` : ""}`);
    this.name = "CdpError";
  }
}

/** What the client needs from a socket; `WsClient` satisfies it, tests may inject their own. */
export type CdpSocket = Pick<WsClient, "send" | "on" | "terminate"> & { close(code?: number, reason?: string): Promise<void> | void };
export type CdpConnector = (url: string, opts: { timeoutMs: number }) => Promise<CdpSocket>;

export interface CdpConnectOptions {
  timeoutMs?: number;
  /** Replaces the real WebSocket connector (tests). */
  transport?: CdpConnector;
}

export interface CdpSendOptions {
  sessionId?: string;
  timeoutMs?: number;
}

export interface CdpOnceOptions {
  predicate?: (params: any) => boolean;
  timeoutMs?: number;
  sessionId?: string;
}

export type CdpHandler = (params: any) => void;

/** A client bound to one flat-mode session. */
export interface CdpSession {
  readonly sessionId: string;
  send<T = unknown>(method: string, params?: object, opts?: { timeoutMs?: number }): Promise<T>;
  on(method: string, handler: CdpHandler): void;
  off(method: string, handler: CdpHandler): void;
  once(method: string, opts?: Omit<CdpOnceOptions, "sessionId">): Promise<any>;
}

interface Pending {
  method: string;
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const defaultConnector: CdpConnector = (url, { timeoutMs }) => connectWebSocket(url, { connectTimeoutMs: timeoutMs });

// Session-less and per-session handlers live in separate buckets.
const bucket = (sessionId: string | undefined, method: string) => `${sessionId ?? ""}\n${method}`;

export class CdpClient {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<CdpHandler>>();
  private readonly closeHandlers = new Set<() => void>();
  private isClosed = false;

  private constructor(private readonly ws: CdpSocket) {
    ws.on("message", (text: string) => this.onMessage(text));
    ws.on("close", () => this.onClosed());
    // Socket errors are always followed by 'close', which rejects what is pending.
    ws.on("error", () => {});
  }

  static async connect(wsUrl: string, opts: CdpConnectOptions = {}): Promise<CdpClient> {
    const connector = opts.transport ?? defaultConnector;
    return new CdpClient(await connector(wsUrl, { timeoutMs: opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS }));
  }

  get closed(): boolean {
    return this.isClosed;
  }

  send<T = unknown>(method: string, params?: object, opts: CdpSendOptions = {}): Promise<T> {
    if (this.isClosed) return Promise.reject(new Error(`CDP connection closed (${method})`));
    const id = ++this.nextId;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method} (${timeoutMs} ms)`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params, sessionId: opts.sessionId }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  on(method: string, handler: CdpHandler, sessionId?: string): void {
    const key = bucket(sessionId, method);
    let set = this.handlers.get(key);
    if (!set) this.handlers.set(key, (set = new Set()));
    set.add(handler);
  }

  off(method: string, handler: CdpHandler, sessionId?: string): void {
    const key = bucket(sessionId, method);
    const set = this.handlers.get(key);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.handlers.delete(key);
  }

  /** Resolve with the params of the next matching event; reject on timeout or when the socket closes. */
  once(method: string, opts: CdpOnceOptions = {}): Promise<any> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off(method, handler, opts.sessionId);
        this.closeHandlers.delete(onClose);
      };
      const handler: CdpHandler = (params) => {
        if (opts.predicate && !opts.predicate(params)) return;
        cleanup();
        resolve(params);
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`CDP connection closed while waiting for ${method}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for CDP event ${method} (${timeoutMs} ms)`));
      }, timeoutMs);
      this.on(method, handler, opts.sessionId);
      this.closeHandlers.add(onClose);
      if (this.isClosed) onClose();
    });
  }

  /** A view of this client bound to one session (`Target.attachToTarget({ flatten: true })`). */
  session(sessionId: string): CdpSession {
    return {
      sessionId,
      send: (method, params, opts) => this.send(method, params, { ...opts, sessionId }),
      on: (method, handler) => this.on(method, handler, sessionId),
      off: (method, handler) => this.off(method, handler, sessionId),
      once: (method, opts) => this.once(method, { ...opts, sessionId }),
    };
  }

  onClose(handler: () => void): void {
    if (this.isClosed) handler();
    else this.closeHandlers.add(handler);
  }

  /** Close the connection (the browser keeps running). */
  async close(): Promise<void> {
    if (this.isClosed) return;
    await this.ws.close();
    this.onClosed();
  }

  private onMessage(text: string): void {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg === null || typeof msg !== "object") return;
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(p.method, Number(msg.error.code) || 0, String(msg.error.message ?? "unknown error")));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method !== "string") return;
    const set = this.handlers.get(bucket(msg.sessionId, msg.method));
    if (!set) return;
    // Copy: handlers (once) unregister themselves while we iterate.
    for (const h of [...set]) {
      try {
        h(msg.params);
      } catch {
        // a faulty listener must not break the others
      }
    }
  }

  private onClosed(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`CDP connection closed (${p.method})`));
    }
    this.pending.clear();
    for (const h of [...this.closeHandlers]) h();
    this.closeHandlers.clear();
  }
}
