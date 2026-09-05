/**
 * plan-mode: explore read-only, then get explicit approval before writing.
 *
 * `/plan` arms a session flag; while armed, a `tool_call` handler allows only
 * explicitly read-only tools and tells the model to finish planning instead.
 * `bash` is judged per command rather than as a whole (see `bash-policy.ts`),
 * because history and diffs are what a plan is grounded in.
 * `/plan done` asks the model to finalize through `plan_ready`; that explicit
 * terminating tool records the complete plan while keeping the write gate
 * closed. A later `/plan` lets the user continue planning or prefill an
 * implementation prompt in this session or a fresh linked session.
 *
 * SCOPE, deliberately stated: a `tool_call` handler gates only THIS
 * interactive session. It cannot reach a headless subagent's or a workflow
 * child's writes — those run in their own sessions.
 *
 * Delegation is still allowed, because that limitation is answered elsewhere:
 * `subagent_spawn` narrows a child to `PLAN_MODE_CHILD_TOOLS` (see
 * `../shared/plan-mode-state.ts`), and a child tool allowlist is enforced by
 * the harness rather than by prompt. Blocking it outright was the first
 * answer and it was the wrong trade: parallel read-only exploration, kept out
 * of the main context, is one of the most useful things to do while planning.
 * `workflow` stays blocked because `agent_type` is optional and the DSL has
 * no run-wide plan-mode narrowing: an untyped or implementation call may
 * still write. `subagent_send` stays blocked because it resumes a child that
 * may predate the plan and still hold the full tool set.
 */

import {
  getMarkdownTheme,
  keyHint,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  PLAN_MODE_CHANNEL,
  type PlanModeState,
} from "../shared/plan-mode-state.ts";
import {
  loadOpenPiCapabilities,
  OPENPI_TOOL_SURFACE,
  patchOwnedTools,
} from "../shared/tool-surface.ts";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import { planBashDecision } from "./bash-policy.ts";

export const MAX_READY_PLAN_CHARS = 50_000;
export const MAX_READY_PLAN_UTF8_BYTES = 48_000;
/** Preview lines shown in the collapsed plan_ready result. */
const PLAN_PREVIEW_LINES = 10;
export const PLAN_MODE_STATE_ENTRY = "my-pi-setup-plan-mode-state";

export type PersistedPlanModeState =
  | { version: 1; status: "inactive" | "planning" }
  | { version: 1; status: "ready"; plan: string };

export interface RestoredPlanModeState {
  planning: boolean;
  readyPlan?: string;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedReadyPlan(value: unknown): value is string {
  return (
    typeof value === "string" &&
    sanitizeTerminalText(value) === value &&
    value.trim().length > 0 &&
    value.length <= MAX_READY_PLAN_CHARS &&
    new TextEncoder().encode(value.trim()).byteLength <=
      MAX_READY_PLAN_UTF8_BYTES
  );
}

function decodePlanModeState(data: unknown): RestoredPlanModeState | undefined {
  if (
    !isRecord(data) ||
    data.version !== 1 ||
    typeof data.status !== "string"
  ) {
    return;
  }
  const keys = Object.keys(data).sort().join(",");
  if (data.status === "inactive" || data.status === "planning") {
    if (keys !== "status,version") return;
    return { planning: data.status === "planning" };
  }
  if (data.status === "ready" && keys === "plan,status,version") {
    if (!isBoundedReadyPlan(data.plan)) return;
    return { planning: true, readyPlan: data.plan.trim() };
  }
}

export function latestAssistantToolCallCount(entries: readonly unknown[]) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (!Array.isArray(message.content)) return 0;
    return message.content.filter(
      (part) => isRecord(part) && part.type === "toolCall",
    ).length;
  }
  return 0;
}

export function planReadyBatchDecision(toolName: string, callCount: number) {
  if (toolName !== "plan_ready" || callCount === 1) return;
  return {
    block: true as const,
    reason:
      "plan_ready must be the only tool call in its assistant message so Pi can terminate planning deterministically. Retry it alone after the other tool results return.",
  };
}

/** Restore only the newest branch-local state; malformed state fails closed. */
export function restorePlanModeState(
  entries: readonly unknown[],
): RestoredPlanModeState {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      !isRecord(entry) ||
      entry.type !== "custom" ||
      entry.customType !== PLAN_MODE_STATE_ENTRY
    ) {
      continue;
    }
    return (
      decodePlanModeState(entry.data) ?? {
        planning: true,
        error:
          "The latest persisted Plan Mode state is malformed; writes remain blocked. Use `/plan off` to clear it explicitly.",
      }
    );
  }
  return { planning: false };
}

