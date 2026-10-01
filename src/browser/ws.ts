import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { request } from "node:http";
import type { Socket } from "node:net";

// A minimal RFC 6455 client, just enough for the DevTools endpoint on loopback.
// Node 18 has no global WebSocket and the engine may not take a dependency, so
// this is the only WebSocket path in the library.

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_MESSAGE = 64 * 1024 * 1024;

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** A violation of the protocol; `code` is the close status to answer with. */
export class WsProtocolError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "WsProtocolError";
  }
}

/** Encode one frame. Client frames are masked (RFC 6455 section 5.3) unless told otherwise. */
export function encodeFrame(opcode: number, payload: Buffer, opts: { mask?: boolean; fin?: boolean; maskKey?: Buffer } = {}): Buffer {
  const mask = opts.mask ?? true;
  const len = payload.length;
  const lenBytes = len <= 125 ? 0 : len <= 0xffff ? 2 : 8;
  const head = Buffer.alloc(2 + lenBytes + (mask ? 4 : 0));
  head[0] = (opts.fin === false ? 0 : 0x80) | (opcode & 0x0f);
  head[1] = (mask ? 0x80 : 0) | (lenBytes === 0 ? len : lenBytes === 2 ? 126 : 127);
  if (lenBytes === 2) head.writeUInt16BE(len, 2);
  if (lenBytes === 8) head.writeBigUInt64BE(BigInt(len), 2);
  if (!mask) return Buffer.concat([head, payload]);
  const key = opts.maskKey ?? randomBytes(4);
  key.copy(head, 2 + lenBytes);
  return Buffer.concat([head, unmask(payload, key)]);
}

function unmask(payload: Buffer, key: Buffer): Buffer {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i++) out[i] = payload[i]! ^ key[i & 3]!;
  return out;
}

/** Incremental frame parser: feed it chunks cut anywhere, get back the frames completed so far. */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);
  private readonly max: number;

  constructor(opts: { maxMessageSize?: number } = {}) {
    this.max = opts.maxMessageSize ?? DEFAULT_MAX_MESSAGE;
  }

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      const frame = this.next();
      if (!frame) return frames;
      frames.push(frame);
    }
  }

  private next(): Frame | undefined {
    const b = this.buf;
    if (b.length < 2) return undefined;
    const masked = (b[1]! & 0x80) !== 0;
    let len = b[1]! & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return undefined;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return undefined;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.max)) throw new WsProtocolError("message too large", 1009);
      len = Number(big);
      off = 10;
    }
    if (len > this.max) throw new WsProtocolError("message too large", 1009);
    const total = off + (masked ? 4 : 0) + len;
    if (b.length < total) return undefined;
    const payload = masked ? unmask(b.subarray(off + 4, total), b.subarray(off, off + 4)) : Buffer.from(b.subarray(off, total));
    this.buf = b.subarray(total);
    return { fin: (b[0]! & 0x80) !== 0, opcode: b[0]! & 0x0f, payload };
  }
}

export interface WsOptions {
  /** Handshake budget (default 10 s). */
  connectTimeoutMs?: number;
  /** How long `close()` waits for the peer before dropping the socket (default 2 s). */
  closeTimeoutMs?: number;
  /** Largest message accepted, fragments included (default 64 MiB). */
  maxMessageSize?: number;
}

export interface WsCloseInfo {
  code: number;
  reason: string;
}

/**
 * An open connection. Events: `'message'` (string), `'close'` ({ code, reason },
 * emitted once) and `'error'` (Error, followed by `'close'`).
 */
export class WsClient extends EventEmitter {
  private readonly parser: FrameParser;
  private readonly max: number;
  private readonly closeTimeoutMs: number;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private started = false;
  private closing = false;
  private done = false;

  constructor(
    private readonly socket: Socket,
    opts: WsOptions = {},
    head: Buffer = Buffer.alloc(0),
  ) {
    super();
    this.max = opts.maxMessageSize ?? DEFAULT_MAX_MESSAGE;
    this.closeTimeoutMs = opts.closeTimeoutMs ?? 2000;
    this.parser = new FrameParser({ maxMessageSize: this.max });
    socket.on("data", (d) => this.feed(d));
    socket.on("error", (e) => this.fail(e, 1006));
    socket.on("close", () => this.finish(1006, ""));
    // Frames may already sit in `head` (or the socket) when the caller gets us:
    // hold them back one tick so listeners attached right after `await` see them.
    socket.pause();
    setImmediate(() => {
      if (head.length) this.feed(head);
      socket.resume();
    });
  }

  send(text: string): void {
    if (this.done || this.closing) throw new Error("WebSocket is not open");
    this.socket.write(encodeFrame(0x1, Buffer.from(text, "utf8")));
  }

