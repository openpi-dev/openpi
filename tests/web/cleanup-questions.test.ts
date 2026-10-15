import assert from "node:assert/strict";
import test from "node:test";
import { cleanupQuestions } from "../../extensions/shared/web-cleanup-confirmation.ts";
import {
  type QuestionOwner,
  WebQuestionBroker,
} from "../../web/host/questions.ts";

const owner: QuestionOwner = {
  workspace: "/workspace",
  sessionId: "session",
  commandId: "prompt",
  epoch: 1,
  controllerId: "ea1e029c-363a-47cf-a917-889e5d0ab477",
};
const cleanup = { workspace: "/workspace", paths: ["keep.txt"] };
function decision(body: object) {
  return "cleanupDecision" in body ? body.cleanupDecision : undefined;
}
const approve = [{ id: "cleanup", selected: "Approve exact deletion" }];

test("cleanup terminal preserves original decision after the native turn settles", async () => {
  let current: QuestionOwner | undefined = owner;
  const broker = new WebQuestionBroker(
    () => current,
    () => {},
  );
  const outcome = broker.request(
    "tool",
    cleanupQuestions(cleanup),
    undefined,
    undefined,
    cleanup,
  );
  const pending = broker.read(owner.sessionId, owner.controllerId)!;
  assert.equal(
    broker.answer(
      owner.sessionId,
      pending.requestId,
      owner.controllerId,
      "answer",
      [{ ...approve[0], note: "only if safe" }],
    ).status,
    400,
  );
  assert.equal(
    decision(
      broker.answer(
        owner.sessionId,
        pending.requestId,
        owner.controllerId,
        "answer",
        approve,
      ).body,
    ),
    "approved",
  );
  await outcome;
  current = undefined;
  assert.equal(
    decision(
      broker.answer(
        owner.sessionId,
        pending.requestId,
        owner.controllerId,
        "dismiss",
        undefined,
      ).body,
    ),
    "approved",
  );
  assert.deepEqual(
    broker.receipt(owner.sessionId, pending.requestId, owner.controllerId)
      ?.cleanupDecision,
    "approved",
  );
  assert.equal(
    broker.receipt(owner.sessionId, pending.requestId, "another-controller"),
    null,
  );
});

for (const terminal of ["denied", "cancelled", "expired", "stale"] as const) {
  test(`cleanup ${terminal} is recoverable and cannot turn into approval`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let current: QuestionOwner | undefined = owner;
    const broker = new WebQuestionBroker(
      () => current,
      () => {},
      100,
    );
    const controller = new AbortController();
    const outcome = broker.request(
      "tool",
      cleanupQuestions(cleanup),
      controller.signal,
      undefined,
      cleanup,
    );
    const pending = broker.read(owner.sessionId, owner.controllerId)!;
    if (terminal === "denied")
      broker.answer(
        owner.sessionId,
        pending.requestId,
        owner.controllerId,
        "dismiss",
        undefined,
      );
    if (terminal === "cancelled") controller.abort();
    if (terminal === "expired") t.mock.timers.tick(101);
    if (terminal === "stale") {
      current = undefined;
      broker.reconcile();
    }
    await outcome;
    const recovered = broker.receipt(
      owner.sessionId,
      pending.requestId,
      owner.controllerId,
    )!;
    assert.equal(recovered.cleanupDecision, terminal);
    assert.deepEqual(recovered.cleanupTarget, cleanup);
    assert.equal(
      decision(
        broker.answer(
          owner.sessionId,
          pending.requestId,
          owner.controllerId,
          "answer",
          approve,
        ).body,
      ),
      terminal,
    );
    assert.equal(
      broker.receipt("other-session", pending.requestId, owner.controllerId),
      null,
    );
  });
}

test("cleanup owner and exact targets are immutable snapshots; oversized requests are unavailable", async () => {
  const original = { ...owner };
  const target = { ...cleanup, paths: ["keep.txt"] };
  const broker = new WebQuestionBroker(
    () => original,
    () => {},
  );
  const result = broker.request(
    "tool",
    cleanupQuestions(target),
    undefined,
    undefined,
    target,
  );
  const pending = broker.read(owner.sessionId, owner.controllerId)!;
  target.paths[0] = "other.txt";
  broker.answer(
    owner.sessionId,
    pending.requestId,
    owner.controllerId,
    "answer",
    approve,
  );
  await result;
  original.controllerId = "foreign";
  const receipt = broker.receipt(
    owner.sessionId,
    pending.requestId,
    owner.controllerId,
  )!;
  assert.deepEqual(receipt.cleanupTarget?.paths, ["keep.txt"]);
  receipt.cleanupTarget!.paths = ["client mutation"];
  assert.deepEqual(
    broker.receipt(owner.sessionId, pending.requestId, owner.controllerId)
      ?.cleanupTarget?.paths,
    ["keep.txt"],
  );
  const huge = { ...cleanup, paths: ["x".repeat(3000)] };
  assert.deepEqual(
    await broker.request(
      "tool",
      cleanupQuestions(huge),
      undefined,
      undefined,
      huge,
    ),
    { kind: "unavailable" },
  );
  assert.equal(
    new WebQuestionBroker(
      () => owner,
      () => {},
    ).receipt(owner.sessionId, pending.requestId, owner.controllerId),
    null,
  );
});
