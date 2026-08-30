import assert from "node:assert/strict";
import test from "node:test";
import {
  createStatusWriter,
  formatActivityStatus,
  hasActivity,
  unreadActivityCounts,
} from "../../../extensions/shared/activity-status.ts";

const identityTheme = {
  fg: (_name: string, text: string) => text,
} as unknown as Parameters<typeof formatActivityStatus>[0];

test("running work always reports; settled work only until the next request", () => {
  const items = [
    { status: "running" as const },
    { status: "done" as const, settledAt: 50 },
    { status: "error" as const, settledAt: 60 },
    { status: "done" as const, settledAt: 150 },
  ];

  assert.deepEqual(unreadActivityCounts(items, 0), {
    running: 1,
    done: 2,
    failed: 1,
  });
  // A request at t=100 acknowledges everything that settled before it.
  assert.deepEqual(unreadActivityCounts(items, 100), {
    running: 1,
    done: 1,
    failed: 0,
  });
  assert.deepEqual(unreadActivityCounts(items, 200), {
    running: 1,
    done: 0,
    failed: 0,
  });
});

test("acknowledged settled work leaves no status line", () => {
  const settled = [{ status: "done" as const, settledAt: 10 }];
  assert.equal(hasActivity(unreadActivityCounts(settled, 0)), true);
  // Same millisecond as the request: the user cannot have read it yet.
  assert.equal(hasActivity(unreadActivityCounts(settled, 10)), true);
  assert.equal(hasActivity(unreadActivityCounts(settled, 11)), false);
  assert.equal(hasActivity(unreadActivityCounts([], 0)), false);
});

test("a settle without a timestamp is treated as unread", () => {
  assert.deepEqual(unreadActivityCounts([{ status: "done" }], 100), {
    running: 0,
    done: 1,
    failed: 0,
  });
});

test("the status writer forwards changes and swallows repeats", () => {
  const writes: Array<[string, string | undefined]> = [];
  const ui = {
    setStatus(key: string, text: string | undefined) {
      writes.push([key, text]);
    },
  };
  const writer = createStatusWriter("subagents");

  // Pi repaints the whole TUI on every setStatus, so the first clear has to
  // land but its repeats must not.
  assert.equal(writer.write(ui, undefined), true);
  assert.equal(writer.write(ui, undefined), false);
  assert.equal(writer.write(ui, "1 running"), true);
  assert.equal(writer.write(ui, "1 running"), false);
  assert.equal(writer.write(ui, undefined), true);
  assert.deepEqual(writes, [
    ["subagents", undefined],
    ["subagents", "1 running"],
    ["subagents", undefined],
  ]);

  // A new session's footer starts empty, so its first write must land even
  // when the text matches what the previous session last showed.
  const nextSession = {
    setStatus(key: string, text: string | undefined) {
      writes.push([key, text]);
    },
  };
  assert.equal(writer.write(nextSession, undefined), true);

  writer.reset();
  assert.equal(writer.write(nextSession, undefined), true);
});

test("status text names its own view command", () => {
  assert.equal(
    formatActivityStatus(identityTheme, "subagents", {
      running: 1,
      done: 2,
      failed: 0,
    }),
    "subagents: 1 running · 2 done · /subagents to view",
  );
  assert.equal(
    formatActivityStatus(identityTheme, "workflows", {
      running: 0,
      done: 0,
      failed: 3,
    }),
    "workflows: 3 failed · /workflows to view",
  );
});
