import assert from "node:assert/strict";
import test from "node:test";
import type { LiveToolEvidence } from "../../web/protocol/evidence.ts";
import { reduceLiveTools } from "../../web/protocol/live-tools.ts";
import { projectMessage } from "../../web/protocol/types.ts";
import { codemodeChildren } from "../../web/ui/src/features/transcript/codemode-tools.ts";

function call(id: string, name: string, args: Record<string, unknown> = {}) {
  const part = projectMessage({
    content: [{ type: "toolCall", id, name, arguments: args }],
  }).parts?.[0];
  assert.ok(part?.type === "toolCall");
  return part;
}
const outer = call("code", "codemode", {
  code: "text(await tools.read({path:'file.ts'}));",
});
function result(calls: unknown[], extra = {}) {
  return projectMessage({
    role: "toolResult",
    toolName: "codemode",
    toolCallId: "code",
    isError: false,
    content: [{ type: "text", text: "script output" }],
    nestedCalls: { calls, complete: true },
    ...extra,
  });
}

test("native nested records survive projection and reload without invented result bodies", () => {
  const projected = result([
    {
      id: "code/1",
      name: "read",
      arguments: { path: "file.ts" },
      status: "ok",
    },
    {
      id: "code/2",
      name: "edit",
      arguments: { path: "file.ts", newText: "not a diff" },
      status: "error",
      error: "not found",
    },
  ]);
  const view = codemodeChildren(
    outer,
    JSON.parse(JSON.stringify(projected)),
    [],
  );
  assert.deepEqual(
    view?.children.map((item) => [
      item.call.name,
      item.state,
      item.outputMissing,
    ]),
    [
      ["read", "returned", true],
      ["edit", "failed", true],
    ],
  );
  assert.equal(view?.children[0]?.result, undefined);
  assert.equal(view?.children[1]?.error, "not found");
  assert.equal(view?.showWrapper, false);
});

test("parallel native events retain start order, parent identity and exact tool output", () => {
  let live: LiveToolEvidence[] = [];
  for (const [id, name] of [
    ["code/1", "read"],
    ["code/2", "bash"],
  ]) {
    live = reduceLiveTools(live, "tool_execution_start", {
      toolCallId: id,
      parentToolCallId: "code",
      call: call(id!, name!),
    });
  }
  live = reduceLiveTools(live, "tool_execution_end", {
    toolCallId: "code/2",
    isError: false,
    result: { content: "shell", isError: false },
  });
  live = reduceLiveTools(live, "tool_execution_update", {
    toolCallId: "code/1",
    result: { content: "partial" },
  });
  const view = codemodeChildren(outer, undefined, live, "running");
  assert.deepEqual(
    view?.children.map((item) => [item.call.id, item.state]),
    [
      ["code/1", "running"],
      ["code/2", "returned"],
    ],
  );
  assert.equal(view?.children[1]?.result?.content, "shell");
  assert.equal(live[1]?.parentToolCallId, "code");
  assert.equal(view?.showWrapper, false);
  assert.equal(
    codemodeChildren(outer, undefined, [
      { call: call("code/3", "read"), state: "running" },
    ])?.children.length,
    0,
    "id prefix alone never establishes parentage",
  );
});

test("cancellation, unfinished calls and wrapper failure remain separate terminal facts", () => {
  const projected = result(
    [
      {
        id: "code/1",
        name: "bash",
        arguments: { command: "long" },
        status: "error",
      },
      {
        id: "code/2",
        name: "read",
        arguments: { path: "other" },
        status: "unfinished",
      },
    ],
    {
      isError: true,
      details: { calls: [{ id: "code/1", name: "bash", status: "cancelled" }] },
    },
  );
  const view = codemodeChildren(outer, projected, []);
  assert.deepEqual(
    view?.children.map((item) => item.state),
    ["cancelled", "unknown"],
  );
  assert.equal(view?.showWrapper, true);
  assert.equal(view?.incomplete, true);
  assert.equal(codemodeChildren(outer, result([]), [])?.showWrapper, true);
  assert.equal(
    codemodeChildren(outer, { content: "syntax error", isError: true }, [])
      ?.showWrapper,
    true,
  );
  assert.equal(
    codemodeChildren(outer, { ...projected, forkSnapshotToolResult: true }, []),
    undefined,
  );
});

