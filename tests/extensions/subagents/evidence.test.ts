import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  SessionManager,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { projectDelegationCompletion } from "../../../extensions/shared/delegation-completion.ts";
import {
  queryDirectEvidence,
  DIRECT_EVIDENCE_MAX_BYTES,
} from "../../../extensions/subagents/src/evidence.ts";
import type { DirectEvidenceBinding } from "../../../extensions/subagents/src/domain.ts";

function fixture() {
  const parent = SessionManager.inMemory("/fixture");
  const origin = parent.appendCustomEntry("origin", {});
  const completion = projectDelegationCompletion({
    owner: "direct",
    executionId: "sa-1:run:1",
    outcome: "success",
  });
  const binding: DirectEvidenceBinding = {
    generation: 1,
    sessionId: "12345678-1234-1234-1234-123456789abc",
    sessionPath: "/private/session.jsonl",
    startEntryId: "start",
    endEntryId: "end",
    finalEntryId: "end",
    sealed: true,
    parentBound: true,
    parentSessionId: parent.getSessionId(),
    parentOriginEntryId: origin,
    structured: { status: "not-run" },
  };
  const header = { type: "session", id: binding.sessionId };
  const entries = [
    { type: "custom", id: "start", parentId: null },
    {
      type: "message",
      id: "end",
      parentId: "start",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first output" }],
      },
    },
    {
      type: "message",
      id: "followup",
      parentId: "end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "second output" }],
      },
    },
  ];
  let source = [header, ...entries]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  const reads: string[] = [];
  let denied = false;
  let oversized = false;
  const ctx = {
    sessionManager: parent,
    executeTool: async (name: string, args: { path: string }) => {
      assert.equal(name, "read");
      reads.push(args.path);
      return {
        isError: denied,
        result: {
          content: [{ type: "text", text: source }],
          details: { truncation: { truncated: oversized } },
        },
      };
    },
  } as unknown as ExtensionToolContext;
  const save = (
    evidence: DirectEvidenceBinding | undefined = binding,
    origin: string = "model",
  ) =>
    parent.appendCustomEntry("subagent-finished", {
      id: "sa-1",
      origin,
      evidence,
      completion,
    });
  save();
  return {
    parent,
    origin,
    completion,
    binding,
    entries,
    header,
    ctx,
    reads,
    save,
    setSource: (text: string) => {
      source = text;
    },
    deny: () => {
      denied = true;
    },
    oversized: () => {
      oversized = true;
    },
  };
}

test("owner generation retrieval survives follow-up and does not include subsequent entries", async () => {
  const f = fixture();
  f.save({
    ...f.binding,
    generation: 2,
    startEntryId: "end",
    endEntryId: "followup",
    finalEntryId: "followup",
  });
  const first = await queryDirectEvidence(f.ctx, {
    id: "sa-1",
    generation: 1,
    evidence: "transcript",
  });
  const second = await queryDirectEvidence(f.ctx, {
    id: "sa-1",
    generation: 2,
    evidence: "final",
  });
  assert.equal(first.status, "available");
  assert.equal(second.status, "available");
  assert.ok(
    "text" in first &&
      first.text.includes("first output") &&
      !first.text.includes("second output"),
  );
  assert.ok("text" in second && second.text.includes("second output"));
  const receipt = await queryDirectEvidence(f.ctx, {
    id: "sa-1",
    generation: 1,
  });
  assert.deepEqual(
    "completion" in receipt ? receipt.completion : undefined,
    f.completion,
  );
  assert.equal(JSON.stringify(receipt).includes("/private"), false);
});

test("active parent branch, model origin, UUID and child anchor ancestry fail closed", async () => {
  for (const mode of [
    "branch",
    "origin",
    "uuid",
    "ancestry",
    "parent-session",
    "unsealed",
    "pruned",
    "legacy",
  ] as const) {
    const f = fixture();
    if (mode === "branch") f.parent.branch(f.origin);
    if (mode === "origin") f.save(f.binding, "btw");
    if (mode === "uuid") f.save({ ...f.binding, sessionId: "fake" });
    if (mode === "ancestry") f.save({ ...f.binding, startEntryId: "followup" });
    if (mode === "parent-session")
      f.save({ ...f.binding, parentSessionId: "other" });
    if (mode === "unsealed") f.save({ ...f.binding, sealed: false });
    if (mode === "pruned") f.setSource(JSON.stringify(f.header));
    if (mode === "legacy")
      f.parent.appendCustomEntry("subagent-finished", {
        id: "sa-1",
        origin: "model",
      });
    const result = await queryDirectEvidence(f.ctx, {
      id: "sa-1",
      evidence: "transcript",
    });
    assert.equal(result.status, "unavailable", mode);
  }
});

