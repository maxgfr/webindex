import { createHash, randomBytes } from "node:crypto";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type Frame, FrameParser, type WsClient, WsProtocolError, connectWebSocket, encodeFrame } from "../src/browser/ws.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const accept = (key: string) =>
  createHash("sha1")
    .update(key + GUID)
    .digest("base64");

describe("encodeFrame / FrameParser", () => {
  const sizes = [0, 125, 126, 65535, 65536, 3 * 1024 * 1024];
  for (const size of sizes) {
    for (const mask of [true, false]) {
      it(`round-trips ${size} bytes (${mask ? "masked" : "unmasked"})`, () => {
        const payload = randomBytes(size);
        const wire = encodeFrame(0x2, payload, { mask });
        const frames = new FrameParser().push(wire);
        expect(frames).toHaveLength(1);
        expect(frames[0]?.opcode).toBe(0x2);
        expect(frames[0]?.fin).toBe(true);
        expect(frames[0]?.payload.equals(payload)).toBe(true);
      });
    }
  }

  it("uses the three length encodings", () => {
    expect(encodeFrame(1, Buffer.alloc(125), { mask: false }).length).toBe(2 + 125);
    expect(encodeFrame(1, Buffer.alloc(126), { mask: false }).length).toBe(4 + 126);
    expect(encodeFrame(1, Buffer.alloc(65536), { mask: false }).length).toBe(10 + 65536);
  });

  it("masks by default with an injectable key, and honours fin=false", () => {
    const wire = encodeFrame(0x1, Buffer.from("abc"), { maskKey: Buffer.from([1, 2, 3, 4]), fin: false });
    expect(wire[0]).toBe(0x01);
    expect(wire[1]).toBe(0x80 | 3);
    expect([...wire.subarray(2, 6)]).toEqual([1, 2, 3, 4]);
    expect([...wire.subarray(6)]).toEqual([0x61 ^ 1, 0x62 ^ 2, 0x63 ^ 3]);
    const [f] = new FrameParser().push(wire);
    expect(f?.fin).toBe(false);
    expect(f?.payload.toString()).toBe("abc");
  });

  it("parses byte by byte", () => {
    const payload = randomBytes(300);
    const wire = Buffer.concat([encodeFrame(0x2, payload), encodeFrame(0x1, Buffer.from("hi"), { mask: false })]);
    const parser = new FrameParser();
    const out: Frame[] = [];
    for (let i = 0; i < wire.length; i++) out.push(...parser.push(wire.subarray(i, i + 1)));
    expect(out).toHaveLength(2);
    expect(out[0]?.payload.equals(payload)).toBe(true);
    expect(out[1]?.payload.toString()).toBe("hi");
  });

  it("parses random-size chunks", () => {
    const payloads = [randomBytes(70000), Buffer.alloc(0), randomBytes(200), randomBytes(5)];
    const wire = Buffer.concat(payloads.map((p, i) => encodeFrame(0x2, p, { mask: i % 2 === 0 })));
    const parser = new FrameParser();
    const out: Frame[] = [];
    for (let i = 0; i < wire.length; ) {
      const n = 1 + Math.floor(Math.random() * 5000);
      out.push(...parser.push(wire.subarray(i, i + n)));
      i += n;
    }
    expect(out.map((f) => f.payload.length)).toEqual(payloads.map((p) => p.length));
    out.forEach((f, i) => expect(f.payload.equals(payloads[i]!)).toBe(true));
  });

  it("returns several frames from one chunk", () => {
    const wire = Buffer.concat([1, 2, 3].map((n) => encodeFrame(0x1, Buffer.from(String(n)), { mask: false })));
    expect(new FrameParser().push(wire).map((f) => f.payload.toString())).toEqual(["1", "2", "3"]);
  });

  it("rejects a frame above the max size with 1009", () => {
    const wire = encodeFrame(0x2, Buffer.alloc(100), { mask: false });
    expect(() => new FrameParser({ maxMessageSize: 99 }).push(wire)).toThrow(WsProtocolError);
    try {
      new FrameParser({ maxMessageSize: 99 }).push(wire);
    } catch (e) {
      expect((e as WsProtocolError).code).toBe(1009);
    }
  });

  it("rejects a 64-bit length that does not fit", () => {
    const head = Buffer.alloc(10);
    head[0] = 0x82;
    head[1] = 127;
    head.writeBigUInt64BE(2n ** 40n, 2);
    expect(() => new FrameParser().push(head)).toThrow(WsProtocolError);
  });
});

