import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPLETION_MAX_BYTES,
  type DelegationCompletionFacts,
  delegationCompletionText,
  projectDelegationCompletion,
} from "../../../extensions/shared/delegation-completion.ts";

const facts = {
  owner: "direct" as const,
  executionId: "sa-1:run:1",
  outcome: "success" as const,
  evidenceRef: "child-session.jsonl",
  effectiveCwd: "/shared",
  isolation: "shared" as const,
  tools: [{ callId: "tool-1", name: "bash", isError: false }],
  textRef: "child-session.jsonl#assistant",
};

test("completion separates tool returns and model claims from verification/process exit", () => {
  const receipt = projectDelegationCompletion(facts);
  assert.equal(receipt.observed.outcome, "success");
  assert.equal(receipt.observed.tools.items[0]?.returned, "success");
  assert.equal(receipt.observed.tools.items[0]?.processExit.status, "unknown");
  assert.equal(receipt.verification.status, "unknown");
  assert.equal(receipt.verification.automatic.status, "not-run");
  assert.equal(receipt.workspace.attribution, "unknown");
  assert.equal(receipt.modelClaimed.textRef, facts.textRef);
  assert.equal(JSON.stringify(receipt).includes("tests passed"), false);
});

test("completion remains bounded and marks partial tool coverage", () => {
  const receipt = projectDelegationCompletion({
    ...facts,
    tools: Array.from({ length: 40 }, (_, index) => ({
      callId: `tool-${index}`,
      name: "bash",
      isError: false,
    })),
  });
  assert.equal(receipt.observed.tools.items.length, 16);
  assert.equal(receipt.observed.tools.omitted, 24);
  assert.equal(receipt.observed.tools.coverage, "partial");
});

test("replay does not invent an original execution; isolated evidence is not exclusive authorship", () => {
  const receipt = projectDelegationCompletion({
    ...facts,
    owner: "workflow",
    outcome: "replayed",
    replay: { origin: "unknown" },
    isolation: "worktree",
    handoffRef: "worktree-handoff.json",
    persistence: "failed",
  });
  assert.equal(receipt.replay?.newExecution, false);
  assert.equal(receipt.replay?.origin, "unknown");
  assert.equal(receipt.workspace.attribution, "checkout-only");
  assert.equal(receipt.workspace.handoffRef, "worktree-handoff.json");
  assert.equal(receipt.persistence.status, "failed");
});

test("oversized references become unavailable, not fabricated truncated paths", () => {
  const huge = "x".repeat(100_000);
  const receipt = projectDelegationCompletion({
    ...facts,
    evidenceRef: huge,
    executionId: huge,
    textRef: huge,
    tools: Array.from({ length: 100 }, () => ({
      callId: huge,
      name: huge,
      isError: false,
    })),
    replay: { origin: { executionId: huge, evidenceRef: huge } },
  });
  assert.equal(receipt.identity.executionId, "unknown");
  assert.equal(receipt.observed.evidenceRef, undefined);
  assert.equal(receipt.modelClaimed.status, "unknown");
  assert.equal(receipt.replay?.origin, "unknown");
  assert.ok(Buffer.byteLength(JSON.stringify(receipt), "utf8") < 16 * 1024);
});

test("completion has an aggregate UTF-8 budget even with near-limit references", () => {
  const ref = "x".repeat(4096);
  const input = {
    ...facts,
    executionId: ref,
    evidenceRef: ref,
    toolEvidenceRef: ref,
    textRef: ref,
    structuredRef: ref,
    handoffRef: ref,
    requestedCwd: ref,
    effectiveCwd: ref,
    tools: Array.from({ length: 40 }, () => ({
      callId: "y".repeat(512),
      name: "\u0000".repeat(128),
    })),
    replay: { origin: { executionId: ref, evidenceRef: ref } },
  };
  const receipt = projectDelegationCompletion(input);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 16 * 1024);
  assert.ok(Buffer.byteLength(delegationCompletionText(receipt)) <= 16 * 1024);
  assert.equal(
    receipt.observed.tools.items.length + receipt.observed.tools.omitted,
    40,
  );
  assert.deepEqual(projectDelegationCompletion(input), receipt);
  assert.equal(input.tools.length, 40);
  assert.equal(input.textRef, ref);
  const escaped = projectDelegationCompletion({
    ...input,
    executionId: "\u0000".repeat(4096),
    evidenceRef: "\u0000".repeat(4096),
    textRef: "\u0000".repeat(4096),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(escaped)) <= 16 * 1024);
  assert.equal(escaped.identity.executionId, "unknown");
});

