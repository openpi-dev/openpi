import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { projectLedger, restoreLedgerSnapshot } from "../ledger/ledger.ts";
import { evaluateGoal, type EvaluationResult } from "./evaluator.ts";
import {
  GOAL_ENTRY_TYPE,
  GoalRestoreError,
  applyGoalJudge,
  hardLimitTransition,
  isGoalRunning,
  markLedgerReminderUsed,
  recordEvaluatorFailure,
  recordGoalSettlement,
  restoreGoalSnapshot,
  transitionGoal,
  validateGoalSnapshot,
  type GoalSnapshot,
} from "./state.ts";

export const GOAL_CONTINUATION_TYPE = "goal-continuation";
export const WAIT_MIN_MS = 5_000;
export const WAIT_MAX_MS = 300_000;

export interface GoalFence {
  epoch: number;
  id: string;
  revision: number;
}

export interface GoalControllerOptions {
  now?: () => number;
  evaluate?: (options: {
    ctx: ExtensionContext;
    goal: GoalSnapshot;
    signal: AbortSignal;
  }) => Promise<EvaluationResult>;
  schedule?: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  createId?: () => string;
}

export function waitingBackoffMs(waitCount: number) {
  const exponent = Math.max(0, Math.min(16, waitCount - 1));
  return Math.min(WAIT_MAX_MS, WAIT_MIN_MS * 2 ** exponent);
}

export function fenceMatches(
  fence: GoalFence,
  epoch: number,
  goal: GoalSnapshot | undefined,
) {
  return (
    goal !== undefined &&
    fence.epoch === epoch &&
    fence.id === goal.id &&
    fence.revision === goal.revision
  );
}

export function countAssistantTokens(
  entries: readonly unknown[],
  baselineLength: number,
) {
  if (
    !Number.isSafeInteger(baselineLength) ||
    baselineLength < 0 ||
    baselineLength > entries.length
  ) {
    return 0;
  }
  let total = 0;
  for (const entry of entries.slice(baselineLength)) {
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message) || message.role !== "assistant") continue;
    const usage = message.usage;
    if (!isRecord(usage)) continue;
    const tokens = usage.totalTokens;
    if (Number.isSafeInteger(tokens) && (tokens as number) >= 0) {
      total += tokens as number;
      if (!Number.isSafeInteger(total)) return 0;
    }
  }
  return total;
}

export function ledgerReminder(
  sessionManager: ExtensionContext["sessionManager"],
) {
  try {
    const projection = projectLedger(
      restoreLedgerSnapshot(sessionManager.getBranch()),
    );
    if (!projection) return "";
    return Array.from(projection).slice(0, 800).join("");
  } catch {
    return "";
  }
}

export class GoalController {
  private readonly pi: ExtensionAPI;
  private goal: GoalSnapshot | undefined;
  private lockedReason: string | undefined;
  private epoch = 0;
  private evaluator: AbortController | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private continuationPending = false;
  private baselineLength = 0;
  private automationEnabled = false;
  private evaluating = false;
  private readonly now: () => number;
  private readonly evaluate: NonNullable<GoalControllerOptions["evaluate"]>;
  private readonly schedule: NonNullable<GoalControllerOptions["schedule"]>;
  readonly createId: () => string;

