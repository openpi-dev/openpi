import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LEDGER_LIMITS,
  LedgerRestoreError,
  LedgerValidationError,
  applyLedgerAdd,
  createSessionLedger,
  emptyLedgerSnapshot,
  projectLedger,
  renderLedgerList,
  restoreLedgerSnapshot,
  validateLedgerSnapshot,
  type LedgerSnapshot,
  type LedgerStatus,
} from "./ledger.ts";

function snapshot(
  revision: number,
  items: LedgerSnapshot["items"] = [],
  nextId = items.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1,
): LedgerSnapshot {
  return { version: 1, revision, nextId, items };
}

function entry(data: unknown) {
  return { type: "custom", customType: "task-ledger", data };
}

test("add, update, list, and stable allocation", () => {
  const ledger = createSessionLedger();
  const added = ledger.add([
    { subject: "First", detail: "one" },
    { subject: "Second" },
  ]);
  ledger.commit(added.snapshot);
  assert.deepEqual(
    added.items.map((item) => item.id),
    [1, 2],
  );
  assert.equal(added.snapshot.revision, 1);

  ledger.commit(ledger.update({ id: 1, subject: "First revised" }).snapshot);
  const third = ledger.add({ subject: "Third" });
  ledger.commit(third.snapshot);
  assert.equal(third.items[0].id, 3);
  assert.deepEqual(ledger.list({ id: 1 }), [
    {
      id: 1,
      subject: "First revised",
      detail: "one",
      status: "pending",
    },
  ]);
  assert.equal(ledger.snapshot().revision, 3);
});

test("all status transitions are allowed and multiple items may be in progress", () => {
  const statuses: LedgerStatus[] = [
    "pending",
    "in_progress",
    "blocked",
    "done",
    "dropped",
  ];
  for (const from of statuses) {
    for (const to of statuses) {
      const initial = snapshot(1, [
        {
          id: 1,
          subject: "Transition",
          status: from,
          ...(["blocked", "done", "dropped"].includes(from)
            ? { note: "existing note" }
            : {}),
        },
      ]);
      const ledger = createSessionLedger(initial);
      if (to !== from) {
        ledger.commit(
          ledger.update({
            id: 1,
            status: to,
            ...(["blocked", "done", "dropped"].includes(to)
              ? { note: "fresh note" }
              : {}),
          }).snapshot,
        );
      }
      assert.equal(ledger.list()[0].status, to);
    }
  }

  const ledger = createSessionLedger();
  ledger.commit(ledger.add([{ subject: "A" }, { subject: "B" }]).snapshot);
  ledger.commit(ledger.update({ id: 1, status: "in_progress" }).snapshot);
  ledger.commit(ledger.update({ id: 2, status: "in_progress" }).snapshot);
  assert.equal(ledger.list({ status: "in_progress" }).length, 2);
});

test("status entry requires a fresh note and stale notes clear only on leaving", () => {
  const ledger = createSessionLedger();
  ledger.commit(ledger.add({ subject: "Work" }).snapshot);
  for (const status of ["blocked", "done", "dropped"] as const) {
    assert.throws(
      () => ledger.update({ id: 1, status }),
      /fresh note is required/,
    );
  }

  ledger.commit(
    ledger.update({ id: 1, status: "blocked", note: "Waiting for access" })
      .snapshot,
  );
  ledger.commit(ledger.update({ id: 1, subject: "Work renamed" }).snapshot);
  assert.equal(ledger.list()[0].note, "Waiting for access");
  assert.throws(
    () => ledger.update({ id: 1, status: "blocked" }),
    /does not change/,
  );
  assert.equal(ledger.list()[0].note, "Waiting for access");

  ledger.commit(ledger.update({ id: 1, status: "in_progress" }).snapshot);
  assert.equal(ledger.list()[0].note, undefined);
  ledger.commit(
    ledger.update({ id: 1, status: "done", note: "tests passed" }).snapshot,
  );
  ledger.commit(
    ledger.update({ id: 1, status: "pending", note: "reopened intentionally" })
      .snapshot,
  );
  assert.equal(ledger.list()[0].note, "reopened intentionally");
});

