import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  GoalController,
  countAssistantTokens,
  fenceMatches,
  waitingBackoffMs,
} from "./controller.ts";
import { createGoalSnapshot, transitionGoal } from "./state.ts";

function harness(options: { sendMessage?: () => void } = {}) {
  const entries: unknown[] = [];
  const messages: unknown[] = [];
  const pi = {
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message: unknown, sendOptions: unknown) {
      options.sendMessage?.();
      messages.push({ message, options: sendOptions });
    },
  } as unknown as ExtensionAPI;
  let branch: unknown[] = [];
  let idle = true;
  const ctx = {
    mode: "tui",
    isIdle: () => idle,
    sessionManager: { getBranch: () => branch },
  } as unknown as ExtensionContext;
  return {
    pi,
    ctx,
    entries,
    messages,
    setBranch(value: unknown[]) {
      branch = value;
    },
    setIdle(value: boolean) {
      idle = value;
    },
  };
}

function active(now = 100) {
  return createGoalSnapshot(
    { objective: "Do work", condition: "Tests pass" },
    0,
    now,
    "goal_ctrl_1",
  );
}

test("wait backoff is exponential and capped", () => {
  assert.equal(waitingBackoffMs(1), 5_000);
  assert.equal(waitingBackoffMs(2), 10_000);
  assert.equal(waitingBackoffMs(20), 300_000);
});

test("fence includes epoch, id, and revision", () => {
  const goal = active();
  const fence = { epoch: 3, id: goal.id, revision: goal.revision };
  assert.equal(fenceMatches(fence, 3, goal), true);
  assert.equal(fenceMatches(fence, 4, goal), false);
  assert.equal(fenceMatches(fence, 3, { ...goal, revision: 2 }), false);
  assert.equal(fenceMatches(fence, 3, { ...goal, id: "goal_ctrl_2" }), false);
});

test("parent token accounting uses only reliable assistant usage after baseline", () => {
  const message = (role: string, tokens?: number) => ({
    type: "message",
    message: {
      role,
      ...(tokens === undefined ? {} : { usage: { totalTokens: tokens } }),
    },
  });
  assert.equal(
    countAssistantTokens(
      [
        message("assistant", 99),
        message("user"),
        message("assistant", 12),
        message("assistant"),
      ],
      1,
    ),
    12,
  );
  assert.equal(countAssistantTokens([], 1), 0);
});

test("restore demotes running goal persist-before-memory and print mode stays inert", async () => {
  const h = harness();
  h.setBranch([{ type: "custom", customType: "session-goal", data: active() }]);
  const controller = new GoalController(h.pi, {
    now: () => 200,
    evaluate: async () => {
      throw new Error("must not run");
    },
  });
  controller.restore(h.ctx, true);
  assert.equal(controller.snapshot()?.status, "paused");
  assert.equal(h.entries.length, 1);

  const print = { ...h.ctx, mode: "print" } as ExtensionContext;
  controller.restore(print, false);
  await controller.settled(print);
  assert.equal(h.messages.length, 0);
});

test("kickoff immediately starts the first worker without judging or consuming a turn", async () => {
  const h = harness();
  let evaluations = 0;
  h.setBranch([{ type: "custom", customType: "session-goal", data: active() }]);
  const controller = new GoalController(h.pi, {
    now: () => 101,
    evaluate: async () => {
      evaluations++;
      throw new Error("the setup action is not worker evidence");
    },
  });
  controller.restore(h.ctx, false);

  assert.equal(controller.kickoff(h.ctx), true);
  assert.equal(controller.kickoff(h.ctx), false);
  assert.equal(h.messages.length, 1);
  assert.equal(controller.snapshot()?.iterations, 0);
  assert.equal(evaluations, 0);
  assert.equal(
    (
      h.messages[0] as { message: { content: string } }
    ).message.content.includes("Objective: Do work"),
    true,
  );
});

