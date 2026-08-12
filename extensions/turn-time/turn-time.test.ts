import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_REPORTED_MS,
  formatTurnDuration,
  shouldReportTurnTime,
} from "./index.ts";

test("shouldReportTurnTime filters sub-second noise", () => {
  assert.equal(shouldReportTurnTime(999), false);
  assert.equal(shouldReportTurnTime(MIN_REPORTED_MS), true);
  assert.equal(shouldReportTurnTime(60_000), true);
});

test("formatTurnDuration buckets s/m/h", () => {
  assert.equal(formatTurnDuration(1_500), "2s");
  assert.equal(formatTurnDuration(90_000), "1m30s");
  assert.equal(formatTurnDuration(3_665_000), "1h01m");
});
