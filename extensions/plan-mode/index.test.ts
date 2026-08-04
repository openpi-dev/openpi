import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
    "subagent_spawn",
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
  assert.match(reason ?? "", /read-only investigation commands/);
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