test("kickoff during goal_set queues a follow-up and never judges the setup run", async () => {
  const h = harness();
  let evaluations = 0;
  h.setIdle(false);
  const goal = active();
  const goalEntry = { type: "custom", customType: "session-goal", data: goal };
  const assistantEntry = (tokens: number) => ({
    type: "message",
    message: { role: "assistant", usage: { totalTokens: tokens } },
  });
  h.setBranch([goalEntry]);
  const controller = new GoalController(h.pi, {
    now: () => 101,
    evaluate: async () => {
      evaluations++;
      return {
        judge: {
          met: false,
          impossible: false,
          progress: true,
          waiting: false,
          reason: "worker made progress",
        },
        tokens: 1,
      };
    },
  });
  controller.restore(h.ctx, false);

  assert.equal(controller.kickoff(h.ctx), true);
  assert.equal(h.messages.length, 1);
  assert.deepEqual((h.messages[0] as { options: unknown }).options, {
    triggerTurn: true,
    deliverAs: "followUp",
  });
  h.setIdle(true);
  h.setBranch([goalEntry, assistantEntry(999)]);
  await controller.settled(h.ctx);
  assert.equal(h.messages.length, 1);
  assert.equal(controller.snapshot()?.iterations, 0);
  assert.equal(controller.snapshot()?.parentTokens, 0);
  assert.equal(evaluations, 0);

  controller.beforeAgentStart(h.ctx);
  h.setBranch([goalEntry, assistantEntry(999), assistantEntry(5)]);
  await controller.settled(h.ctx);
  assert.equal(controller.snapshot()?.iterations, 1);
  assert.equal(controller.snapshot()?.parentTokens, 5);
  assert.equal(evaluations, 1);
  assert.equal(h.messages.length, 2);
});

test("resume plus kickoff immediately authorizes the next autonomous turn", () => {
  const h = harness();
  h.setIdle(false);
  h.setBranch([
    {
      type: "custom",
      customType: "session-goal",
      data: transitionGoal(active(), "paused", 101, "restored"),
    },
  ]);
  const controller = new GoalController(h.pi, { now: () => 102 });
  controller.restore(h.ctx, false);

  assert.equal(controller.resume()?.status, "active");
  assert.equal(controller.kickoff(h.ctx), true);
  assert.equal(h.messages.length, 1);
  assert.deepEqual((h.messages[0] as { options: unknown }).options, {
    triggerTurn: true,
    deliverAs: "followUp",
  });
});

test("kickoff remains inert outside TUI/RPC automation and enforces hard limits", () => {
  const printHarness = harness();
  printHarness.setBranch([
    { type: "custom", customType: "session-goal", data: active() },
  ]);
  const printController = new GoalController(printHarness.pi, {
    now: () => 101,
  });
  printController.restore(
    { ...printHarness.ctx, mode: "print" } as ExtensionContext,
    false,
  );
  assert.equal(printController.kickoff(printHarness.ctx), false);
  assert.equal(printHarness.messages.length, 0);

  const limitedHarness = harness();
  limitedHarness.setBranch([
    {
      type: "custom",
      customType: "session-goal",
      data: { ...active(), iterations: 40 },
    },
  ]);
  const limitedController = new GoalController(limitedHarness.pi, {
    now: () => 101,
  });
  limitedController.restore(limitedHarness.ctx, false);
  assert.equal(limitedController.kickoff(limitedHarness.ctx), false);
  assert.equal(limitedController.snapshot()?.status, "max_iterations");
  assert.equal(limitedHarness.messages.length, 0);
});

test("a failed kickoff dispatch persists a paused state", () => {
  const h = harness({
    sendMessage() {
      throw new Error("dispatch failed");
    },
  });
  h.setBranch([{ type: "custom", customType: "session-goal", data: active() }]);
  const controller = new GoalController(h.pi, { now: () => 101 });
  controller.restore(h.ctx, false);

  assert.throws(() => controller.kickoff(h.ctx), /dispatch failed/);
  assert.equal(controller.snapshot()?.status, "paused");
  assert.match(controller.snapshot()?.reason ?? "", /could not be dispatched/);
  assert.equal(h.messages.length, 0);
});

