import { PromptError, ToolError, type McpAdapter, type ToolDecl } from "../src/mcp/server.js";
import { ANNOTATIONS_SINCE, RICH_TOOLS_SINCE, type ProtocolVersion } from "../src/mcp/protocol.js";

// A minimal skill, invented for the transport tests.
//
// The engine owns the protocol but not the tools, so its own suite must not
// borrow a real skill's. These four exist to exercise exactly the decisions the
// server makes and nothing else:
//
//   probe_echo    a happy path with a required argument (schema validation)
//   probe_big     returns more text than the cap allows (response capping)
//   probe_fail    throws ToolError (isError result, NOT a JSON-RPC error)
//   probe_crash   throws a plain Error (JSON-RPC internal error)
//
// probe_echo also carries annotations and an output schema so the
// version-gating can be observed: neither may be advertised to a client that
// negotiated a revision predating them.

export const TOOL_NAMES = ["probe_echo", "probe_big", "probe_fail", "probe_crash"];

export function toolsFor(protocol: ProtocolVersion): ToolDecl[] {
  const rich = protocol >= RICH_TOOLS_SINCE;
  const annotated = protocol >= ANNOTATIONS_SINCE;
  return [
    {
      name: "probe_echo",
      description: "Echo the text back.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "what to echo" }, times: { type: "number", description: "repeat count" } },
        required: ["text"],
      },
      ...(rich ? { outputSchema: { type: "object", properties: { text: { type: "string", description: "the echo" } }, required: [] } } : {}),
      ...(annotated ? { annotations: { readOnlyHint: true } } : {}),
    },
    { name: "probe_big", description: "Return a lot of text.", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "probe_fail", description: "Fail the way a tool fails.", inputSchema: { type: "object", properties: {}, required: [] } },
    { name: "probe_crash", description: "Fail the way a bug fails.", inputSchema: { type: "object", properties: {}, required: [] } },
  ];
}

export function testAdapter(overrides: Partial<McpAdapter> = {}): McpAdapter {
  return {
    version: "9.9.9",
    listTools: toolsFor,
    async callTool(name, args) {
      switch (name) {
        case "probe_echo": {
          const times = typeof args.times === "number" ? args.times : 1;
          return { text: String(args.text).repeat(times) };
        }
        case "probe_big":
          return { text: "x".repeat(50_000), artifact: "/tmp/probe/BIG.md" };
        case "probe_fail":
          throw new ToolError("the dossier is not there");
        case "probe_crash":
          throw new Error("boom");
        default:
          throw new ToolError(`unknown tool: ${name}`);
      }
    },
    prompts: [
      {
        name: "probe_prompt",
        title: "A prompt",
        description: "Exercises prompts/list and prompts/get.",
        arguments: [{ name: "topic", description: "what about", required: true }],
      },
    ],
    getPrompt(name, args) {
      // A skill throws the ENGINE's PromptError — that is how the server knows
      // to answer with an invalid-params error rather than an internal one.
      if (name !== "probe_prompt") throw new PromptError(`unknown prompt: ${name || "(none given)"}`);
      if (!args.topic) throw new PromptError("`topic` is required");
      return { description: "probe", messages: [{ role: "user", content: { type: "text", text: `about ${args.topic}` } }] };
    },
    ...overrides,
  };
}
