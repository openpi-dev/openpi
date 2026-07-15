import assert from "node:assert/strict";
import test from "node:test";
import type { OutputView, TerminalSnapshot } from "./src/domain.ts";
import {
  BG_START_PARAMETER_DESCRIPTIONS,
  BG_START_TOOL_DESCRIPTION,
  buildKillReport,
  buildStatusResult,
  buildTerminalResultMessage,
} from "./src/prompt.ts";

test("start descriptions identify the platform-specific shell contract", () => {
  assert.match(BG_START_TOOL_DESCRIPTION, /sh -c on POSIX/);
  assert.match(BG_START_TOOL_DESCRIPTION, /cmd\.exe \/d \/s \/c on Windows/);
  assert.match(BG_START_PARAMETER_DESCRIPTIONS.command, /sh -c on POSIX/);
  assert.match(
    BG_START_PARAMETER_DESCRIPTIONS.command,
    /cmd\.exe \/d \/s \/c on Windows/,
  );
});

function view(overrides: Partial<OutputView> = {}): OutputView {
  return { text: "", totalBytes: 0, truncatedBytes: 0, ...overrides };
}

function snap(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    id: "bt-1",
    command: "sleep 999",
    title: "test",
    cwd: "/tmp",
    pid: 123,
    status: "done",
    createdAt: Date.now() - 5_000,
    settledAt: Date.now(),
    exitCode: 0,
    stdout: view(),
    stderr: view(),
    ...overrides,
  };
}

test("kill report distinguishes killed / raced natural exit / already settled", () => {
  const report = buildKillReport([
    {
      id: "bt-1",
      title: "a",
      status: "killed",
      wasRunning: true,
      killed: true,
      exit: "SIGTERM",
    },
    {
      id: "bt-2",
      title: "b",
      status: "done",
      wasRunning: true,
      killed: false,
      exit: "exit 0",
    },
    {
      id: "bt-3",
      title: "c",
      status: "failed",
      wasRunning: false,
      killed: false,
      exit: "exit 1",
    },
  ]);
  const lines = report.split("\n");
  assert.equal(lines[0], 'Killed bt-1 "a" (SIGTERM).');
  assert.match(lines[1], /exited on its own before the kill landed \(exit 0\)/);
  assert.match(lines[2], /was already failed \(exit 1\)/);
});

test("status result marks head-truncated output with a pointer at the full log", () => {
  const text = buildStatusResult(
    snap({
      stdout: view({
        text: "tail of the log\n",
        totalBytes: 5 * 1024 * 1024,
        truncatedBytes: 5 * 1024 * 1024 - 16,
        spillPath: "/tmp/bt-1.stdout.log",
      }),
    }),
  );
  assert.match(text, /stdout truncated: showing last /);
  assert.match(text, /Full log: \/tmp\/bt-1\.stdout\.log/);
});

test("completion message reports kill vs exit and omits empty stderr", () => {
  const killed = buildTerminalResultMessage(
    snap({ status: "killed", exitCode: undefined, signal: "SIGTERM" }),
  );
  assert.match(killed, /was killed after/);
  assert.ok(!killed.includes("stderr"), "empty stderr section omitted");

  const failed = buildTerminalResultMessage(
    snap({
      status: "failed",
      exitCode: 3,
      stderr: view({ text: "boom\n", totalBytes: 5 }),
    }),
  );
  assert.match(failed, /exited \(exit 3\)/);
  assert.match(failed, /stderr:\nboom/);
});

test("completion output is a shorter tail than the detailed status view", () => {
  const output = Array.from(
    { length: 100 },
    (_, index) => `line-${index + 1}`,
  ).join("\n");
  const terminal = snap({
    stdout: view({ text: output, totalBytes: Buffer.byteLength(output) }),
  });

  const completion = buildTerminalResultMessage(terminal);
  const status = buildStatusResult(terminal);

  assert.ok(!completion.includes("line-1\n"));
  assert.match(completion, /line-100/);
  assert.match(completion, /stdout truncated/);
  assert.match(status, /line-1\n/);
});
