import { brand } from "../brand.js";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  LATEST_PROTOCOL,
  RICH_TOOLS_SINCE,
  capResponse,
  negotiateProtocol,
  structuredContentFor,
  validateArgs,
  type CapAdvice,
  type JsonSchema,
  type ProtocolVersion,
} from "./protocol.js";
import { listResources, readResource, ResourceError } from "./resources.js";

// The JSON-RPC layer, with no idea how the bytes arrive. stdio.ts frames it in
// newline-delimited JSON, http.ts in request bodies; both call `handle`.
//
// Responses go out through a `send` callback rather than a return value. That
// is not decoration: it is what lets a later revision stream progress
// notifications over SSE without touching this file.
//
// ── What the engine owns, and what it does not ──────────────────────────────
//
// Everything protocol-shaped lives here: version negotiation, the notification
// vs request split, cancellation, argument validation against a declared
// schema, response capping, the error taxonomy, and the exact line between a
// JSON-RPC error and an `isError` tool result.
//
// What the engine cannot know is WHICH tools exist. Every consumer exposes its
// own — different names, different schemas, different handlers. So the consumer
// passes an McpAdapter and keeps its tools, handlers and prompts; this file
// keeps the protocol.

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ToolDecl {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  title?: string;
  outputSchema?: JsonSchema;
  annotations?: Record<string, boolean>;
}

export interface PromptDecl {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface PromptResult {
  description?: string;
  messages: { role: string; content: { type: string; text: string } }[];
}

/** What a tool handler gives back: text for the model, plus an optional artifact path. */
export interface ToolOutcome {
  text: string;
  artifact?: string;
}

/**
 * Thrown for anything the caller can fix by calling again differently. The
 * server turns it into an `isError` tool result, never a JSON-RPC error: the
 * tool ran, the request was wrong or the world didn't cooperate.
 *
 * Lives here rather than in each skill so the distinction is decided in ONE
 * place. Conflating a tool failure with a protocol error hides a client bug
 * inside a model-readable result the model then tries to reason around.
 */
export class ToolError extends Error {}

/** Thrown for an unknown prompt or a missing required argument. A client bug. */
export class PromptError extends Error {}

/**
 * The skill half of the server. Everything the engine cannot know.
 *
 * `listTools` takes the negotiated protocol version because tool declarations
 * are version-gated: annotations and output schemas only exist from certain
 * revisions onward, and advertising them to an older client is a spec
 * violation.
 */
export interface McpAdapter {
  /** Version reported in `serverInfo`. The skill's, not the engine's. */
  version: string;
  listTools(protocol: ProtocolVersion): ToolDecl[];
  callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  /**
   * Per-tool advice for narrowing an oversized request. The engine detects the
   * overflow; only the skill knows which argument makes the result smaller.
   */
  capAdvice?: CapAdvice;
  /** Omit to advertise no prompts; the capability is declared either way. */
  prompts?: PromptDecl[];
  getPrompt?(name: string, args: Record<string, unknown>): PromptResult;
}

export interface ServerOptions {
  maxResponseBytes?: number;
  /** Defaults to the brand name. */
  serverName?: string;
  // Where to look for the skill payload (SKILL.md + references/). Injectable
  // for tests; in production resources.ts finds it from its own module path.
  skillDir?: string;
}

export const ERR_INVALID_REQUEST = -32600;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
export const ERR_INTERNAL = -32603;

export interface McpServer {
  // Handle one message. `send` is called zero times for a notification, once
  // for a request. Never throws.
  handle(msg: JsonRpcMessage, send: (out: JsonRpcMessage) => void): Promise<void>;
  // The version agreed during `initialize`. The HTTP transport overrides it per
  // request from the MCP-Protocol-Version header, since it has no session.
  protocolVersion(): ProtocolVersion;
  setProtocolVersion(v: ProtocolVersion): void;
  tools(): ToolDecl[];
}

export function createServer(adapter: McpAdapter, opts: ServerOptions = {}): McpServer {
  const serverInfo = { name: opts.serverName ?? brand().name, version: adapter.version };
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  // Until a client says otherwise, assume the newest. `initialize` replaces it.
  let protocol: ProtocolVersion = LATEST_PROTOCOL;
  // Requests the client withdrew. Per spec a cancelled request gets NO response
  // at all, so the id has to survive until the in-flight work finishes. An id
  // that never had a request in flight is never claimed, so the set is bounded:
  // a client that cancels ids it never sent cannot grow it without limit in a
  // process that may run for days.
  const cancelled = new Set<string>();
  const CANCELLED_MAX = 1024;

  const listTools = () => adapter.listTools(protocol);
  const prompts = () => adapter.prompts ?? [];

  async function handle(msg: JsonRpcMessage, send: (out: JsonRpcMessage) => void): Promise<void> {
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
      send({ jsonrpc: "2.0", id: null, error: { code: ERR_INVALID_REQUEST, message: "invalid request: expected a JSON-RPC object" } });
      return;
    }

    // A message with no id is a notification: act on it, answer nothing.
    if (msg.id === undefined || msg.id === null) {
      if (msg.method === "notifications/cancelled") {
        const target = msg.params?.requestId;
        if (typeof target === "string" || typeof target === "number") {
          if (cancelled.size >= CANCELLED_MAX) cancelled.delete(cancelled.values().next().value!);
          cancelled.add(String(target));
        }
      }
      return;
    }
    const id = msg.id;

    const reply = (out: Omit<JsonRpcMessage, "jsonrpc" | "id">) => {
      // A cancelled request is dropped on the floor — answering it after the
      // client moved on is exactly what the notification asks us not to do.
      if (cancelled.delete(String(id))) return;
      send({ jsonrpc: "2.0", id, ...out });
    };

    try {
      switch (msg.method) {
        case "initialize": {
          protocol = negotiateProtocol(msg.params?.protocolVersion);
          reply({
            result: {
              protocolVersion: protocol,
              // Three primitives, because a skill is three things: the engine
              // (tools), the method (prompts) and the documentation the method
              // refers to (resources). A client given only the first has to
              // invent the other two.
              capabilities: {
                tools: { listChanged: false },
                resources: { subscribe: false, listChanged: false },
                prompts: { listChanged: false },
              },
              serverInfo,
            },
          });
          return;
        }
        case "ping":
          reply({ result: {} });
          return;
        case "tools/list":
          reply({ result: { tools: listTools() } });
          return;
        case "tools/call":
          await handleToolCall(msg, reply);
          return;
        case "resources/list":
          reply({ result: { resources: listResources(opts.skillDir) } });
          return;
        case "resources/read": {
          const uri = typeof msg.params?.uri === "string" ? msg.params.uri : "";
          if (!uri) {
            reply({ error: { code: ERR_INVALID_PARAMS, message: "`uri` is required" } });
            return;
          }
          try {
            reply({ result: { contents: [readResource(uri, opts.skillDir)] } });
          } catch (e) {
            // A resource the client named wrongly is a client bug, the same as
            // an unknown tool — not a read that failed on its own terms.
            if (e instanceof ResourceError) reply({ error: { code: ERR_INVALID_PARAMS, message: e.message } });
            else reply({ error: { code: ERR_INTERNAL, message: errMessage(e) } });
          }
          return;
        }
        case "prompts/list":
          reply({ result: { prompts: prompts() } });
          return;
        case "prompts/get": {
          const name = typeof msg.params?.name === "string" ? msg.params.name : "";
          const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
          try {
            if (!adapter.getPrompt) throw new PromptError(`unknown prompt: ${name || "(none given)"}`);
            reply({ result: adapter.getPrompt(name, args) });
          } catch (e) {
            if (e instanceof PromptError) reply({ error: { code: ERR_INVALID_PARAMS, message: e.message } });
            else reply({ error: { code: ERR_INTERNAL, message: errMessage(e) } });
          }
          return;
        }
        default:
          reply({ error: { code: ERR_METHOD_NOT_FOUND, message: `method not found: ${String(msg.method)}` } });
          return;
      }
    } catch (e) {
      // Nothing above is supposed to throw. Reaching here is a bug in the
      // server, not a bad request — report it as such rather than as a tool
      // failure the model might try to work around.
      reply({ error: { code: ERR_INTERNAL, message: errMessage(e) } });
    }
  }

