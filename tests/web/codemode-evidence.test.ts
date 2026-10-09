import assert from "node:assert/strict";
import test from "node:test";
import { projectCodemodeEvidence } from "../../web/protocol/codemode.ts";
import { reduceLiveTools } from "../../web/protocol/live-tools.ts";
import { projectMessage } from "../../web/protocol/types.ts";

function call() {
  const part = projectMessage({
    content: [
      {
        type: "toolCall",
        id: "script",
        name: "codemode",
        arguments: { code: "await tools.read({path: 'report.md'});" },
      },
    ],
  }).parts?.[0];
  assert.ok(part?.type === "toolCall");
  return part;
}

test("native nested receipts preserve arguments, ordering and child failures independently of script success", () => {
  const message = projectMessage({
    role: "toolResult",
    isError: false,
    content: "Script completed\nOutput:\nretained error",
    details: {
      calls: [
        {
          id: "script/1",
          name: "read",
          args: '{"path":"incomplete...',
          status: "ok",
          durationMs: 5,
        },
        {
          id: "script/2",
          name: "bash",
          args: '{"command":"exit 7"}',
          status: "error",
          error: "Command exited with code 7",
        },
      ],
    },
    nestedCalls: {
      complete: true,
      calls: [
        {
          id: "script/1",
          name: "read",
          arguments: { path: "report.md", offset: 4 },
          status: "ok",
        },
        {
          id: "script/2",
          name: "bash",
          arguments: { command: "exit 7" },
          status: "error",
        },
        {
          id: "script/1/1",
          name: "read",
          arguments: { path: "nested.md" },
          status: "ok",
        },
      ],
    },
  });
  const view = projectCodemodeEvidence(call(), message);
  assert.equal(view.state, "returned");
  assert.deepEqual(
    view.calls.map((item) => item.id),
    ["script/1", "script/2", "script/1/1"],
  );
  assert.equal(view.calls[0]?.args?.path, "report.md");
  assert.equal(view.calls[0]?.durationMs, 5);
  assert.equal(view.calls[1]?.state, "failed");
  assert.equal(view.calls[1]?.error, "Command exited with code 7");
  assert.equal(view.partial, false);
  assert.ok(view.calls.every((item) => item.live === undefined));
});

test("incomplete preview JSON never manufactures a filename, while unfinished and cancelled calls retain uncertainty", () => {
  const result = {
    content: "",
    isError: false,
    details: {
      calls: [
        {
          id: "script/?",
          name: "read",
          args: '{"path":"incomplete...',
          status: "running",
        },
        {
          id: "script/2",
          name: "bash",
          args: "{}",
          status: "cancelled",
          durationMs: -2,
        },
      ],
    },
  };
  const view = projectCodemodeEvidence(call(), result);
  assert.equal(view.calls[0]?.args, undefined);
  assert.equal(view.calls[0]?.argumentsText, '{"path":"incomplete...');
  assert.equal(view.calls[0]?.state, "unknown");
  assert.equal(view.calls[1]?.state, "cancelled");
  assert.equal(view.calls[1]?.durationMs, undefined);
  assert.equal(
    projectCodemodeEvidence(call(), result, "running").calls[0]?.state,
    "running",
  );
  const fallback = projectCodemodeEvidence(call(), {
    content: "",
    nestedCalls: {
      complete: false,
      calls: [
        {
          id: "script/1",
          name: "read",
          arguments: { path: "report.md" },
          status: "unfinished",
        },
      ],
    },
  });
  assert.equal(fallback.state, "unknown");
  assert.equal(fallback.calls[0]?.state, "unknown");
  assert.equal(fallback.partial, true);
});

test("live child output requires exact native id, name and parent and is cleared across Sessions", () => {
  const child = {
    type: "toolCall" as const,
    id: "script/1",
    name: "read",
    arguments: '{"path":"report.md"}',
  };
  let live = reduceLiveTools([], "tool_execution_start", {
    toolCallId: child.id,
    parentToolCallId: "script",
    call: child,
  });
  live = reduceLiveTools(live, "tool_execution_end", {
    toolCallId: child.id,
    result: { content: "actual child output", isError: false },
    isError: false,
  });
  assert.equal(live[0]?.parentToolCallId, "script");
  const result = {
    content: "",
    details: { calls: [{ id: child.id, name: child.name, status: "ok" }] },
  };
  assert.equal(
    projectCodemodeEvidence(call(), result, "running", live).calls[0]?.live
      ?.result?.content,
    "actual child output",
  );
  for (const item of [
    { ...live[0]!, parentToolCallId: "other" },
    { ...live[0]!, call: { ...child, name: "bash" } },
  ])
    assert.equal(
      projectCodemodeEvidence(call(), result, "running", [item]).calls[0]?.live,
      undefined,
    );
  assert.deepEqual(reduceLiveTools(live, "session_switched", {}), []);
});

test("nested receipts are bounded projections and never invoke accessors or mutate native data", () => {
  const nested = {
    complete: true,
    calls: Array.from({ length: 256 }, (_, index) => ({
      id: `script/${index}`,
      name: "read",
      status: "ok",
      arguments: { path: "x".repeat(8000) },
    })),
  };
  const source = { role: "toolResult", content: "", nestedCalls: nested };
  const projected = projectMessage(source);
  assert.equal(projected.truncation?.nestedCalls, true);
  assert.equal(projected.nestedCalls, undefined);
  assert.equal(projectCodemodeEvidence(call(), projected).partial, true);
  assert.equal(nested.calls.length, 256);
  assert.equal(nested.complete, true);
  let invoked = false;
  const getter = Object.defineProperty(
    { role: "toolResult", content: "" },
    "nestedCalls",
    {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("getter");
      },
    },
  );
  assert.equal(projectMessage(getter).nestedCalls, undefined);
  assert.equal(invoked, false);
  assert.equal(
    projectMessage({ role: "assistant", nestedCalls: nested }).nestedCalls,
    undefined,
  );
});
