import type {
  ExtensionContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";

/** Direct tool fixtures have no nested executor; unexpected nesting must fail. */
export function toolExecutionContext(context: ExtensionContext) {
  return {
    ...context,
    tools: [],
    async executeTool() {
      throw new Error("This fixture does not implement nested tool execution");
    },
  } satisfies ExtensionToolContext;
}