test("successful judge admits at most one follow-up and writes ledger reminder marker first", async () => {
  const h = harness();
  const goal = active();
  h.setBranch([
    { type: "custom", customType: "session-goal", data: goal },
    {
      type: "custom",
      customType: "task-ledger",
      data: {
        version: 1,
        revision: 1,
        nextId: 2,
        items: [{ id: 1, subject: "Run focused tests", status: "pending" }],
      },
    },
  ]);
  const controller = new GoalController(h.pi, {
    now: (() => {
      let now = 100;
      return () => ++now;
    })(),
    evaluate: async () => ({
      judge: {
        met: false,
        impossible: false,
        progress: true,
        waiting: false,
        reason: "progress",
      },
      tokens: 7,
    }),
  });
  controller.restore(h.ctx, false);
  controller.beforeAgentStart(h.ctx);
  await controller.settled(h.ctx);
  assert.equal(h.messages.length, 1);
  assert.equal(controller.snapshot()?.ledgerReminderUsed, true);
  const reminderEntry = h.entries.findIndex(
    (entry) =>
      (entry as { data?: { ledgerReminderUsed?: boolean } }).data
        ?.ledgerReminderUsed === true,
  );
  assert.equal(reminderEntry >= 0, true);
  assert.equal(
    (
      h.messages[0] as { message: { content: string } }
    ).message.content.includes("T1"),
    true,
  );
  await controller.settled(h.ctx);
  assert.equal(h.messages.length, 1);
});

test("extension-triggered continuation runs settle and continue again", async () => {
  const h = harness();
  h.setBranch([{ type: "custom", customType: "session-goal", data: active() }]);
  const controller = new GoalController(h.pi, {
    now: (() => {
      let now = 100;
      return () => ++now;
    })(),
    evaluate: async () => ({
      judge: {
        met: false,
        impossible: false,
        progress: true,
        waiting: false,
        reason: "more work remains",
      },
      tokens: 1,
    }),
  });
  controller.restore(h.ctx, false);

  // This boundary represents agent_start, which fires for both ordinary and
  // extension-triggered runs (unlike before_agent_start).
  controller.beforeAgentStart(h.ctx);
  await controller.settled(h.ctx);
  assert.equal(h.messages.length, 1);
  assert.equal(controller.snapshot()?.iterations, 1);

  controller.beforeAgentStart(h.ctx);
  await controller.settled(h.ctx);
  assert.equal(h.messages.length, 2);
  assert.equal(controller.snapshot()?.iterations, 2);
});

test("new run invalidates stale evaluator and wakes waiting goal", async () => {
  const h = harness();
  let resolveEvaluation!: (value: {
    judge: {
      met: boolean;
      impossible: boolean;
      progress: boolean;
      waiting: boolean;
      reason: string;
    };
    tokens: number;
  }) => void;
  const controller = new GoalController(h.pi, {
    now: (() => {
      let now = 100;
      return () => ++now;
    })(),
    evaluate: () => new Promise((resolve) => (resolveEvaluation = resolve)),
  });
  h.setBranch([{ type: "custom", customType: "session-goal", data: active() }]);
  controller.restore(h.ctx, false);
  controller.beforeAgentStart(h.ctx);
  const settling = controller.settled(h.ctx);
  controller.beforeAgentStart(h.ctx);
  resolveEvaluation({
    judge: {
      met: true,
      impossible: false,
      progress: true,
      waiting: false,
      reason: "stale",
    },
    tokens: 1,
  });
  await settling;
  assert.notEqual(controller.snapshot()?.status, "achieved");

  const waiting = transitionGoal(
    controller.snapshot()!,
    "waiting",
    102,
    "wait",
  );
  controller.replace(waiting);
  controller.beforeAgentStart(h.ctx);
  assert.equal(controller.snapshot()?.status, "active");
});

test("three evaluator failures pause without changing stall count", async () => {
  const h = harness();
  h.setBranch([{ type: "custom", customType: "session-goal", data: active() }]);
  const controller = new GoalController(h.pi, {
    now: (() => {
      let now = 100;
      return () => ++now;
    })(),
    evaluate: async () => {
      throw new Error("judge unavailable");
    },
  });
  controller.restore(h.ctx, false);
  for (let index = 0; index < 3; index++) {
    controller.beforeAgentStart(h.ctx);
    await controller.settled(h.ctx);
  }
  assert.equal(controller.snapshot()?.status, "paused");
  assert.equal(controller.snapshot()?.noProgressCount, 0);
  assert.equal(controller.snapshot()?.evaluatorFailures, 3);
});