test("runtime enum fields cannot inject unbounded strings or objects", () => {
  for (const invalid of [
    "x".repeat(100_000),
    { payload: "x".repeat(100_000) },
    null,
  ]) {
    const input = {
      ...facts,
      owner: invalid,
      outcome: invalid,
      isolation: invalid,
      persistence: invalid,
      referenceKind: invalid,
    } as unknown as DelegationCompletionFacts;
    const receipt = projectDelegationCompletion(input);
    assert.ok(
      Buffer.byteLength(JSON.stringify(receipt)) <= COMPLETION_MAX_BYTES,
    );
    assert.equal(receipt.identity.owner, "unknown");
    assert.equal(receipt.observed.outcome, "uncertain");
    assert.equal(receipt.workspace.isolation, "unknown");
    assert.equal(receipt.workspace.attribution, "unknown");
    assert.equal(receipt.persistence.status, "unknown");
    assert.equal(receipt.observed.referenceKind, "unknown");
    assert.equal(receipt.modelClaimed.referenceKind, "unknown");
  }
});

test("replay copies only bounded decoded origin fields, never runtime payloads", () => {
  const huge = "x".repeat(100_000);
  for (const origin of [
    huge,
    null,
    {},
    { executionId: huge, evidenceRef: huge },
    { executionId: {}, evidenceRef: [] },
  ]) {
    const receipt = projectDelegationCompletion({
      ...facts,
      replay: { origin, payload: huge },
    } as unknown as DelegationCompletionFacts);
    assert.deepEqual(receipt.replay, {
      newExecution: false,
      origin: "unknown",
    });
    assert.ok(
      Buffer.byteLength(JSON.stringify(receipt)) <= COMPLETION_MAX_BYTES,
    );
  }
  const origin = {
    executionId: "original-run",
    evidenceRef: "original.jsonl",
    payload: huge,
  };
  const receipt = projectDelegationCompletion({ ...facts, replay: { origin } });
  assert.deepEqual(receipt.replay?.origin, {
    executionId: "original-run",
    evidenceRef: "original.jsonl",
  });
  assert.notEqual(receipt.replay?.origin, origin);
  assert.equal(origin.payload, huge);
});

test("reference metadata becomes unknown when all corresponding locators are unavailable", () => {
  for (const referenceKind of ["fingerprint", "owner-locator"] as const) {
    for (const ref of ["x".repeat(100_000), "\u0000".repeat(4096)]) {
      const receipt = projectDelegationCompletion({
        ...facts,
        referenceKind,
        executionId: ref,
        evidenceRef: ref,
        toolEvidenceRef: ref,
        textRef: ref,
        structuredRef: ref,
        handoffRef: ref,
        branch: "\u0000".repeat(512),
        baseSha: "\u0000".repeat(128),
        replay: { origin: { executionId: ref, evidenceRef: ref } },
      });
      assert.ok(
        Buffer.byteLength(JSON.stringify(receipt)) <= COMPLETION_MAX_BYTES,
      );
      assert.equal(receipt.identity.executionId, "unknown");
      assert.equal(receipt.observed.evidenceRef, undefined);
      assert.equal(receipt.observed.tools.evidenceRef, undefined);
      assert.equal(receipt.observed.referenceKind, "unknown");
      assert.equal(receipt.modelClaimed.textRef, undefined);
      assert.equal(receipt.modelClaimed.structuredRef, undefined);
      assert.equal(receipt.modelClaimed.status, "unknown");
      assert.equal(receipt.modelClaimed.referenceKind, "unknown");
    }
    const retained = projectDelegationCompletion({ ...facts, referenceKind });
    assert.equal(retained.observed.referenceKind, referenceKind);
    assert.equal(retained.modelClaimed.referenceKind, referenceKind);
  }
});

test("cwd identifiers disclose neither host paths nor sensitive components", () => {
  for (const cwd of [
    "/Users/private-host/sensitive-project",
    "C:\\Users\\private-host\\sensitive-project",
  ]) {
    const receipt = projectDelegationCompletion({
      ...facts,
      requestedCwd: cwd,
      effectiveCwd: cwd,
    });
    const text = JSON.stringify(receipt) + delegationCompletionText(receipt);
    for (const sensitive of [cwd, "private-host", "sensitive-project"])
      assert.equal(text.includes(sensitive), false);
    assert.equal(receipt.workspace.effectiveCwd, undefined);
    assert.equal(receipt.workspace.requestedCwd, undefined);
    assert.equal(
      receipt.workspace.effectiveCwd,
      receipt.workspace.requestedCwd,
    );
  }
});

for (const outcome of ["failure", "cancelled", "uncertain"] as const) {
  test(`completion preserves ${outcome} without acceptance judgment`, () => {
    assert.equal(
      projectDelegationCompletion({ ...facts, outcome }).observed.outcome,
      outcome,
    );
  });
}
