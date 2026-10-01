import { createHash } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { FrameParser, encodeFrame } from "../../src/browser/ws.js";

// A scriptable fake of a Chrome DevTools endpoint on 127.0.0.1: the /json/*
// HTTP routes plus CDP JSON over WebSocket (the real frame codec, server side).

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface FakeTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface FakeCall {
  method: string;
  params: any;
  sessionId?: string;
}

export type FakeHandler = (params: any, sessionId?: string) => unknown | Promise<unknown>;

export interface FakeCdpOptions {
  /** Answer PUT /json/new with 405, as pre-111 builds did not and some proxies do. */
  rejectPut?: boolean;
}

export class FakeCdp {
  /** Ordered log of every CDP command received. */
  readonly calls: FakeCall[] = [];
  /** Ordered log of HTTP requests: `"PUT /json/new?..."`. */
  readonly requests: string[] = [];
  readonly targets: FakeTarget[] = [];
  rejectPut: boolean;
  port = 0;
  private readonly handlers = new Map<string, FakeHandler>();
  private readonly sockets = new Set<Socket>();
  private readonly conns = new Set<Socket>();
  private server!: Server;
  private nextTarget = 1;

  constructor(opts: FakeCdpOptions = {}) {
    this.rejectPut = opts.rejectPut ?? false;
  }

  static async start(opts: FakeCdpOptions = {}): Promise<FakeCdp> {
    const fake = new FakeCdp(opts);
    fake.server = createServer((req, res) => fake.onHttp(req, res));
    fake.server.on("upgrade", (req, socket) => fake.onUpgrade(req, socket as Socket));
    fake.server.on("connection", (s) => {
      fake.conns.add(s);
      s.on("close", () => fake.conns.delete(s));
    });
    await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
    fake.port = (fake.server.address() as AddressInfo).port;
    return fake;
  }

  get browserWsUrl(): string {
    return `ws://127.0.0.1:${this.port}/devtools/browser/fake`;
  }

  /** Register a page target (also what /json/list reports). */
  addTarget(url = "about:blank", title = "", type = "page"): FakeTarget {
    const id = `T${this.nextTarget++}`;
    const target = { id, type, title, url, webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/page/${id}` };
    this.targets.push(target);
    return target;
  }

  /** Script a command. Return the result, or throw `{ code, message }` for a CDP error. */
  handle(method: string, handler: FakeHandler): void {
    this.handlers.set(method, handler);
  }

  /** Push an event to every connected client. */
  emit(method: string, params: unknown = {}, sessionId?: string): void {
    this.broadcast({ method, params, ...(sessionId ? { sessionId } : {}) });
  }

  /** Send raw text to every client (malformed-frame tests). */
  sendRaw(text: string): void {
    for (const s of this.sockets) s.write(encodeFrame(0x1, Buffer.from(text), { mask: false }));
  }

  /** Hang up on every WebSocket client without a closing handshake. */
  dropClients(): void {
    for (const s of [...this.sockets]) s.destroy();
  }

  async close(): Promise<void> {
    for (const s of this.conns) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private broadcast(msg: object): void {
    const frame = encodeFrame(0x1, Buffer.from(JSON.stringify(msg)), { mask: false });
    for (const s of this.sockets) s.write(frame);
  }

  private onHttp(req: IncomingMessage, res: ServerResponse) {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    this.requests.push(`${method} ${url}`);
    const send = (status: number, body: string, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(body);
    };
    const [path = "", query = ""] = url.split("?", 2);
    if (path === "/json/version") {
      return send(200, JSON.stringify({ Browser: "FakeChrome/1.0", "Protocol-Version": "1.3", webSocketDebuggerUrl: this.browserWsUrl }));
    }
    if (path === "/json/list" || path === "/json") return send(200, JSON.stringify(this.targets));
    if (path === "/json/new") {
      if (method === "PUT" && this.rejectPut)
        return send(405, "Using unsafe HTTP verb GET to invoke /json/new. This action supports only PUT verb.", "text/plain");
      const target = this.addTarget(query ? decodeURIComponent(query) : "about:blank");
      return send(200, JSON.stringify(target));
    }
    const m = /^\/json\/(close|activate)\/(.+)$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[2] as string);
      const idx = this.targets.findIndex((t) => t.id === id);
      if (idx < 0) return send(404, `No such target id: ${id}`, "text/plain");
      if (m[1] === "close") this.targets.splice(idx, 1);
      return send(200, m[1] === "close" ? "Target is closing" : "Target activated", "text/plain");
    }
    send(404, "Not found", "text/plain");
  }

  private onUpgrade(req: IncomingMessage, socket: Socket): void {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const known = path === "/devtools/browser/fake" || this.targets.some((t) => t.webSocketDebuggerUrl.endsWith(path));
    const key = req.headers["sec-websocket-key"];
    if (!known || typeof key !== "string") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const accept = createHash("sha1")
      .update(key + GUID)
      .digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    const parser = new FrameParser();
    socket.on("data", (chunk) => {
      for (const f of parser.push(chunk)) {
        if (f.opcode === 0x8) {
          socket.end(encodeFrame(0x8, f.payload.subarray(0, 2), { mask: false }));
        } else if (f.opcode === 0x1) {
          void this.onCommand(socket, f.payload.toString("utf8"));
        }
      }
    });
  }

  private async onCommand(socket: Socket, text: string): Promise<void> {
    let msg: { id: number; method: string; params?: unknown; sessionId?: string };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    this.calls.push({ method: msg.method, params: msg.params, sessionId: msg.sessionId });
    const reply = (body: object) => {
      if (socket.destroyed) return;
      socket.write(
        encodeFrame(0x1, Buffer.from(JSON.stringify({ id: msg.id, ...body, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) })), { mask: false }),
      );
    };
    const handler = this.handlers.get(msg.method);
    if (!handler) return reply({ result: {} });
    try {
      reply({ result: (await handler(msg.params, msg.sessionId)) ?? {} });
    } catch (e) {
      const err = e as { code?: number; message?: string };
      reply({ error: { code: err.code ?? -32000, message: err.message ?? String(e) } });
    }
  }
}
