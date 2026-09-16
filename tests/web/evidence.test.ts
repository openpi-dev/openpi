import assert from "node:assert/strict";
import test from "node:test";
import {
  evidenceText,
  isEvidenceTool,
  projectToolEvidence,
  testSummary,
} from "../../web/protocol/evidence.ts";
import { projectMessage } from "../../web/protocol/types.ts";
import { reduceLiveTools } from "../../web/protocol/live-tools.ts";

function call(name: string, args: Record<string, unknown> = {}) {
  const part = projectMessage({
    content: [{ type: "toolCall", id: "call", name, arguments: args }],
  }).parts?.[0];
  assert.ok(part?.type === "toolCall");
  return part;
}

test("bounded messages preserve final bash receipts before output truncation", () => {
  const message = projectMessage({
    role: "toolResult",
    toolName: "bash",
    isError: true,
    content: [
      {
        type: "text",
        text: "output\n".repeat(10_000) + "\nCommand exited with code 7",
      },
    ],
  });
  assert.ok(message.truncation);
  assert.equal(projectToolEvidence(call("bash"), message).exitCode, 7);
});

test("runner summaries are recognized as observations across supported formats", () => {
  assert.equal(
    testSummary("ℹ tests 2\nℹ pass 1\nℹ fail 1\nℹ cancelled 0")?.format,
    "Node",
  );
  assert.equal(
    testSummary(" Tests  1 failed | 3 passed (4)\n Duration 1s")?.failed,
    1,
  );
  assert.equal(
    testSummary(" 2 pass\n 0 fail\nRan 2 tests across 1 file. [1ms]")?.format,
    "Bun",
  );
  const file = projectToolEvidence(call("read", { offset: 4 }), {
    content: "code\n\n[5 more lines in file. Use offset=5 to continue.]",
    isError: false,
  });
  assert.equal(file.output, "code");
  assert.match(file.readRecovery ?? "", /offset=5/u);
});

test("file evidence preserves requested range after oversized arguments and never invents a diff", () => {
  const args = call("read", {
    extra: "x".repeat(50_000),
    path: "report.md",
    offset: 42,
  });
  assert.equal(projectToolEvidence(args).path, "report.md");
  assert.equal(projectToolEvidence(args).offset, 42);
  assert.equal(projectToolEvidence(args).state, "unknown");
  const written = projectToolEvidence(
    call("write", { path: "report.md", content: "new" }),
    { content: "Successfully wrote", isError: false },
  );
  assert.equal(written.diff, undefined);
  const edited = projectToolEvidence(call("edit", { path: "report.md" }), {
    content: "edited",
    isError: false,
    details: { diff: "-1 old\n+1 new" },
  });
  assert.equal(edited.diff, "-1 old\n+1 new");
  assert.equal(
    projectToolEvidence(call("edit"), {
      content: "failed",
      isError: true,
      details: { diff: "fake" },
    }).diff,
    undefined,
  );
});

test("terminal receipts, TAP observations, and tool returns remain separate", () => {
  const bash = call("bash", { command: "node --test" });
  const output =
    "not ok 1 - failure\n  error: assertion\n# tests 2\n# pass 1\n# fail 1\n# cancelled 0\n\nCommand exited with code 1";
  const view = projectToolEvidence(bash, { content: output, isError: true });
  assert.equal(view.kind, "test");
  assert.equal(view.exitCode, 1);
  assert.equal(view.tests?.failed, 1);
  assert.equal(view.tests?.failures.length, 1);
  assert.equal(
    projectToolEvidence(bash, {
      content: "Command exited with code 23",
      isError: false,
    }).exitCode,
    undefined,
  );
  assert.equal(
    projectToolEvidence(bash, { content: "Command aborted", isError: true })
      .state,
    "cancelled",
  );
  assert.equal(
    projectToolEvidence(bash, {
      content: "Command timed out after 10 seconds",
      isError: true,
    }).state,
    "timed_out",
  );
  assert.equal(
    projectToolEvidence(bash, {
      content: "Command aborted",
      isError: true,
      truncation: { truncated: true },
    }).state,
    "failed",
  );
  assert.equal(
    projectToolEvidence(call("bg_status"), {
      content: "output",
      isError: false,
      details: { status: "running" },
    }).state,
    "running",
  );
  assert.equal(
    projectToolEvidence(call("bg_status"), {
      content: "output",
      details: { status: "killed", signal: "SIGTERM" },
    }).state,
    "cancelled",
  );
  assert.equal(testSummary("PASS test"), undefined);
  assert.equal(testSummary("# tests 1\n# pass 3\n# fail 0"), undefined);
  assert.equal(isEvidenceTool("future_test_tool"), false);
});

test("display projections bound UTF-8, lines and terminal controls without mutating evidence", () => {
  const source =
    "\x1b]8;;https://evil.example\x07link\x1b]8;;\x07\x1b[31mRED\x1b[0m\u202e";
  assert.equal(evidenceText(source).text, "linkRED");
  for (const tail of [false, true]) {
    const value = evidenceText("中文\n".repeat(100_000), tail);
    assert.ok(Buffer.byteLength(value.text) <= 12 * 1024);
    assert.ok(value.text.split("\n").length <= 300);
    assert.equal(value.truncated, true);
  }
  let getterCalls = 0;
  call(
    "read",
    Object.defineProperty({}, "path", {
      enumerable: true,
      get() {
        getterCalls++;
        return "secret";
      },
    }),
  );
  assert.equal(getterCalls, 0);
});

test("tool updates replace snapshots, final results resist replay, caches are bounded and Session-scoped", () => {
  const bash = call("bash");
  let tools = reduceLiveTools([], "tool_execution_start", {
    call: bash,
    toolCallId: "call",
  });
  tools = reduceLiveTools(tools, "tool_execution_update", {
    call: bash,
    toolCallId: "call",
    result: { content: "a" },
  });
  tools = reduceLiveTools(tools, "tool_execution_update", {
    call: bash,
    toolCallId: "call",
    result: { content: "ab" },
  });
  assert.equal(tools[0]?.result?.content, "ab");
  tools = reduceLiveTools(tools, "tool_execution_end", {
    toolCallId: "call",
    result: { content: "final", isError: false },
    isError: false,
  });
  const replayed = reduceLiveTools(tools, "tool_execution_update", {
    call: bash,
    toolCallId: "call",
    result: { content: "old" },
  });
  assert.deepEqual(replayed, tools);
  for (let index = 0; index < 90; index++)
    tools = reduceLiveTools(tools, "tool_execution_start", {
      call: { ...bash, id: String(index) },
      toolCallId: String(index),
    });
  assert.ok(tools.length <= 32);
  assert.equal(
    reduceLiveTools(tools, "turn_settled", {}).some(
      (item) => item.state === "running",
    ),
    false,
  );
  assert.deepEqual(reduceLiveTools(tools, "session_switched", {}), []);
});
test("successful foreground completion does not invent an exit code or complete background jobs", () => {
  const result = projectMessage({ content: "done", isError: false });
  const foreground = projectToolEvidence(call("bash"), result);
  assert.equal(foreground.processState, "returned");
  assert.equal(foreground.exitCode, undefined);
  assert.equal(
    projectToolEvidence(call("bg_start"), result).processState,
    "unknown",
  );
});