// A real server speaking the other side of the protocol.
type Handler = (socket: Socket, send: (opcode: number, payload?: Buffer, fin?: boolean) => void, req: IncomingMessage) => void;

let server: Server | undefined;
const sockets = new Set<Socket>();
const clients: WsClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  for (const s of sockets) s.destroy();
  sockets.clear();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function serve(
  onUpgrade: Handler,
  opts: { badAccept?: boolean; status?: number; hang?: boolean } = {},
): Promise<{ url: string; frames: Frame[]; received: Promise<void> }> {
  const frames: Frame[] = [];
  let notify: () => void = () => {};
  const received = new Promise<void>((r) => (notify = r));
  server = createServer((_req, res) => {
    res.writeHead(404);
    res.end("nope");
  });
  server.on("upgrade", (req, socket: Socket) => {
    sockets.add(socket);
    if (opts.hang) return;
    if (opts.status) {
      socket.write(`HTTP/1.1 ${opts.status} Nope\r\nConnection: close\r\n\r\n`);
      socket.end();
      return;
    }
    const key = String(req.headers["sec-websocket-key"]);
    const acc = opts.badAccept ? "AAAA" : accept(key);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
    const parser = new FrameParser();
    socket.on("data", (d) => {
      for (const f of parser.push(d)) {
        frames.push(f);
        notify();
      }
    });
    socket.on("error", () => {});
    onUpgrade(socket, (op, p = Buffer.alloc(0), fin = true) => socket.write(encodeFrame(op, p, { mask: false, fin })), req);
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/devtools/page/x`, frames, received };
}

async function connect(url: string, opts?: ConstructorParameters<typeof WsClient>[1]): Promise<WsClient> {
  const c = await connectWebSocket(url, opts);
  clients.push(c);
  return c;
}

const nextEvent = <T>(c: WsClient, ev: string) => new Promise<T>((r) => c.once(ev, r));

describe("WsClient", () => {
  it("handshakes and echoes text", async () => {
    const echo = await serve((socket) => {
      const parser = new FrameParser();
      socket.on("data", (d) => {
        for (const f of parser.push(d)) socket.write(encodeFrame(f.opcode, f.payload, { mask: false }));
      });
    });
    const c = await connect(echo.url);
    const msg = nextEvent<string>(c, "message");
    c.send("héllo ✓");
    expect(await msg).toBe("héllo ✓");
  });

  it("reassembles a fragmented message around a ping and answers pong", async () => {
    const s = await serve((_sock, send) => {
      send(0x1, Buffer.from("he"), false);
      send(0x9, Buffer.from("pp"));
      send(0x0, Buffer.from("l"), false);
      send(0x0, Buffer.from("lo"), true);
      send(0xa, Buffer.from("unsolicited"));
    });
    const c = await connect(s.url);
    expect(await nextEvent<string>(c, "message")).toBe("hello");
    await s.received;
    const pong = s.frames.find((f) => f.opcode === 0xa);
    expect(pong?.payload.toString()).toBe("pp");
  });

  it("emits close with code and reason on a server-initiated close, and echoes it", async () => {
    const s = await serve((_sock, send) => {
      const p = Buffer.alloc(2 + 3);
      p.writeUInt16BE(4000, 0);
      p.write("bye", 2);
      send(0x8, p);
    });
    const c = await connect(s.url);
    expect(await nextEvent(c, "close")).toEqual({ code: 4000, reason: "bye" });
    await s.received;
    expect(s.frames[0]?.opcode).toBe(0x8);
    expect(s.frames[0]?.payload.readUInt16BE(0)).toBe(4000);
  });

  it("defaults to 1005 when a close frame has no status", async () => {
    const s = await serve((_sock, send) => send(0x8));
    const c = await connect(s.url);
    expect(await nextEvent(c, "close")).toEqual({ code: 1005, reason: "" });
  });

  it("client close() sends 1000 and resolves when the server answers", async () => {
    const s = await serve((socket) => {
      const parser = new FrameParser();
      socket.on("data", (d) => {
        for (const f of parser.push(d)) if (f.opcode === 0x8) socket.end(encodeFrame(0x8, f.payload, { mask: false }));
      });
    });
    const c = await connect(s.url);
    const closed = nextEvent(c, "close");
    await c.close();
    expect(await closed).toEqual({ code: 1000, reason: "" });
    expect(s.frames[0]?.opcode).toBe(0x8);
    expect(s.frames[0]?.payload.readUInt16BE(0)).toBe(1000);
  });

  it("close() is bounded when the peer never answers, and send after close throws", async () => {
    const s = await serve(() => {});
    const c = await connect(s.url, { closeTimeoutMs: 50 });
    await c.close(1000, "done");
    expect(s.frames[0]?.payload.subarray(2).toString()).toBe("done");
    expect(() => c.send("x")).toThrow(/not open/);
    await c.close(); // idempotent
  });

  it("emits close once when the socket drops", async () => {
    const s = await serve((socket) => setTimeout(() => socket.destroy(), 10));
    const c = await connect(s.url);
    let n = 0;
    c.on("close", () => n++);
    await nextEvent(c, "close");
    await new Promise((r) => setTimeout(r, 30));
    expect(n).toBe(1);
  });

  it("answers an oversize message with 1009", async () => {
    const s = await serve((_sock, send) => send(0x1, Buffer.alloc(200, 0x61)));
    const c = await connect(s.url, { maxMessageSize: 100 });
    const err = nextEvent<Error>(c, "error");
    const closed = nextEvent<{ code: number }>(c, "close");
    expect((await err).message).toMatch(/too large|1009/);
    expect((await closed).code).toBe(1009);
    await s.received;
    expect(s.frames[0]?.opcode).toBe(0x8);
    expect(s.frames[0]?.payload.readUInt16BE(0)).toBe(1009);
  });

  it("applies the size limit to a reassembled fragmented message", async () => {
    const s = await serve((_sock, send) => {
      send(0x1, Buffer.alloc(60, 0x61), false);
      send(0x0, Buffer.alloc(60, 0x61), true);
    });
    const c = await connect(s.url, { maxMessageSize: 100 });
    c.on("error", () => {});
    expect((await nextEvent<{ code: number }>(c, "close")).code).toBe(1009);
  });

  it("fails the connection on an unexpected continuation frame", async () => {
    const s = await serve((_sock, send) => send(0x0, Buffer.from("x")));
    const c = await connect(s.url);
    c.on("error", () => {});
    expect((await nextEvent<{ code: number }>(c, "close")).code).toBe(1002);
  });

  it("rejects a bad Sec-WebSocket-Accept", async () => {
    const s = await serve(() => {}, { badAccept: true });
    await expect(connectWebSocket(s.url)).rejects.toThrow(/bad Accept/);
  });

  it("rejects a non-101 response", async () => {
    const s = await serve(() => {}, { status: 403 });
    await expect(connectWebSocket(s.url)).rejects.toThrow(/403/);
  });

  it("rejects a plain HTTP response (no upgrade)", async () => {
    server = createServer((_req, res) => {
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    await expect(connectWebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/`)).rejects.toThrow(/200/);
  });

  it("times out when the server never answers", async () => {
    const s = await serve(() => {}, { hang: true });
    await expect(connectWebSocket(s.url, { connectTimeoutMs: 80 })).rejects.toThrow(/timed out/);
  });

  it("rejects when nothing listens", async () => {
    await expect(connectWebSocket("ws://127.0.0.1:1/")).rejects.toThrow();
  });

  it("rejects wss:// and garbage URLs", async () => {
    await expect(connectWebSocket("wss://127.0.0.1:1/")).rejects.toThrow(/ws:\/\//);
    await expect(connectWebSocket("http://127.0.0.1:1/")).rejects.toThrow(/ws:\/\//);
  });
});