test("bounded records mark omissions, reject duplicate identity and never parse JavaScript", () => {
  const projected = result([
    { id: "code/1", name: "read", status: "ok", argumentsBytes: 9000 },
    { id: "code/1", name: "write", arguments: {}, status: "ok" },
    { id: "code/3", name: "read", arguments: {}, status: "invented-success" },
  ]);
  assert.equal(projected.nestedCalls?.complete, false);
  assert.equal(projected.nestedCalls?.calls.length, 1);
  assert.equal(projected.nestedCalls?.calls[0]?.argumentsOmitted, true);
  assert.deepEqual(codemodeChildren(outer, undefined, [])?.children, []);
  const huge = result(
    Array.from({ length: 300 }, (_, index) => ({
      id: `code/${index}`,
      name: "read",
      arguments: { path: "x".repeat(7000) },
      status: "ok",
    })),
  );
  assert.equal(huge.nestedCalls?.complete, false);
  assert.ok(Buffer.byteLength(JSON.stringify(huge.nestedCalls)) < 66 * 1024);
});

test("persisted terminal records supersede running events and foreign snapshots", () => {
  const live: LiveToolEvidence[] = [
    {
      call: call("code/1", "read"),
      parentToolCallId: "code",
      state: "running",
    },
  ];
  const view = codemodeChildren(
    outer,
    result([{ id: "code/1", name: "read", arguments: {}, status: "ok" }]),
    live,
  );
  assert.equal(view?.children[0]?.state, "returned");
  assert.equal(view?.showWrapper, false);
  const contradictory = result(
    [{ id: "code/1", name: "read", arguments: {}, status: "ok" }],
    { details: { calls: [{ id: "code/1", status: "cancelled" }] } },
  );
  assert.equal(
    codemodeChildren(outer, contradictory, [])?.children[0]?.state,
    "returned",
    "display ledger cannot override native success",
  );
  assert.deepEqual(reduceLiveTools(live, "session_switched", {}), []);
});

test("a native tool ledger never hides separate model-call failures or unresolved terminal identities", () => {
  const native = [
    { id: "code/1", name: "read", arguments: { path: "a" }, status: "ok" },
  ];
  for (const entry of [
    {
      id: "code/models.classify/1",
      name: "models.classify",
      status: "error",
      error: "provider failed",
    },
    { id: "code/?", name: "bash", status: "cancelled" },
  ]) {
    const projected = result(native, {
      details: { calls: [{ ...native[0] }, entry] },
    });
    const view = codemodeChildren(outer, projected, []);
    assert.equal(view?.children[0]?.state, "returned");
    assert.equal(view?.showWrapper, true);
    assert.equal(view?.incomplete, true);
  }
});

test("late exact native terminal evidence refines unfinished history without overriding recorded final status", () => {
  const live: LiveToolEvidence[] = [
    {
      call: call("code/1", "bash"),
      parentToolCallId: "code",
      state: "failed",
      result: {
        content: "Command aborted",
        isError: true,
        terminalReceipt: { state: "cancelled" },
      },
    },
  ];
  for (const [status, expected] of [
    ["unfinished", "cancelled"],
    ["ok", "returned"],
    ["error", "failed"],
  ]) {
    const projected = result([
      { id: "code/1", name: "bash", arguments: {}, status },
    ]);
    assert.equal(
      codemodeChildren(outer, projected, live)?.children[0]?.state,
      expected,
    );
  }
  const pending = [
    { ...live[0]!, state: "running" as const, result: undefined },
  ];
  const disconnected = [
    {
      ...live[0]!,
      state: "unknown" as const,
      result: { content: "partial", isError: false },
    },
  ];
  assert.equal(
    codemodeChildren(
      outer,
      result([
        { id: "code/1", name: "bash", arguments: {}, status: "unfinished" },
      ]),
      disconnected,
    )?.children[0]?.state,
    "unknown",
    "an unobserved partial result is not a final receipt",
  );
  assert.equal(
    codemodeChildren(
      outer,
      result([
        { id: "code/1", name: "bash", arguments: {}, status: "unfinished" },
      ]),
      pending,
    )?.children[0]?.state,
    "unknown",
  );
});
