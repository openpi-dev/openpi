import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  PLAN_MODE_CHANNEL,
  PLAN_MODE_CHILD_TOOLS,
  planModeAllowsDeclaredTools,
  planModeChildTools,
} from "../shared/plan-mode-state.ts";
import { getLoadedOpenPiCapabilities } from "../shared/tool-surface.ts";
import planMode, {
  BLOCK_REASON,
  buildPlanImplementationPrompt,
  latestAssistantToolCallCount,
  MAX_READY_PLAN_UTF8_BYTES,
  PLAN_MODE_STATE_ENTRY,
  PLAN_READY_ACTIONS,
  PLAN_SAFE_TOOLS,
  planReadyBatchDecision,
  planToolCallDecision,
  restorePlanModeState,
} from "./index.ts";

type PlanReadyExecute = (
  toolCallId: string,
  params: { plan: string },
  signal: AbortSignal,
  onUpdate: undefined,
  ctx: ExtensionContext,
) => Promise<{
  details?: { status?: string; plan?: string };
  terminate?: boolean;
}>;

test("plan mode allows only explicit observational tools", () => {
  for (const tool of [
    "read",
    "fd",
    "rg",
    "web_search",
    "bg_status",
    "subagent_check",
    "workflow_status",
    "tasks_list",
    "get_goal",
    "ask_user",
    "git_show",
    "git_diff",
    "git_log",
    "plan_ready",
  ]) {
    assert.ok(PLAN_SAFE_TOOLS.has(tool), `${tool} must stay available`);
    assert.equal(planToolCallDecision(tool), undefined);
  }
});

test("entering Plan Mode loads the structured search capability", async () => {
  let commandHandler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  const pi = {
    registerTool() {},
    getActiveTools: () => [],
    setActiveTools() {},
    registerCommand(
      _name: string,
      command: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      commandHandler = command.handler;
    },
    on() {},
    events: {
      on() {
        return () => {};
      },
      emit() {},
    },
    appendEntry() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    ui: { setStatus() {}, notify() {} },
  } as unknown as ExtensionCommandContext;

  planMode(pi);
  assert.ok(commandHandler);
  assert.deepEqual(getLoadedOpenPiCapabilities(pi), []);

  await commandHandler("inspect history", ctx);

  assert.deepEqual(getLoadedOpenPiCapabilities(pi), ["search"]);
});

test("plan mode fail-closes known mutations and future unknown tools", () => {
  for (const tool of [
    "edit",
    "write",
    "subagent_send",
    "workflow",
    "bg_start",
    "bg_kill",
    "subagent_cancel",
    "workflow_stop",
    "configure_my_pi_setup",
    "context_pivot",
    "tasks_add",
    "tasks_update",
    "create_goal",
    "update_goal",
    "future_mutating_extension_tool",
  ]) {
    assert.equal(
      planToolCallDecision(tool)?.block,
      true,
      `${tool} must be blocked`,
    );
  }
});

test("bash is judged per command, not blocked as a whole tool", () => {
  // The tool name alone cannot say whether a command writes, so bash is the
  // one tool decided by its argument. See bash-policy.test.ts for the command
  // grammar itself.
  assert.equal(
    planToolCallDecision("bash", { command: "git log -5" }),
    undefined,
  );
  assert.equal(
    planToolCallDecision("bash", { command: "git push" })?.block,
    true,
  );
  // A bash call whose input never arrives must not fall through to allowed.
  assert.equal(planToolCallDecision("bash")?.block, true);
  assert.equal(planToolCallDecision("bash", {})?.block, true);
  // The refusal keeps both the specific reason and the standing instruction.
  const reason = planToolCallDecision("bash", { command: "rm -rf /" })?.reason;
  assert.match(reason ?? "", /read-only git and gh investigation commands/);
  assert.match(reason ?? "", /Plan mode is active/);
});

test("plan_ready fails preflight unless it is the only tool call", () => {
  const branch = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Finishing." },
          { type: "toolCall", id: "ready", name: "plan_ready" },
          { type: "toolCall", id: "read", name: "read" },
        ],
      },
    },
  ];
  const count = latestAssistantToolCallCount(branch);
  assert.equal(count, 2);
  assert.equal(planReadyBatchDecision("plan_ready", count)?.block, true);
  assert.match(
    planReadyBatchDecision("plan_ready", count)?.reason ?? "",
    /only tool call/,
  );
  assert.equal(planReadyBatchDecision("plan_ready", 1), undefined);
  assert.equal(planReadyBatchDecision("read", 2), undefined);
});

