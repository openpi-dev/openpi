import assert from "node:assert/strict";
import test from "node:test";
import bashTimeout, {
  BASH_TIMEOUT_NOTE,
  DEFAULT_BASH_TIMEOUT_SECONDS,
} from "../../../extensions/bash-timeout/index.ts";

function harness() {
  const handlers = new Map<string, (event: never, ctx: never) => unknown>();
  bashTimeout({
    on(name: string, handler: (event: never, ctx: never) => unknown) {
      handlers.set(name, handler);
    },
  } as never);
  return {
    toolCall(event: unknown, ctx: { mode: string }) {
      return handlers.get("tool_call")!(event as never, ctx as never);
    },
    toolResult(event: unknown) {
      return handlers.get("tool_result")!(
        event as never,
        { mode: "print" } as never,
      );
    },
  };
}

function bashCall(toolCallId: string, timeout?: number) {
  return {
    type: "tool_call",
    toolName: "bash",
    toolCallId,
    input: {
      command: "sleep 5",
      ...(timeout === undefined ? {} : { timeout }),
    },
  };
}

function bashResult(toolCallId: string, text: string, isError: boolean) {
  return {
    type: "tool_result",
    toolName: "bash",
    toolCallId,
    input: {},
    content: [{ type: "text", text }],
    isError,
  };
}

const TIMED_OUT = `Command timed out after ${DEFAULT_BASH_TIMEOUT_SECONDS} seconds`;

for (const mode of ["print", "json"]) {
  test(`injects the default timeout in ${mode} mode`, () => {
    const h = harness();
    const event = bashCall("tc-1");
    h.toolCall(event, { mode });
    assert.equal(event.input.timeout, DEFAULT_BASH_TIMEOUT_SECONDS);
  });
}

test("never overrides a timeout the model passed", () => {
  const h = harness();
  const event = bashCall("tc-1", 5);
  h.toolCall(event, { mode: "print" });
  assert.equal(event.input.timeout, 5);
});

for (const mode of ["tui", "rpc"]) {
  test(`leaves ${mode} mode untouched`, () => {
    const h = harness();
    const event = bashCall("tc-1");
    h.toolCall(event, { mode });
    assert.equal(event.input.timeout, undefined);
  });
}

test("ignores non-bash calls", () => {
  const h = harness();
  const event = bashCall("tc-1");
  event.toolName = "powershell";
  h.toolCall(event, { mode: "print" });
  assert.equal(event.input.timeout, undefined);
});

test("appends the note when an injected call times out", () => {
  const h = harness();
  h.toolCall(bashCall("tc-1"), { mode: "print" });
  const result = h.toolResult(
    bashResult("tc-1", `partial output\n${TIMED_OUT}`, true),
  );
  assert.ok(result);
  const content = (result as { content: { type: string; text?: string }[] })
    .content;
  assert.equal(content.length, 2);
  assert.equal(content[1]!.text, BASH_TIMEOUT_NOTE);
});

test("a model-supplied timeout gets no note", () => {
  const h = harness();
  h.toolCall(bashCall("tc-1", 5), { mode: "print" });
  const result = h.toolResult(
    bashResult("tc-1", "Command timed out after 5 seconds", true),
  );
  assert.equal(result, undefined);
});

test("a successful injected call returns nothing", () => {
  const h = harness();
  h.toolCall(bashCall("tc-1"), { mode: "print" });
  const result = h.toolResult(bashResult("tc-1", "done", false));
  assert.equal(result, undefined);
});