export const PLAN_READY_ACTIONS = {
  continue: "Continue planning",
  current: "Implement in this session",
  fresh: "Start a fresh session",
  off: "Turn plan mode off",
} as const;

/** Menu label for the same effect as `/plan done`. */
const FINALIZE_NOW = "Finalize now";

export function buildPlanImplementationPrompt(plan: string) {
  return [
    "Implement the approved plan below. Re-check the repository state before editing, follow the project instructions, and verify the finished change.",
    "",
    "--- APPROVED PLAN ---",
    plan,
    "--- END APPROVED PLAN ---",
  ].join("\n");
}

/**
 * Fail-closed allow-list for planning. Unknown and newly installed tools are
 * blocked until they are deliberately classified here as observational.
 * `bash` is absent from this set on purpose but is NOT blocked outright:
 * whether an arbitrary command is read-only cannot be decided by tool name, so
 * it is decided one level down, per command, by `planBashDecision`.
 */
export const PLAN_SAFE_TOOLS = new Set([
  // Local repository investigation.
  "read",
  "grep",
  "find",
  "ls",
  "fd",
  "rg",
  "git_show",
  "git_diff",
  "git_log",
  // Web research without write actions.
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
  // Read-only inspection of work already in flight.
  "bg_status",
  "bg_list",
  "bg_watch",
  "subagent_check",
  "subagent_list",
  "subagent_wait",
  "workflow_status",
  // Delegated investigation. Exploring several subsystems in parallel without
  // dragging the noise into the main context is one of the most useful things
  // to do while planning, so spawning is allowed — but only because the
  // child's tool allowlist is enforced by the harness. See
  // `plan-mode-state.ts`: subagents narrows a planning child to
  // PLAN_MODE_CHILD_TOOLS, which has no write, edit, or bash in it. A
  // tool_call handler could never gate a child's writes itself, since the
  // child runs in its own session.
  //
  // `subagent_send` is NOT here for the same reason: it resumes an existing
  // child's session, and one started before `/plan` was armed still holds the
  // full tool set. Narrowing applies at spawn, so only spawning is safe.
  "subagent_spawn",
  // Advisory state reads and an explicit user clarification.
  "tasks_list",
  "get_goal",
  "ask_user",
  // The model's explicit, terminating transition from planning to ready.
  "plan_ready",
]);

export const BLOCK_REASON =
  "Plan mode is active: no changes yet. Keep investigating with read-only tools (read, fd, rg, git_log/git_diff/git_show, web search, read-only bash like git log/status, and subagent_spawn for parallel exploration — planning children get read-only tools). Raw git diff/show and diff-generating git log forms are blocked; use the structured Git tools instead. When the plan is decision-complete, call plan_ready alone with the complete Markdown plan; the user then chooses the next action with `/plan`, or cancels with `/plan off`.";

export function planToolCallDecision(
  toolName: string,
  input?: Record<string, unknown>,
) {
  // Creating a worktree changes Git metadata before the child even starts;
  // delegation is safe in plan mode only in the existing checkout.
  if (toolName === "subagent_spawn" && input?.isolation === "worktree") {
    return {
      block: true as const,
      reason: `Plan mode cannot create an isolated worktree. Omit isolation for read-only delegation. ${BLOCK_REASON}`,
    };
  }
  if (PLAN_SAFE_TOOLS.has(toolName)) return;
  // bash is decided per command, not per tool: the read-only investigation a
  // plan is built on (history, diffs, PR state) lives behind it.
  if (toolName === "bash") {
    const decision = planBashDecision(input?.command);
    if (decision.allowed) return;
    return {
      block: true as const,
      reason: `${decision.reason ?? "plan mode could not verify this command is read-only"}. ${BLOCK_REASON}`,
    };
  }
  return { block: true as const, reason: BLOCK_REASON };
}

