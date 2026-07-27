import assert from "node:assert/strict";
import test from "node:test";
import {
  GoalRestoreError,
  applyGoalJudge,
  createGoalSnapshot,
  hardLimitTransition,
  markLedgerReminderUsed,
  recordEvaluatorFailure,
  recordGoalSettlement,
  restoreGoalSnapshot,
  transitionGoal,
  validateGoalSnapshot,
  type GoalSnapshot,
} from "./state.ts";

const NOW = 1_000_000;

function goal(overrides: Partial<GoalSnapshot> = {}) {
  const created = createGoalSnapshot(
    {
      objective: "Ship the feature",
      condition: "All focused tests pass",
      maxTurns: 40,
      noProgressCap: 8,
      wallClockMinutes: 120,
    },
    0,
    NOW,
    "goal_test_1",
  );
  return validateGoalSnapshot({ ...created, ...overrides });
}

function entry(data: unknown, customType = "session-goal") {
  return {
    type: "custom",
    id: Math.random().toString(16),
    parentId: null,
    timestamp: new Date(0).toISOString(),
    customType,
    data,
  };
}

test("creates exact bounded defaults and rejects invalid text and limits", () => {
  const created = goal();
  assert.equal(created.status, "active");
  assert.equal(created.maxTurns, 40);
  assert.equal(created.noProgressCap, 8);
  assert.equal(created.wallClockMinutes, 120);
  assert.equal(
    createGoalSnapshot(
      { objective: "ship\tthe\nfeature", condition: "tests\r\npass" },
      0,
      NOW,
      "goal_test_2",
    ).objective,
    "ship the feature",
  );
  assert.throws(
    () =>
      createGoalSnapshot(
        { objective: "x", condition: "y", maxTurns: 201 },
        0,
        NOW,
        "goal_test_2",
      ),
    /exceeds 200/,
  );
  assert.throws(
    () =>
      createGoalSnapshot(
        { objective: "x", condition: "y", tokenBudget: 999 },
        0,
        NOW,
        "goal_test_2",
      ),
    /at least 1000/,
  );
  assert.throws(
    () => validateGoalSnapshot({ ...created, extra: true }),
    /unknown field/,
  );
});

test("restore is branch-local, chooses highest revision, resolves ties late, and locks on later malformed", () => {
  const first = goal();
  const second = transitionGoal(first, "paused", NOW + 1, "pause");
  assert.equal(
    restoreGoalSnapshot([entry(second), entry(first)])?.revision,
    second.revision,
  );
  const tie = { ...second, reason: "later tie" };
  assert.equal(
    restoreGoalSnapshot([entry(second), entry(tie)])?.reason,
    "later tie",
  );
  assert.equal(
    restoreGoalSnapshot([
      entry(first),
      entry({ ...second, revision: 99 }, "foreign"),
    ])?.revision,
    first.revision,
  );
  assert.throws(
    () => restoreGoalSnapshot([entry(first), entry({ nope: true })]),
    GoalRestoreError,
  );
  assert.throws(
    () =>
      restoreGoalSnapshot([
        entry(first),
        entry({ ...first, revision: 9, objective: "" }),
      ]),
    /winning goal revision 9 is malformed/,
  );
});

test("settlement, judge transitions, stall cap, and evaluator failure neutrality", () => {
  const settled = recordGoalSettlement(goal(), 120, NOW + 1);
  assert.equal(settled.iterations, 1);
  assert.equal(settled.parentTokens, 120);

  const progress = applyGoalJudge(
    { ...settled, noProgressCount: 4 },
    {
      met: false,
      impossible: false,
      progress: true,
      waiting: false,
      reason: "Useful change landed",
    },
    30,
    NOW + 2,
  );
  assert.equal(progress.noProgressCount, 0);
  assert.equal(progress.evaluatorTokens, 30);

  const stalled = applyGoalJudge(
    { ...progress, noProgressCount: progress.noProgressCap - 1 },
    {
      met: false,
      impossible: false,
      progress: false,
      waiting: false,
      reason: "No observable movement",
    },
    1,
    NOW + 3,
  );
  assert.equal(stalled.status, "stalled");

  const failed1 = recordEvaluatorFailure(progress, NOW + 4);
  assert.equal(failed1.noProgressCount, progress.noProgressCount);
  assert.equal(failed1.iterations, progress.iterations);
  const failed2 = recordEvaluatorFailure(failed1, NOW + 5);
  const failed3 = recordEvaluatorFailure(failed2, NOW + 6);
  assert.equal(failed3.status, "paused");
  assert.equal(failed3.evaluatorFailures, 3);
});

test("hard limits dominate and active wall clock excludes paused time", () => {
  const maxed = { ...goal(), iterations: 40 };
  assert.equal(hardLimitTransition(maxed, NOW + 1)?.status, "max_iterations");

  const budgeted = createGoalSnapshot(
    {
      objective: "x",
      condition: "y",
      tokenBudget: 1_000,
    },
    0,
    NOW,
    "goal_budget",
  );
  assert.equal(
    hardLimitTransition({ ...budgeted, parentTokens: 1_000 }, NOW + 1)?.status,
    "budget_limited",
  );

  const short = createGoalSnapshot(
    {
      objective: "x",
      condition: "y",
      wallClockMinutes: 1,
    },
    0,
    NOW,
    "goal_clock_1",
  );
  assert.equal(
    hardLimitTransition(short, NOW + 60_000)?.status,
    "budget_limited",
  );
  const paused = transitionGoal(short, "paused", NOW + 30_000, "pause");
  const resumed = transitionGoal(paused, "active", NOW + 90_000, "resume");
  assert.equal(hardLimitTransition(resumed, NOW + 119_999), undefined);
});

test("ledger reminder marker is one-shot", () => {
  const first = markLedgerReminderUsed(goal(), NOW + 1);
  const second = markLedgerReminderUsed(first, NOW + 2);
  assert.equal(first.ledgerReminderUsed, true);
  assert.equal(second.revision, first.revision);
});
