import { isAbsolute, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { spinnerFrame } from "../shared/spinner.ts";

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

type ActivityRow = {
  verb: string;
  target: string;
  detail?: string;
};

const HORIZONTAL_PADDING = "  ";

const emptyComponent: Component = {
  render: () => [],
  invalidate() {},
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown) {
  return typeof value === "string" ? value : "";
}

function number(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function textOutput(result: AgentToolResult<unknown> | undefined) {
  return (
    result?.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n") ?? ""
  );
}

function resultCount(result: AgentToolResult<unknown> | undefined) {
  return textOutput(result)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith("["))
    .length;
}

function grepMatchCount(result: AgentToolResult<unknown> | undefined) {
  const output = textOutput(result).trim();
  if (!output || output === "No matches found") return 0;
  return output.split(/\r?\n/).filter((line) => /^.+:\d+:/.test(line)).length;
}

function itemCount(
  result: AgentToolResult<unknown> | undefined,
  emptyMessage: string,
) {
  const output = textOutput(result).trim();
  return !output || output === emptyMessage ? 0 : resultCount(result);
}

function plural(count: number, singular: string) {
  const pluralForm =
    singular === "match"
      ? "matches"
      : singular === "entry"
        ? "entries"
        : `${singular}s`;
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function editStats(details: unknown) {
  const diff = string(record(details).diff);
  if (!diff) return undefined;
  let additions = 0;
  let removals = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) removals += 1;
  }
  return { additions, removals };
}

function range(args: Record<string, unknown>) {
  const offset = number(args.offset);
  const limit = number(args.limit);
  if (offset === undefined && limit === undefined) return "";
  const start = offset ?? 1;
  return limit === undefined ? `:${start}-` : `:${start}-${start + limit - 1}`;
}

function displayPath(path: string, cwd: string) {
  if (!isAbsolute(path)) return path;
  const local = relative(cwd, path);
  if (local === "") return ".";
  return local.startsWith("..") || isAbsolute(local) ? path : local;
}

function activityRow(
  name: string,
  argsValue: unknown,
  result: AgentToolResult<unknown> | undefined,
  cwd: string,
): ActivityRow {
  const args = record(argsValue);
  const path = displayPath(string(args.path) || ".", cwd);
  switch (name) {
    case "read":
      return { verb: "Read", target: `${path}${range(args)}` };
    case "bash":
      return {
        verb: "Ran",
        target: string(args.command).replace(/\s+/g, " ").trim(),
      };
    case "write": {
      const content = string(args.content);
      const lines =
        content.length === 0
          ? 0
          : content.replace(/\r?\n$/, "").split(/\r?\n/).length;
      return { verb: "Wrote", target: path, detail: plural(lines, "line") };
    }
    case "edit":
      return { verb: "Edited", target: path };
    case "grep":
      return {
        verb: "Searched",
        target: string(args.pattern),
        detail: `in ${path}  ${plural(grepMatchCount(result), "match")}`,
      };
    case "find":
      return {
        verb: "Searched",
        target: string(args.pattern),
        detail: `in ${path}  ${plural(itemCount(result, "No files found matching pattern"), "result")}`,
      };
    case "ls":
      return {
        verb: "Listed",
        target: path,
        detail: plural(itemCount(result, "(empty directory)"), "entry"),
      };
    default:
      return { verb: name, target: "" };
  }
}

function pendingVerb(name: string) {
  switch (name) {
    case "read":
      return "Reading";
    case "bash":
      return "Running";
    case "write":
      return "Writing";
    case "edit":
      return "Editing";
    case "grep":
    case "find":
      return "Searching";
    case "ls":
      return "Listing";
    default:
      return "Running";
  }
}

function activityIcon(name: string) {
  switch (name) {
    case "read":
      return "\ueaa4"; // Nerd Fonts Codicon: book
    case "bash":
      return "\uea85"; // Nerd Fonts Codicon: terminal
    case "write":
    case "edit":
      return "\uea73"; // Nerd Fonts Codicon: edit
    case "grep":
    case "find":
      return "\uea6d"; // Nerd Fonts Codicon: search
    case "ls":
      return "\uea83"; // Nerd Fonts Codicon: folder
    default:
      return "✓";
  }
}

function errorSummary(result: AgentToolResult<unknown> | undefined) {
  const lines = textOutput(result)
    .split(/\r?\n/)
    .map((line) => stripVTControlCharacters(line).trim())
    .filter(Boolean);
  return (
    [...lines]
      .reverse()
      .find((line) =>
        /(?:command (?:exited|timed out|aborted)|error|denied|failed)/i.test(
          line,
        ),
      ) ?? lines[0]
  );
}

function duration(
  state: NonNullable<ActivityRenderState<unknown>["openpiActivity"]>,
) {
  if (state.startedAt === undefined) return undefined;
  const seconds = Math.floor(
    ((state.endedAt ?? Date.now()) - state.startedAt) / 1000,
  );
  return seconds > 0 ? `${seconds}s` : undefined;
}

function activityText(
  name: string,
  args: unknown,
  state: NonNullable<ActivityRenderState<unknown>["openpiActivity"]>,
  theme: Theme,
  cwd: string,
) {
  const row = activityRow(name, args, state.result, cwd);
  const elapsed = duration(state);
  const verbText = (
    state.status === "pending"
      ? pendingVerb(name)
      : state.status === "error"
        ? "Failed"
        : row.verb
  ).padEnd(8);
  const verb = theme.fg(
    state.status === "error"
      ? "error"
      : state.status === "success"
        ? "muted"
        : "toolTitle",
    verbText,
  );
  if (state.status === "pending") {
    const detail = elapsed ? ` · ${elapsed}` : "";
    return `${theme.fg("warning", spinnerFrame(Date.now()))} ${verb} ${row.target}${theme.fg("dim", detail)}`;
  }
  if (state.status === "error") {
    const summary = errorSummary(state.result);
    const detail = [elapsed, summary].filter(Boolean).join(" · ");
    return `${theme.fg("error", "✕")} ${verb} ${row.target}${detail ? theme.fg("dim", ` · ${detail}`) : ""}`;
  }
  const parts: string[] = [];
  if (name === "edit") {
    // Kimi-style diff stats: additions green, removals red.
    const stats = editStats(state.result?.details);
    if (stats) {
      parts.push(
        `${theme.fg("success", `+${stats.additions}`)} ${theme.fg("error", `-${stats.removals}`)}`,
      );
    }
  } else if (row.detail) {
    parts.push(theme.fg("dim", row.detail));
  }
  if (elapsed) parts.push(theme.fg("dim", elapsed));
  const detail = parts.join(theme.fg("dim", " · "));
  return `${theme.fg("dim", activityIcon(name))} ${verb} ${theme.fg("muted", row.target)}${detail ? `  ${detail}` : ""}`;
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
      const contentWidth = width - HORIZONTAL_PADDING.length * 2;
      if (contentWidth <= 0) return [];
      const ellipsis =
        state.status === "success" ? theme.fg("muted", "…") : "…";
      return [
        `${HORIZONTAL_PADDING}${truncateToWidth(
          activityText(name, args, state, theme, cwd),
          contentWidth,
          ellipsis,
        )}${HORIZONTAL_PADDING}`,
      ];
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
