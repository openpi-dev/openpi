import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { loadSetupConfig } from "../shared/setup-config.ts";
import { compactRenderedComponent } from "./render.ts";

function withCompactCallRenderer(
  definition: ToolDefinition<any, any, any>,
): ToolDefinition<any, any, any> {
  const renderCall = definition.renderCall;
  if (!renderCall) return definition;
  return {
    ...definition,
    renderCall(args, theme, context) {
      const component = renderCall(args, theme, context);
      if (
        context.expanded ||
        loadSetupConfig().ui.fileMutationDisplay === "full"
      ) {
        return component;
      }
      return compactRenderedComponent(component, theme);
    },
  };
}

/**
 * Override only the TUI renderer. The wrapped definitions are Pi's native
 * Write/Edit tools, so schemas, execution, mutation queues, diffs, and errors
 * stay on the upstream implementation.
 */
export default function fileMutationDisplay(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    pi.registerTool(
      withCompactCallRenderer(createWriteToolDefinition(ctx.cwd)),
    );
    pi.registerTool(withCompactCallRenderer(createEditToolDefinition(ctx.cwd)));
  });
}