test("Plan Ready keeps the write gate closed until the user prepares an editable implementation prompt", async () => {
  let commandHandler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  let toolHandler:
    | ((event: {
        toolName: string;
        input?: Record<string, unknown>;
      }) => unknown)
    | undefined;
  let readyExecute: PlanReadyExecute | undefined;
  let editorText = "";
  let activeTools = ["read", "third_party_tool"];
  const messages: Array<{ content: string }> = [];
  const pi = {
    registerTool(definition: { name: string; execute: PlanReadyExecute }) {
      if (definition.name === "plan_ready") readyExecute = definition.execute;
      activeTools = [
        ...activeTools.filter((name) => name !== definition.name),
        definition.name,
      ];
    },
    getActiveTools: () => [...activeTools],
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    registerCommand(
      _name: string,
      command: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      commandHandler = command.handler;
    },
    on(event: string, handler: unknown) {
      if (event === "tool_call") {
        toolHandler = handler as (event: {
          toolName: string;
          input?: Record<string, unknown>;
        }) => unknown;
      }
    },
    events: { emit() {} },
    appendEntry() {},
    sendMessage(message: { content: string }) {
      messages.push(message);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    ui: {
      setStatus() {},
      notify() {},
      select: async () => PLAN_READY_ACTIONS.current,
      setEditorText(text: string) {
        editorText = text;
      },
    },
  } as unknown as ExtensionCommandContext;
  planMode(pi);
  assert.ok(commandHandler);
  assert.ok(toolHandler);
  assert.ok(readyExecute);

  await commandHandler("", ctx);
  assert.deepEqual(activeTools, ["read", "third_party_tool", "plan_ready"]);
  assert.deepEqual(toolHandler({ toolName: "tasks_add" }), {
    block: true,
    reason: BLOCK_REASON,
  });
  assert.equal(toolHandler({ toolName: "read" }), undefined);
  // The gate passes the call's input through, so bash reaches the per-command
  // policy instead of being decided by name.
  assert.equal(
    toolHandler({ toolName: "bash", input: { command: "git status" } }),
    undefined,
  );
  assert.equal(
    (
      toolHandler({ toolName: "bash", input: { command: "npm publish" } }) as {
        block?: boolean;
      }
    )?.block,
    true,
  );

  await commandHandler("done", ctx);
  assert.match(messages.at(-1)?.content ?? "", /call plan_ready alone/);
  assert.equal(
    (toolHandler({ toolName: "write" }) as { block?: boolean } | undefined)
      ?.block,
    true,
  );

  await assert.rejects(
    readyExecute(
      "ready-too-large",
      { plan: "界".repeat(Math.ceil(MAX_READY_PLAN_UTF8_BYTES / 3) + 1) },
      new AbortController().signal,
      undefined,
      ctx,
    ),
    /at most 48000 UTF-8 bytes/,
  );
  assert.equal(
    (toolHandler({ toolName: "write" }) as { block?: boolean } | undefined)
      ?.block,
    true,
  );

  const plan = "# Plan\n\n1. Add the feature.\n2. Test it.";
  const result = await readyExecute(
    "ready-1",
    { plan: `${plan}\u001b]52;c;hidden\u0007` },
    new AbortController().signal,
    undefined,
    ctx,
  );
  assert.equal(result.terminate, true);
  assert.deepEqual(result.details, { status: "ready", plan });
  assert.equal(
    (toolHandler({ toolName: "write" }) as { block?: boolean } | undefined)
      ?.block,
    true,
    "recording a plan must not open the write gate",
  );
  assert.equal(
    (toolHandler({ toolName: "read" }) as { block?: boolean } | undefined)
      ?.block,
    true,
    "a ready plan is sealed against follow-up tool calls",
  );

  await commandHandler("", ctx);
  assert.deepEqual(activeTools, ["read", "third_party_tool"]);
  assert.equal(toolHandler({ toolName: "write" }), undefined);
  assert.equal(
    toolHandler({ toolName: "bash", input: { command: "npm publish" } }),
    undefined,
  );
  assert.equal(editorText, buildPlanImplementationPrompt(plan));
  assert.equal(
    messages.length,
    2,
    "Plan Ready and implementation selection must not auto-submit a turn",
  );
});

test("bare /plan offers to turn planning mode off", async () => {
  let commandHandler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  let toolHandler:
    | ((event: { toolName: string }) => { block?: boolean } | void)
    | undefined;
  const entries: unknown[] = [];
  const pi = {
    registerTool() {},
    getActiveTools: () => [],
    setActiveTools() {},
    registerCommand(
      _name: string,
      command: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      commandHandler = command.handler;
    },
    on(event: string, handler: unknown) {
      if (event === "tool_call") toolHandler = handler as typeof toolHandler;
    },
    events: { emit() {} },
    appendEntry(_type: string, state: unknown) {
      entries.push(state);
    },
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    ui: {
      setStatus() {},
      notify() {},
      select: async () => PLAN_READY_ACTIONS.off,
    },
  } as unknown as ExtensionCommandContext;

  planMode(pi);
  assert.ok(commandHandler);
  assert.ok(toolHandler);
  await commandHandler("", ctx);
  await commandHandler("", ctx);

  assert.equal(toolHandler({ toolName: "write" }), undefined);
  assert.deepEqual(entries.at(-1), { version: 1, status: "inactive" });
});

test("bare /plan offers to turn ready mode off", async () => {
  let commandHandler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  let toolHandler:
    | ((event: { toolName: string }) => { block?: boolean } | void)
    | undefined;
  let readyExecute: PlanReadyExecute | undefined;
  const entries: unknown[] = [];
  const pi = {
    registerTool(definition: { name: string; execute: PlanReadyExecute }) {
      if (definition.name === "plan_ready") readyExecute = definition.execute;
    },
    getActiveTools: () => [],
    setActiveTools() {},
    registerCommand(
      _name: string,
      command: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      commandHandler = command.handler;
    },
    on(event: string, handler: unknown) {
      if (event === "tool_call") toolHandler = handler as typeof toolHandler;
    },
    events: { emit() {} },
    appendEntry(_type: string, state: unknown) {
      entries.push(state);
    },
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    ui: {
      setStatus() {},
      notify() {},
      select: async () => PLAN_READY_ACTIONS.off,
    },
  } as unknown as ExtensionCommandContext;

  planMode(pi);
  assert.ok(commandHandler);
  assert.ok(readyExecute);
  assert.ok(toolHandler);
  await commandHandler("", ctx);
  await readyExecute(
    "ready-off",
    { plan: "# Plan" },
    new AbortController().signal,
    undefined,
    ctx,
  );
  await commandHandler("", ctx);

  assert.equal(toolHandler({ toolName: "write" }), undefined);
  assert.deepEqual(entries.at(-1), { version: 1, status: "inactive" });
});

test("/plan off clears plan mode", async () => {
  let commandHandler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  let toolHandler:
    | ((event: { toolName: string }) => { block?: boolean } | void)
    | undefined;
  const entries: unknown[] = [];
  const pi = {
    registerTool() {},
    getActiveTools: () => [],
    setActiveTools() {},
    registerCommand(
      _name: string,
      command: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      commandHandler = command.handler;
    },
    on(event: string, handler: unknown) {
      if (event === "tool_call") toolHandler = handler as typeof toolHandler;
    },
    events: { emit() {} },
    appendEntry(_type: string, state: unknown) {
      entries.push(state);
    },
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    ui: { setStatus() {}, notify() {} },
  } as unknown as ExtensionCommandContext;

  planMode(pi);
  assert.ok(commandHandler);
  assert.ok(toolHandler);
  await commandHandler("", ctx);
  await commandHandler("off", ctx);

  assert.equal(toolHandler({ toolName: "write" }), undefined);
  assert.deepEqual(entries.at(-1), { version: 1, status: "inactive" });
});

test("fresh implementation links a new session and prefills without submitting", async () => {
  let commandHandler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  let readyExecute: PlanReadyExecute | undefined;
  let parentSession: string | undefined;
  let editorText = "";
  let messageCount = 0;
  const pi = {
    registerTool(definition: { name: string; execute: PlanReadyExecute }) {
      if (definition.name === "plan_ready") readyExecute = definition.execute;
    },
    registerCommand(
      _name: string,
      command: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      commandHandler = command.handler;
    },
    on() {},
    getActiveTools: () => [],
    setActiveTools() {},
    events: { emit() {} },
    appendEntry() {},
    sendMessage() {
      messageCount++;
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    ui: {
      setStatus() {},
      notify() {},
      select: async () => PLAN_READY_ACTIONS.fresh,
    },
    sessionManager: {
      getSessionFile: () => "/tmp/source-session.jsonl",
    },
    waitForIdle: async () => {},
    newSession: async (options: {
      parentSession?: string;
      withSession: (ctx: {
        ui: {
          setEditorText(text: string): void;
          notify(): void;
        };
      }) => Promise<void>;
    }) => {
      parentSession = options.parentSession;
      await options.withSession({
        ui: {
          setEditorText(text: string) {
            editorText = text;
          },
          notify() {},
        },
      });
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;
  planMode(pi);
  assert.ok(commandHandler);
  assert.ok(readyExecute);

  await commandHandler("", ctx);
  const plan = "# Plan\n\nImplement in a clean context.";
  await readyExecute(
    "ready-2",
    { plan },
    new AbortController().signal,
    undefined,
    ctx,
  );
  await commandHandler("", ctx);

  assert.equal(parentSession, "/tmp/source-session.jsonl");
  assert.equal(editorText, buildPlanImplementationPrompt(plan));
  assert.equal(messageCount, 1, "only arming Plan Mode starts a model turn");
});

test("spawning is allowed while planning, resuming an existing child is not", () => {
  // Parallel read-only exploration is one of the most useful things to do
  // while planning, and it is safe because the child's tool allowlist is
  // enforced by the harness — subagents narrows a planning child to
  // PLAN_MODE_CHILD_TOOLS, which has no write, edit, or bash.
  assert.ok(PLAN_SAFE_TOOLS.has("subagent_spawn"));
  assert.equal(planToolCallDecision("subagent_spawn"), undefined);
  const isolated = planToolCallDecision("subagent_spawn", {
    isolation: "worktree",
  });
  assert.equal(isolated?.block, true);
  assert.match(isolated?.reason ?? "", /cannot create an isolated worktree/);

  // subagent_send resumes a child that may predate the plan and still hold the
  // full tool set; narrowing only applies at spawn.
  assert.equal(planToolCallDecision("subagent_send")?.block, true);

  // agent_type is optional and there is no run-wide plan-mode narrowing, so
  // an untyped or implementation Workflow call may still write.
  assert.equal(planToolCallDecision("workflow")?.block, true);
});

test("planning children get investigation tools and never gain any", () => {
  // The allowlist can only ever remove: a type that restricted itself further
  // keeps its own limit, and one that named a writing tool does not get it.
  assert.deepEqual(
    [...planModeChildTools(undefined)],
    [...PLAN_MODE_CHILD_TOOLS],
  );
  assert.deepEqual(planModeChildTools(["read", "write", "bash"]), ["read"]);
  assert.deepEqual(planModeChildTools(["read", "rg"]), ["read", "rg"]);
  assert.deepEqual(planModeChildTools(["write", "edit"]), []);
  for (const tool of ["write", "edit", "bash", "subagent_spawn"]) {
    assert.ok(
      !PLAN_MODE_CHILD_TOOLS.includes(tool),
      `${tool} must not be available to a planning child`,
    );
  }
});

test("plan mode rejects type declarations it would silently narrow", () => {
  assert.equal(planModeAllowsDeclaredTools(["read", "rg"]), true);
  assert.equal(planModeAllowsDeclaredTools(["read", "write"]), false);
  assert.equal(planModeAllowsDeclaredTools(["bash"]), false);
  // Omitting a type allowlist inherits the normal write-capable child tools,
  // so selecting that type would still require silent narrowing.
  assert.equal(planModeAllowsDeclaredTools(undefined), false);
});

test("persisted Plan Mode state restores branch-locally and fails closed", () => {
  const readyEntry = {
    type: "custom",
    customType: PLAN_MODE_STATE_ENTRY,
    data: { version: 1, status: "ready", plan: "# Restored plan" },
  };
  assert.deepEqual(restorePlanModeState([readyEntry]), {
    planning: true,
    readyPlan: "# Restored plan",
  });
  assert.deepEqual(
    restorePlanModeState([
      readyEntry,
      {
        type: "custom",
        customType: PLAN_MODE_STATE_ENTRY,
        data: { version: 1, status: "inactive" },
      },
    ]),
    { planning: false },
  );
  const malformed = restorePlanModeState([
    {
      type: "custom",
      customType: PLAN_MODE_STATE_ENTRY,
      data: { version: 1, status: "ready", plan: "# Plan", extra: true },
    },
  ]);
  assert.equal(malformed.planning, true);
  assert.match(malformed.error ?? "", /writes remain blocked/);
});

test("session reload and tree navigation restore the branch-local write gate", () => {
  let sessionStart:
    | ((event: unknown, ctx: ExtensionContext) => void)
    | undefined;
  let sessionTree:
    | ((event: unknown, ctx: ExtensionContext) => void)
    | undefined;
  let toolHandler:
    | ((event: { toolName: string; input?: Record<string, unknown> }) => {
        block?: boolean;
      } | void)
    | undefined;
  let status = "";
  let branch: unknown[] = [
    {
      type: "custom",
      customType: PLAN_MODE_STATE_ENTRY,
      data: { version: 1, status: "ready", plan: "# Restored plan" },
    },
  ];
  const pi = {
    registerTool() {},
    getActiveTools: () => [],
    setActiveTools() {},
    registerCommand() {},
    appendEntry() {},
    sendMessage() {},
    events: {
      on() {
        return () => {};
      },
      emit() {},
    },
    on(event: string, handler: unknown) {
      if (event === "session_start") {
        sessionStart = handler as typeof sessionStart;
      } else if (event === "session_tree") {
        sessionTree = handler as typeof sessionTree;
      } else if (event === "tool_call") {
        toolHandler = handler as typeof toolHandler;
      }
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    ui: {
      setStatus(_key: string, value?: string) {
        status = value ?? "";
      },
      notify() {},
    },
    sessionManager: {
      getBranch: () => branch,
    },
  } as unknown as ExtensionContext;

  planMode(pi);
  assert.ok(sessionStart);
  assert.ok(sessionTree);
  assert.ok(toolHandler);
  assert.deepEqual(getLoadedOpenPiCapabilities(pi), []);
  sessionStart({}, ctx);

  assert.deepEqual(getLoadedOpenPiCapabilities(pi), ["search"]);
  assert.equal(toolHandler({ toolName: "write" })?.block, true);
  assert.match(status, /ready/);

  branch = [
    {
      type: "custom",
      customType: PLAN_MODE_STATE_ENTRY,
      data: { version: 1, status: "inactive" },
    },
  ];
  sessionTree({}, ctx);
  assert.equal(toolHandler({ toolName: "write" }), undefined);
  assert.equal(status, "");
});

test("the stance is broadcast on every change, including shutdown", () => {
  // subagents keeps its own copy of the flag; a stale broadcast would mean a
  // child spawned with write tools during a plan, or one needlessly
  // restricted in the session that follows.
  const emitted: unknown[] = [];
  let commandHandler:
    | ((args: string, ctx: ExtensionContext) => Promise<void>)
    | undefined;
  let shutdown: (() => void) | undefined;
  const pi = {
    registerTool() {},
    getActiveTools: () => [],
    setActiveTools() {},
    registerCommand(
      _name: string,
      command: { handler: typeof commandHandler },
    ) {
      commandHandler = command.handler;
    },
    on(event: string, handler: unknown) {
      if (event === "session_shutdown") shutdown = handler as () => void;
    },
    events: {
      emit(channel: string, payload: unknown) {
        if (channel === PLAN_MODE_CHANNEL) emitted.push(payload);
      },
    },
    appendEntry() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: true,
    ui: {
      setStatus() {},
      notify() {},
      select: async () => "Approve — start making changes",
    },
  } as unknown as ExtensionContext;

  planMode(pi);
  assert.ok(commandHandler);
  assert.ok(shutdown);

  void commandHandler("", ctx);
  assert.deepEqual(emitted.at(-1), { planning: true });

  void commandHandler("off", ctx);
  assert.deepEqual(emitted.at(-1), { planning: false });

  void commandHandler("", ctx);
  assert.deepEqual(emitted.at(-1), { planning: true });
  shutdown();
  assert.deepEqual(emitted.at(-1), { planning: false });
});
