import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  PLAN_MODE_CHANNEL,
  PLAN_MODE_CHILD_TOOLS,
  planModeAllowsDeclaredTools,
  planModeChildTools,
} from "../shared/plan-mode-state.ts";
import planMode, {
  BLOCK_REASON,
  PLAN_SAFE_TOOLS,
  planToolCallDecision,
} from "./index.ts";

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
  ]) {
    assert.ok(PLAN_SAFE_TOOLS.has(tool), `${tool} must stay available`);
    assert.equal(planToolCallDecision(tool), undefined);
  }
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

test("runtime gate blocks before approval and opens after explicit approval", async () => {
  let commandHandler:
    ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  let toolHandler:
    | ((event: {
        toolName: string;
        input?: Record<string, unknown>;
      }) => unknown)
    | undefined;
  const pi = {
    registerCommand(
      _name: string,
      command: {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
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
  assert.ok(toolHandler);

  await commandHandler("", ctx);
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
  assert.equal(toolHandler({ toolName: "write" }), undefined);
  assert.equal(
    toolHandler({ toolName: "bash", input: { command: "npm publish" } }),
    undefined,
  );
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

test("the stance is broadcast on every change, including shutdown", () => {
  // subagents keeps its own copy of the flag; a stale broadcast would mean a
  // child spawned with write tools during a plan, or one needlessly
  // restricted in the session that follows.
  const emitted: unknown[] = [];
  let commandHandler:
    ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  let shutdown: (() => void) | undefined;
  const pi = {
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