test("strict snapshot validation rejects unknown fields, bad notes, duplicate IDs, limits, and bytes", () => {
  assert.throws(
    () =>
      validateLedgerSnapshot({
        ...emptyLedgerSnapshot(),
        extra: true,
      }),
    /unknown field/,
  );
  assert.throws(
    () =>
      validateLedgerSnapshot(
        snapshot(1, [{ id: 1, subject: "Blocked", status: "blocked" }]),
      ),
    /note is required/,
  );
  assert.throws(
    () =>
      validateLedgerSnapshot(
        snapshot(1, [
          { id: 1, subject: "A", status: "pending" },
          { id: 1, subject: "B", status: "pending" },
        ]),
      ),
    /duplicate ledger id/,
  );
  assert.throws(
    () =>
      validateLedgerSnapshot(
        snapshot(1, [
          {
            id: 1,
            subject: "x".repeat(LEDGER_LIMITS.subjectChars + 1),
            status: "pending",
          },
        ]),
      ),
    /subject exceeds/,
  );
  assert.throws(
    () =>
      validateLedgerSnapshot(
        snapshot(1, [{ id: 2, subject: "bad nextId", status: "pending" }], 2),
      ),
    /nextId must be greater/,
  );
  const tooLarge = snapshot(
    1,
    Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      subject: "界".repeat(40),
      detail: "界".repeat(500),
      status: "pending" as const,
      note: "界".repeat(500),
    })),
    101,
  );
  assert.throws(() => validateLedgerSnapshot(tooLarge), /UTF-8 bytes/);
});

test("batch and item caps are enforced", () => {
  assert.throws(
    () =>
      applyLedgerAdd(
        emptyLedgerSnapshot(),
        Array.from({ length: 21 }, (_, index) => ({ subject: `T${index}` })),
      ),
    /batch exceeds 20/,
  );
  const full = snapshot(
    1,
    Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      subject: `T${index + 1}`,
      status: "pending" as const,
    })),
    101,
  );
  assert.throws(
    () => applyLedgerAdd(full, [{ subject: "overflow" }]),
    /100 items/,
  );
});

test("oversized candidate is rejected before mutable ledger commit", () => {
  const ledger = createSessionLedger();
  ledger.commit(
    ledger.add(
      Array.from({ length: 20 }, (_, index) => ({
        subject: `Seed ${index}`,
        detail: "a".repeat(220),
        note: "a".repeat(220),
      })),
    ).snapshot,
  );
  const before = ledger.snapshot();
  const huge = Array.from({ length: 20 }, (_, index) => ({
    subject: `Huge ${index}`,
    detail: "界".repeat(500),
    note: "界".repeat(500),
  }));
  assert.throws(() => ledger.add(huge), /UTF-8 bytes/);
  assert.deepEqual(ledger.snapshot(), before);
});

test("restore chooses highest revision regardless of position and later entry wins ties", () => {
  const revision3Early = snapshot(3, [
    { id: 3, subject: "revision three", status: "pending" },
  ]);
  const revision2Late = snapshot(2, [
    { id: 2, subject: "revision two", status: "pending" },
  ]);
  assert.equal(
    restoreLedgerSnapshot([entry(revision3Early), entry(revision2Late)])
      .revision,
    3,
  );

  const tieLate = snapshot(3, [
    { id: 7, subject: "later tie", status: "pending" },
  ]);
  assert.equal(
    restoreLedgerSnapshot([revision3Early, { snapshot: tieLate }]).items[0].id,
    7,
  );
});

test("malformed winner and later malformed or unknown entries fail closed", () => {
  const valid = snapshot(5, [{ id: 5, subject: "valid", status: "pending" }]);
  assert.throws(
    () =>
      restoreLedgerSnapshot([
        entry(valid),
        entry({ version: 1, revision: 6, nextId: 6, items: "bad" }),
      ]),
    LedgerRestoreError,
  );
  assert.throws(
    () => restoreLedgerSnapshot([entry(valid), entry({ version: 2 })]),
    /locks restoration/,
  );
  assert.throws(
    () =>
      restoreLedgerSnapshot([
        entry(valid),
        entry({ version: 2, revision: 99, nextId: 100, items: [] }),
      ]),
    /winning ledger revision 99 is malformed/,
  );
  assert.throws(
    () => restoreLedgerSnapshot([entry(valid), entry({ garbage: true })]),
    /locks restoration/,
  );
});

test("restore high-water nextId prevents ID rewind", () => {
  const restored = restoreLedgerSnapshot([
    entry(snapshot(3, [], 80)),
    entry(snapshot(4, [{ id: 42, subject: "high id", status: "pending" }], 43)),
  ]);
  assert.equal(restored.nextId, 80);
  assert.equal(
    createSessionLedger(restored).add({ subject: "next" }).items[0].id,
    80,
  );
});