  async function handleToolCall(msg: JsonRpcMessage, reply: (out: Omit<JsonRpcMessage, "jsonrpc" | "id">) => void): Promise<void> {
    const params = msg.params ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    // An unknown tool and malformed arguments are PROTOCOL errors: the client
    // asked for something that doesn't exist or sent something the declared
    // schema forbids. They are not tool failures, and conflating the two hides
    // a client bug inside a model-readable result the model tries to reason
    // around.
    const decl = listTools().find((t) => t.name === name);
    if (!decl) {
      reply({ error: { code: ERR_INVALID_PARAMS, message: `unknown tool: ${name || "(none given)"}` } });
      return;
    }
    const invalid = validateArgs(decl.inputSchema, args);
    if (invalid) {
      reply({ error: { code: ERR_INVALID_PARAMS, message: invalid } });
      return;
    }

    try {
      const { text: raw, artifact } = await adapter.callTool(name, args);
      const text = capResponse(raw, name, maxBytes, artifact, adapter.capAdvice);
      const capped = text !== raw;
      const structured = protocol >= RICH_TOOLS_SINCE ? structuredContentFor(text, capped, decl.outputSchema !== undefined) : undefined;
      reply({ result: { content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}) } });
    } catch (e) {
      // The tool ran and could not finish: a repo that won't clone, a path
      // outside the tree, a dossier that isn't there. The caller can act on all
      // of these, so they come back as a readable result, not a protocol error.
      //
      // What never lands here: a source that degraded. Those are `notes` inside
      // a successful result — an unreachable issues API is information, not a
      // failure, and reporting it as one would make the model retry work that
      // already told it everything it is going to.
      if (e instanceof ToolError) {
        reply({ result: { content: [{ type: "text", text: e.message }], isError: true } });
        return;
      }
      reply({ error: { code: ERR_INTERNAL, message: errMessage(e) } });
    }
  }

  return {
    handle,
    protocolVersion: () => protocol,
    setProtocolVersion: (v: ProtocolVersion) => {
      protocol = v;
    },
    tools: listTools,
  };
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
