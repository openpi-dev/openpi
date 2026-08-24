import { isAbsolute, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { spinnerFrame } from "./spinner.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";

export type ToolActivityStatus = "pending" | "success" | "error";

export interface ToolActivity {
  readonly name: string;
  readonly args?: unknown;
  readonly argsFallback?: string;
  readonly output?: string;
  readonly details?: unknown;
  readonly status: ToolActivityStatus;
  readonly cwd?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
}

interface ActivityRow {
  readonly verb: string;
  readonly target: string;
  readonly detail?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown) {
  return typeof value === "string" ? sanitizeTerminalText(value) : "";
}

function number(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

function compact(value: string) {
  return sanitizeTerminalText(value).replace(/\r?\n/g, " ↵ ").trim();
}

export function parseToolArgsPreview(preview?: string) {
  const clean = sanitizeTerminalText(preview ?? "").trim();
  const fallback = compact(clean);
  if (!fallback) return { args: undefined, fallback: undefined };
  try {
    const args: unknown = JSON.parse(clean);
    return { args, fallback };
  } catch {
    return { args: undefined, fallback };
  }
}

function displayPath(value: string, cwd?: string) {
  if (!isAbsolute(value) || !cwd) return value;
  const local = relative(cwd, value);
  if (local === "") return ".";
  return local.startsWith("..") || isAbsolute(local) ? value : local;
}

function resultCount(output: string) {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith("["))
    .length;
}

function grepMatchCount(output: string) {
  const text = output.trim();
  if (!text || text === "No matches found") return 0;
  return text.split(/\r?\n/).filter((line) => /^.+:\d+:/.test(line)).length;
}

function itemCount(output: string, emptyMessage: string) {
  const text = output.trim();
  return !text || text === emptyMessage ? 0 : resultCount(output);
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

function canonicalName(name: string) {
  const lower = sanitizeTerminalText(name).toLowerCase();
  if (lower === "rg") return "grep";
  if (lower === "fd") return "find";
  return lower;
}

function activityRow(activity: ToolActivity): ActivityRow {
  const name = canonicalName(activity.name);
  const args = record(activity.args);
  const fallback = compact(activity.argsFallback ?? "");
  const output = sanitizeTerminalText(activity.output ?? "");
  const path = displayPath(string(args.path) || ".", activity.cwd);
  switch (name) {
    case "read":
      return { verb: "Read", target: `${path}${range(args)}` };
    case "bash":
      return {
        verb: "Ran",
        target:
          string(args.command).replace(/\s+/g, " ").trim() || fallback || name,
      };
    case "write": {
      const content = string(args.content);
      const lines =
        content.length === 0
          ? 0
          : content.replace(/\r?\n$/, "").split(/\r?\n/).length;
      return {
        verb: "Wrote",
        target: string(args.path) ? path : fallback,
        ...(content ? { detail: plural(lines, "line") } : {}),
      };
    }
    case "edit":
      return { verb: "Edited", target: string(args.path) ? path : fallback };
    case "grep": {
      const pattern = string(args.pattern) || fallback;
      return {
        verb: "Searched",
        target: pattern,
        ...(output
          ? { detail: `in ${path}  ${plural(grepMatchCount(output), "match")}` }
          : string(args.path)
            ? { detail: `in ${path}` }
            : {}),
      };
    }
    case "find": {
      const pattern = string(args.pattern) || fallback;
      return {
        verb: "Searched",
        target: pattern,
        ...(output
          ? {
              detail: `in ${path}  ${plural(itemCount(output, "No files found matching pattern"), "result")}`,
            }
          : string(args.path)
            ? { detail: `in ${path}` }
            : {}),
      };
    }
    case "ls":
      return {
        verb: "Listed",
        target: string(args.path) ? path : fallback || ".",
        ...(output
          ? { detail: plural(itemCount(output, "(empty directory)"), "entry") }
          : {}),
      };
    default:
      return {
        verb: sanitizeTerminalText(activity.name),
        target: fallback || name,
      };
  }
}

function pendingVerb(name: string) {
  switch (canonicalName(name)) {
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
  switch (canonicalName(name)) {
    case "read":
      return "\ueaa4";
    case "bash":
      return "\uea85";
    case "write":
    case "edit":
      return "\uea73";
    case "grep":
    case "find":
      return "\uea6d";
    case "ls":
      return "\uea83";
    default:
      return "✓";
  }
}

function errorSummary(output?: string) {
  const lines = sanitizeTerminalText(output ?? "")
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

function elapsed(activity: ToolActivity, now: number) {
  if (activity.startedAt === undefined) return undefined;
  const seconds = Math.floor(
    ((activity.endedAt ?? now) - activity.startedAt) / 1000,
  );
  return seconds > 0 ? `${seconds}s` : undefined;
}

export function toolActivityText(
  activity: ToolActivity,
  theme: Theme,
  now = Date.now(),
) {
  const row = activityRow(activity);
  const duration = elapsed(activity, now);
  const verbText = (
    activity.status === "pending"
      ? pendingVerb(activity.name)
      : activity.status === "error"
        ? "Failed"
        : row.verb
  ).padEnd(8);
  const verb = theme.fg(
    activity.status === "error"
      ? "error"
      : activity.status === "success"
        ? "muted"
        : "toolTitle",
    verbText,
  );

  if (activity.status === "pending") {
    const detail = duration ? ` · ${duration}` : "";
    return `${theme.fg("warning", spinnerFrame(now))} ${verb} ${row.target}${theme.fg("dim", detail)}`;
  }
  if (activity.status === "error") {
    const summary = errorSummary(activity.output);
    const detail = [duration, summary].filter(Boolean).join(" · ");
    return `${theme.fg("error", "✕")} ${verb} ${row.target}${detail ? theme.fg("dim", ` · ${detail}`) : ""}`;
  }

  const parts: string[] = [];
  if (canonicalName(activity.name) === "edit") {
    const stats = editStats(activity.details);
    if (stats) {
      parts.push(
        `${theme.fg("success", `+${stats.additions}`)} ${theme.fg("error", `-${stats.removals}`)}`,
      );
    }
  } else if (row.detail) {
    parts.push(theme.fg("dim", row.detail));
  }
  if (duration) parts.push(theme.fg("dim", duration));
  const detail = parts.join(theme.fg("dim", " · "));
  return `${theme.fg("dim", activityIcon(activity.name))} ${verb} ${theme.fg("muted", row.target)}${detail ? `  ${detail}` : ""}`;
}

export function renderToolActivityLine(
  activity: ToolActivity,
  theme: Theme,
  width: number,
  now = Date.now(),
) {
  const ellipsis = activity.status === "success" ? theme.fg("muted", "…") : "…";
  return truncateToWidth(
    toolActivityText(activity, theme, now),
    width,
    ellipsis,
  );
}

/** Historical Direct helper retained without owning a second formatter. */
export function summarizeToolArgs(
  name: string,
  argsPreview?: string,
  cwd?: string,
) {
  if (!argsPreview) return undefined;
  const fallback = compact(argsPreview);
  if (!fallback || fallback === "{}") return undefined;

  let args: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(argsPreview);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    return fallback;
  }
  if (!args) return fallback;

  const field = (key: string) => {
    const value = args[key];
    return typeof value === "string" && value.length > 0
      ? sanitizeTerminalText(value).replace(/\r?\n/g, " ↵ ")
      : undefined;
  };
  const path = () => {
    const value = field("path");
    return value ? displayPath(value, cwd) : undefined;
  };
  const tool = canonicalName(name);
  if (tool === "bash") return field("command") ?? fallback;
  if (tool === "read" || tool === "write" || tool === "edit") {
    return path() ?? fallback;
  }
  if (tool === "grep" || tool === "find") {
    const pattern = field("pattern");
    const searchPath = path();
    if (pattern && searchPath) return `${pattern} · ${searchPath}`;
    return pattern ?? searchPath ?? fallback;
  }
  return fallback;
}
