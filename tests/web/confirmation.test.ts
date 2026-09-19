import assert from "node:assert/strict";
import test from "node:test";
import { WebCleanupConfirmations } from "../../web/runtime/confirmation.ts";

const turn = { sessionId: "session-1", commandId: "command-1", epoch: 1 };
const target = { workspace: "/workspace", turn };

test("approval is bound to the exact request, workspace and turn and settles once", async () => {
  let changes = 0;
  const confirmations = new WebCleanupConfirmations(() => {
    changes++;
  });
  const decision = confirmations.request(target, ["old.txt"]);
  const [pending] = confirmations.list();
  assert.ok(pending);
  assert.deepEqual(pending.paths, ["old.txt"]);
  assert.equal(
    confirmations.respond({ ...pending, workspace: "/other" }, true),
    "stale",
  );
  assert.equal(confirmations.respond({ ...pending, epoch: 2 }, true), "stale");
  assert.equal(
    confirmations.respond({ ...pending, requestId: "unknown" }, true),
    "stale",
  );
  assert.equal(confirmations.list().length, 1);
  assert.equal(confirmations.respond(pending, true), "approved");
  assert.equal(await decision, "approved");
  assert.equal(confirmations.respond(pending, true), "already-settled");
  assert.deepEqual(confirmations.list(), []);
  assert.equal(changes, 2);
});

test("denial, abort, expiry and shutdown never grant deletion", async () => {
  const confirmations = new WebCleanupConfirmations(() => {}, 15);
  const denied = confirmations.request(target, ["keep.txt"]);
  assert.equal(
    confirmations.respond(confirmations.list()[0]!, false),
    "denied",
  );
  assert.equal(await denied, "denied");

  const controller = new AbortController();
  const cancelled = confirmations.request(
    target,
    ["keep.txt"],
    controller.signal,
  );
  controller.abort();
  assert.equal(await cancelled, "unavailable");
  assert.deepEqual(confirmations.list(), []);

  const expired = confirmations.request(target, ["keep.txt"]);
  const request = confirmations.list()[0]!;
  assert.equal(await expired, "unavailable");
  assert.equal(confirmations.respond(request, true), "expired");

  const shutdown = confirmations.request(target, ["keep.txt"]);
  confirmations.invalidate();
  assert.equal(await shutdown, "unavailable");
  assert.deepEqual(confirmations.list(), []);
});

test("oversized paths and exhausted capacity fail closed without exposing a partial request", async () => {
  const confirmations = new WebCleanupConfirmations(() => {});
  assert.equal(
    await confirmations.request(target, ["x".repeat(513)]),
    "unavailable",
  );
  assert.equal(
    await confirmations.request(target, Array(33).fill("old.txt")),
    "unavailable",
  );
  assert.deepEqual(confirmations.list(), []);
  const waits = Array.from({ length: 4 }, () =>
    confirmations.request(target, ["old.txt"]),
  );
  assert.equal(
    await confirmations.request(target, ["other.txt"]),
    "unavailable",
  );
  assert.equal(confirmations.list().length, 4);
  confirmations.invalidate();
  assert.deepEqual(await Promise.all(waits), Array(4).fill("unavailable"));
});
