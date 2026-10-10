import {
  BookOpen,
  Bot,
  ClipboardList,
  Folder,
  GitBranch,
  Globe,
  ListChecks,
  Pencil,
  Search,
  SquareTerminal,
  Target,
  Workflow,
  Wrench,
} from "lucide-react";
import type { TFunction } from "i18next";

/** Operator presentation only; tool names and receipts remain Pi-owned. */
export function toolActivity(name: string) {
  switch (name.toLowerCase()) {
    case "read":
      return { action: "read", Icon: BookOpen };
    case "write":
      return { action: "write", Icon: Pencil };
    case "edit":
      return { action: "edit", Icon: Pencil };
    case "bash":
      return { action: "command", Icon: SquareTerminal };
    case "grep":
    case "rg":
    case "find":
    case "fd":
    case "glob":
    case "tool_search":
      return { action: "search", Icon: Search };
    case "ls":
      return { action: "list", Icon: Folder };
    case "webfetch":
    case "websearch":
    case "web_fetch":
    case "web_search":
      return { action: "web", Icon: Globe };
    case "plan_ready":
      return { action: "plan", Icon: ClipboardList };
    case "tasks_add":
    case "tasks_update":
    case "tasks_list":
      return { action: "task", Icon: ListChecks };
    case "get_goal":
    case "create_goal":
    case "update_goal":
      return { action: "goal", Icon: Target };
    case "git_show":
    case "git_diff":
    case "git_log":
      return { action: "git", Icon: GitBranch };
    default:
      if (name.startsWith("bg_"))
        return { action: "command", Icon: SquareTerminal };
      if (name.startsWith("subagent")) return { action: "agent", Icon: Bot };
      if (name.startsWith("workflow"))
        return { action: "workflow", Icon: Workflow };
      return { action: "call", Icon: Wrench };
  }
}

export function toolActivityLabel(t: TFunction, name: string, state: string) {
  const { action } = toolActivity(name);
  if (state === "returned") return t(`toolActionDone_${action}`);
  const labelState = ["running", "failed", "cancelled", "timed_out"].includes(
    state,
  )
    ? state
    : "unknown";
  return t(`toolActivity_${labelState}`, { action: t(`toolAction_${action}`) });
}

export function toolActivityTarget(
  name: string,
  args: Record<string, unknown>,
) {
  const { action } = toolActivity(name);
  const value =
    action === "search"
      ? (args.pattern ?? args.query ?? args.path)
      : action === "web"
        ? (args.url ?? args.query)
        : (args.path ??
          args.command ??
          args.url ??
          args.query ??
          args.id ??
          args.runId);
  return typeof value === "string" ? value : "";
}
