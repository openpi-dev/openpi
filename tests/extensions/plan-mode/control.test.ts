import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import planMode, {
  PLAN_MODE_STATE_ENTRY,
} from "../../../extensions/plan-mode/index.ts";
import {
  controlPlan,
  projectPlanControl,
} from "../../../extensions/plan-mode/control.ts";

function harness() {
  const branch: Array<Record<string, unknown>> = [];
  const handlers = new Map<
    string,
    (event: never, ctx: ExtensionContext) => unknown
  >();
  const messages: unknown[] = [];
  let failAppend = false;
  let busy = false;
  const ctx = {
    hasUI: false,
    isIdle: () => !busy,
    sessionManager: { getBranch: () => branch },
    ui: { notify() {}, setStatus() {} },
  } as unknown as ExtensionContext;
  planMode({
    registerTool() {},
    registerCommand() {},
    getActiveTools: () => [],
    setActiveTools() {},
    events: { emit() {} },
    on: (
      name: string,
      handler: (event: never, ctx: ExtensionContext) => unknown,
    ) => handlers.set(name, handler),
    appendEntry(customType: string, data: unknown) {
      if (failAppend) throw new Error("disk failure");
      branch.push({
        type: "custom",
        customType,
        data,
        id: `entry-${branch.length}`,
      });
    },
    sendMessage(message: unknown) {
      messages.push(message);
    },
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: unknown = {}) =>
    handlers.get(name)?.(event as never, ctx);
  emit("session_start");
  return {
    branch,
    ctx,
    emit,
    messages,
    setBusy: (value: boolean) => {
      busy = value;
    },
    failAppend: () => {
      failAppend = true;
    },
    set: (
      enabled: boolean,
      expectedRevision = projectPlanControl(branch).revision,
    ) =>
      controlPlan(ctx.sessionManager, {
        action: "mode",
        enabled,
        expectedRevision,
      }),
    prepare: (expectedRevision = projectPlanControl(branch).revision) =>
      controlPlan(ctx.sessionManager, {
        action: "prepare",
        expectedRevision,
      }),
    authorize: (
      prompt: string,
      expectedRevision = projectPlanControl(branch).revision,
    ) =>
      controlPlan(ctx.sessionManager, {
        action: "authorize",
        expectedRevision,
        prompt,
      }),
    implement: (expectedRevision = projectPlanControl(branch).revision) =>
      controlPlan(ctx.sessionManager, {
        action: "implement",
        expectedRevision,
      }),
    cancel: (expectedRevision = projectPlanControl(branch).revision) =>
      controlPlan(ctx.sessionManager, { action: "cancel", expectedRevision }),
  };
}

test("mode-only control persists and gates tools without sending a model turn; restores and cleans up", () => {
  const h = harness();
  const on = h.set(true);
  assert.equal(on.status, "planning");
  assert.equal(on.hasPrompt, false);
  assert.deepEqual(h.messages, []);
  assert.equal(
    (h.emit("tool_call", { toolName: "write" }) as { block: boolean }).block,
    true,
  );
  assert.equal(h.emit("tool_call", { toolName: "read" }), undefined);
  assert.match(
    JSON.stringify(h.emit("context", { messages: [] })),
    /Plan mode is active/,
  );
  const count = h.branch.length;
  h.set(true);
  assert.equal(h.branch.length, count);
  h.branch.push({
    type: "message",
    message: { role: "user", content: "Plan export" },
  });
  assert.equal(projectPlanControl(h.branch).hasPrompt, true);
  h.emit("session_tree");
  assert.equal(projectPlanControl(h.branch).hasPrompt, true);
  h.set(false);
  assert.equal(h.emit("tool_call", { toolName: "write" }), undefined);
  assert.match(
    JSON.stringify(h.emit("context", { messages: [] })),
    /Plan mode is inactive/,
  );
  assert.equal(projectPlanControl(h.branch).hasPrompt, false);
  assert.deepEqual(h.messages, []);
  h.emit("session_shutdown");
  assert.throws(() => h.set(true), /unavailable/);
});

test("inactive context follows the current branch and never authorizes a previous plan", () => {
  const h = harness();
  assert.equal(h.emit("context", { messages: [] }), undefined);
  h.set(true);
  h.set(false);
  h.emit("session_tree");
  const input = {
    messages: [
      {
        role: "custom",
        customType: "openpi-setup-request",
        content: "Change theme",
      },
    ],
  };
  const projection = h.emit("context", input);
  const prompt = JSON.stringify(projection);
  assert.match(prompt, /Plan mode is inactive/);
  assert.match(prompt, /does not authorize implementation/);
  assert.equal(input.messages.length, 1);
  assert.deepEqual(h.emit("context", projection), projection);
  assert.deepEqual(h.messages, []);
  h.branch.length = 0;
  h.emit("session_tree");
  assert.equal(h.emit("context", { messages: [] }), undefined);
  h.emit("session_shutdown");
});

test("busy, stale, ready and failed persistence never silently open the Plan gate", () => {
  const h = harness();
  h.set(true);
  h.setBusy(true);
  assert.throws(() => h.set(false), /Stop the current turn/);
  h.setBusy(false);
  assert.throws(() => h.set(false, null), /changed/);
  h.branch.push({
    type: "custom",
    customType: PLAN_MODE_STATE_ENTRY,
    id: "ready",
    data: { version: 1, status: "ready", plan: "Review this plan" },
  });
  h.emit("session_tree");
  assert.throws(() => h.set(true), /explicitly exit/);
  assert.throws(() => h.implement("stale"), /changed/);
  assert.equal(projectPlanControl(h.branch).status, "ready");
  h.failAppend();
  assert.throws(() => h.set(false), /disk failure/);
  assert.equal(projectPlanControl(h.branch).status, "ready");
  h.authorize("Implement Review this plan", "ready");
  assert.equal(
    h.emit("before_agent_start", { prompt: "Implement Review this plan" }),
    undefined,
  );
  assert.throws(() => h.implement("ready"), /disk failure/);
  assert.equal(projectPlanControl(h.branch).status, "ready");
  assert.match(
    JSON.stringify(h.emit("context", { messages: [] })),
    /plan is ready[\s\S]*Do not start implementation/,
  );
  assert.equal(
    (h.emit("tool_call", { toolName: "write" }) as { block: boolean }).block,
    true,
  );
  h.emit("session_shutdown");
});

test("preparing is read-only; an admitted approved prompt clears the gate", () => {
  const h = harness();
  h.branch.push({
    type: "custom",
    customType: PLAN_MODE_STATE_ENTRY,
    id: "ready",
    data: { version: 1, status: "ready", plan: "Review this plan" },
  });
  h.emit("session_tree");

  const branchLength = h.branch.length;
  const prepared = h.prepare("ready");
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.revision, "ready");
  assert.match(prepared.prompt ?? "", /Review this plan/);
  assert.equal(h.branch.length, branchLength);
  assert.equal(projectPlanControl(h.branch).status, "ready");
  assert.equal(
    (h.emit("tool_call", { toolName: "write" }) as { block: boolean }).block,
    true,
  );

  const approvedPrompt = "Implement Review this plan";
  const authorized = h.authorize(approvedPrompt, "ready");
  assert.equal(authorized.status, "ready");
  assert.equal(projectPlanControl(h.branch).status, "ready");
  assert.equal(
    h.emit("before_agent_start", { prompt: "an unrelated prompt" }),
    undefined,
  );
  assert.match(
    JSON.stringify(h.emit("context", { messages: [] })),
    /plan is ready[\s\S]*Do not start implementation/,
  );
  assert.equal(
    h.emit("before_agent_start", {
      prompt: approvedPrompt,
    }),
    undefined,
  );
  assert.equal(projectPlanControl(h.branch).status, "ready");
  assert.equal(
    (h.emit("tool_call", { toolName: "write" }) as { block: boolean }).block,
    true,
  );
  assert.match(
    JSON.stringify(h.emit("context", { messages: [] })),
    /plan is ready[\s\S]*Do not start implementation/,
  );

  const result = h.implement("ready");
  assert.equal(result.status, "inactive");
  assert.match(result.prompt ?? "", /Review this plan/);
  assert.deepEqual(h.branch.at(-1), {
    type: "custom",
    customType: PLAN_MODE_STATE_ENTRY,
    id: `entry-${h.branch.length - 1}`,
    data: { version: 1, status: "inactive" },
  });
  assert.equal(h.emit("tool_call", { toolName: "write" }), undefined);
  assert.match(
    JSON.stringify(h.emit("context", { messages: [] })),
    /Plan mode is inactive/,
  );
  assert.throws(() => h.implement("ready"), /changed/);
  assert.equal(projectPlanControl(h.branch).status, "inactive");
  h.emit("session_shutdown");
});

test("cancelling a rejected prompt keeps Plan Ready and the write gate closed", () => {
  const h = harness();
  h.branch.push({
    type: "custom",
    customType: PLAN_MODE_STATE_ENTRY,
    id: "ready",
    data: { version: 1, status: "ready", plan: "Review this plan" },
  });
  h.emit("session_tree");
  h.authorize("Implement Review this plan", "ready");
  assert.equal(
    h.emit("before_agent_start", {
      prompt: "Implement Review this plan",
    }),
    undefined,
  );
  h.cancel("ready");

  assert.equal(projectPlanControl(h.branch).status, "ready");
  assert.match(
    JSON.stringify(h.emit("context", { messages: [] })),
    /Do not start implementation/,
  );
  assert.throws(() => h.implement("ready"), /Pi did not start/);
  assert.equal(
    (h.emit("tool_call", { toolName: "write" }) as { block: boolean }).block,
    true,
  );
  h.emit("session_shutdown");
});
