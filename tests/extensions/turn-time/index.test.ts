import assert from "node:assert/strict";
import test from "node:test";
import { formatTurnDuration } from "../../../extensions/turn-time/index.ts";

test("durations read as seconds, then minutes, then hours", () => {
  assert.equal(formatTurnDuration(1_000), "1s");
  assert.equal(formatTurnDuration(26_400), "26s");
  assert.equal(formatTurnDuration(59_600), "1m00s");
  assert.equal(formatTurnDuration(61_000), "1m01s");
  assert.equal(formatTurnDuration(9 * 60_000 + 5_000), "9m05s");
  assert.equal(formatTurnDuration(3_600_000), "1h00m");
  assert.equal(formatTurnDuration(2 * 3_600_000 + 7 * 60_000), "2h07m");
});
