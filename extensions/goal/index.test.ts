import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import sessionGoal, {
  goalToolResponse,
  parseGoalCommand,
  statusText,
} from "./index.ts";
import { createGoalSnapshot, transitionGoal } from "./state.ts";

test("goal command matches the current Codex surface", () => {
  assert.deepEqual(parseGoalCommand(""), { action: "status" });
  assert.deepEqual(parseGoalCommand("status"), { action: "status" });
  assert.deepEqual(parseGoalCommand("edit"), { action: "edit" });
  assert.deepEqual(parseGoalCommand(" PAUSE "), { action: "pause" });
  assert.deepEqual(parseGoalCommand("resume"), { action: "resume" });
  assert.deepEqual(parseGoalCommand("clear"), { action: "clear" });
  assert.deepEqual(parseGoalCommand("ship release"), {
    action: "set",
    objective: "ship release",
  });
});

test("bare goal summary uses Codex fields, compact usage, and status-specific command hints", () => {
  const goal = {
    ...createGoalSnapshot(
      { objective: "Ship", tokenBudget: 50_000 },
      0,
      1_000,
      "goal_index_1",
    ),
    tokensUsed: 12_500,
    timeUsedSeconds: 90,
  };
  assert.equal(
    statusText(goal),
    [
      "Goal",
      "Status: active",
      "Objective: Ship",
      "Time used: 1m",
      "Tokens used: 12.5K",
      "Token budget: 50K",
      "",
      "Commands: /goal edit, /goal pause, /goal clear",
    ].join("\n"),
  );
  assert.equal(
    statusText(undefined),
    "Usage: /goal [<objective>|clear|edit|pause|resume]\n\nNo goal is currently set.",
  );
});

test("tool responses expose only Codex-shaped goal fields and remaining budget", () => {
  const snapshot = {
    ...createGoalSnapshot(
      { objective: "Ship", tokenBudget: 100 },
      0,
      10_000,
      "goal_index_2",
    ),
    tokensUsed: 20,
    reason: "private persistence detail",
  };
  const response = goalToolResponse(snapshot);
  assert.deepEqual(response, {
    goal: {
      objective: "Ship",
      status: "active",
      tokenBudget: 100,
      tokensUsed: 20,
      timeUsedSeconds: 0,
      createdAt: 10,
      updatedAt: 10,
    },
    remainingTokens: 80,
    completionBudgetReport: null,
  });
  assert.equal(JSON.stringify(response).includes("reason"), false);
  assert.equal(JSON.stringify(response).includes("revision"), false);
});

type CapturedTool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: { type: string; text: string }[] }>;
};

type CapturedCommand = {
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
};

type Handler = (
  event: Record<string, unknown>,
  ctx: ExtensionContext,
) => unknown;

function extensionHarness(options: { branch?: unknown[] } = {}) {
  const tools = new Map<string, CapturedTool>();
  const commands = new Map<string, CapturedCommand>();
  const handlers = new Map<string, Handler[]>();
  const entries: { customType: string; data: unknown }[] = [];
  const messages: { message: unknown; options: unknown }[] = [];
  const notifications: string[] = [];
  const statuses: (string | undefined)[] = [];
  const selections: (string | undefined)[] = [];
  const confirmations: boolean[] = [];
  const edits: (string | undefined)[] = [];
  let branch = options.branch ?? [];
  const pi = {
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: CapturedCommand) {
      commands.set(name, command);
    },
    registerMessageRenderer() {},
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    sendMessage(message: unknown, sendOptions: unknown) {
      messages.push({ message, options: sendOptions });
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    sessionManager: {
      getBranch: () => branch,
      getSessionId: () => "session-test-1",
    },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: (message: string) => notifications.push(message),
      setStatus: (_key: string, value: string | undefined) =>
        statuses.push(value),
      select: async () => selections.shift(),
      confirm: async () => confirmations.shift() ?? false,
      editor: async () => edits.shift(),
    },
  } as unknown as ExtensionContext;
  sessionGoal(pi);
  return {
    tools,
    commands,
    handlers,
    entries,
    messages,
    notifications,
    statuses,
    selections,
    confirmations,
    edits,
    ctx,
    setBranch(value: unknown[]) {
      branch = value;
    },
    async emit(event: string, data: Record<string, unknown> = {}) {
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) {
        results.push(await handler({ type: event, ...data }, ctx));
      }
      return results;
    },
  };
}

test("model tools create, read, complete, and replace goals with Codex semantics", async () => {
  const h = extensionHarness();
  await h.emit("session_start", { reason: "startup" });
  assert.deepEqual(
    [...h.tools.keys()],
    ["get_goal", "create_goal", "update_goal"],
  );

  const create = h.tools.get("create_goal");
  const get = h.tools.get("get_goal");
  const update = h.tools.get("update_goal");
  assert.ok(create && get && update);

  const created = await create.execute(
    "create-1",
    { objective: "Ship", token_budget: 25 },
    undefined,
    undefined,
    h.ctx,
  );
  assert.equal(JSON.parse(created.content[0]!.text).goal.status, "active");
  assert.equal(
    JSON.parse(created.content[0]!.text).goal.threadId,
    "session-test-1",
  );
  assert.equal(h.messages.length, 1);
  assert.throws(
    () =>
      create.execute(
        "create-2",
        { objective: "Replace too soon" },
        undefined,
        undefined,
        h.ctx,
      ),
    /unfinished goal/,
  );

  const read = await get.execute("get", {}, undefined, undefined, h.ctx);
  assert.equal(JSON.parse(read.content[0]!.text).goal.objective, "Ship");

  const completed = await update.execute(
    "update",
    { status: "complete" },
    undefined,
    undefined,
    h.ctx,
  );
  assert.match(
    JSON.parse(completed.content[0]!.text).completionBudgetReport,
    /Goal achieved/,
  );

  const replacement = await create.execute(
    "create-3",
    { objective: "Next" },
    undefined,
    undefined,
    h.ctx,
  );
  assert.equal(JSON.parse(replacement.content[0]!.text).goal.objective, "Next");
});

