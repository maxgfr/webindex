import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { batchRefusal, type ProtocolVersion } from "./protocol.js";
import { createServer, ERR_INVALID_REQUEST, type JsonRpcMessage, type McpAdapter, type ServerOptions } from "./server.js";
import { toolSlots } from "./slots.js";

// The stdio transport: one JSON-RPC message per line, in on stdin, out on
// stdout. This is what `claude mcp add --transport stdio` and Claude Desktop
// speak, and it is the default.
//
// Two properties this file exists to guarantee:
//
// 1. stdout carries frames and nothing else. Today no module outside cli.ts
//    writes to stdout, but "nobody does it yet" is an invariant maintained by
//    discipline. Reassigning process.stdout.write makes it one maintained by
//    construction: a console.log added to a source module in a year lands on
//    stderr instead of corrupting the stream mid-session.
//
// 2. A slow tool never blocks a fast one. a cold-start tool call takes
//    tens of seconds; serializing the read loop behind it would make `ping` and
//    `tools/list` time out. JSON-RPC explicitly permits out-of-order responses.

export interface StdioOptions extends ServerOptions {
  input?: Readable;
  output?: Writable;
  // Skip the stdout guard. Only for tests, which need to read what the server
  // wrote through a stream they control.
  captureStdout?: boolean;
}

export async function runStdioServer(adapter: McpAdapter, opts: StdioOptions = {}): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;

  // Capture the real writer BEFORE the guard goes up, so frames still reach the
  // client afterwards.
  const emit = output.write.bind(output);
  let restore: (() => void) | undefined;
  if (!opts.captureStdout && output === process.stdout) {
    const original = process.stdout.write;
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
      (process.stderr.write as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
    restore = () => {
      process.stdout.write = original;
    };
  }

  const server = createServer(adapter, opts);
  const send = (msg: JsonRpcMessage) => {
    emit(JSON.stringify(msg) + "\n");
  };

  const inFlight = new Set<Promise<void>>();
  const track = (p: Promise<void>) => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
    return p;
  };

  // The in-flight SET is lifecycle: what must finish before stdin's close is
  // allowed to end the session. It is not a budget, because one tracked promise
  // can be a whole batch — four batch frames each running four handlers is
  // sixteen tool calls at once, four times the ceiling this file advertises.
  //
  // The budget is this counter, and every TOOL CALL passes through it: a batch
  // member competes for the same slots as a single frame, so the ceiling holds
  // however the client frames its requests.
  //
  // Nothing else waits for a slot, and the read loop never does. It used to
  // stop reading while four calls ran, and then a ping went unanswered — and
  // the notifications/cancelled meant for those very calls sat unread until
  // one of them finished on its own. A ping, a tools/list or a cancel costs
  // nothing, so it is handled the moment it arrives.
  //
  // The same slots the HTTP transport hands out (slots.ts): a freed slot is
  // handed to the head of the queue, never left for whichever call looks first.
  const slots = toolSlots();
  // Tool calls still waiting for a slot. The server only learns of a request
  // once it runs, so a cancel for one still queued is delivered here: the call
  // leaves the queue, and is never run and never answered, as the notification asks.
  const queued = new Map<string | number, AbortController>();
  // The revision `initialize` settled, which decides whether batches exist.
  let negotiated: ProtocolVersion | undefined;

  // `reply` is where the answer goes — a batch collects it — while progress
  // notifications always go straight out as frames of their own.
  const handleOpts = { notify: send };
  const runToolCall = async (msg: JsonRpcMessage, id: string | number, reply: (out: JsonRpcMessage) => void): Promise<void> => {
    const ticket = new AbortController();
    queued.set(id, ticket);
    let release: (() => void) | undefined;
    try {
      release = await slots.acquire(ticket.signal);
    } finally {
      if (queued.get(id) === ticket) queued.delete(id);
    }
    if (!release) return; // cancelled while it queued: it took no slot
    try {
      await server.handle(msg, reply, handleOpts);
    } finally {
      release();
    }
  };

  const dispatch = async (msg: JsonRpcMessage, reply: (out: JsonRpcMessage) => void): Promise<void> => {
    if (msg !== null && typeof msg === "object" && !Array.isArray(msg)) {
      if (msg.method === "notifications/cancelled") {
        const target = msg.params?.requestId;
        if (typeof target === "string" || typeof target === "number") queued.get(target)?.abort();
      }
      const tool = (msg.params as { name?: unknown } | undefined)?.name;
      const ownQueue = typeof tool === "string" && adapter.serialized?.(tool) === true;
      if (msg.method === "tools/call" && !ownQueue && (typeof msg.id === "string" || typeof msg.id === "number")) {
        await runToolCall(msg, msg.id, reply);
        return;
      }
    }
    await server.handle(msg, reply, handleOpts);
    if (msg?.method === "initialize") negotiated = server.protocolVersion();
  };

  const rl = createInterface({ input, terminal: false });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        continue;
      }

      if (Array.isArray(parsed)) {
        const refusal = batchRefusal(parsed, negotiated);
        if (refusal) {
          send({ jsonrpc: "2.0", id: null, error: { code: ERR_INVALID_REQUEST, message: refusal } });
          continue;
        }
        // A batch answers as one array, so the client can match it to what it
        // sent. Notifications inside it contribute nothing, and a batch of only
        // notifications produces no frame at all. Its tool calls draw on the
        // shared budget like any other.
        const batch = parsed as JsonRpcMessage[];
        track(
          (async () => {
            const out: JsonRpcMessage[] = [];
            await Promise.all(batch.map((m) => dispatch(m, (r) => void out.push(r))));
            if (out.length) emit(JSON.stringify(out) + "\n");
          })().catch(reportInternal(send)),
        );
        continue;
      }

      if (parsed === null || typeof parsed !== "object") {
        send({ jsonrpc: "2.0", id: null, error: { code: ERR_INVALID_REQUEST, message: "invalid request: expected a JSON-RPC object" } });
        continue;
      }

      // Deliberately not awaited: the loop goes back for the next frame while
      // this one works.
      track(dispatch(parsed as JsonRpcMessage, send).catch(reportInternal(send)));
    }

    // stdin closed. Let whatever is still running finish and answer — calling
    // process.exit() here would drop these frames, because stdout on a pipe is
    // asynchronous and exit() does not flush it.
    await Promise.all(inFlight);
  } finally {
    rl.close();
    restore?.();
  }
}

function reportInternal(send: (msg: JsonRpcMessage) => void) {
  return (e: unknown) => {
    send({ jsonrpc: "2.0", id: null, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } });
  };
}