  /** Send a close frame, then wait (bounded) for the peer to answer or hang up. */
  async close(code = 1000, reason = ""): Promise<void> {
    if (this.done) return;
    if (!this.closing) {
      this.closing = true;
      this.writeClose(code, reason);
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.socket.destroy();
        this.finish(code, reason);
      }, this.closeTimeoutMs);
      this.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Drop the socket without a closing handshake. */
  terminate(): void {
    this.socket.destroy();
    this.finish(1006, "");
  }

  private writeClose(code: number, reason: string): void {
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    if (!this.socket.destroyed) this.socket.write(encodeFrame(0x8, payload));
  }

  private feed(chunk: Buffer): void {
    const messages: string[] = [];
    let failure: unknown;
    try {
      for (const frame of this.parser.push(chunk)) {
        const text = this.onFrame(frame);
        if (text !== undefined) messages.push(text);
      }
    } catch (e) {
      failure = e;
    }
    // Listeners run outside the try: a throwing one is the consumer's bug, not a protocol violation.
    for (const text of messages) this.deliver(text);
    if (failure) this.fail(failure as Error, failure instanceof WsProtocolError ? failure.code : 1002);
  }

  private deliver(text: string): void {
    try {
      this.emit("message", text);
    } catch (e) {
      // Keep the connection and the remaining messages; never swallow the error.
      if (this.listenerCount("error") > 0) this.emit("error", e);
      else
        process.nextTick(() => {
          throw e;
        });
    }
  }

  /** Handle one frame; returns the text of a message it completed. */
  private onFrame(f: Frame): string | undefined {
    if (this.done) return;
    switch (f.opcode) {
      case 0x9:
        if (!this.socket.destroyed) this.socket.write(encodeFrame(0xa, f.payload));
        return;
      case 0xa:
        return;
      case 0x8: {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
        const reason = f.payload.subarray(2).toString("utf8");
        if (!this.closing) this.writeClose(f.payload.length >= 2 ? code : 1000, "");
        this.socket.end();
        this.finish(code, reason);
        return;
      }
      case 0x1:
      case 0x2:
        if (this.started) throw new WsProtocolError("new data frame inside a fragmented message", 1002);
        this.started = true;
        break;
      case 0x0:
        if (!this.started) throw new WsProtocolError("unexpected continuation frame", 1002);
        break;
      default:
        throw new WsProtocolError(`unknown opcode ${f.opcode}`, 1002);
    }
    this.fragmentBytes += f.payload.length;
    if (this.fragmentBytes > this.max) throw new WsProtocolError("message too large", 1009);
    this.fragments.push(f.payload);
    if (!f.fin) return;
    const text = Buffer.concat(this.fragments).toString("utf8");
    this.fragments = [];
    this.fragmentBytes = 0;
    this.started = false;
    return text;
  }

  /** Protocol or socket failure: tell the peer why (when we can), surface the error, close. */
  private fail(err: Error, code: number): void {
    if (this.done) return;
    if (code !== 1006 && !this.closing) {
      this.closing = true;
      this.writeClose(code, "");
    }
    if (this.listenerCount("error") > 0) this.emit("error", err);
    this.socket.end();
    this.finish(code, err.message);
  }

  private finish(code: number, reason: string): void {
    if (this.done) return;
    this.done = true;
    this.emit("close", { code, reason } satisfies WsCloseInfo);
  }
}

/** Open a `ws://` connection (loopback is the only intended use; `wss://` is refused). */
export function connectWebSocket(url: string, opts: WsOptions = {}): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error(`bad WebSocket URL: ${url}`));
    }
    if (u.protocol !== "ws:") return reject(new Error(`only ws:// URLs are supported, got ${u.protocol}//`));
    const key = randomBytes(16).toString("base64");
    const expected = createHash("sha1")
      .update(key + GUID)
      .digest("base64");
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const req = request({
      host: u.hostname.replace(/^\[|\]$/g, ""),
      port: u.port || 80,
      path: u.pathname + u.search,
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" },
    });
    const timer = setTimeout(
      () =>
        settle(() => {
          req.destroy();
          reject(new Error(`WebSocket connect timed out after ${opts.connectTimeoutMs ?? 10_000} ms`));
        }),
      opts.connectTimeoutMs ?? 10_000,
    );
    req.on("upgrade", (res, socket, head) => {
      if (res.headers["sec-websocket-accept"] !== expected) {
        socket.destroy();
        return settle(() => reject(new Error("WebSocket handshake failed: bad Accept")));
      }
      settle(() => resolve(new WsClient(socket, opts, head)));
    });
    req.on("response", (res) => {
      res.resume();
      settle(() => reject(new Error(`WebSocket handshake failed: HTTP ${res.statusCode}`)));
    });
    req.on("error", (e) => settle(() => reject(e)));
    req.end();
  });
}
