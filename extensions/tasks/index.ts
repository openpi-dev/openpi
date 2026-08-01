import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  TASKS_ENTRY_TYPE,
  TASKS_LIMITS,
  TASK_STATUSES,
  TaskRestoreError,
  applyTaskAdd,
  applyTaskUpdate,
  createSessionTasks,
  emptyTaskSnapshot,
  projectTasks,
  restoreTaskSnapshot,
  type TaskFilter,
  type TaskItem,
  type TaskSnapshot,
} from "./tasks.ts";
import {
  openTasksScreen,
  renderTaskWidget,
  renderToolResult,
  type TaskToolDetails,
} from "./ui.ts";

const TOOL_NAMES = ["tasks_add", "tasks_update", "tasks_list"] as const;
const TASK_WIDGET_KEY = "session-tasks-panel";
const CONFLICT_NAMES = new Set(["todo", "TodoWrite", "update_plan"]);
const TOOL_PURPOSE =
  "Records session work intent. It does not execute, schedule, or delegate work.";

export interface TaskConflict {
  name: string;
  source?: string;
}

export function findTaskConflict(tools: readonly ToolInfo[]) {
  const conflict = tools.find((tool) => CONFLICT_NAMES.has(tool.name));
  if (!conflict) return undefined;
  const source = conflict.sourceInfo?.path || conflict.sourceInfo?.source;
  return { name: conflict.name, source } satisfies TaskConflict;
}

export function injectTaskProjection(
  messages: readonly unknown[],
  projection: string,
) {
  // Keep this pure for direct tests. Pi already supplies the context hook a
  // deep copy, so this is defensive rather than required by the runtime.
  const next = structuredClone(messages) as Array<{
    role?: string;
    content?: unknown;
  }>;
  for (let index = next.length - 1; index >= 0; index--) {
    const message = next[index];
    if (message.role !== "user") continue;
    const safeProjection = projection
      .replaceAll("<session-tasks>", "[session-tasks]")
      .replaceAll("</session-tasks>", "[/session-tasks]");
    const block = {
      type: "text",
      text: `\n\n<session-tasks>\n${safeProjection}\n</session-tasks>`,
    };
    if (typeof message.content === "string") {
      message.content = [{ type: "text", text: message.content }, block];
    } else if (Array.isArray(message.content)) {
      message.content.push(block);
    } else {
      return undefined;
    }
    return next;
  }
  return undefined;
}

export function taskConflictMessage(conflict: TaskConflict) {
  return `Session tasks disabled because tool “${conflict.name}” is already registered${conflict.source ? ` by ${conflict.source}` : ""}. Disable the other Todo/plan extension and run /reload.`;
}

