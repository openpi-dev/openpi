import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Key, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  LEDGER_ENTRY_TYPE,
  LEDGER_LIMITS,
  LEDGER_STATUSES,
  LedgerRestoreError,
  applyLedgerAdd,
  applyLedgerUpdate,
  createSessionLedger,
  emptyLedgerSnapshot,
  projectLedger,
  restoreLedgerSnapshot,
  type LedgerFilter,
  type LedgerItem,
  type LedgerSnapshot,
} from "./ledger.ts";
import {
  openLedgerScreen,
  renderTaskWidget,
  renderToolResult,
  type LedgerToolDetails,
} from "./ui.ts";

const TOOL_NAMES = ["ledger_add", "ledger_update", "ledger_list"] as const;
const TASK_WIDGET_KEY = "session-ledger-tasks";
const CONFLICT_NAMES = new Set(["todo", "TodoWrite", "update_plan"]);
const TOOL_PURPOSE =
  "Records session work intent. It does not execute, schedule, or delegate work.";

export interface LedgerConflict {
  name: string;
  source?: string;
}

export function findLedgerConflict(tools: readonly ToolInfo[]) {
  const conflict = tools.find((tool) => CONFLICT_NAMES.has(tool.name));
  if (!conflict) return undefined;
  const source = conflict.sourceInfo?.path || conflict.sourceInfo?.source;
  return { name: conflict.name, source } satisfies LedgerConflict;
}

