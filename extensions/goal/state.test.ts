import assert from "node:assert/strict";
import test from "node:test";
import {
  GoalRestoreError,
  acknowledgeGoalCompletion,
  budgetLimitTransition,
  createGoalSnapshot,
  editGoalObjective,
  markContinuationDispatched,
  recordBlockedAudit,
  recordGoalProgress,
  restoreGoalSnapshot,
  restoreGoalState,
  setContinuationDeferred,
  transitionGoal,
  validateGoalSnapshot,
  type GoalSnapshot,
} from "./state.ts";

const NOW = 1_000_000;

function goal(overrides: Partial<GoalSnapshot> = {}) {
  const created = createGoalSnapshot(
    { objective: "Ship the feature" },
    0,
    NOW,
    "goal_test_1",
  );
  return validateGoalSnapshot({ ...created, ...overrides });
}

function entry(data: unknown, customType = "session-goal") {
  return { type: "custom", customType, data };
}

function legacy(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    revision: 3,
    id: "legacy_goal_1",
    objective: "Ship legacy feature",
    condition: "Focused tests pass",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW + 5_000,
    activeMs: 9_500,
    activeSince: NOW,
    maxTurns: 40,
    noProgressCap: 8,
    wallClockMinutes: 120,
    iterations: 4,
    parentTokens: 321,
    evaluatorTokens: 12,
    noProgressCount: 0,
    evaluatorFailures: 0,
    waitCount: 0,
    ...overrides,
  };
}

test("creates Codex-shaped v2 goals with a 4000-character objective and positive optional budget", () => {
  const created = goal();
  assert.equal(created.version, 2);
  assert.equal(created.status, "active");
  assert.equal(created.tokensUsed, 0);
  assert.equal(created.timeUsedSeconds, 0);
  assert.equal(
    createGoalSnapshot(
      { objective: "  line one\nline two  ", tokenBudget: 1 },
      0,
      NOW,
      "goal_test_2",
    ).objective,
    "line one\nline two",
  );
  assert.equal(
    createGoalSnapshot(
      { objective: "😀".repeat(4_000) },
      0,
      NOW,
      "goal_unicode_limit",
    ).objective,
    "😀".repeat(4_000),
  );
  assert.throws(
    () =>
      createGoalSnapshot(
        { objective: "x".repeat(4_001) },
        0,
        NOW,
        "goal_test_2",
      ),
    /at most 4000/,
  );
  assert.throws(
    () =>
      createGoalSnapshot(
        { objective: "x", tokenBudget: 0 },
        0,
        NOW,
        "goal_test_2",
      ),
    /positive safe integer/,
  );
  assert.throws(
    () => validateGoalSnapshot({ ...created, condition: "old" }),
    /unknown field: condition/,
  );
});

test("v1 migration pauses active work once, folds distinct success criteria, and maps terminal statuses", () => {
  const restored = restoreGoalState([entry(legacy())]);
  assert.equal(restored.migrated, true);
  assert.equal(restored.snapshot?.version, 2);
  assert.equal(restored.snapshot?.revision, 4);
  assert.equal(restored.snapshot?.status, "paused");
  assert.equal(restored.snapshot?.tokensUsed, 321);
  assert.equal(restored.snapshot?.timeUsedSeconds, 9);
  assert.match(restored.snapshot?.objective ?? "", /Success criteria:/);
  assert.match(restored.snapshot?.reason ?? "", /migrating/);

  assert.equal(
    restoreGoalSnapshot([entry(legacy({ status: "achieved" }))])?.status,
    "complete",
  );
  assert.equal(
    restoreGoalSnapshot([entry(legacy({ status: "stalled" }))])?.status,
    "blocked",
  );
  assert.equal(
    restoreGoalSnapshot([entry(legacy({ status: "max_iterations" }))])?.status,
    "budget_limited",
  );
  assert.equal(
    restoreGoalSnapshot([entry(legacy({ status: "cleared" }))]),
    undefined,
  );
});

