import assert from "node:assert/strict";
import test from "node:test";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import {
  historyKeyApplies,
  idlePromptHistory,
  promptHistory,
  stepPromptHistory,
} from "../../web/ui/src/features/composer/prompt-history.ts";

type Entry = NonNullable<WebSnapshot["selectedSession"]>["entries"][number];

let entryId = 0;
function entry(role: string, content: string, type = "message") {
  return {
    id: `entry-${++entryId}`,
    type,
    timestamp: "2026-10-31T00:00:00Z",
    message: { role, content },
  } as Entry;
}

test("history holds real user prompts newest first, consecutive repeats once", () => {
  const items = promptHistory([
    entry("user", "first"),
    entry("assistant", "model reply"),
    entry("custom", "extension note", "custom_message"),
    entry("user", "   "),
    entry("user", "second"),
    entry("user", "second"),
    entry("user", "latest"),
  ]);
  assert.deepEqual(
    items.map((item) => item.text),
    ["latest", "second", "first"],
  );
});

test("Up belongs to history only from an empty editor, the very start, or the first line while browsing", () => {
  const caret = (at: number) => ({ start: at, end: at });
  assert.equal(historyKeyApplies("ArrowUp", "", caret(0), false), true);
  assert.equal(historyKeyApplies("ArrowUp", "one\ntwo", caret(0), false), true);
  assert.equal(
    historyKeyApplies("ArrowUp", "one\ntwo", caret(2), false),
    false,
  );
  assert.equal(historyKeyApplies("ArrowUp", "one\ntwo", caret(2), true), true);
  assert.equal(historyKeyApplies("ArrowUp", "one\ntwo", caret(6), true), false);
  assert.equal(
    historyKeyApplies("ArrowUp", "one", { start: 0, end: 2 }, false),
    false,
  );
});

test("Down belongs to history only on the last line while browsing", () => {
  const caret = (at: number) => ({ start: at, end: at });
  assert.equal(
    historyKeyApplies("ArrowDown", "one\ntwo", caret(6), true),
    true,
  );
  assert.equal(
    historyKeyApplies("ArrowDown", "one\ntwo", caret(1), true),
    false,
  );
  assert.equal(historyKeyApplies("ArrowDown", "", caret(0), false), false);
});

test("stepping stops at the oldest prompt and returns to the draft past the newest", () => {
  const at = (index: number) => ({ ...idlePromptHistory(), index });
  assert.equal(stepPromptHistory(at(-1), "ArrowUp", 2), 0);
  assert.equal(stepPromptHistory(at(1), "ArrowUp", 2), undefined);
  assert.equal(stepPromptHistory(at(0), "ArrowDown", 2), -1);
  assert.equal(stepPromptHistory(at(-1), "ArrowDown", 2), undefined);
  assert.equal(stepPromptHistory(at(-1), "ArrowUp", 0), undefined);
});
