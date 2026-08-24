import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { renderPaddedToolActivityLine } from "../shared/tool-activity.ts";

type ActivityStatus = "pending" | "success" | "error";

type ActivityRenderState<TDetails> = {
  openpiActivity?: {
    result?: AgentToolResult<TDetails>;
    status: ActivityStatus;
    startedAt?: number;
    endedAt?: number;
    interval?: NodeJS.Timeout;
    nativeCallComponent?: Component;
    nativeResultComponent?: Component;
  };
};

const emptyComponent: Component = {
  render: () => [],
  invalidate() {},
};

function textOutput(result: AgentToolResult<unknown> | undefined) {
  return (
    result?.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n") ?? ""
  );
}

function activityComponent(
  name: string,
  args: unknown,
  state: NonNullable<ActivityRenderState<unknown>["openpiActivity"]>,
  theme: Theme,
  cwd: string,
): Component {
  return {
    render(width) {
      const line = renderPaddedToolActivityLine(
        {
          name,
          args,
          output: textOutput(state.result),
          details: state.result?.details,
          status: state.status,
          cwd,
          startedAt: state.startedAt,
          endedAt: state.endedAt,
        },
        theme,
        width,
      );
      return line ? [line] : [];
    },
    invalidate() {},
  };
}

/**
 * Preserve Pi's complete tool definition and execution semantics while
 * replacing only the collapsed operator-facing projection.
 */
export function withActivityRenderer<TParams extends TSchema, TDetails, TState>(
  definition: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState & ActivityRenderState<TDetails>> {
  const nativeRenderCall = definition.renderCall;
  const nativeRenderResult = definition.renderResult;
  return {
    ...definition,
    renderShell: "self",
    renderCall(args, theme, context) {
      const state = context.state as TState & ActivityRenderState<TDetails>;
      state.openpiActivity ??= { status: "pending" };
      const activity = state.openpiActivity;
      if (context.executionStarted && activity.startedAt === undefined) {
        activity.startedAt = Date.now();
      }
      if (
        context.executionStarted &&
        definition.name === "bash" &&
        activity.status === "pending" &&
        !context.expanded &&
        activity.interval === undefined
      ) {
        activity.interval = setInterval(() => context.invalidate(), 1000);
        activity.interval.unref();
      }
      if (context.expanded && activity.interval) {
        clearInterval(activity.interval);
        activity.interval = undefined;
      }
      if (context.expanded && nativeRenderCall) {
        const nativeContext: Parameters<typeof nativeRenderCall>[2] = {
          ...context,
          state,
          lastComponent: activity.nativeCallComponent,
        };
        const component = nativeRenderCall(args, theme, nativeContext);
        activity.nativeCallComponent = component;
        return component;
      }
      return activityComponent(
        definition.name,
        args,
        activity as NonNullable<ActivityRenderState<unknown>["openpiActivity"]>,
        theme,
        context.cwd,
      );
    },
    renderResult(result, options, theme, context) {
      const state = context.state as TState & ActivityRenderState<TDetails>;
      state.openpiActivity ??= { status: "pending" };
      const activity = state.openpiActivity;
      activity.result = result;
      activity.status = options.isPartial
        ? "pending"
        : context.isError
          ? "error"
          : "success";
      if (
        options.isPartial &&
        definition.name === "bash" &&
        !options.expanded &&
        activity.interval === undefined
      ) {
        activity.interval = setInterval(() => context.invalidate(), 1000);
        activity.interval.unref();
      }
      if (!options.isPartial || context.isError || options.expanded) {
        activity.endedAt ??= Date.now();
        if (activity.interval) {
          clearInterval(activity.interval);
          activity.interval = undefined;
        }
      }
      if (options.isPartial && options.expanded) {
        activity.endedAt = undefined;
      }

      if (options.expanded && nativeRenderResult) {
        const nativeContext: Parameters<typeof nativeRenderResult>[3] = {
          ...context,
          state,
          lastComponent: activity.nativeResultComponent,
        };
        const component = nativeRenderResult(
          result,
          options,
          theme,
          nativeContext,
        );
        activity.nativeResultComponent = component;
        return component;
      }
      return emptyComponent;
    },
  };
}
