import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  budgetLimitPrompt,
  continuationPrompt,
  objectiveUpdatedPrompt,
} from "./prompts.ts";
import {
  GOAL_ENTRY_TYPE,
  GoalRestoreError,
  budgetLimitTransition,
  canResumeGoal,
  editGoalObjective,
  emergencyLimitTransition,
  isGoalActive,
  isGoalVisible,
  markContinuationDispatched,
  recordGoalProgress,
  restoreGoalState,
  setContinuationDeferred,
  transitionGoal,
  validateGoalSnapshot,
  type GoalSnapshot,
} from "./state.ts";

export const GOAL_CONTINUATION_TYPE = "goal-continuation";

type AssistantStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface GoalControllerOptions {
  now?: () => number;
  createId?: () => string;
}

export function countAssistantTokens(messages: readonly unknown[]) {
  let total = 0;
  for (const item of messages) {
    const message = unwrapMessage(item);
    if (!message || message.role !== "assistant") continue;
    const tokens = assistantGoalTokens(message);
    total += tokens;
    if (!Number.isSafeInteger(total)) return 0;
  }
  return total;
}

export function lastAssistantStopReason(messages: readonly unknown[]) {
  return lastAssistantMessage(messages)?.stopReason as
    AssistantStopReason | undefined;
}

export function isUsageLimitError(messages: readonly unknown[]) {
  const message = lastAssistantMessage(messages);
  if (!message || message.stopReason !== "error") return false;
  const diagnosticText = Array.isArray(message.diagnostics)
    ? message.diagnostics
        .flatMap((diagnostic) =>
          isRecord(diagnostic) && isRecord(diagnostic.error)
            ? [diagnostic.error.message, diagnostic.error.code]
            : [],
        )
        .join(" ")
    : "";
  const text = `${String(message.errorMessage ?? "")} ${diagnosticText}`;
  return /usage(?:_|\s+)limit|insufficient_quota|quota (?:has been )?exceeded|billing limit/iu.test(
    text,
  );
}

export class GoalController {
  private readonly pi: ExtensionAPI;
  private goal: GoalSnapshot | undefined;
  private lockedReason: string | undefined;
  private automationEnabled = false;
  private continuationPending = false;
  private trackedGoalId: string | undefined;
  private trackedStartedAt: number | undefined;
  private trackedTokens = 0;
  private currentRunObservedTokens = 0;
  private currentRunFlushedTokens = 0;
  private trackedFromRunStart = false;
  private accountingGoalId: string | undefined;
  private elapsedRemainderMs = 0;
  private lastStopReason: AssistantStopReason | undefined;
  private lastErrorWasUsageLimit = false;
  private suppressAbortedStop = false;
  private readonly now: () => number;
  readonly createId: () => string;