test("denied, oversized, mismatched and failed persistence are unavailable without bypass", async () => {
  for (const mode of ["denied", "oversized", "mismatch", "failed"] as const) {
    const f = fixture();
    if (mode === "denied") f.deny();
    if (mode === "oversized") f.oversized();
    if (mode === "mismatch")
      f.setSource(JSON.stringify({ ...f.header, id: "other" }));
    if (mode === "failed")
      f.save({ ...f.binding, structured: { status: "failed" } });
    assert.equal(
      (
        await queryDirectEvidence(f.ctx, {
          id: "sa-1",
          evidence: mode === "failed" ? "structured" : "transcript",
        })
      ).status,
      "unavailable",
    );
    assert.deepEqual(f.reads, [f.binding.sessionPath]);
  }
});

test("parseable malformed Session entries are unavailable before indexing or final selection", async () => {
  const malformed: unknown[] = [
    null,
    false,
    42,
    "entry",
    [],
    { type: "custom", parentId: null },
    { type: "custom", id: null, parentId: null },
    { type: "custom", id: 42, parentId: null },
    { type: "custom", id: "", parentId: null },
    { type: "custom", id: "end" },
    { type: "custom", id: "end", parentId: {} },
    { id: "end", parentId: "start" },
    ...[
      undefined,
      null,
      false,
      "assistant",
      {},
      { role: "assistant" },
      { role: "assistant", content: null },
      { role: "assistant", content: "text" },
      { role: "assistant", content: [null] },
      { role: "assistant", content: [{ type: "text", text: 42 }] },
      { role: "assistant", content: [{ type: "thinking" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call", name: "read" }],
      },
    ].map((message) => ({
      type: "message",
      id: "end",
      parentId: "start",
      message,
    })),
  ];
  for (const entry of malformed) {
    for (const evidence of ["transcript", "final", "structured"] as const) {
      const f = fixture();
      f.setSource(
        [f.header, f.entries[0], entry]
          .map((value) => JSON.stringify(value))
          .join("\n"),
      );
      const result = await queryDirectEvidence(f.ctx, { id: "sa-1", evidence });
      assert.deepEqual(
        result,
        { status: "unavailable", reason: "invalid-session" },
        JSON.stringify(entry),
      );
      assert.deepEqual(f.reads, [f.binding.sessionPath]);
    }
  }
});

test("corrupt evidence validation does not swallow read cancellation", async () => {
  const f = fixture();
  f.setSource([JSON.stringify(f.header), "null"].join("\n"));
  const controller = new AbortController();
  const read = f.ctx.executeTool;
  f.ctx.executeTool = async (name, args, options) => {
    const result = await read(name, args, options);
    controller.abort();
    return result;
  };
  await assert.rejects(
    queryDirectEvidence(
      f.ctx,
      { id: "sa-1", evidence: "final" },
      controller.signal,
    ),
    { name: "AbortError" },
  );
});

test("pagination is lossless and counts escaped bytes, not just characters", async () => {
  const f = fixture();
  f.entries[1].message!.content[0].text = "\u0000😀".repeat(2000);
  f.setSource(
    [f.header, ...f.entries].map((entry) => JSON.stringify(entry)).join("\n"),
  );
  let offset = 0;
  let recovered = "";
  let more = true;
  do {
    const page = await queryDirectEvidence(f.ctx, {
      id: "sa-1",
      evidence: "final",
      offset,
      limit: 4096,
    });
    assert.equal(page.status, "available");
    assert.ok("text" in page);
    assert.ok(
      Buffer.byteLength(JSON.stringify(page)) <= DIRECT_EVIDENCE_MAX_BYTES,
    );
    recovered += page.text;
    more = page.nextOffset !== undefined;
    if (page.nextOffset !== undefined) {
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    }
  } while (more);
  assert.equal(recovered, JSON.stringify(f.entries[1].message));
});

test("structured artifact uses its private binding and validates original content", async () => {
  const f = fixture();
  const json = '{"answer":42}';
  f.save({
    ...f.binding,
    structured: {
      status: "saved",
      path: "/private/artifact.json",
      digest: createHash("sha256").update(json).digest("hex"),
    },
  });
  const readSession = f.ctx.executeTool;
  f.ctx.executeTool = async (name, args, options) => {
    if ((args as { path: string }).path === "/private/artifact.json")
      return {
        toolCall: { type: "toolCall", id: "nested", name, arguments: {} },
        isError: false,
        result: { content: [{ type: "text", text: json }], details: {} },
      };
    return readSession(name, args, options);
  };
  const result = await queryDirectEvidence(f.ctx, {
    id: "sa-1",
    evidence: "structured",
  });
  assert.ok("text" in result && result.text === json);
});
