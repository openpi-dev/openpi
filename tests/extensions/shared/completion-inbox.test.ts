import assert from "node:assert/strict";
import { test } from "node:test";
import {
  completionOwnerFor,
  type CompletionEnvelope,
  type CompletionOwner,
  createCompletionInbox,
} from "../../../extensions/shared/completion-inbox.ts";

const owner: CompletionOwner = { sessionId: "session-1", epoch: 1 };

function envelope(
  producerId: string,
  patch: Partial<CompletionEnvelope<{ value: string }>> = {},
): CompletionEnvelope<{ value: string }> {
  return {
    deliveryId: `subagent:${producerId}:terminal`,
    owner,
    producer: "subagent",
    producerId,
    terminalRef: { id: producerId, status: "done" },
    wake: "follow-up",
    payload: { value: producerId },
    ...patch,
  };
}

test("all producers share one owner generation for a Pi Session identity", () => {
  let sessionId = "session-1";
  const identity = { getSessionId: () => sessionId };
  const first = completionOwnerFor(identity);
  assert.equal(completionOwnerFor(identity), first);

  sessionId = "session-2";
  const switched = completionOwnerFor(identity);
  assert.equal(switched.sessionId, "session-2");
  assert.notEqual(switched.epoch, first.epoch);

  const replacement = completionOwnerFor({ getSessionId: () => sessionId });
  assert.notEqual(replacement.epoch, switched.epoch);
});

test("explicit consumption and automatic claim share one atomic gate", () => {
  const inbox = createCompletionInbox<{ value: string }>();
  inbox.defer(envelope("sa-1"), owner);
  inbox.consume("subagent", ["sa-1"]);
  assert.deepEqual(inbox.claim(owner), []);

  inbox.defer(envelope("sa-2"), owner);
  assert.deepEqual(
    inbox.claim(owner).map((item) => item.producerId),
    ["sa-2"],
  );
  inbox.consume("subagent", ["sa-2"]);
  assert.deepEqual(inbox.claim(owner), []);
});

test("a failed transport restores exact envelopes ahead of newer work", () => {
  const inbox = createCompletionInbox<{ value: string }>();
  const first = envelope("sa-1");
  const second = envelope("sa-2");
  inbox.defer(first, owner);
  const claimed = inbox.claim(owner);
  inbox.defer(second, owner);
  inbox.retry(claimed, owner);

  assert.deepEqual(
    inbox.claim(owner).map((item) => item.deliveryId),
    [first.deliveryId, second.deliveryId],
  );
});

test("separate in-flight batches can be acknowledged or retried independently", () => {
  const inbox = createCompletionInbox<{ value: string }>();
  const first = envelope("sa-1");
  const second = envelope("sa-2");
  const third = envelope("sa-3");
  for (const item of [first, second, third]) inbox.defer(item, owner);

  assert.deepEqual(
    inbox.claim(owner, 2).map((item) => item.producerId),
    ["sa-1", "sa-2"],
  );
  assert.deepEqual(
    inbox.claim(owner, 1).map((item) => item.producerId),
    ["sa-3"],
  );
  inbox.acknowledge([third.deliveryId]);
  inbox.retryClaimed("subagent", [first.producerId, second.producerId], owner);

  assert.deepEqual(
    inbox.claim(owner).map((item) => item.producerId),
    ["sa-1", "sa-2"],
  );
});

test("a Session epoch switch dead-letters stale completions", () => {
  const inbox = createCompletionInbox<{ value: string }>();
  inbox.defer(envelope("sa-1"), owner);
  const nextOwner = { ...owner, epoch: owner.epoch + 1 };

  assert.deepEqual(inbox.claim(nextOwner), []);
  assert.deepEqual(inbox.inspectDeadLetters(), [
    {
      deliveryId: "subagent:sa-1:terminal",
      producer: "subagent",
      producerId: "sa-1",
      failure: "stale-owner",
    },
  ]);
});

test("a Session identity switch cannot redirect a completion", () => {
  const inbox = createCompletionInbox<{ value: string }>();
  inbox.defer(envelope("sa-1"), owner);

  assert.deepEqual(
    inbox.claim({ sessionId: "session-2", epoch: owner.epoch }),
    [],
  );
  assert.equal(inbox.inspectDeadLetters()[0]?.failure, "stale-owner");
});

test("producer identity prevents cross-capability consumption", () => {
  const inbox = createCompletionInbox<{ value: string }>();
  inbox.defer(envelope("same"), owner);
  inbox.defer(
    envelope("same", {
      deliveryId: "background:same:terminal",
      producer: "background",
      wake: "next-turn",
    }),
    owner,
  );

  inbox.consume("subagent", ["same"]);
  assert.deepEqual(
    inbox.claim(owner).map((item) => item.producer),
    ["background"],
  );
});

test("an unavailable owner becomes an inspectable dead letter", () => {
  const inbox = createCompletionInbox<{ value: string }>();
  assert.equal(inbox.defer(envelope("sa-1"), undefined), false);
  assert.equal(inbox.size(), 0);
  assert.equal(inbox.inspectDeadLetters()[0]?.failure, "owner-unavailable");
});

test("an unowned completion cannot match any session and dead-letters fail-closed", () => {
  const inbox = createCompletionInbox<{ value: string }>();
  assert.equal(
    inbox.defer(
      envelope("unowned-1", {
        owner: { sessionId: "unowned", epoch: 0 },
      }),
      {
        sessionId: "unowned",
        epoch: 0,
      },
    ),
    false,
  );
  assert.equal(inbox.size(), 0);
  assert.equal(inbox.inspectDeadLetters()[0]?.failure, "stale-owner");
});
