import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

/**
 * Pi's built-in extensions reach a resource loader only through
 * `extensionFactories`. They carry `builtin: true`, the CLI's `main()` supplies
 * them, and an SDK session has to supply them itself — Pi's SDK docs say so
 * explicitly ("SDK sessions do not; add `createCodemodeExtension()`,
 * `createToolSearchExtension()`, and `createMcpExtension()`"). A session that
 * passes none has no built-in registry at all: `builtin:<name>` paths resolve to
 * "Unknown built-in extension" and `tool_search` / `codemode` / MCP tools are
 * never registered, so nothing can activate them later.
 *
 * `llama.cpp` is absent on purpose: Pi exports no factory for it and it only
 * serves local models. A user's own MCP extension replaces the built-in one
 * through the `replaceable` flag.
 */
export function createPiBuiltinExtensionFactories(): InlineExtension[] {
  return [
    {
      name: "tool-search",
      factory: createToolSearchExtension(),
      builtin: true,
      replaceable: true,
    },
    {
      name: "codemode",
      factory: createCodemodeExtension(),
      builtin: true,
      replaceable: true,
    },
    {
      name: "mcp",
      factory: createMcpExtension(),
      builtin: true,
      replaceable: true,
    },
  ];
}