export default function sessionTasks(pi: ExtensionAPI) {
  let tasks = createSessionTasks();
  let lockedReason: string | undefined;
  let conflict: TaskConflict | undefined;
  let toolsRegistered = false;
  let coldRun = true;
  let activeRun = false;
  let frozenProjection = "";
  let notifiedProblem: string | undefined;
  let taskWidgetVisible = true;
  let ui: ExtensionContext["ui"] | undefined;
  let uiMode: ExtensionContext["mode"] | undefined;

  const snapshot = () => tasks.snapshot();

  const hasActionableTasks = () =>
    snapshot().items.some(
      (item) =>
        item.status === "pending" ||
        item.status === "in_progress" ||
        item.status === "blocked",
    );

  const updateTaskWidget = (ctx?: ExtensionContext) => {
    if (ctx?.hasUI) {
      ui = ctx.ui;
      uiMode = ctx.mode;
    }
    if (!ui || uiMode !== "tui") return false;
    const current = snapshot();
    const shown =
      taskWidgetVisible && !problemMessage() && hasActionableTasks();
    if (!shown) {
      ui.setWidget(TASK_WIDGET_KEY, undefined);
      return false;
    }
    ui.setWidget(TASK_WIDGET_KEY, (_tui, theme) => ({
      render: (width) => renderTaskWidget(current, theme, width),
      invalidate() {},
    }));
    return true;
  };

  const taskWidgetFeedback = (shown: boolean) =>
    shown
      ? "Task panel shown."
      : uiMode !== "tui"
        ? "Task panel is available only in interactive TUI mode."
        : taskWidgetVisible
          ? "Task panel enabled; it will appear when active tasks exist."
          : "Task panel hidden.";

  const restore = (ctx: ExtensionContext) => {
    try {
      tasks = createSessionTasks(
        restoreTaskSnapshot(ctx.sessionManager.getBranch()),
      );
      lockedReason = undefined;
    } catch (error) {
      tasks = createSessionTasks(emptyTaskSnapshot());
      lockedReason =
        error instanceof TaskRestoreError || error instanceof Error
          ? error.message
          : String(error);
    }
  };

  const problemMessage = () => {
    if (conflict) return taskConflictMessage(conflict);
    if (lockedReason) {
      return `Session tasks are locked because their newest snapshot is invalid: ${lockedReason}. Navigate to a clean branch or start a new session.`;
    }
    return undefined;
  };

  const notifyProblem = (ctx: ExtensionContext) => {
    const problem = problemMessage();
    if (!problem) {
      notifiedProblem = undefined;
      return;
    }
    if (ctx.hasUI && notifiedProblem !== problem) {
      notifiedProblem = problem;
      ctx.ui.notify(problem, "warning");
    }
  };

  const assertAvailable = () => {
    const problem = problemMessage();
    if (problem) throw new Error(problem);
  };

  const persistThenCommit = (candidate: TaskSnapshot) => {
    if (candidate.revision === snapshot().revision) return false;
    // Keep this path synchronous. An await here would let sibling tool calls
    // reorder state and persistence, recreating the upstream Todo lost-update bug.
    pi.appendEntry(TASKS_ENTRY_TYPE, candidate);
    tasks.commit(candidate);
    updateTaskWidget();
    return true;
  };

  const toolDetails = (
    action: TaskToolDetails["action"],
    items: TaskItem[],
    batchClosed = false,
  ): TaskToolDetails => ({
    action,
    items,
    total: snapshot().items.length,
    revision: snapshot().revision,
    ...(batchClosed ? { batchClosed: true } : {}),
  });

  const registerTools = () => {
    if (toolsRegistered || conflict) return;
    toolsRegistered = true;

    pi.registerTool({
      name: "tasks_add",
      label: "Tasks Add",
      description: `${TOOL_PURPOSE} Add one or more stable-ID items to the current Pi session tasks. Use this only for work spanning multiple agent runs or user turns, or for an explicit user task list. When every item in a batch reaches done/dropped the batch closes and the list clears; the next tasks_add starts a fresh batch numbered from T1, so a T-id only identifies work within its own batch (past evidence remains in the session history, not this list).`,
      promptSnippet:
        "Add stable work-intent items to the current session tasks",
      promptGuidelines: [
        "Use tasks_add only for work spanning multiple agent runs or user turns, or when the user explicitly provides a task list; do not use it as a per-step scratchpad within one run.",
        "Task tools record advisory intent only; Subagents and Workflows execute work, while files, git, tests, tool results, artifacts, and user confirmation remain truth.",
      ],
      parameters: Type.Object({
        items: Type.Array(
          Type.Object({
            subject: Type.String({
              minLength: 1,
              maxLength: TASKS_LIMITS.subjectChars,
              description: "Short imperative description.",
            }),
            detail: Type.Optional(
              Type.String({ maxLength: TASKS_LIMITS.detailChars }),
            ),
          }),
          { minItems: 1, maxItems: TASKS_LIMITS.addBatch },
        ),
      }),
      execute(_id, params) {
        assertAvailable();
        const mutation = applyTaskAdd(snapshot(), params.items);
        persistThenCommit(mutation.snapshot);
        return Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: `Added ${mutation.items.map((item) => `T${item.id}`).join(", ")}.`,
            },
          ],
          details: toolDetails("add", mutation.items),
        });
      },
      renderCall(args, theme) {
        return new Text(
          `${theme.fg("toolTitle", theme.bold("tasks_add"))} ${theme.fg("muted", `${args.items.length} item(s)`)}`,
          0,
          0,
        );
      },
      renderResult(result, options, theme) {
        return renderToolResult(
          result.details as TaskToolDetails | undefined,
          options.expanded,
          theme,
        );
      },
    });

    pi.registerTool({
      name: "tasks_update",
      label: "Tasks Update",
      description: `${TOOL_PURPOSE} Patch one task item by numeric ID. blocked, done, and dropped status changes require a fresh note explaining the blocker, observable evidence, or drop reason.`,
      promptSnippet: "Update one session task item by stable ID",
      promptGuidelines: [
        "Keep tasks_update status current when tracked work materially changes, but avoid ceremonial status churn.",
        "Before setting a task item to done, include a note citing an observable check, artifact, commit, tool result, or user confirmation; Tasks record this claim but do not verify it.",
      ],
      parameters: Type.Object({
        id: Type.Integer({ minimum: 1 }),
        subject: Type.Optional(
          Type.String({ minLength: 1, maxLength: TASKS_LIMITS.subjectChars }),
        ),
        detail: Type.Optional(
          Type.Union([
            Type.String({ maxLength: TASKS_LIMITS.detailChars }),
            Type.Null(),
          ]),
        ),
        status: Type.Optional(StringEnum(TASK_STATUSES)),
        note: Type.Optional(
          Type.Union([
            Type.String({ maxLength: TASKS_LIMITS.noteChars }),
            Type.Null(),
          ]),
        ),
      }),
      execute(_id, params) {
        assertAvailable();
        const before = snapshot();
        const closesBatch = mutationWillCloseBatch(
          before,
          params.id,
          params.status,
        );
        const mutation = applyTaskUpdate(before, params);
        const changed = persistThenCommit(mutation.snapshot);
        return Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: changed
                ? closesBatch
                  ? `${params.status === "dropped" ? "Dropped" : "Completed"} T${params.id}. Task batch closed; the next tasks_add starts again at T1.`
                  : `Updated T${params.id}.`
                : `T${params.id} already has that state; no update recorded.`,
            },
          ],
          details: toolDetails("update", mutation.items, closesBatch),
        });
      },
      renderCall(args, theme) {
        return new Text(
          `${theme.fg("toolTitle", theme.bold("tasks_update"))} ${theme.fg("accent", `T${args.id}`)}${args.status ? ` ${theme.fg("muted", args.status)}` : ""}`,
          0,
          0,
        );
      },
      renderResult(result, options, theme) {
        return renderToolResult(
          result.details as TaskToolDetails | undefined,
          options.expanded,
          theme,
        );
      },
    });

    pi.registerTool({
      name: "tasks_list",
      label: "Tasks List",
      description: `${TOOL_PURPOSE} Read current session task items, optionally filtered by ID and status.`,
      promptSnippet: "List current session work-intent task items",
      parameters: Type.Object({
        id: Type.Optional(Type.Integer({ minimum: 1 })),
        status: Type.Optional(StringEnum(TASK_STATUSES)),
      }),
      execute(_id, params) {
        assertAvailable();
        const filter = params satisfies TaskFilter;
        const items = tasks.list(filter);
        const preview = items.slice(0, 5);
        const rendered = tasks.render(filter, 3_800);
        const text =
          rendered.endsWith("…") || items.length > preview.length
            ? `${rendered}\nShowing a bounded view of ${items.length} matched item(s); filter by status or id for a narrower result.`
            : rendered;
        return Promise.resolve({
          content: [{ type: "text" as const, text }],
          details: toolDetails("list", preview),
        });
      },
      renderCall(_args, theme) {
        return new Text(theme.fg("toolTitle", theme.bold("tasks_list")), 0, 0);
      },
      renderResult(result, options, theme) {
        return renderToolResult(
          result.details as TaskToolDetails | undefined,
          options.expanded,
          theme,
        );
      },
    });
  };

  pi.registerCommand("tasks", {
    description: "Inspect the current session work-intent tasks",
    handler: async (args, ctx) => {
      const problem = problemMessage();
      if (problem) {
        if (ctx.hasUI) ctx.ui.notify(problem, "warning");
        return;
      }
      const action = args.trim().toLowerCase();
      if (action === "hide" || action === "show" || action === "toggle") {
        taskWidgetVisible =
          action === "show"
            ? true
            : action === "hide"
              ? false
              : !taskWidgetVisible;
        const shown = updateTaskWidget(ctx);
        if (ctx.hasUI) ctx.ui.notify(taskWidgetFeedback(shown), "info");
        return;
      }
      await openTasksScreen(ctx, snapshot());
    },
  });

  pi.registerShortcut(Key.ctrlShift("t"), {
    description: "Hide or show the persistent task panel",
    handler: async (ctx) => {
      const problem = problemMessage();
      if (problem) {
        if (ctx.hasUI) ctx.ui.notify(problem, "warning");
        return;
      }
      taskWidgetVisible = !taskWidgetVisible;
      const shown = updateTaskWidget(ctx);
      if (ctx.hasUI) ctx.ui.notify(taskWidgetFeedback(shown), "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.hasUI ? ctx.ui : undefined;
    uiMode = ctx.hasUI ? ctx.mode : undefined;
    restore(ctx);
    conflict = findTaskConflict(pi.getAllTools());
    coldRun = true;
    activeRun = false;
    frozenProjection = "";
    registerTools();
    notifyProblem(ctx);
    updateTaskWidget(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restore(ctx);
    coldRun = true;
    activeRun = false;
    frozenProjection = "";
    notifyProblem(ctx);
    updateTaskWidget(ctx);
  });

  pi.on("session_compact", () => {
    coldRun = true;
    frozenProjection = "";
  });

  pi.on("agent_start", () => {
    activeRun = true;
    if (coldRun) {
      frozenProjection = !problemMessage() ? projectTasks(snapshot()) : "";
      coldRun = false;
    }
  });

  pi.on("agent_settled", () => {
    activeRun = false;
    frozenProjection = "";
  });

  pi.on("context", (event) => {
    if (!activeRun || !frozenProjection || problemMessage()) return;
    const messages = injectTaskProjection(event.messages, frozenProjection);
    if (messages) return { messages: messages as typeof event.messages };
  });

  pi.on("session_shutdown", () => {
    try {
      ui?.setWidget(TASK_WIDGET_KEY, undefined);
    } catch {
      // The interactive UI may already be disposed.
    }
    ui = undefined;
    uiMode = undefined;
  });
}

export { TOOL_NAMES as TASK_TOOL_NAMES };

function mutationWillCloseBatch(
  snapshot: TaskSnapshot,
  id: number,
  status: TaskItem["status"] | undefined,
) {
  if (status !== "done" && status !== "dropped") return false;
  return snapshot.items.every(
    (item) =>
      item.id === id || item.status === "done" || item.status === "dropped",
  );
}
