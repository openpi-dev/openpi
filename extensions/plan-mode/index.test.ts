import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import planMode, { PLAN_SAFE_TOOLS, planToolCallDecision } from "./index.ts";

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
    "bash",
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

test("runtime gate blocks before approval and opens after explicit approval", async () => {
  let commandHandler:
    ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
  let toolHandler: ((event: { toolName: string }) => unknown) | undefined;
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
        toolHandler = handler as (event: { toolName: string }) => unknown;
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
    reason:
      "Plan mode is active: no changes yet. Keep investigating with read-only tools (read, fd, rg, web search) and present your plan. The user runs `/plan done` to approve it, or `/plan off` to cancel.",
  });
  assert.equal(toolHandler({ toolName: "read" }), undefined);

  await commandHandler("done", ctx);
  assert.equal(toolHandler({ toolName: "write" }), undefined);
});
