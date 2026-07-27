import assert from "node:assert/strict";
import test from "node:test";
import { parseGoalCommand, statusText } from "./index.ts";
import { createGoalSnapshot } from "./state.ts";

test("goal command recognizes controls and treats other text as objective", () => {
  assert.deepEqual(parseGoalCommand(""), { action: "status" });
  assert.deepEqual(parseGoalCommand(" pause "), { action: "pause" });
  assert.deepEqual(parseGoalCommand("resume"), { action: "resume" });
  assert.deepEqual(parseGoalCommand("clear"), { action: "clear" });
  assert.deepEqual(parseGoalCommand("ship release"), {
    action: "set",
    objective: "ship release",
  });
});

test("status explains parent versus evaluator token semantics", () => {
  const goal = createGoalSnapshot(
    {
      objective: "Ship",
      condition: "Tests pass",
      tokenBudget: 1_000,
    },
    0,
    1,
    "goal_index_1",
  );
  const text = statusText({ ...goal, parentTokens: 100, evaluatorTokens: 20 });
  assert.match(text, /100\/1000 parent \+ 20 evaluator/);
  assert.match(text, /do not consume the optional parent-run budget/);
  assert.equal(statusText(undefined), "No session goal is set.");
});
