import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyInterruptedInvocation,
  createInvocationIdentity,
  decodeInvocationRecord,
  requestInvocation,
  transitionInvocation,
  type InvocationIdentity,
  type InvocationRecord,
} from "./invocation-ledger.ts";

function requested(callIndex = 1) {
  return requestInvocation(createInvocationIdentity("run-123", callIndex), 10);
}

function running(callIndex = 1) {
  const claimed = transitionInvocation(requested(callIndex), {
    status: "claimed",
    at: 20,
  });
  return transitionInvocation(claimed, { status: "running", at: 30 });
}

test("identity requires a nonblank run id and a positive safe call index", () => {
  assert.deepEqual(createInvocationIdentity("run-123", 1), {
    runId: "run-123",
    callIndex: 1,
  });

  for (const runId of ["", " ", "\n\t"]) {
    assert.throws(
      () => createInvocationIdentity(runId, 1),
      /runId must be a nonblank string/,
    );
  }
  for (const callIndex of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createInvocationIdentity("run-123", callIndex),
      /callIndex must be a positive safe integer/,
    );
  }
});

test("a call advances requested -> claimed -> running -> settled success", () => {
  const identity = createInvocationIdentity("run-123", 2);
  const request = requestInvocation(identity, 10);
  const claim = transitionInvocation(request, { status: "claimed", at: 20 });
  const start = transitionInvocation(claim, { status: "running", at: 30 });
  const settle = transitionInvocation(start, {
    status: "settled",
    outcome: "success",
    at: 40,
  });

  assert.deepEqual(settle, {
    identity: { runId: "run-123", callIndex: 2 },
    intentState: "requested",
    admissionState: "claimed",
    executionState: "settled",
    outcome: "success",
    requestedAt: 10,
    claimedAt: 20,
    runningAt: 30,
    terminalAt: 40,
  });
  assert.equal(
    request.admissionState,
    "pending",
    "transitions return new snapshots",
  );
  assert.equal(claim.admissionState, "claimed");
  assert.equal(claim.executionState, "pending");
  assert.equal(start.executionState, "running");
  assert.ok(Object.isFrozen(identity));
  assert.ok(Object.isFrozen(settle));
  assert.ok(Object.isFrozen(settle.identity));
  assert.deepEqual(JSON.parse(JSON.stringify(settle)), settle);
});

test("a running call can settle with an error outcome", () => {
  const settled = transitionInvocation(running(), {
    status: "settled",
    outcome: "error",
    at: 40,
  });

  assert.equal(settled.admissionState, "claimed");
  assert.equal(settled.executionState, "settled");
  assert.equal(settled.outcome, "error");
  assert.equal(settled.terminalAt, 40);
});

test("a request may terminate as replayed or rejected instead of running", () => {
  const replayed = transitionInvocation(requested(1), {
    status: "replayed",
    at: 11,
  });
  const rejected = transitionInvocation(requested(2), {
    status: "rejected",
    at: 12,
  });

  assert.deepEqual(replayed, {
    identity: { runId: "run-123", callIndex: 1 },
    intentState: "requested",
    admissionState: "replayed",
    executionState: "settled",
    outcome: "success",
    requestedAt: 10,
    terminalAt: 11,
  });
  assert.deepEqual(rejected, {
    identity: { runId: "run-123", callIndex: 2 },
    intentState: "requested",
    admissionState: "rejected",
    executionState: "settled",
    outcome: "error",
    requestedAt: 10,
    terminalAt: 12,
  });
});

test("interrupted nonterminal calls settle as uncertain", () => {
  const request = requested(1);
  const claim = transitionInvocation(requested(2), {
    status: "claimed",
    at: 20,
  });
  const start = transitionInvocation(claim, { status: "running", at: 30 });

  for (const [record, at] of [
    [request, 11],
    [claim, 21],
    [start, 31],
  ] as const) {
    const uncertain = classifyInterruptedInvocation(record, at);
    assert.equal(uncertain.executionState, "uncertain");
    assert.equal(uncertain.outcome, "uncertain");
    assert.equal(uncertain.terminalAt, at);
  }
});

test("illegal, repeated, and backward-dated transitions fail closed", () => {
  const request = requested();
  const claim = transitionInvocation(request, { status: "claimed", at: 20 });
  const start = transitionInvocation(claim, { status: "running", at: 30 });
  const settled = transitionInvocation(start, {
    status: "settled",
    outcome: "success",
    at: 40,
  });

  assert.throws(
    () => transitionInvocation(request, { status: "running", at: 20 }),
    /Illegal invocation transition: requested -> running/,
  );
  assert.throws(
    () => transitionInvocation(claim, { status: "claimed", at: 21 }),
    /Illegal invocation transition: claimed -> claimed/,
  );
  assert.throws(
    () => transitionInvocation(claim, { status: "replayed", at: 21 }),
    /Illegal invocation transition: claimed -> replayed/,
  );
  assert.throws(
    () =>
      transitionInvocation(settled, {
        status: "settled",
        outcome: "error",
        at: 41,
      }),
    /Illegal invocation transition: settled -> settled/,
  );
  assert.throws(
    () => classifyInterruptedInvocation(settled, 41),
    /Cannot classify terminal invocation settled as uncertain/,
  );
  assert.throws(
    () => transitionInvocation(claim, { status: "running", at: 19 }),
    /Transition time cannot precede claimedAt/,
  );
});

test("persisted invocation timestamps must remain monotonic", () => {
  assert.equal(
    decodeInvocationRecord({
      identity: { runId: "wf_order", callIndex: 1 },
      intentState: "requested",
      admissionState: "claimed",
      executionState: "running",
      requestedAt: 20,
      claimedAt: 10,
      runningAt: 30,
    }),
    undefined,
  );
  assert.equal(
    decodeInvocationRecord({
      identity: { runId: "wf_order", callIndex: 2 },
      intentState: "requested",
      admissionState: "claimed",
      executionState: "settled",
      outcome: "success",
      requestedAt: 10,
      claimedAt: 20,
      runningAt: 30,
      terminalAt: 25,
    }),
    undefined,
  );
});

test("record creation and transitions reject malformed durable inputs", () => {
  assert.throws(
    () =>
      requestInvocation({ runId: "", callIndex: 1 } as InvocationIdentity, 10),
    /runId must be a nonblank string/,
  );
  assert.throws(
    () => requestInvocation(createInvocationIdentity("run-123", 1), NaN),
    /at must be finite/,
  );
  assert.throws(
    () =>
      transitionInvocation(
        {
          ...requested(),
          admissionState: "claimed",
        } as InvocationRecord,
        { status: "running", at: 30 },
      ),
    /claimedAt must be finite/,
  );
});