test("slash command creates directly, confirms unfinished replacement, edits, pauses, resumes, and clears", async () => {
  const h = extensionHarness();
  await h.emit("session_start", { reason: "startup" });
  const command = h.commands.get("goal");
  assert.ok(command);

  await command.handler("First objective", h.ctx);
  assert.match(h.notifications.at(-1) ?? "", /Goal active/);
  assert.equal(h.messages.length, 1);

  h.selections.push("Cancel");
  await command.handler("Cancelled replacement", h.ctx);
  await command.handler("", h.ctx);
  assert.match(h.notifications.at(-1) ?? "", /Objective: First objective/);

  h.selections.push("Replace current goal");
  await command.handler("Second objective", h.ctx);
  assert.match(h.notifications.at(-1) ?? "", /Second objective/);

  h.edits.push("Edited objective");
  await command.handler("edit", h.ctx);
  await command.handler("", h.ctx);
  assert.match(h.notifications.at(-1) ?? "", /Objective: Edited objective/);

  await command.handler("pause", h.ctx);
  assert.match(h.notifications.at(-1) ?? "", /Goal paused/);
  await command.handler("resume", h.ctx);
  assert.match(h.notifications.at(-1) ?? "", /Goal active/);
  await command.handler("clear", h.ctx);
  assert.equal(h.notifications.at(-1), "Goal cleared");
  await command.handler("clear", h.ctx);
  assert.match(h.notifications.at(-1) ?? "", /No goal to clear/);
});

test("the next explicit user message durably hides an achieved footer without clearing goal history", async () => {
  const complete = transitionGoal(
    createGoalSnapshot(
      { objective: "Finished goal" },
      0,
      1,
      "goal_index_complete",
    ),
    "complete",
    2,
    "done",
  );
  const h = extensionHarness({
    branch: [{ type: "custom", customType: "session-goal", data: complete }],
  });
  await h.emit("session_start", { reason: "reload" });
  assert.equal(h.statuses.at(-1), "Goal achieved (0s)");

  await h.emit("input", { source: "extension", text: "automatic" });
  assert.equal(h.entries.length, 0);
  assert.equal(h.statuses.at(-1), "Goal achieved (0s)");

  const transformed = await h.emit("input", {
    source: "interactive",
    text: "next request",
  });
  const inputTransform = transformed.at(-1) as any;
  assert.equal(inputTransform.text, "next request");
  assert.equal(
    inputTransform.images[0].mimeType,
    "application/x-pi-goal-completion-ack",
  );
  assert.equal(h.entries.length, 0, "input may still be handled or queued");
  assert.equal(h.statuses.at(-1), "Goal achieved (0s)");
  await h.emit("agent_start");
  await h.emit("turn_start");
  assert.equal(h.entries.length, 0);
  const replacements = await h.emit("message_end", {
    message: {
      role: "user",
      content: [
        { type: "text", text: "next request" },
        inputTransform.images[0],
      ],
    },
  });
  assert.deepEqual((replacements.at(-1) as any).message.content, [
    { type: "text", text: "next request" },
  ]);
  assert.equal(h.statuses.at(-1), undefined);
  assert.equal(h.entries.length, 0, "message_end precedes user persistence");
  await h.emit("turn_end");
  assert.equal(h.entries.length, 1);
  assert.equal((h.entries[0]?.data as any).status, "complete");
  assert.equal((h.entries[0]?.data as any).completionAcknowledged, true);

  const reloaded = extensionHarness({
    branch: [
      { type: "custom", customType: "session-goal", data: complete },
      { type: "custom", customType: "session-goal", data: h.entries[0]!.data },
    ],
  });
  await reloaded.emit("session_start", { reason: "reload" });
  assert.equal(reloaded.statuses.at(-1), undefined);
  await reloaded.commands.get("goal")!.handler("", reloaded.ctx);
  assert.match(reloaded.notifications.at(-1) ?? "", /Status: complete/);
});

test("restored active goals auto-continue, stopped goals prompt, and forks defer until explicit input", async () => {
  const active = createGoalSnapshot(
    { objective: "Resume me" },
    0,
    1,
    "goal_index_3",
  );
  const branch = [{ type: "custom", customType: "session-goal", data: active }];

  const resumed = extensionHarness({ branch });
  await resumed.emit("session_start", { reason: "reload" });
  assert.equal(resumed.messages.length, 1);

  const paused = extensionHarness({
    branch: [
      {
        type: "custom",
        customType: "session-goal",
        data: { ...active, status: "paused" },
      },
    ],
  });
  paused.confirmations.push(true);
  await paused.emit("session_start", { reason: "reload" });
  assert.equal(paused.messages.length, 1);

  const forked = extensionHarness({ branch });
  await forked.emit("session_start", { reason: "fork" });
  assert.equal(forked.messages.length, 0);
  await forked.emit("input", { source: "extension", text: "hidden" });
  assert.equal(forked.entries.length, 1);
  await forked.emit("input", { source: "interactive", text: "hello" });
  assert.equal(forked.entries.length, 2);
  await forked.emit("agent_start");
  await forked.emit("agent_end", { messages: [] });
  await forked.emit("agent_settled");
  assert.equal(forked.messages.length, 1);
});