  constructor(pi: ExtensionAPI, options: GoalControllerOptions = {}) {
    this.pi = pi;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  snapshot() {
    return isGoalVisible(this.goal) ? structuredClone(this.goal) : undefined;
  }

  revision() {
    return this.goal?.revision ?? 0;
  }

  problem() {
    return this.lockedReason;
  }

  restore(ctx: ExtensionContext, deferActive = false) {
    this.resetRuntime();
    this.automationEnabled = ctx.mode !== "print" && ctx.mode !== "json";
    try {
      const restored = restoreGoalState(ctx.sessionManager.getBranch());
      this.goal = restored.snapshot;
      this.lockedReason = undefined;
      if (restored.migrated && this.goal) this.persist(this.goal);
      if (deferActive && this.goal?.status === "active") {
        this.persist(setContinuationDeferred(this.goal, true, this.now()));
      }
    } catch (error) {
      this.goal = undefined;
      this.lockedReason =
        error instanceof GoalRestoreError || error instanceof Error
          ? error.message
          : String(error);
    }
  }

  replace(candidate: GoalSnapshot) {
    this.assertUnlocked();
    this.continuationPending = false;
    if (this.goal?.id !== candidate.id) this.resetAccountingClock();
    this.persist(candidate);
    return this.snapshot();
  }

  edit(objective: string, ctx: ExtensionContext) {
    this.assertUnlocked();
    const current = this.requireVisibleGoal();
    this.flushTrackedProgress();
    this.persist(
      editGoalObjective(this.goal ?? current, objective, this.now()),
    );
    if (this.goal?.status === "active") {
      this.continuationPending = false;
      if (!ctx.isIdle()) this.beginTracking(this.goal);
      this.dispatchPrompt(
        ctx,
        ctx.isIdle() ? "continuation" : "objective_updated",
        true,
      );
    }
    return this.snapshot();
  }

  pause(reason = "Paused by user.") {
    this.assertUnlocked();
    const current = this.requireVisibleGoal();
    if (current.status === "paused") return this.snapshot();
    if (current.status !== "active") {
      throw new Error(`Goal cannot pause from ${current.status}.`);
    }
    this.flushTrackedProgress();
    this.continuationPending = false;
    this.persist(
      transitionGoal(this.goal ?? current, "paused", this.now(), reason),
    );
    this.resetAccountingClock();
    return this.snapshot();
  }

  resume() {
    this.assertUnlocked();
    const current = this.requireVisibleGoal();
    if (!canResumeGoal(current)) {
      throw new Error(`Goal cannot resume from ${current.status}.`);
    }
    this.continuationPending = false;
    this.resetAccountingClock();
    this.persist(
      transitionGoal(current, "active", this.now(), "Resumed by user."),
    );
    return this.snapshot();
  }

  updateFromModel(status: "complete" | "blocked") {
    this.assertUnlocked();
    const current = this.requireVisibleGoal();
    if (
      current.status === status ||
      (current.status === "budget_limited" && status === "blocked")
    ) {
      return this.snapshot();
    }
    this.flushTrackedProgress();
    this.continuationPending = false;
    this.persist(
      transitionGoal(
        this.goal ?? current,
        status,
        this.now(),
        status === "complete"
          ? "Marked complete by the goal agent."
          : "Marked blocked by the goal agent.",
      ),
    );
    this.resetAccountingClock();
    return this.snapshot();
  }

  clear() {
    this.assertUnlocked();
    if (!isGoalVisible(this.goal)) return false;
    this.flushTrackedProgress();
    this.continuationPending = false;
    this.persist(
      transitionGoal(this.goal, "cleared", this.now(), "Cleared by user."),
    );
    this.resetAccountingClock();
    return true;
  }

  kickoff(ctx: ExtensionContext) {
    this.assertUnlocked();
    const current = this.requireVisibleGoal();
    if (current.status !== "active") {
      throw new Error(`Goal cannot start from ${current.status}.`);
    }
    if (!ctx.isIdle()) this.beginTracking(current);
    return this.dispatchPrompt(ctx, "continuation", true);
  }

  continueWhenIdle(ctx: ExtensionContext) {
    return this.dispatchPrompt(ctx, "continuation", false);
  }

  releaseDeferredContinuation() {
    if (this.goal?.status !== "active" || !this.goal.deferContinuation) {
      return false;
    }
    this.persist(setContinuationDeferred(this.goal, false, this.now()));
    return true;
  }

  agentStarted() {
    this.continuationPending = false;
    this.lastStopReason = undefined;
    this.lastErrorWasUsageLimit = false;
    this.suppressAbortedStop = false;
    this.currentRunObservedTokens = 0;
    this.currentRunFlushedTokens = 0;
    if (!this.goal || !isGoalActive(this.goal) || this.goal.deferContinuation) {
      if (!this.trackedGoalId) this.resetTrackedRun();
      else this.trackedFromRunStart = true;
      return;
    }
    this.beginTracking(this.goal, true);
  }

  messageEnded(message: unknown) {
    const unwrapped = unwrapMessage(message);
    if (!unwrapped || unwrapped.role !== "assistant") return;
    this.currentRunObservedTokens = safeTokenAdd(
      this.currentRunObservedTokens,
      assistantGoalTokens(unwrapped),
    );
  }

  agentEnded(messages: readonly unknown[]) {
    if (!this.trackedGoalId) return;
    const observed = this.trackedFromRunStart
      ? Math.max(this.currentRunObservedTokens, countAssistantTokens(messages))
      : this.currentRunObservedTokens;
    this.trackedTokens = safeTokenAdd(
      this.trackedTokens,
      Math.max(0, observed - this.currentRunFlushedTokens),
    );
    this.currentRunObservedTokens = 0;
    this.currentRunFlushedTokens = 0;
    this.lastStopReason = lastAssistantStopReason(messages);
    this.lastErrorWasUsageLimit = isUsageLimitError(messages);
  }

  toolFinished(ctx: ExtensionContext) {
    if (
      !this.trackedGoalId ||
      !this.goal ||
      this.goal.id !== this.trackedGoalId ||
      this.goal.status !== "active"
    ) {
      return;
    }
    this.flushTrackedProgress();
    if (!this.goal || this.goal.status !== "active") return;
    const budgetLimited = budgetLimitTransition(this.goal, this.now());
    if (!budgetLimited) return;
    this.persist(budgetLimited);
    this.resetAccountingClock();
    this.dispatchPrompt(ctx, "budget_limit", true);
  }

  compacted(willRetry: boolean) {
    if (willRetry && this.lastStopReason === "aborted") {
      this.suppressAbortedStop = true;
    }
  }

  settled(ctx: ExtensionContext) {
    const trackedGoalId = this.trackedGoalId;
    if (trackedGoalId) this.continuationPending = false;
    const stopReason = this.lastStopReason;
    const errorWasUsageLimit = this.lastErrorWasUsageLimit;
    const suppressAbortedStop = this.suppressAbortedStop;

    if (!trackedGoalId || !this.goal || this.goal.id !== trackedGoalId) {
      this.resetTrackedRun();
      return;
    }

    this.flushTrackedProgress();
    this.resetTrackedRun();
    if (!this.goal || this.goal.id !== trackedGoalId) return;
    if (
      this.goal.status === "budget_limited" &&
      stopReason === "error" &&
      errorWasUsageLimit
    ) {
      this.persist(
        transitionGoal(
          this.goal,
          "usage_limited",
          this.now(),
          "Stopped after the active turn hit a usage limit.",
        ),
      );
      this.resetAccountingClock();
      return;
    }
    if (this.goal.status !== "active") return;

    const budgetLimited = budgetLimitTransition(this.goal, this.now());
    if (budgetLimited) {
      this.persist(budgetLimited);
      this.resetAccountingClock();
      this.dispatchPrompt(ctx, "budget_limit", true);
      return;
    }
    if (stopReason === "aborted" && !suppressAbortedStop) {
      this.persist(
        transitionGoal(
          this.goal,
          "paused",
          this.now(),
          "Paused after the active turn was interrupted.",
        ),
      );
      this.resetAccountingClock();
      return;
    }
    if (stopReason === "error") {
      this.persist(
        transitionGoal(
          this.goal,
          errorWasUsageLimit ? "usage_limited" : "blocked",
          this.now(),
          errorWasUsageLimit
            ? "Stopped after the active turn hit a usage limit."
            : "Blocked after the active turn ended with an error.",
        ),
      );
      this.resetAccountingClock();
      return;
    }

    const emergencyLimited = emergencyLimitTransition(this.goal, this.now());
    if (emergencyLimited) {
      this.persist(emergencyLimited);
      this.resetAccountingClock();
      return;
    }
    this.continueWhenIdle(ctx);
  }

  shutdown() {
    this.automationEnabled = false;
    this.resetRuntime();
  }

  private dispatchPrompt(
    ctx: ExtensionContext,
    kind: "continuation" | "objective_updated" | "budget_limit",
    allowBusy: boolean,
  ) {
    if (!this.automationEnabled || !this.goal || this.continuationPending) {
      return false;
    }
    if (!allowBusy && !ctx.isIdle()) return false;
    if (kind !== "budget_limit") {
      if (this.goal.status !== "active" || this.goal.deferContinuation) {
        return false;
      }
      const emergencyLimited = emergencyLimitTransition(this.goal, this.now());
      if (emergencyLimited) {
        this.persist(emergencyLimited);
        return false;
      }
      this.persist(markContinuationDispatched(this.goal, this.now()));
    } else if (this.goal.status !== "budget_limited") {
      return false;
    }

    if (kind === "budget_limit") this.beginTracking(this.goal);
    const goal = this.goal;
    const content =
      kind === "continuation"
        ? continuationPrompt(goal)
        : kind === "objective_updated"
          ? objectiveUpdatedPrompt(goal)
          : budgetLimitPrompt(goal);
    this.continuationPending = true;
    try {
      this.pi.sendMessage(
        {
          customType: GOAL_CONTINUATION_TYPE,
          display: true,
          content,
          details: { kind, goalId: goal.id, revision: goal.revision },
        },
        {
          triggerTurn: true,
          deliverAs: ctx.isIdle() ? "followUp" : "steer",
        },
      );
      return true;
    } catch (error) {
      this.continuationPending = false;
      if (this.goal?.status === "active") {
        this.persist(
          transitionGoal(
            this.goal,
            "paused",
            this.now(),
            "Paused because the next autonomous turn could not be dispatched.",
          ),
        );
      }
      throw error;
    }
  }

  private persist(candidate: GoalSnapshot) {
    const checked = validateGoalSnapshot(candidate);
    this.pi.appendEntry(GOAL_ENTRY_TYPE, checked);
    this.goal = checked;
  }

  private beginTracking(goal: GoalSnapshot, fromRunStart = false) {
    if (this.accountingGoalId !== goal.id) {
      this.accountingGoalId = goal.id;
      this.elapsedRemainderMs = 0;
    }
    if (this.trackedGoalId !== goal.id) {
      this.trackedGoalId = goal.id;
      this.trackedStartedAt = this.now();
      this.trackedTokens = 0;
      this.currentRunFlushedTokens = fromRunStart
        ? 0
        : this.currentRunObservedTokens;
      this.trackedFromRunStart = fromRunStart;
    } else if (fromRunStart) {
      this.trackedFromRunStart = true;
    }
  }

  private flushTrackedProgress() {
    if (
      !this.trackedGoalId ||
      !this.goal ||
      this.goal.id !== this.trackedGoalId ||
      this.goal.status === "cleared"
    ) {
      return;
    }
    const unflushedCurrentTokens = Math.max(
      0,
      this.currentRunObservedTokens - this.currentRunFlushedTokens,
    );
    const tokens = safeTokenAdd(this.trackedTokens, unflushedCurrentTokens);
    const now = this.now();
    const elapsedMs =
      this.trackedStartedAt === undefined
        ? 0
        : Math.max(0, now - this.trackedStartedAt);
    const totalElapsedMs = this.elapsedRemainderMs + elapsedMs;
    const elapsedSeconds = Math.floor(totalElapsedMs / 1_000);
    this.elapsedRemainderMs = totalElapsedMs % 1_000;
    if (tokens > 0 || elapsedSeconds > 0) {
      this.persist(recordGoalProgress(this.goal, tokens, elapsedSeconds, now));
    }
    this.trackedTokens = 0;
    this.currentRunFlushedTokens = this.currentRunObservedTokens;
    this.trackedStartedAt = now;
  }

  private requireVisibleGoal() {
    if (!isGoalVisible(this.goal)) throw new Error("No goal is currently set.");
    return this.goal;
  }

  private resetRuntime() {
    this.continuationPending = false;
    this.resetTrackedRun();
    this.resetAccountingClock();
  }

  private resetTrackedRun() {
    this.trackedGoalId = undefined;
    this.trackedStartedAt = undefined;
    this.trackedTokens = 0;
    this.currentRunObservedTokens = 0;
    this.currentRunFlushedTokens = 0;
    this.trackedFromRunStart = false;
    this.lastStopReason = undefined;
    this.lastErrorWasUsageLimit = false;
    this.suppressAbortedStop = false;
  }

  private resetAccountingClock() {
    this.accountingGoalId = undefined;
    this.elapsedRemainderMs = 0;
  }

  private assertUnlocked() {
    if (this.lockedReason) {
      throw new Error(
        `Session goal is locked by malformed branch history: ${this.lockedReason}`,
      );
    }
  }
}

function assistantGoalTokens(message: Record<string, unknown>) {
  const usage = message.usage;
  if (!isRecord(usage)) return 0;
  const input = usage.input;
  const output = usage.output;
  if (
    Number.isSafeInteger(input) &&
    (input as number) >= 0 &&
    Number.isSafeInteger(output) &&
    (output as number) >= 0
  ) {
    return safeTokenAdd(input as number, output as number);
  }
  const total = usage.totalTokens;
  return Number.isSafeInteger(total) && (total as number) >= 0
    ? (total as number)
    : 0;
}

function lastAssistantMessage(messages: readonly unknown[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = unwrapMessage(messages[index]);
    if (!message || message.role !== "assistant") continue;
    if (
      message.stopReason === "stop" ||
      message.stopReason === "length" ||
      message.stopReason === "toolUse" ||
      message.stopReason === "error" ||
      message.stopReason === "aborted"
    ) {
      return message;
    }
  }
  return undefined;
}

function unwrapMessage(value: unknown) {
  if (!isRecord(value)) return undefined;
  if (value.role) return value;
  return isRecord(value.message) ? value.message : undefined;
}

function safeTokenAdd(left: number, right: number) {
  const result = left + right;
  return Number.isSafeInteger(result) && result >= 0 ? result : left;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
