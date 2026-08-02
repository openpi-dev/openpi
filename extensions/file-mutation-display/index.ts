import {
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { loadSetupConfig } from "../shared/setup-config.ts";
import {
  compactBashRenderedComponent,
  compactRenderedComponent,
  singleLineRenderedComponent,
} from "./render.ts";

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
      const background = context.isPartial
        ? (text: string) => theme.bg("toolPendingBg", text)
        : context.isError
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
      return compactRenderedComponent(component, theme, undefined, background);
    },
  };
}

function withCompactBashRenderer(
  definition: ToolDefinition<any, any, any>,
): ToolDefinition<any, any, any> {
  const renderCall = definition.renderCall;
  const renderResult = definition.renderResult;
  if (!renderCall || !renderResult) return definition;
  return {
    ...definition,
    renderCall(args, theme, context) {
      // A compact wrapper is not the native Text component expected through
      // lastComponent, so rebuild the cheap call renderer on each update.
      const component = renderCall(args, theme, {
        ...context,
        lastComponent: undefined,
      });
      if (context.expanded || loadSetupConfig().ui.bashToolDisplay === "full") {
        return component;
      }
      return singleLineRenderedComponent(component, theme);
    },
    renderResult(result, options, theme, context) {
      // Bash streams partial results. Never hand our wrapper back to Pi's
      // native BashResultRenderComponent updater.
      const component = renderResult(result, options, theme, {
        ...context,
        lastComponent: undefined,
      });
      if (options.expanded || loadSetupConfig().ui.bashToolDisplay === "full") {
        return component;
      }
      return compactBashRenderedComponent(component, theme);
    },
  };
}

/**
 * Override only the TUI renderers. The wrapped definitions are Pi's native
 * Bash/Write/Edit tools, so schemas, execution, mutation queues, diffs, and
 * errors stay on the upstream implementation.
 */
export default function fileMutationDisplay(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const display = loadSetupConfig().ui;
    if (ctx.mode === "tui") {
      // Ctrl+O remains a temporary override. A new/reloaded session starts from
      // the persisted defaults instead of inheriting an old expanded toggle.
      ctx.ui.setToolsExpanded(
        display.subagentResultDisplay === "full" &&
          display.bashToolDisplay === "full" &&
          display.fileMutationDisplay === "full",
      );
    }
    pi.registerTool(withCompactBashRenderer(createBashToolDefinition(ctx.cwd)));
    pi.registerTool(
      withCompactCallRenderer(createWriteToolDefinition(ctx.cwd)),
    );
    pi.registerTool(withCompactCallRenderer(createEditToolDefinition(ctx.cwd)));
  });
}
