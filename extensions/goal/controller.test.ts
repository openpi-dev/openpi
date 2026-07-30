import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  GoalController,
  countAssistantTokens,
  lastAssistantStopReason,
} from "./controller.ts";
import { createGoalSnapshot, transitionGoal } from "./state.ts";

function harness(options: { sendMessage?: () => void } = {}) {
  const entries: { customType: string; data: unknown }[] = [];
  const messages: { message: unknown; options: unknown }[] = [];
  const pi = {
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
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

function active(now = 100, tokenBudget?: number) {
  return createGoalSnapshot(
    { objective: "Do work", tokenBudget },
    0,
    now,
    "goal_ctrl_1",
  );
}

function assistant(totalTokens: number, stopReason = "stop") {
  return {
    role: "assistant",
    usage: { totalTokens },
    stopReason,
  };
}

test("assistant accounting matches Codex non-cached input plus output and falls back for legacy usage", () => {
  assert.equal(
    countAssistantTokens([
      {
        role: "assistant",
        usage: { input: 7, output: 3, cacheRead: 90, totalTokens: 100 },
        stopReason: "stop",
      },
      { type: "message", message: assistant(8) },
      { role: "user", content: "x" },
    ]),
    18,
  );
  assert.equal(lastAssistantStopReason([assistant(1, "aborted")]), "aborted");
});

test("v2 active goals survive restore while v1 active goals migrate to a durably paused v2 state", () => {
  const h = harness();
  h.setBranch([{ type: "custom", customType: "session-goal", data: active() }]);
  const controller = new GoalController(h.pi, { now: () => 200 });
  controller.restore(h.ctx);
  assert.equal(controller.snapshot()?.status, "active");
  assert.equal(h.entries.length, 0);

  h.setBranch([
    {
      type: "custom",
      customType: "session-goal",
      data: {
        version: 1,
        revision: 1,
        id: "legacy_ctrl_1",
        objective: "Legacy work",
        condition: "Tests pass",
        status: "active",
        createdAt: 100,
        updatedAt: 100,
        activeMs: 0,
        activeSince: 100,
        maxTurns: 40,
        noProgressCap: 8,
        wallClockMinutes: 120,
        iterations: 0,
        parentTokens: 0,
        evaluatorTokens: 0,
        noProgressCount: 0,
        evaluatorFailures: 0,
        waitCount: 0,
      },
    },
  ]);
  controller.restore(h.ctx);
  assert.equal(controller.snapshot()?.status, "paused");
  assert.equal(h.entries.at(-1)?.customType, "session-goal");
  assert.equal((h.entries.at(-1)?.data as { version: number }).version, 2);
});

test("kickoff queues one Codex-style continuation without consuming usage", () => {
  const h = harness();
  h.setBranch([{ type: "custom", customType: "session-goal", data: active() }]);
  const controller = new GoalController(h.pi, { now: () => 101 });
  controller.restore(h.ctx);

  assert.equal(controller.kickoff(h.ctx), true);
  assert.equal(controller.kickoff(h.ctx), false);
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.messages[0]?.options, {
    triggerTurn: true,
    deliverAs: "followUp",
  });
  const content = (h.messages[0]?.message as { content: string }).content;
  assert.match(content, /Completion audit:/);
  assert.match(content, /call update_goal with status "complete"/);
  assert.equal(controller.snapshot()?.tokensUsed, 0);
  assert.equal(controller.snapshot()?.continuationCount, 1);
});

test("a goal created during a busy run accounts post-create work and continues after the absorbed steer", () => {
  const h = harness();
  let now = 100;
  h.setIdle(false);
  const controller = new GoalController(h.pi, { now: () => now });
  controller.restore(h.ctx);
  controller.agentStarted();
  controller.messageEnded(assistant(100));
  controller.replace(active(now));

  assert.equal(controller.kickoff(h.ctx), true);
  assert.deepEqual(h.messages[0]?.options, {
    triggerTurn: true,
    deliverAs: "steer",
  });
  now = 1_100;
  controller.messageEnded(assistant(5));
  controller.agentEnded([assistant(100), assistant(5)]);
  h.setIdle(true);
  controller.settled(h.ctx);

  assert.equal(controller.snapshot()?.tokensUsed, 5);
  assert.equal(controller.snapshot()?.timeUsedSeconds, 1);
  assert.equal(h.messages.length, 2);
  assert.deepEqual(h.messages[1]?.options, {
    triggerTurn: true,
    deliverAs: "followUp",
  });
});

test("a settled active goal accounts tokens and time then dispatches exactly one continuation", () => {
  const h = harness();
  let now = 100;
  h.setBranch([
    { type: "custom", customType: "session-goal", data: active(now) },
  ]);
  const controller = new GoalController(h.pi, { now: () => now });
  controller.restore(h.ctx);
  controller.agentStarted();
  now = 2_250;
  controller.agentEnded([assistant(25)]);
  controller.settled(h.ctx);

  assert.equal(controller.snapshot()?.tokensUsed, 25);
  assert.equal(controller.snapshot()?.timeUsedSeconds, 2);
  assert.equal(controller.snapshot()?.status, "active");
  assert.equal(h.messages.length, 1);
  controller.settled(h.ctx);
  assert.equal(h.messages.length, 1);
});

test("user interruption pauses, provider errors block, usage errors limit, and overflow retry aborts do neither", () => {
  for (const [reason, expected] of [
    ["aborted", "paused"],
    ["error", "blocked"],
  ] as const) {
    const h = harness();
    let now = 100;
    h.setBranch([
      { type: "custom", customType: "session-goal", data: active() },
    ]);
    const controller = new GoalController(h.pi, { now: () => now });
    controller.restore(h.ctx);
    controller.agentStarted();
    now = 200;
    controller.agentEnded([assistant(1, reason)]);
    controller.settled(h.ctx);
    assert.equal(controller.snapshot()?.status, expected);
    assert.equal(h.messages.length, 0);
  }

  const usage = harness();
  let now = 100;
  usage.setBranch([
    { type: "custom", customType: "session-goal", data: active() },
  ]);
  const usageController = new GoalController(usage.pi, { now: () => now });
  usageController.restore(usage.ctx);
  usageController.agentStarted();
  usageController.agentEnded([
    {
      ...assistant(1, "error"),
      errorMessage: "You have hit your usage limit.",
    },
  ]);
  usageController.settled(usage.ctx);
  assert.equal(usageController.snapshot()?.status, "usage_limited");

  const retry = harness();
  now = 100;
  retry.setBranch([
    { type: "custom", customType: "session-goal", data: active() },
  ]);
  const controller = new GoalController(retry.pi, { now: () => now });
  controller.restore(retry.ctx);
  controller.agentStarted();
  controller.agentEnded([assistant(1, "aborted")]);
  controller.compacted(true);
  now = 200;
  controller.settled(retry.ctx);
  assert.equal(controller.snapshot()?.status, "active");
  assert.equal(retry.messages.length, 1);
});

test("crossing a token budget marks the goal limited and sends only a wrap-up turn", () => {
  const h = harness();
  let now = 100;
  h.setBranch([
    {
      type: "custom",
      customType: "session-goal",
      data: active(now, 10),
    },
  ]);
  const controller = new GoalController(h.pi, { now: () => now });
  controller.restore(h.ctx);
  controller.agentStarted();
  controller.messageEnded(assistant(12));
  now = 200;
  controller.toolFinished(h.ctx);

  assert.equal(controller.snapshot()?.status, "budget_limited");
  assert.equal(h.messages.length, 1);
  assert.match(
    (h.messages[0]?.message as { content: string }).content,
    /do not start new substantive work/,
  );
  controller.agentEnded([assistant(12)]);
  controller.settled(h.ctx);
  controller.agentStarted();
  controller.agentEnded([assistant(5)]);
  controller.settled(h.ctx);
  assert.equal(h.messages.length, 1);
});

test("editing uses a plain continuation when idle and objective-updated steering while busy", () => {
  const idle = harness();
  idle.setBranch([
    { type: "custom", customType: "session-goal", data: active() },
  ]);
  const idleController = new GoalController(idle.pi, { now: () => 101 });
  idleController.restore(idle.ctx);
  idleController.edit("new idle objective", idle.ctx);
  assert.equal(
    (idle.messages[0]?.message as { details: { kind: string } }).details.kind,
    "continuation",
  );

  const busy = harness();
  busy.setIdle(false);
  busy.setBranch([
    { type: "custom", customType: "session-goal", data: active() },
  ]);
  const busyController = new GoalController(busy.pi, { now: () => 101 });
  busyController.restore(busy.ctx);
  busyController.agentStarted();
  busyController.edit("new busy objective", busy.ctx);
  assert.equal(
    (busy.messages[0]?.message as { details: { kind: string } }).details.kind,
    "objective_updated",
  );
});

test("busy editing a complete goal tracks only post-edit work and keeps the loop running", () => {
  const h = harness();
  let now = 100;
  h.setIdle(false);
  h.setBranch([
    {
      type: "custom",
      customType: "session-goal",
      data: transitionGoal(active(98), "complete", 99, "done"),
    },
  ]);
  const controller = new GoalController(h.pi, { now: () => now });
  controller.restore(h.ctx);
  controller.agentStarted();
  controller.messageEnded(assistant(100));

  controller.edit("revived objective", h.ctx);
  now = 1_100;
  controller.messageEnded(assistant(5));
  controller.agentEnded([assistant(100), assistant(5)]);
  h.setIdle(true);
  controller.settled(h.ctx);

  assert.equal(controller.snapshot()?.status, "active");
  assert.equal(controller.snapshot()?.tokensUsed, 5);
  assert.equal(controller.snapshot()?.timeUsedSeconds, 1);
  assert.equal(h.messages.length, 2);
  assert.equal(
    (h.messages[0]?.message as { details: { kind: string } }).details.kind,
    "objective_updated",
  );
  assert.equal(
    (h.messages[1]?.message as { details: { kind: string } }).details.kind,
    "continuation",
  );
});

test("completion acknowledgement follows a tagged user message and persists after it", () => {
  const h = harness();
  const complete = transitionGoal(active(98), "complete", 99, "done");
  h.setBranch([{ type: "custom", customType: "session-goal", data: complete }]);
  const controller = new GoalController(h.pi, { now: () => 100 });
  controller.restore(h.ctx);

  const transformed = controller.prepareExplicitInput();
  assert.equal(transformed?.mimeType, "application/x-pi-goal-completion-ack");
  assert.equal(controller.footerSnapshot()?.completionAcknowledged, undefined);
  assert.equal(h.entries.length, 0);

  const result = controller.messageEnded({
    role: "user",
    content: [{ type: "text", text: "next" }, transformed],
  });
  assert.deepEqual((result?.message as any).content, [
    { type: "text", text: "next" },
  ]);
  assert.equal(controller.footerSnapshot()?.completionAcknowledged, true);
  assert.equal(h.entries.length, 0);
  controller.turnEnded();
  assert.equal(controller.snapshot()?.completionAcknowledged, true);
  assert.equal(h.entries.length, 1);
});

test("handled explicit input does not acknowledge a later extension user message", () => {
  const h = harness();
  h.setBranch([
    {
      type: "custom",
      customType: "session-goal",
      data: transitionGoal(active(98), "complete", 99, "done"),
    },
  ]);
  const controller = new GoalController(h.pi, { now: () => 100 });
  controller.restore(h.ctx);
  controller.prepareExplicitInput();

  assert.equal(
    controller.messageEnded({ role: "user", content: "extension kickoff" }),
    undefined,
  );
  assert.equal(controller.footerSnapshot()?.completionAcknowledged, undefined);
  assert.equal(h.entries.length, 0);
  const stale = controller.prepareExplicitInput();
  controller.settledWithoutAcknowledgement();
  const fresh = controller.prepareExplicitInput();
  const resubmitted = controller.messageEnded({
    role: "user",
    content: [{ type: "text", text: "dequeued" }, stale, fresh],
  });
  assert.equal(resubmitted?.footerChanged, true);
  assert.deepEqual((resubmitted?.message as any).content, [
    { type: "text", text: "dequeued" },
  ]);
});

test("an extension-reinjected tagged input cannot acknowledge after its correlation settles", () => {
  const h = harness();
  h.setBranch([
    {
      type: "custom",
      customType: "session-goal",
      data: transitionGoal(active(98), "complete", 99, "done"),
    },
  ]);
  const controller = new GoalController(h.pi, { now: () => 100 });
  controller.restore(h.ctx);
  const intercepted = controller.prepareExplicitInput();
  const sanitized = controller.sanitizeCompletionMarkerImages([intercepted!]);
  assert.equal(sanitized.changed, true);
  assert.deepEqual(sanitized.images, []);

  const result = controller.messageEnded({
    role: "user",
    content: [{ type: "text", text: "handled then reinjected" }, intercepted],
  });
  assert.deepEqual((result?.message as any).content, [
    { type: "text", text: "handled then reinjected" },
  ]);
  assert.equal(result?.footerChanged, false);
  assert.equal(controller.footerSnapshot()?.completionAcknowledged, undefined);
});

test("fork deferral survives restore until explicit input releases it", () => {
  const h = harness();
  h.setBranch([{ type: "custom", customType: "session-goal", data: active() }]);
  const controller = new GoalController(h.pi, { now: () => 101 });
  controller.restore(h.ctx, true);
  assert.equal(controller.snapshot()?.deferContinuation, true);
  assert.equal(controller.kickoff(h.ctx), false);
  assert.equal(controller.releaseDeferredContinuation(), true);
  assert.equal(controller.snapshot()?.deferContinuation, undefined);
  assert.equal(controller.kickoff(h.ctx), true);
});

test("model completion flushes current assistant usage into its tool result without double accounting", () => {
  const h = harness();
  let now = 100;
  h.setBranch([{ type: "custom", customType: "session-goal", data: active() }]);
  const controller = new GoalController(h.pi, { now: () => now });
  controller.restore(h.ctx);
  controller.agentStarted();
  const finalAssistant = {
    role: "assistant",
    usage: { input: 7, output: 2, cacheRead: 90, totalTokens: 99 },
    stopReason: "stop",
  };
  now = 1_100;
  controller.messageEnded(finalAssistant);
  controller.updateFromModel("complete");
  assert.equal(controller.snapshot()?.tokensUsed, 9);
  assert.equal(controller.snapshot()?.timeUsedSeconds, 1);

  controller.agentEnded([finalAssistant]);
  now = 1_300;
  controller.settled(h.ctx);
  assert.equal(controller.snapshot()?.status, "complete");
  assert.equal(controller.snapshot()?.tokensUsed, 9);
  assert.equal(controller.snapshot()?.timeUsedSeconds, 1);
  assert.equal(h.messages.length, 0);
});

test("blocked reports require the same blocker on three consecutive distinct goal turns", () => {
  const h = harness();
  let now = 100;
  h.setBranch([
    {
      type: "custom",
      customType: "session-goal",
      data: { ...active(now), continuationCount: 100 },
    },
  ]);
  const controller = new GoalController(h.pi, { now: () => now });
  controller.restore(h.ctx);

  const first = controller.updateFromModel(
    "blocked",
    "Missing production access",
  );
  assert.equal(first.goal.status, "active");
  assert.deepEqual(first.blockedAudit, {
    blocker: "Missing production access",
    consecutiveTurns: 1,
    requiredTurns: 3,
    accepted: false,
  });
  assert.match(first.message, /goal remains active/);
  assert.equal(controller.snapshot()?.blockedAudit?.lastTurn, 100);

  const duplicate = controller.updateFromModel(
    "blocked",
    "Missing production access",
  );
  assert.equal(duplicate.blockedAudit?.consecutiveTurns, 1);
  assert.equal(controller.snapshot()?.revision, 2);

  controller.agentStarted();
  now = 101;
  controller.agentEnded([assistant(1)]);
  controller.settled(h.ctx);
  const second = controller.updateFromModel(
    "blocked",
    "Missing production access",
  );
  assert.equal(second.goal.status, "active");
  assert.equal(second.blockedAudit?.consecutiveTurns, 2);

  controller.agentStarted();
  now = 102;
  controller.agentEnded([assistant(1)]);
  controller.settled(h.ctx);
  const third = controller.updateFromModel(
    "blocked",
    "Missing production access",
  );
  assert.equal(third.goal.status, "blocked");
  assert.equal(third.blockedAudit?.accepted, true);
  assert.equal(h.messages.length, 2);
});

test("a different or unreported blocker resets the blocked audit", () => {
  const h = harness();
  let now = 100;
  h.setBranch([
    { type: "custom", customType: "session-goal", data: active(now) },
  ]);
  const controller = new GoalController(h.pi, { now: () => now });
  controller.restore(h.ctx);

  controller.updateFromModel("blocked", "Missing API credential");
  controller.agentStarted();
  now = 101;
  controller.agentEnded([assistant(1)]);
  controller.settled(h.ctx);
  const different = controller.updateFromModel(
    "blocked",
    "Service is unavailable",
  );
  assert.equal(different.blockedAudit?.consecutiveTurns, 1);

  controller.agentStarted();
  now = 102;
  controller.agentEnded([assistant(1)]);
  controller.settled(h.ctx);
  controller.agentStarted();
  now = 103;
  controller.agentEnded([assistant(1)]);
  controller.settled(h.ctx);
  assert.equal(controller.snapshot()?.blockedAudit, undefined);
});

test("the durable blocked audit survives reload and starts fresh after resume", () => {
  const h = harness();
  let now = 100;
  h.setBranch([
    {
      type: "custom",
      customType: "session-goal",
      data: { ...active(now), continuationCount: 50 },
    },
  ]);
  const firstController = new GoalController(h.pi, { now: () => now });
  firstController.restore(h.ctx);
  firstController.updateFromModel("blocked", "Waiting for approval");
  const persisted = h.entries.at(-1)?.data;
  assert.ok(persisted);

  const resumedHarness = harness();
  resumedHarness.setBranch([
    { type: "custom", customType: "session-goal", data: persisted },
  ]);
  const controller = new GoalController(resumedHarness.pi, { now: () => now });
  controller.restore(resumedHarness.ctx);
  controller.agentStarted();
  now = 101;
  controller.agentEnded([assistant(1)]);
  controller.settled(resumedHarness.ctx);
  assert.equal(
    controller.updateFromModel("blocked", "Waiting for approval").blockedAudit
      ?.consecutiveTurns,
    2,
  );

  const blocked = transitionGoal(
    controller.snapshot()!,
    "blocked",
    102,
    "Waiting for approval",
  );
  resumedHarness.setBranch([
    { type: "custom", customType: "session-goal", data: blocked },
  ]);
  const afterBlocked = new GoalController(resumedHarness.pi, {
    now: () => 103,
  });
  afterBlocked.restore(resumedHarness.ctx);
  assert.equal(afterBlocked.resume()?.blockedAudit, undefined);
});

test("model blocking cannot demote a budget-limited goal", () => {
  const h = harness();
  h.setBranch([
    {
      type: "custom",
      customType: "session-goal",
      data: transitionGoal(active(), "budget_limited", 101, "budget"),
    },
  ]);
  const controller = new GoalController(h.pi, { now: () => 102 });
  controller.restore(h.ctx);
  assert.equal(
    controller.updateFromModel("blocked", "An unrelated blocker").goal.status,
    "budget_limited",
  );
  assert.equal(h.entries.length, 0);
});

test("resume accepts paused, blocked, and usage-limited but not budget-limited", () => {
  for (const status of ["paused", "blocked", "usage_limited"] as const) {
    const h = harness();
    h.setBranch([
      {
        type: "custom",
        customType: "session-goal",
        data: transitionGoal(active(), status, 101, status),
      },
    ]);
    const controller = new GoalController(h.pi, { now: () => 102 });
    controller.restore(h.ctx);
    assert.equal(controller.resume()?.status, "active");
  }

  const h = harness();
  h.setBranch([
    {
      type: "custom",
      customType: "session-goal",
      data: transitionGoal(active(), "budget_limited", 101, "budget"),
    },
  ]);
  const controller = new GoalController(h.pi, { now: () => 102 });
  controller.restore(h.ctx);
  assert.throws(() => controller.resume(), /cannot resume/);
});

test("failed continuation dispatch durably pauses the active goal", () => {
  const h = harness({
    sendMessage() {
      throw new Error("dispatch failed");
    },
  });
  h.setBranch([{ type: "custom", customType: "session-goal", data: active() }]);
  const controller = new GoalController(h.pi, { now: () => 101 });
  controller.restore(h.ctx);
  assert.throws(() => controller.kickoff(h.ctx), /dispatch failed/);
  assert.equal(controller.snapshot()?.status, "paused");
});
