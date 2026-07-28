import assert from "node:assert/strict";
import test from "node:test";
import { createGoalSnapshot, transitionGoal } from "./state.ts";
import {
  formatGoalElapsedSeconds,
  formatTokensCompact,
  goalContinuationLabel,
  goalFooterText,
} from "./ui.ts";

const goal = {
  ...createGoalSnapshot(
    { objective: "全面检查并改进插件", tokenBudget: 50_000 },
    0,
    1,
    "goal_ui_test",
  ),
  tokensUsed: 12_500,
  timeUsedSeconds: 90,
};

test("token and elapsed-time formatting matches current Codex Goal UI", () => {
  assert.equal(formatTokensCompact(0), "0");
  assert.equal(formatTokensCompact(999), "999");
  assert.equal(formatTokensCompact(1_000), "1K");
  assert.equal(formatTokensCompact(12_500), "12.5K");
  assert.equal(formatTokensCompact(63_876), "63.9K");
  assert.equal(formatTokensCompact(100_000), "100K");
  assert.equal(formatGoalElapsedSeconds(59), "59s");
  assert.equal(formatGoalElapsedSeconds(60), "1m");
  assert.equal(formatGoalElapsedSeconds(90 * 60), "1h 30m");
  assert.equal(formatGoalElapsedSeconds(24 * 60 * 60), "1d 0h 0m");
});

test("footer never exposes the objective or legacy turn counters", () => {
  assert.equal(goalFooterText(goal), "Pursuing goal (12.5K / 50K)");
  assert.equal(
    goalFooterText({ ...goal, tokenBudget: undefined }),
    "Pursuing goal (1m)",
  );
  assert.equal(
    goalFooterText(transitionGoal(goal, "paused", 2, "pause")),
    "Goal paused (/goal resume)",
  );
  assert.equal(
    goalFooterText(transitionGoal(goal, "blocked", 2, "block")),
    "Goal blocked (/goal resume)",
  );
  assert.equal(
    goalFooterText(transitionGoal(goal, "budget_limited", 2, "budget")),
    "Goal unmet (12.5K / 50K tokens)",
  );
  assert.equal(
    goalFooterText(transitionGoal(goal, "complete", 2, "done")),
    "Goal achieved (12.5K tokens)",
  );
  assert.equal(
    goalFooterText(
      transitionGoal(
        createGoalSnapshot({ objective: "done" }, 0, 1, "goal_ui_done"),
        "complete",
        2,
        "done",
      ),
    ),
    "Goal achieved (0s)",
  );
  assert.equal(goalFooterText(goal).includes(goal.objective), false);
  assert.equal(goalFooterText(goal).includes("turn"), false);
});

test("continuation rows are one-line labels and never reveal prompt bodies", () => {
  assert.equal(
    goalContinuationLabel({
      kind: "continuation",
      content: "secret".repeat(100),
    }),
    "↻ Goal continuation",
  );
  assert.equal(
    goalContinuationLabel({ kind: "objective_updated" }),
    "↻ Goal objective updated",
  );
  assert.equal(
    goalContinuationLabel({ kind: "budget_limit" }),
    "↻ Goal budget reached",
  );
});