test("restore remains branch-local, ranks by revision then position, and locks after later malformed history", () => {
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

test("progress accounting, deferral, continuation count, and token budget are durable transitions", () => {
  const budgeted = createGoalSnapshot(
    { objective: "Ship", tokenBudget: 100 },
    0,
    NOW,
    "goal_budget_1",
  );
  const progressed = recordGoalProgress(budgeted, 101, 7, NOW + 1);
  assert.equal(progressed.tokensUsed, 101);
  assert.equal(progressed.timeUsedSeconds, 7);
  assert.equal(
    budgetLimitTransition(progressed, NOW + 2)?.status,
    "budget_limited",
  );

  const deferred = setContinuationDeferred(goal(), true, NOW + 1);
  assert.equal(deferred.deferContinuation, true);
  const released = setContinuationDeferred(deferred, false, NOW + 2);
  assert.equal(released.deferContinuation, undefined);
  const dispatched = markContinuationDispatched(released, NOW + 3);
  assert.equal(dispatched.continuationCount, 1);
});

test("blocked audit validates durable current-turn state and ignores duplicate reports", () => {
  const first = recordBlockedAudit(goal(), "  Waiting for access  ", NOW + 1);
  assert.equal(first.recorded, true);
  assert.deepEqual(first.audit, {
    blocker: "Waiting for access",
    consecutiveTurns: 1,
    lastTurn: 0,
  });
  assert.equal(
    recordBlockedAudit(first.snapshot, "Waiting for access", NOW + 2).recorded,
    false,
  );
  assert.throws(
    () =>
      validateGoalSnapshot({
        ...goal(),
        blockedAudit: {
          blocker: "Waiting for access",
          consecutiveTurns: 1,
          lastTurn: 1,
        },
      }),
    /exceeds continuationCount/,
  );
  assert.throws(
    () =>
      validateGoalSnapshot({
        ...goal(),
        blockedAudit: {
          blocker: "Waiting for access",
          consecutiveTurns: 2,
          lastTurn: 0,
        },
      }),
    /exceeds elapsed goal turns/,
  );
});

test("completion acknowledgement is durable, idempotent, and complete-only", () => {
  const complete = transitionGoal(goal(), "complete", NOW + 1, "done");
  const acknowledged = acknowledgeGoalCompletion(complete, NOW + 2);
  assert.equal(acknowledged.completionAcknowledged, true);
  assert.equal(acknowledged.revision, complete.revision + 1);
  assert.deepEqual(
    acknowledgeGoalCompletion(acknowledged, NOW + 3),
    acknowledged,
  );
  assert.deepEqual(acknowledgeGoalCompletion(goal(), NOW + 1), goal());
  assert.throws(
    () =>
      validateGoalSnapshot({
        ...goal(),
        completionAcknowledged: true,
      }),
    /only a complete goal/,
  );
});

test("editing preserves running and stopped statuses but reactivates complete or budget-limited goals", () => {
  assert.equal(editGoalObjective(goal(), "new", NOW + 1).status, "active");
  assert.equal(
    editGoalObjective(
      transitionGoal(goal(), "blocked", NOW + 1, "blocked"),
      "new",
      NOW + 2,
    ).status,
    "blocked",
  );
  const acknowledgedComplete = acknowledgeGoalCompletion(
    transitionGoal(goal(), "complete", NOW + 1, "done"),
    NOW + 2,
  );
  const editedComplete = editGoalObjective(
    acknowledgedComplete,
    "new",
    NOW + 3,
  );
  assert.equal(editedComplete.status, "active");
  assert.equal(editedComplete.completionAcknowledged, undefined);
  assert.equal(
    editGoalObjective(
      transitionGoal(goal(), "budget_limited", NOW + 1, "budget"),
      "new",
      NOW + 2,
    ).status,
    "active",
  );
  const exhausted = {
    ...createGoalSnapshot(
      { objective: "old", tokenBudget: 10 },
      0,
      NOW,
      "goal_edit_budget",
    ),
    tokensUsed: 10,
    status: "budget_limited" as const,
  };
  assert.equal(
    editGoalObjective(exhausted, "new", NOW + 1).status,
    "budget_limited",
  );
});
