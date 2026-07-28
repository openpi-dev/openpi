import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createGoalSnapshot } from "./state.ts";
import { compactGoal, goalContinuationLabel } from "./ui.ts";

const goal = createGoalSnapshot(
  {
    objective: "全面检查并改进插件".repeat(40),
    condition: "对比报告落盘并且所有聚焦测试通过",
  },
  0,
  1,
  "goal_ui_test",
);

test("live goal status stays on one bounded terminal line", () => {
  const status = `Goal: ${compactGoal(goal)}`;
  assert.equal(status.includes("\n"), false);
  assert.equal(visibleWidth(status) <= 80, true);
  assert.equal(status.includes("…"), true);
});

test("continuation label never renders the prompt body", () => {
  assert.equal(
    goalContinuationLabel({
      iteration: 3,
      maxTurns: 40,
      content: "secret long prompt".repeat(100),
    }),
    "↻ Goal continuation · turn 3/40",
  );
  assert.equal(goalContinuationLabel(undefined), "↻ Goal continuation");
});
