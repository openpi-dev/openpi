import assert from "node:assert/strict";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CHILD_TOOL_CALL_TIMEOUT_MS,
  createToolCallTimeoutGuard,
  runWithToolCallTimeout,
  ToolCallTimeoutError,
} from "../../../extensions/shared/tool-call-timeout.ts";

test("the production timeout error names the tool and three-minute limit", () => {
  assert.equal(
    new ToolCallTimeoutError("fixture_tool", CHILD_TOOL_CALL_TIMEOUT_MS)
      .message,
    'Tool call "fixture_tool" timed out after 3 minutes.',
  );
});

test("a hung tool call fails clearly and receives an abort signal", async () => {
  let executionSignal: AbortSignal | undefined;

  await assert.rejects(
    runWithToolCallTimeout("hung_fixture", 10, undefined, (signal) => {
      executionSignal = signal;
      return new Promise(() => {});
    }),
    (error: unknown) => {
      assert.equal(error instanceof ToolCallTimeoutError, true);
      assert.equal(
        error instanceof Error ? error.message : "",
        'Tool call "hung_fixture" timed out after 10 ms.',
      );
      return true;
    },
  );

  assert.equal(executionSignal?.aborted, true);
  assert.equal(executionSignal?.reason instanceof ToolCallTimeoutError, true);
});

test("parent cancellation still stops the timeout wrapper immediately", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled fixture");
  const pending = runWithToolCallTimeout(
    "hung_fixture",
    60_000,
    controller.signal,
    () => new Promise(() => {}),
  );

  controller.abort(reason);

  await assert.rejects(pending, (error: unknown) => error === reason);
});

test("already cancelled tool calls never execute or report success", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled before dispatch");
  controller.abort(reason);
  let calls = 0;

  await assert.rejects(
    runWithToolCallTimeout(
      "cancelled_fixture",
      60_000,
      controller.signal,
      async () => {
        calls++;
        return "must not execute";
      },
    ),
    (error: unknown) => error === reason,
  );

  assert.equal(calls, 0);
});

test("already cancelled hung tools never start side effects", async () => {
  const controller = new AbortController();
  controller.abort("cancelled before dispatch");
  let calls = 0;

  await assert.rejects(
    runWithToolCallTimeout(
      "cancelled_fixture",
      60_000,
      controller.signal,
      () => {
        calls++;
        return new Promise(() => {});
      },
    ),
    { name: "Error", message: 'Tool call "cancelled_fixture" was aborted.' },
  );

  assert.equal(calls, 0);
});

test("the guard wraps each definition once and can discover later tools", () => {
  const definitions = new Map<string, ToolDefinition>();
  const createDefinition = (name: string): ToolDefinition => ({
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "done" }], details: {} };
    },
  });
  const first = createDefinition("first");
  definitions.set(first.name, first);
  const registry = {
    getAllTools: () => [...definitions.keys()].map((name) => ({ name })),
    getToolDefinition: (name: string) => definitions.get(name),
  };
  const guard = createToolCallTimeoutGuard(10);

  const firstExecute = first.execute;
  guard.apply(registry);
  const firstWrappedExecute = first.execute;
  assert.notEqual(firstWrappedExecute, firstExecute);

  const second = createDefinition("second");
  const secondExecute = second.execute;
  definitions.set(second.name, second);
  guard.apply(registry);

  assert.equal(first.execute, firstWrappedExecute);
  assert.notEqual(second.execute, secondExecute);
});

test("successful and terminating tool results pass through unchanged", async () => {
  const result = {
    content: [{ type: "text" as const, text: "recorded" }],
    details: { value: "fixture" },
    terminate: true,
  };

  assert.equal(
    await runWithToolCallTimeout(
      "structured_output",
      10,
      undefined,
      async () => result,
    ),
    result,
  );
});

test("the timeout is fresh for each tool call, not shared across calls", async () => {
  const execute = () =>
    runWithToolCallTimeout("slow_fixture", 100, undefined, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return "done";
    });

  assert.equal(await execute(), "done");
  assert.equal(await execute(), "done");
});

test("diagnostics observe actual timeout and cancellation without inspecting tool payloads", async () => {
  const outcomes: string[] = [];
  await assert.rejects(
    runWithToolCallTimeout(
      "fixture",
      5,
      undefined,
      () => new Promise(() => {}),
      (outcome) => outcomes.push(outcome),
    ),
    ToolCallTimeoutError,
  );
  const controller = new AbortController();
  const pending = runWithToolCallTimeout(
    "fixture",
    60_000,
    controller.signal,
    () => new Promise(() => {}),
    (outcome) => outcomes.push(outcome),
  );
  controller.abort(new Error("fixture"));
  await assert.rejects(pending, /fixture/);
  assert.deepEqual(outcomes, ["timeout", "cancelled"]);
});

test("a failing diagnostic observer cannot prevent the actual timeout outcome", async () => {
  await assert.rejects(
    runWithToolCallTimeout(
      "fixture",
      5,
      undefined,
      () => new Promise(() => {}),
      () => {
        throw new Error("diagnostic failure");
      },
    ),
    ToolCallTimeoutError,
  );
});
