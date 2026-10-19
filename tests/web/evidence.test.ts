import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  evidenceText,
  isEvidenceTool,
  projectToolEvidence,
  testSummary,
} from "../../web/protocol/evidence.ts";
import { projectMessage } from "../../web/protocol/types.ts";
import { reduceLiveTools } from "../../web/protocol/live-tools.ts";
import { ArtifactReader } from "../../web/host/artifacts.ts";

function call(name: string, args: Record<string, unknown> = {}) {
  const part = projectMessage({
    content: [{ type: "toolCall", id: "call", name, arguments: args }],
  }).parts?.[0];
  assert.ok(part?.type === "toolCall");
  return part;
}

test("Web evidence strips terminal-owned hidden strings rather than exposing their payloads", () => {
  for (const start of [
    "\x1bP",
    "\x1bX",
    "\x1b^",
    "\x1b_",
    "\u0090",
    "\u0098",
    "\u009e",
    "\u009f",
  ]) {
    for (const end of ["\x1b\\", "\u009c"]) {
      assert.equal(
        evidenceText(`before${start}hidden${end}after`).text,
        "beforeafter",
      );
    }
    assert.equal(evidenceText(`before${start}unterminated`).text, "before");
  }
  assert.equal(
    evidenceText("中文\t👩‍💻\x1b[31mvisible\x1b[0m").text,
    "中文  👩‍💻visible",
  );
  const result = projectToolEvidence(call("bash"), {
    content: "before\x1bPhidden\x1b\\after",
    isError: false,
  });
  assert.equal(result.output, "beforeafter");
});

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

test("file evidence keeps artifact identities separate from sanitized display labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-evidence-path-"));
  const identity = "a\u200bb.txt";
  const resolvedPath = join(root, identity);
  const reader = new ArtifactReader(() => ({ sessionId: "s", cwd: root }));
  try {
    await writeFile(resolvedPath, "zero-width identity");
    await writeFile(join(root, "ab.txt"), "different file");
    const message = projectMessage(
      {
        content: [
          {
            type: "toolCall",
            id: "call",
            name: "read",
            arguments: { path: identity },
          },
        ],
      },
      (path) => join(root, path),
    );
    const part = message.parts?.[0];
    assert.ok(part?.type === "toolCall");
    const view = projectToolEvidence(part);
    assert.equal(view.path, identity);
    assert.equal(view.displayPath, "ab.txt");
    assert.equal(view.resolvedPath, resolvedPath);
    const handle = await reader.resolveFile("s", view.resolvedPath!);
    assert.equal(
      (await reader.read(handle, "s")).preview.text,
      "zero-width identity",
    );

    const tabView = projectToolEvidence(call("read", { path: "a\tb.txt" }));
    assert.equal(tabView.path, "a\tb.txt");
    assert.equal(tabView.displayPath, "a  b.txt");
    if (process.platform !== "win32") {
      // Windows filenames cannot contain tab characters.
      await writeFile(join(root, "a\tb.txt"), "tab identity");
      assert.equal(
        await readFile(join(root, tabView.path!), "utf8"),
        "tab identity",
      );
    }
    // Artifact policy still rejects controls; evidence must not silently retarget
    // the sanitized label to another real file to bypass that boundary.
    await assert.rejects(reader.resolveFile("s", tabView.path!), {
      code: "ARTIFACT_DENIED",
    });
  } finally {
    reader.dispose();
    await rm(root, { recursive: true, force: true });
  }
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
test("successful foreground completion does not invent an exit code or process state for other tools", () => {
  const result = projectMessage({ content: "done", isError: false });
  const foreground = projectToolEvidence(call("bash"), result);
  assert.equal(foreground.processState, "returned");
  assert.equal(foreground.exitCode, undefined);
  assert.equal(
    projectToolEvidence(call("subagent_check"), result).processState,
    "unknown",
  );
});
test("evidence admits exact UTF-8 path bytes and rejects oversized identities without fallback", () => {
  const budget = 4096;
  for (const exact of [
    "x".repeat(budget),
    "中".repeat(1365) + "x",
    "😀".repeat(1024),
  ]) {
    for (const path of [exact.slice(0, -2), exact]) {
      assert.equal(projectToolEvidence(call("read", { path })).path, path);
    }
    const path = exact + "x";
    const view = projectToolEvidence(call("read", { path }));
    assert.equal(view.path, undefined);
    assert.equal(view.resolvedPath, undefined);
    assert.equal(
      view.pathUnavailable,
      "File reference exceeds the evidence byte limit.",
    );
    assert.equal(view.truncated, true);
    for (const legacy of [
      {
        type: "toolCall" as const,
        name: "read",
        arguments: JSON.stringify({ path }),
      },
      {
        type: "toolCall" as const,
        name: "read",
        arguments: "{}",
        evidenceArguments: { path, resolvedPath: "short.txt" },
      },
      {
        type: "toolCall" as const,
        name: "read",
        arguments: "{}",
        evidenceArguments: { path: "short.txt", resolvedPath: path },
      },
    ]) {
      const projected = projectToolEvidence(legacy);
      assert.equal(projected.path, undefined);
      assert.equal(projected.resolvedPath, undefined);
    }
  }
});

test("production evidence serialization bounds raw and resolved 1 MiB paths", () => {
  const huge = "x".repeat(1024 * 1024);
  let resolutions = 0;
  for (const path of [huge, "short.txt"]) {
    const message = projectMessage(
      { content: [{ type: "toolCall", name: "read", arguments: { path } }] },
      () => {
        resolutions++;
        return huge;
      },
    );
    const part = message.parts?.[0];
    assert.ok(part?.type === "toolCall");
    const view = projectToolEvidence(part);
    assert.equal(view.path, undefined);
    assert.equal(view.resolvedPath, undefined);
    assert.ok(view.pathUnavailable);
    assert.ok(Buffer.byteLength(JSON.stringify(message)) < 64 * 1024);
    assert.ok(Buffer.byteLength(JSON.stringify(view)) < 64 * 1024);
    assert.ok(Buffer.byteLength(view.displayPath ?? "") <= 12 * 1024);
  }
  assert.equal(resolutions, 1);
  const exact = "中".repeat(1365) + "x";
  const projected = projectMessage(
    {
      content: [{ type: "toolCall", name: "read", arguments: { path: "ok" } }],
    },
    () => exact,
  );
  const part = projected.parts?.[0];
  assert.ok(part?.type === "toolCall");
  assert.equal(projectToolEvidence(part).resolvedPath, exact);
});

test("raw tool arguments cannot supply the trusted resolved evidence identity", () => {
  for (const path of ["~/.note", "@named/path", "report.md"]) {
    let resolverCalls = 0;
    const message = projectMessage(
      {
        content: [
          {
            type: "toolCall",
            name: "read",
            arguments: { path, resolvedPath: "different.txt" },
          },
        ],
      },
      () => {
        resolverCalls++;
        return "/workspace/report.md";
      },
    );
    const part = message.parts?.[0];
    assert.ok(part?.type === "toolCall");
    const view = projectToolEvidence(part);
    assert.equal(view.path, path);
    assert.equal(
      view.resolvedPath,
      path === "report.md" ? "/workspace/report.md" : undefined,
    );
    assert.equal(resolverCalls, path === "report.md" ? 1 : 0);
    const legacy = projectToolEvidence({
      type: "toolCall",
      name: "read",
      arguments: JSON.stringify({ path, resolvedPath: "different.txt" }),
    });
    assert.equal(legacy.path, path);
    assert.equal(legacy.resolvedPath, undefined);
  }
});
