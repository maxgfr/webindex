declare const PROTOCOL_VERSIONS: readonly ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];
declare const LATEST_PROTOCOL: ProtocolVersion;
declare const ASSUMED_HTTP_PROTOCOL: ProtocolVersion;
declare const ANNOTATIONS_SINCE = "2025-03-26";
declare const RICH_TOOLS_SINCE = "2025-06-18";
declare const DEFAULT_MAX_RESPONSE_BYTES = 1000000;
declare function isProtocolVersion(v: unknown): v is ProtocolVersion;
declare function negotiateProtocol(requested: unknown): ProtocolVersion;
interface JsonSchemaProp {
    type?: "string" | "number" | "boolean" | "array" | "object";
    items?: {
        type?: string;
    };
    enum?: readonly string[];
    description?: string;
}
interface JsonSchema {
    type: "object";
    properties: Record<string, JsonSchemaProp>;
    required: string[];
}
declare function validateArgs(schema: JsonSchema, args: Record<string, unknown>): string | undefined;
/**
 * How to ask for less, per tool name.
 *
 * A cap that only says "too big" makes the model retry the same call; one that
 * names the narrowing argument gets a smaller second call. Which argument that
 * is depends entirely on the tool, so the map is supplied by the consuming
 * skill through McpAdapter.capAdvice — the engine knows a response is oversized,
 * only the skill knows how to make it smaller.
 */
type CapAdvice = Record<string, string>;
declare function capResponse(text: string, tool: string, maxBytes: number, artifact?: string, advice?: CapAdvice): string;
declare function structuredContentFor(text: string, capped: boolean, hasSchema: boolean): Record<string, unknown> | undefined;
declare function isOriginAllowed(origin: string | undefined, allowed?: string[]): boolean;

interface JsonRpcMessage {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
    [k: string]: unknown;
}
interface ToolDecl {
    name: string;
    description: string;
    inputSchema: JsonSchema;
    title?: string;
    outputSchema?: JsonSchema;
    annotations?: Record<string, boolean>;
}
interface PromptDecl {
    name: string;
    title?: string;
    description?: string;
    arguments?: {
        name: string;
        description?: string;
        required?: boolean;
    }[];
}
interface PromptResult {
    description?: string;
    messages: {
        role: string;
        content: {
            type: string;
            text: string;
        };
    }[];
}
/** What a tool handler gives back: text for the model, plus an optional artifact path. */
interface ToolOutcome {
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
declare class ToolError extends Error {
}
/** Thrown for an unknown prompt or a missing required argument. A client bug. */
declare class PromptError extends Error {
}
/**
 * The skill half of the server. Everything the engine cannot know.
 *
 * `listTools` takes the negotiated protocol version because tool declarations
 * are version-gated: annotations and output schemas only exist from certain
 * revisions onward, and advertising them to an older client is a spec
 * violation.
 */
interface McpAdapter {
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
interface ServerOptions {
    maxResponseBytes?: number;
    /** Defaults to the brand name. */
    serverName?: string;
    skillDir?: string;
}
declare const ERR_INVALID_REQUEST = -32600;
declare const ERR_METHOD_NOT_FOUND = -32601;
declare const ERR_INVALID_PARAMS = -32602;
declare const ERR_INTERNAL = -32603;
interface McpServer {
    handle(msg: JsonRpcMessage, send: (out: JsonRpcMessage) => void): Promise<void>;
    protocolVersion(): ProtocolVersion;
    setProtocolVersion(v: ProtocolVersion): void;
    tools(): ToolDecl[];
}
declare function createServer(adapter: McpAdapter, opts?: ServerOptions): McpServer;

export { ANNOTATIONS_SINCE as A, type CapAdvice as C, DEFAULT_MAX_RESPONSE_BYTES as D, ERR_INTERNAL as E, type JsonRpcMessage as J, LATEST_PROTOCOL as L, type McpAdapter as M, PROTOCOL_VERSIONS as P, RICH_TOOLS_SINCE as R, type ServerOptions as S, type ToolDecl as T, ASSUMED_HTTP_PROTOCOL as a, ERR_INVALID_PARAMS as b, ERR_INVALID_REQUEST as c, ERR_METHOD_NOT_FOUND as d, type JsonSchema as e, type JsonSchemaProp as f, type McpServer as g, type PromptDecl as h, PromptError as i, type PromptResult as j, type ProtocolVersion as k, ToolError as l, type ToolOutcome as m, capResponse as n, createServer as o, isOriginAllowed as p, isProtocolVersion as q, negotiateProtocol as r, structuredContentFor as s, validateArgs as v };
