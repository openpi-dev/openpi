/** Translate Cursor MCP requests into Pi calls; execution stays in Pi's loop. */
import type { Context, ToolCall } from "@earendil-works/pi-ai/compat";
import { type McpArgs, McpToolDefinitionSchema } from "./proto.ts";
import {
  create,
  decodeJsonValue,
  encodeJsonValue,
  type JsonValue,
} from "./protobuf.ts";

export const CURSOR_PI_PROVIDER = "openpi";
export const CURSOR_PI_TOOLS_SYSTEM_PROMPT =
  "Use only the provided openpi MCP tools. These are the active Pi tools and Pi owns their execution and permissions. Do not use Cursor-native filesystem, shell, editing, web, task, or interaction tools. When tool results appear in conversation history, continue from those results. Do not repeat a completed tool call.";

export function buildCursorTools(tools: Context["tools"]) {
  return (tools ?? []).map((tool) => {
    const schema: JsonValue = JSON.parse(JSON.stringify(tool.parameters));
    return create(McpToolDefinitionSchema, {
      name: tool.name,
      providerIdentifier: CURSOR_PI_PROVIDER,
      toolName: tool.name,
      description: tool.description,
      inputSchema: encodeJsonValue(schema),
      inputSchemaJson: JSON.stringify(schema),
    });
  });
}

export function decodeCursorTool(
  args: McpArgs,
  tools: Context["tools"],
): ToolCall {
  const name = args.toolName || args.name;
  if (
    args.providerIdentifier !== CURSOR_PI_PROVIDER ||
    (args.serverIdentifier && args.serverIdentifier !== CURSOR_PI_PROVIDER) ||
    !name ||
    (args.name && args.name !== name) ||
    !tools?.some((tool) => tool.name === name)
  ) {
    throw new Error("Cursor requested an unadvertised Pi tool identity");
  }
  if (!args.toolCallId.trim())
    throw new Error("Cursor MCP tool call has no identity");
  const values: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args.args)) {
    // google.protobuf.Value, not JSON text. Define own properties so keys such
    // as __proto__ cannot alter the decoded argument object's prototype.
    if (!value.length || ![8, 17, 26, 32, 42, 50].includes(value[0]!)) {
      throw new Error("Cursor MCP argument is not a protobuf JSON value");
    }
    const decoded = decodeJsonValue(value);
    const validateJson = (item: JsonValue): void => {
      if (typeof item === "number" && !Number.isFinite(item))
        throw new Error("Cursor MCP argument contains a non-finite number");
      if (item && typeof item === "object")
        for (const child of Object.values(item)) validateJson(child);
    };
    validateJson(decoded);
    Object.defineProperty(values, key, {
      value: decoded,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { type: "toolCall", id: args.toolCallId, name, arguments: values };
}