test("concurrent sibling completion order survives reload by monotonic revision", () => {
  const ledger = createSessionLedger();
  const first = ledger.add({ subject: "first completed mutation" }).snapshot;
  ledger.commit(first);
  const second = ledger.add({ subject: "second completed mutation" }).snapshot;
  ledger.commit(second);

  // A session writer may place sibling results out of completion order.
  const restored = restoreLedgerSnapshot([entry(second), entry(first)]);
  assert.equal(restored.revision, 2);
  assert.deepEqual(
    restored.items.map((item) => item.subject),
    ["first completed mutation", "second completed mutation"],
  );
});

test("branch slices model new, resume, tree, fork, and context-pivot semantics", () => {
  const root = snapshot(1, [{ id: 1, subject: "root", status: "pending" }]);
  const left = snapshot(2, [{ id: 1, subject: "left", status: "in_progress" }]);
  const right = snapshot(2, [
    { id: 1, subject: "right", status: "blocked", note: "branch reason" },
  ]);

  assert.deepEqual(restoreLedgerSnapshot([]), emptyLedgerSnapshot()); // /new
  assert.equal(
    restoreLedgerSnapshot([entry(root), entry(left)]).items[0].subject,
    "left",
  ); // resume/tree
  assert.equal(restoreLedgerSnapshot([entry(root)]).nextId, 2); // fork at root
  assert.equal(
    restoreLedgerSnapshot([
      entry(root),
      { type: "context-pivot" },
      entry(right),
    ]).items[0].subject,
    "right",
  );
});

test("projection is empty without actionable work, prioritized, advisory, and bounded", () => {
  assert.equal(projectLedger(emptyLedgerSnapshot()), "");
  assert.equal(
    projectLedger(
      snapshot(1, [{ id: 1, subject: "finished", status: "done", note: "ok" }]),
    ),
    "",
  );

  const projected = projectLedger(
    snapshot(1, [
      { id: 1, subject: "pending", status: "pending" },
      { id: 2, subject: "blocked", status: "blocked", note: "reason" },
      { id: 3, subject: "active", status: "in_progress" },
      ...Array.from({ length: 30 }, (_, index) => ({
        id: index + 4,
        subject: "long pending subject ".repeat(5),
        status: "pending" as const,
      })),
    ]),
  );
  assert.match(projected, /advisory context, not an instruction/);
  assert.match(
    projected,
    /Real files, git, tests, tools, artifacts, and user confirmation are truth/,
  );
  assert.match(projected, /ledger_list/);
  assert.match(projected, /compaction\/pivot/);
  assert.ok(projected.indexOf("T3") < projected.indexOf("T2"));
  assert.ok(projected.indexOf("T2") < projected.indexOf("T1"));
  assert.ok(Array.from(projected).length <= 800);
});

test("render list supports combined id/status filters and character bounds", () => {
  const state = snapshot(1, [
    { id: 1, subject: "one", status: "pending" },
    {
      id: 2,
      subject: "two",
      detail: "detail",
      status: "blocked",
      note: "reason",
    },
  ]);
  assert.equal(
    renderLedgerList(state, { id: 2, status: "blocked" }),
    "T2 [blocked] two\n  detail: detail\n  note: reason",
  );
  assert.equal(
    renderLedgerList(state, { id: 2, status: "pending" }),
    "No ledger items.",
  );
  assert.equal(Array.from(renderLedgerList(state, {}, 12)).length, 12);
});

test("apply functions are synchronous and returned state cannot mutate internal state", () => {
  const ledger = createSessionLedger();
  const result = ledger.add({ subject: "immutable" });
  assert.equal(result instanceof Promise, false);
  assert.equal(
    ledger.list().length,
    0,
    "candidate must not commit before persistence",
  );
  ledger.commit(result.snapshot);
  result.snapshot.items[0].subject = "external mutation";
  result.items[0].subject = "external mutation";
  assert.equal(ledger.list()[0].subject, "immutable");

  const candidate = applyLedgerAdd(ledger.snapshot(), [
    { subject: "committed after persistence" },
  ]).snapshot;
  ledger.commit(candidate);
  assert.equal(ledger.list()[1].subject, "committed after persistence");
});

test("no-op updates are rejected without advancing the revision", () => {
  const ledger = createSessionLedger();
  ledger.commit(ledger.add({ subject: "same" }).snapshot);
  const before = ledger.snapshot();
  assert.throws(
    () => ledger.update({ id: 1, subject: "same" }),
    /does not change/,
  );
  assert.deepEqual(ledger.snapshot(), before);
});

test("validation errors have a stable public class", () => {
  assert.throws(
    () => createSessionLedger().add({ subject: "" }),
    LedgerValidationError,
  );
  assert.throws(
    () => createSessionLedger().add({ subject: "bad\u0007subject" }),
    /control characters/,
  );
});