  constructor(pi: ExtensionAPI, options: GoalControllerOptions = {}) {
    this.pi = pi;
    this.now = options.now ?? Date.now;
    this.evaluate = options.evaluate ?? evaluateGoal;
    this.schedule = options.schedule ?? setTimeout;
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  snapshot() {
    return this.goal ? structuredClone(this.goal) : undefined;
  }

  problem() {
    return this.lockedReason;
  }

  isEvaluating() {
    return this.evaluating;
  }

  restore(ctx: ExtensionContext, demoteRunning: boolean) {
    this.invalidate();
    this.automationEnabled = ctx.mode !== "print" && ctx.mode !== "json";
    try {
      this.goal = restoreGoalSnapshot(ctx.sessionManager.getBranch());
      this.lockedReason = undefined;
      if (demoteRunning && this.goal && isGoalRunning(this.goal)) {
        this.persist(
          transitionGoal(
            this.goal,
            "paused",
            this.now(),
            "Paused after session restore or branch navigation; run /goal resume to continue.",
          ),
        );
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
    this.invalidate();
    this.persist(candidate);
  }

  pause(reason = "Paused by user.") {
    this.assertUnlocked();
    if (!this.goal) throw new Error("No session goal is set.");
    if (!isGoalRunning(this.goal)) return this.snapshot();
    this.invalidate();
    this.persist(transitionGoal(this.goal, "paused", this.now(), reason));
    return this.snapshot();
  }

  resume() {
    this.assertUnlocked();
    if (!this.goal) throw new Error("No session goal is set.");
    if (this.goal.status !== "paused") {
      throw new Error(`Goal cannot resume from ${this.goal.status}.`);
    }
    this.invalidate();
    this.persist(
      transitionGoal(this.goal, "active", this.now(), "Resumed by user."),
    );
    return this.snapshot();
  }

  clear() {
    this.assertUnlocked();
    if (!this.goal) return undefined;
    this.invalidate();
    if (this.goal.status === "cleared") return this.snapshot();
    this.persist(
      transitionGoal(this.goal, "cleared", this.now(), "Cleared by user."),
    );
    return this.snapshot();
  }

  kickoff(ctx: ExtensionContext) {
    this.assertUnlocked();
    if (!this.goal) throw new Error("No session goal is set.");
    if (this.goal.status !== "active") {
      throw new Error(`Goal cannot start from ${this.goal.status}.`);
    }
    return this.admitContinuation(ctx, true);
  }

  beforeAgentStart(ctx: ExtensionContext) {
    this.clearTimer();
    this.evaluator?.abort();
    this.evaluator = undefined;
    this.evaluating = false;
    this.continuationPending = false;
    this.epoch++;
    this.baselineLength = ctx.sessionManager.getBranch().length;
    if (this.goal?.status === "waiting") {
      this.persist(
        transitionGoal(
          this.goal,
          "active",
          this.now(),
          "New agent evidence woke the waiting goal.",
        ),
      );
    }
  }

  async settled(ctx: ExtensionContext) {
    if (
      !this.automationEnabled ||
      !this.goal ||
      !isGoalRunning(this.goal) ||
      this.evaluator ||
      this.continuationPending
    ) {
      return;
    }

    const beforeSettlementLimit = hardLimitTransition(this.goal, this.now());
    if (beforeSettlementLimit) {
      this.persist(beforeSettlementLimit);
      return;
    }
    const parentTokens = countAssistantTokens(
      ctx.sessionManager.getBranch(),
      this.baselineLength,
    );
    this.persist(recordGoalSettlement(this.goal, parentTokens, this.now()));
    const limited = hardLimitTransition(this.goal, this.now());
    if (limited) {
      this.persist(limited);
      return;
    }

    const abort = new AbortController();
    this.evaluator = abort;
    this.evaluating = true;
    const fence = this.fence();
    try {
      const result = await this.evaluate({
        ctx,
        goal: this.goal,
        signal: abort.signal,
      });
      if (!fenceMatches(fence, this.epoch, this.goal)) return;
      this.persist(
        applyGoalJudge(this.goal, result.judge, result.tokens, this.now()),
      );
      const postJudgeLimit = hardLimitTransition(this.goal, this.now());
      if (postJudgeLimit) {
        this.persist(postJudgeLimit);
        return;
      }
      if (this.goal.status === "active") this.admitContinuation(ctx);
      else if (this.goal.status === "waiting") this.armWaiting(ctx);
    } catch {
      if (abort.signal.aborted || !fenceMatches(fence, this.epoch, this.goal))
        return;
      this.persist(recordEvaluatorFailure(this.goal, this.now()));
      if (this.goal.status === "active") this.admitContinuation(ctx);
      else if (this.goal.status === "waiting") this.armWaiting(ctx);
    } finally {
      if (this.evaluator === abort) this.evaluator = undefined;
      this.evaluating = false;
    }
  }

  shutdown() {
    this.automationEnabled = false;
    this.invalidate();
  }

  private admitContinuation(ctx: ExtensionContext, allowFollowUpQueue = false) {
    if (
      !this.automationEnabled ||
      !this.goal ||
      this.goal.status !== "active" ||
      this.continuationPending ||
      (!allowFollowUpQueue && !ctx.isIdle())
    ) {
      return false;
    }
    const limited = hardLimitTransition(this.goal, this.now());
    if (limited) {
      this.persist(limited);
      return false;
    }

    let reminder = "";
    if (!this.goal.ledgerReminderUsed) {
      reminder = ledgerReminder(ctx.sessionManager);
      if (reminder) {
        // Admission is forbidden until the one-shot marker is durable.
        this.persist(markLedgerReminderUsed(this.goal, this.now()));
      }
    }
    this.continuationPending = true;
    const objective = this.goal.objective;
    const condition = this.goal.condition;
    const reminderText = reminder
      ? `\nAdvisory ledger keys (not completion proof):\n${reminder}`
      : "";
    try {
      this.pi.sendMessage(
        {
          customType: GOAL_CONTINUATION_TYPE,
          display: true,
          content: `Continue the session goal autonomously. Objective: ${objective}. Success: ${condition}. Inspect current evidence, take the smallest useful next action, verify it, and stop this turn when no safe immediate action remains.${reminderText}`,
          details: {
            goalId: this.goal.id,
            revision: this.goal.revision,
            iteration: this.goal.iterations + 1,
            maxTurns: this.goal.maxTurns,
          },
        },
        { triggerTurn: true, deliverAs: "followUp" },
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

  private armWaiting(ctx: ExtensionContext) {
    if (!this.goal || this.goal.status !== "waiting" || this.timer) return;
    const fence = this.fence();
    const delay = waitingBackoffMs(this.goal.waitCount);
    this.timer = this.schedule(() => {
      this.timer = undefined;
      if (!fenceMatches(fence, this.epoch, this.goal)) return;
      if (!ctx.isIdle()) return;
      const goal = this.goal;
      if (!goal) return;
      this.persist(
        transitionGoal(
          goal,
          "active",
          this.now(),
          "Waiting backoff elapsed; checking for new evidence.",
        ),
      );
      this.admitContinuation(ctx);
    }, delay);
    this.timer.unref?.();
  }

  private fence(): GoalFence {
    if (!this.goal) throw new Error("No goal for fence.");
    return {
      epoch: this.epoch,
      id: this.goal.id,
      revision: this.goal.revision,
    };
  }

  private persist(candidate: GoalSnapshot) {
    const checked = validateGoalSnapshot(candidate);
    // appendEntry is synchronous; memory changes only after durable append.
    this.pi.appendEntry(GOAL_ENTRY_TYPE, checked);
    this.goal = checked;
  }

  private invalidate() {
    this.epoch++;
    this.evaluator?.abort();
    this.evaluator = undefined;
    this.evaluating = false;
    this.clearTimer();
    this.continuationPending = false;
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private assertUnlocked() {
    if (this.lockedReason) {
      throw new Error(
        `Session goal is locked by malformed branch history: ${this.lockedReason}`,
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