export default function planMode(pi: ExtensionAPI) {
  let planning = false;
  let readyPlan: string | undefined;
  const syncPlanTool = () =>
    patchOwnedTools(pi, "plan", {
      ...(planning && !readyPlan
        ? { enable: OPENPI_TOOL_SURFACE.plan.deferred }
        : { disable: OPENPI_TOOL_SURFACE.plan.deferred }),
    });

  /**
   * Publish the stance and reflect it in the footer. Every place `planning`
   * changes goes through here, because a subagent spawned while the broadcast
   * was stale would be a child with write tools during a plan — the one thing
   * this extension exists to prevent.
   */
  const setStatus = (ctx: {
    hasUI: boolean;
    ui: { setStatus: (key: string, value?: string) => void };
  }) => {
    if (planning) loadOpenPiCapabilities(pi, ["search"]);
    syncPlanTool();
    pi.events.emit(PLAN_MODE_CHANNEL, { planning } satisfies PlanModeState);
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      "plan-mode",
      readyPlan ? "plan ready" : planning ? "plan mode" : undefined,
    );
  };

  const commitPlanState = (
    state: PersistedPlanModeState,
    ctx: {
      hasUI: boolean;
      ui: { setStatus: (key: string, value?: string) => void };
    },
  ) => {
    // Persist before mutating memory: a failed append must never open the gate
    // or discard a ready plan only in RAM.
    pi.appendEntry(PLAN_MODE_STATE_ENTRY, state);
    planning = state.status !== "inactive";
    readyPlan = state.status === "ready" ? state.plan : undefined;
    setStatus(ctx);
  };

  const clearPlan = (ctx: {
    hasUI: boolean;
    ui: { setStatus: (key: string, value?: string) => void };
  }) => {
    commitPlanState({ version: 1, status: "inactive" }, ctx);
  };

  const continuePlanning = (ctx: ExtensionCommandContext) => {
    commitPlanState({ version: 1, status: "planning" }, ctx);
    ctx.ui.notify(
      "Still in plan mode. Enter the revision you want; writes remain blocked.",
      "info",
    );
  };

  const implementHere = (ctx: ExtensionCommandContext) => {
    if (!readyPlan) {
      ctx.ui.notify("No ready plan is available.", "warning");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Implementing a ready plan requires an interactive editor.",
        "warning",
      );
      return;
    }
    const prompt = buildPlanImplementationPrompt(readyPlan);
    ctx.ui.setEditorText(prompt);
    clearPlan(ctx);
    ctx.ui.notify(
      "Plan mode is off. Review the implementation prompt, then submit it when ready.",
      "info",
    );
  };

  const implementFresh = async (ctx: ExtensionCommandContext) => {
    if (!readyPlan) {
      ctx.ui.notify("No ready plan is available.", "warning");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Starting a fresh implementation requires an interactive editor.",
        "warning",
      );
      return;
    }
    const prompt = buildPlanImplementationPrompt(readyPlan);
    const parentSession = ctx.sessionManager.getSessionFile();
    await ctx.waitForIdle();
    const result = await ctx.newSession({
      ...(parentSession ? { parentSession } : {}),
      withSession: async (nextCtx) => {
        nextCtx.ui.setEditorText(prompt);
        nextCtx.ui.notify(
          "Fresh implementation session ready. Review the prompt, then submit it when ready.",
          "info",
        );
      },
    });
    if (result.cancelled) {
      ctx.ui.notify(
        "Fresh session cancelled; the plan is still ready.",
        "info",
      );
    }
  };

  const showReadyActions = async (ctx: ExtensionCommandContext) => {
    if (!readyPlan) {
      ctx.ui.notify("No ready plan is available.", "warning");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Use `/plan implement`, `/plan fresh`, or `/plan off` in a UI session.",
        "warning",
      );
      return;
    }
    const choice = await ctx.ui.select(
      "Plan Ready — choose what happens next",
      Object.values(PLAN_READY_ACTIONS),
    );
    if (choice === PLAN_READY_ACTIONS.continue) {
      continuePlanning(ctx);
    } else if (choice === PLAN_READY_ACTIONS.current) {
      implementHere(ctx);
    } else if (choice === PLAN_READY_ACTIONS.fresh) {
      await implementFresh(ctx);
    } else if (choice === PLAN_READY_ACTIONS.off) {
      clearPlan(ctx);
      ctx.ui.notify("Plan mode is off.", "info");
    }
  };

  const requestPlanFinalization = () => {
    pi.sendMessage(
      {
        customType: "plan-finalize-requested",
        content:
          "Finalize the plan now. Resolve any remaining material ambiguity with ask_user; otherwise call plan_ready alone with the complete implementation-ready Markdown plan. Do not implement it.",
        display: true,
        details: {},
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  pi.registerTool({
    name: "plan_ready",
    label: "Plan Ready",
    description:
      "Finish an active Plan Mode workflow with the complete implementation-ready Markdown plan. Call it alone as the final action only after research and material user decisions are complete.",
    promptSnippet:
      "Complete active Plan Mode with one explicit implementation-ready plan",
    promptGuidelines: [
      "When Plan Mode is active and the plan is decision-complete, call plan_ready alone as the final action with the complete Markdown plan; do not infer approval or begin implementation.",
    ],
    parameters: Type.Object({
      plan: Type.String({
        minLength: 1,
        maxLength: MAX_READY_PLAN_CHARS,
        description: "The complete implementation-ready Markdown plan",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [
            { type: "text" as const, text: "Plan completion cancelled." },
          ],
          details: { status: "cancelled" as const },
          terminate: true,
        };
      }
      if (!planning) {
        throw new Error("plan_ready requires active Plan Mode.");
      }
      const plan = sanitizeTerminalText(params.plan).trim();
      if (!plan) throw new Error("plan_ready requires a non-empty plan.");
      if (
        new TextEncoder().encode(plan).byteLength > MAX_READY_PLAN_UTF8_BYTES
      ) {
        throw new Error(
          `plan_ready plans must be at most ${MAX_READY_PLAN_UTF8_BYTES} UTF-8 bytes.`,
        );
      }
      commitPlanState({ version: 1, status: "ready", plan }, ctx);
      ctx.ui.notify(
        "Plan ready. Run `/plan` to continue planning or prepare implementation.",
        "info",
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Plan ready for explicit user action. No implementation has started.\n\n${plan}`,
          },
        ],
        details: { status: "ready" as const, plan },
        terminate: true,
      };
    },
    /**
     * Render a completed plan for the TUI. Collapsed shows the line count
     * plus a bounded preview (PLAN_PREVIEW_LINES) with an expand hint;
     * expanded renders the full plan as Markdown. Pi only reflects the
     * expanded flag — it never truncates custom renderer output, so this
     * renderer owns the collapsed/expanded contract.
     */
    renderResult(result, { expanded }, theme) {
      const plan = (result.details as { plan?: string } | undefined)?.plan;
      if (!plan) {
        // Failed invocations (not in plan mode, empty plan, size cap, abort)
        // produce {content:[{text:reason}], details:{}} from agent-loop's
        // createErrorToolResult; surface the real reason instead of a
        // placeholder, mirroring subagent_spawn's fallback.
        const first = result.content?.[0];
        return new Text(
          first?.type === "text"
            ? first.text
            : theme.fg("muted", "(no plan content)"),
          0,
          0,
        );
      }
      if (!expanded) {
        // Bound the collapsed preview by rendered rows, not source lines: a
        // single long source line wraps into many terminal rows at narrow
        // widths, so render the body at the caller's width, keep the first
        // PLAN_PREVIEW_LINES rows, and truncate every row to the viewport
        // width (same contract as renderWaitResult's fixedRows).
        const body = new Text(
          plan
            .split("\n")
            .map((line) => theme.fg("toolOutput", line))
            .join("\n"),
          0,
          0,
        );
        return {
          render(width: number) {
            const bodyRows = body.render(width);
            const shown = bodyRows.slice(0, PLAN_PREVIEW_LINES);
            const hidden = bodyRows.length - shown.length;
            const header = theme.fg(
              "muted",
              `Plan ready · ${plan.split("\n").length} lines`,
            );
            const rows = [header, ...shown];
            if (hidden > 0) {
              // The hint gets its own row: tucking it into the header tail
              // lets a narrow viewport clip it away along with the rest of
              // the header, hiding the expand affordance exactly when the
              // preview is clipped.
              rows.push(keyHint("app.tools.expand", "to expand"));
              rows.push(theme.fg("muted", `... (${hidden} more rows)`));
            }
            return rows.map((row) => truncateToWidth(row, Math.max(1, width)));
          },
          invalidate() {
            body.invalidate();
          },
        };
      }
      // A plan is prose to read, not source to inspect. Without a renderer the
      // TUI falls back to plain text and shows raw Markdown syntax.
      return new Markdown(plan, 0, 0, getMarkdownTheme());
    },
  });

  pi.registerCommand("plan", {
    description:
      "Plan read-only, then use an explicit Plan Ready action: `/plan`, `/plan done`, `/plan implement`, `/plan fresh`, `/plan off`",
    handler: async (rawArgs, ctx) => {
      const action = rawArgs.trim().toLowerCase();

      if (action === "off" || action === "cancel") {
        clearPlan(ctx);
        ctx.ui.notify("Plan mode off. No implementation was started.", "info");
        return;
      }

      if (action === "implement" || action === "current") {
        implementHere(ctx);
        return;
      }

      if (action === "fresh") {
        await implementFresh(ctx);
        return;
      }

      if (action === "done" || action === "approve") {
        if (readyPlan) {
          await showReadyActions(ctx);
          return;
        }
        if (!planning) {
          ctx.ui.notify("Plan mode is not active.", "warning");
          return;
        }
        requestPlanFinalization();
        return;
      }

      if (readyPlan && !action) {
        await showReadyActions(ctx);
        return;
      }

      if (planning) {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            "Plan mode is already active. `/plan done` requests completion; `/plan off` cancels.",
            "info",
          );
          return;
        }
        const choice = await ctx.ui.select(
          "Plan Mode — choose what happens next",
          [PLAN_READY_ACTIONS.continue, FINALIZE_NOW, PLAN_READY_ACTIONS.off],
        );
        if (choice === PLAN_READY_ACTIONS.continue) {
          ctx.ui.notify(
            "Plan mode is already active. `/plan done` requests completion; `/plan off` cancels.",
            "info",
          );
        } else if (choice === FINALIZE_NOW) {
          requestPlanFinalization();
        } else if (choice === PLAN_READY_ACTIONS.off) {
          clearPlan(ctx);
          ctx.ui.notify("Plan mode is off.", "info");
        }
        return;
      }

      commitPlanState({ version: 1, status: "planning" }, ctx);
      const objective = rawArgs.trim();
      pi.sendMessage(
        {
          customType: "plan-mode-armed",
          content:
            `Plan mode is on: investigate and propose a plan, but do not change anything yet. Edits and writes are blocked until the user explicitly chooses an implementation action. For files use the read, ls, grep, fd and rg tools. Use \`git_log\`, \`git_diff\` and \`git_show\` for history and changes; they disable repository external diff and textconv programs. Bash is limited to read-only git and gh commands such as \`git log\`, \`git status\`, \`git blame\` and \`gh pr view\` — raw Git commands that render diffs are blocked, and every Bash call must be one plain command with no pipes or redirects. You can still delegate with \`subagent_spawn\` to explore several parts of the codebase at once: children spawned while planning receive read-only tools, so use them for investigation rather than for work to be done later.${objective ? `\n\nPlan for: ${objective}` : ""}` +
            "\n\nUse read-only tools to ground the plan. When it is decision-complete, call `plan_ready` alone with the complete Markdown plan. That records the plan but does not start implementation; the user chooses the next action with `/plan`.",
          display: true,
          details: {},
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    },
  });

  pi.on("tool_call", (event, ctx) => {
    if (!planning) return;
    if (readyPlan) {
      return {
        block: true as const,
        reason:
          "The plan is ready and the write gate remains closed. Wait for the user to choose the next action with `/plan` or turn it off with `/plan off`; do not call more tools.",
      };
    }
    const batchDecision =
      event.toolName === "plan_ready"
        ? planReadyBatchDecision(
            event.toolName,
            latestAssistantToolCallCount(ctx.sessionManager.getBranch()),
          )
        : undefined;
    if (batchDecision) return batchDecision;
    return planToolCallDecision(event.toolName, event.input);
  });

  const restoreRuntimeState = (ctx: ExtensionContext) => {
    const restored = restorePlanModeState(ctx.sessionManager.getBranch());
    planning = restored.planning;
    readyPlan = restored.readyPlan;
    setStatus(ctx);
    if (restored.error) ctx.ui.notify(restored.error, "error");
  };

  pi.on("session_start", (_event, ctx) => {
    restoreRuntimeState(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreRuntimeState(ctx);
  });

  pi.on("session_shutdown", () => {
    planning = false;
    readyPlan = undefined;
    syncPlanTool();
    // Broadcast without a ctx: subagents keeps its own copy of the stance, and
    // leaving it armed would restrict children in whatever session comes next.
    pi.events.emit(PLAN_MODE_CHANNEL, { planning } satisfies PlanModeState);
  });
}