export function injectLedgerProjection(
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
      .replaceAll("<session-ledger>", "[session-ledger]")
      .replaceAll("</session-ledger>", "[/session-ledger]");
    const block = {
      type: "text",
      text: `\n\n<session-ledger>\n${safeProjection}\n</session-ledger>`,
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

export function ledgerConflictMessage(conflict: LedgerConflict) {
  return `Session ledger disabled because tool “${conflict.name}” is already registered${conflict.source ? ` by ${conflict.source}` : ""}. Disable the other Todo/plan extension and run /reload.`;
}

export default function sessionLedger(pi: ExtensionAPI) {
  let ledger = createSessionLedger();
  let lockedReason: string | undefined;
  let conflict: LedgerConflict | undefined;
  let toolsRegistered = false;
  let coldRun = true;
  let activeRun = false;
  let frozenProjection = "";
  let notifiedProblem: string | undefined;
  let taskWidgetVisible = true;
  let ui: ExtensionContext["ui"] | undefined;
  let uiMode: ExtensionContext["mode"] | undefined;

  const snapshot = () => ledger.snapshot();

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
      ledger = createSessionLedger(
        restoreLedgerSnapshot(ctx.sessionManager.getBranch()),
      );
      lockedReason = undefined;
    } catch (error) {
      ledger = createSessionLedger(emptyLedgerSnapshot());
      lockedReason =
        error instanceof LedgerRestoreError || error instanceof Error
          ? error.message
          : String(error);
    }
  };

  const problemMessage = () => {
    if (conflict) return ledgerConflictMessage(conflict);
    if (lockedReason) {
      return `Session ledger is locked because its newest snapshot is invalid: ${lockedReason}. Navigate to a clean branch or start a new session.`;
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

  const persistThenCommit = (candidate: LedgerSnapshot) => {
    if (candidate.revision === snapshot().revision) return false;
    // Keep this path synchronous. An await here would let sibling tool calls
    // reorder state and persistence, recreating the upstream Todo lost-update bug.
    pi.appendEntry(LEDGER_ENTRY_TYPE, candidate);
    ledger.commit(candidate);
    updateTaskWidget();
    return true;
  };

  const toolDetails = (
    action: LedgerToolDetails["action"],
    items: LedgerItem[],
  ): LedgerToolDetails => ({
    action,
    items,
    total: snapshot().items.length,
    revision: snapshot().revision,
  });

  const registerTools = () => {
    if (toolsRegistered || conflict) return;
    toolsRegistered = true;

    pi.registerTool({
      name: "ledger_add",
      label: "Ledger Add",
      description: `${TOOL_PURPOSE} Add one or more stable-ID items to the current Pi session ledger. Use this only for work spanning multiple agent runs or user turns, or for an explicit user task list.`,
      promptSnippet:
        "Add stable work-intent items to the current session ledger",
      promptGuidelines: [
        "Use ledger_add only for work spanning multiple agent runs or user turns, or when the user explicitly provides a task list; do not use it as a per-step scratchpad within one run.",
        "Ledger tools record advisory intent only; Subagents and Workflows execute work, while files, git, tests, tool results, artifacts, and user confirmation remain truth.",
      ],
      parameters: Type.Object({
        items: Type.Array(
          Type.Object({
            subject: Type.String({
              minLength: 1,
              maxLength: LEDGER_LIMITS.subjectChars,
              description: "Short imperative description.",
            }),
            detail: Type.Optional(
              Type.String({ maxLength: LEDGER_LIMITS.detailChars }),
            ),
          }),
          { minItems: 1, maxItems: LEDGER_LIMITS.addBatch },
        ),
      }),
      execute(_id, params) {
        assertAvailable();
        const mutation = applyLedgerAdd(snapshot(), params.items);
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
          `${theme.fg("toolTitle", theme.bold("ledger_add"))} ${theme.fg("muted", `${args.items.length} item(s)`)}`,
          0,
          0,
        );
      },
      renderResult(result, options, theme) {
        return renderToolResult(
          result.details as LedgerToolDetails | undefined,
          options.expanded,
          theme,
        );
      },
    });

    pi.registerTool({
      name: "ledger_update",
      label: "Ledger Update",
      description: `${TOOL_PURPOSE} Patch one ledger item by numeric ID. blocked, done, and dropped status changes require a fresh note explaining the blocker, observable evidence, or drop reason.`,
      promptSnippet: "Update one session ledger item by stable ID",
      promptGuidelines: [
        "Keep ledger_update status current when tracked work materially changes, but avoid ceremonial status churn.",
        "Before setting a ledger item to done, include a note citing an observable check, artifact, commit, tool result, or user confirmation; the ledger records this claim but does not verify it.",
      ],
      parameters: Type.Object({
        id: Type.Integer({ minimum: 1 }),
        subject: Type.Optional(
          Type.String({ minLength: 1, maxLength: LEDGER_LIMITS.subjectChars }),
        ),
        detail: Type.Optional(
          Type.Union([
            Type.String({ maxLength: LEDGER_LIMITS.detailChars }),
            Type.Null(),
          ]),
        ),
        status: Type.Optional(StringEnum(LEDGER_STATUSES)),
        note: Type.Optional(
          Type.Union([
            Type.String({ maxLength: LEDGER_LIMITS.noteChars }),
            Type.Null(),
          ]),
        ),
      }),
      execute(_id, params) {
        assertAvailable();
        const mutation = applyLedgerUpdate(snapshot(), params);
        const changed = persistThenCommit(mutation.snapshot);
        return Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: changed
                ? `Updated T${params.id}.`
                : `T${params.id} already has that state; no update recorded.`,
            },
          ],
          details: toolDetails("update", mutation.items),
        });
      },
      renderCall(args, theme) {
        return new Text(
          `${theme.fg("toolTitle", theme.bold("ledger_update"))} ${theme.fg("accent", `T${args.id}`)}${args.status ? ` ${theme.fg("muted", args.status)}` : ""}`,
          0,
          0,
        );
      },
      renderResult(result, options, theme) {
        return renderToolResult(
          result.details as LedgerToolDetails | undefined,
          options.expanded,
          theme,
        );
      },
    });

    pi.registerTool({
      name: "ledger_list",
      label: "Ledger List",
      description: `${TOOL_PURPOSE} Read current session ledger items, optionally filtered by ID and status.`,
      promptSnippet: "List current session work-intent ledger items",
      parameters: Type.Object({
        id: Type.Optional(Type.Integer({ minimum: 1 })),
        status: Type.Optional(StringEnum(LEDGER_STATUSES)),
      }),
      execute(_id, params) {
        assertAvailable();
        const filter = params satisfies LedgerFilter;
        const items = ledger.list(filter);
        const preview = items.slice(0, 5);
        const rendered = ledger.render(filter, 3_800);
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
        return new Text(theme.fg("toolTitle", theme.bold("ledger_list")), 0, 0);
      },
      renderResult(result, options, theme) {
        return renderToolResult(
          result.details as LedgerToolDetails | undefined,
          options.expanded,
          theme,
        );
      },
    });
  };

  pi.registerCommand("ledger", {
    description: "Inspect the current session work-intent ledger",
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
      await openLedgerScreen(ctx, snapshot());
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
    conflict = findLedgerConflict(pi.getAllTools());
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
      frozenProjection = !problemMessage() ? projectLedger(snapshot()) : "";
      coldRun = false;
    }
  });

  pi.on("agent_settled", () => {
    activeRun = false;
    frozenProjection = "";
  });

  pi.on("context", (event) => {
    if (!activeRun || !frozenProjection || problemMessage()) return;
    const messages = injectLedgerProjection(event.messages, frozenProjection);
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

export { TOOL_NAMES as LEDGER_TOOL_NAMES };
