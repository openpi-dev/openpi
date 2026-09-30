import assert from "node:assert/strict";
import test from "node:test";
import {
  formatModelCapacity,
  parseModelCapacity,
} from "../../web/ui/src/features/settings/model-capacity.ts";

test("DSH capacity spelling preserves exact token counts and optional native defaults", () => {
  for (const [text, count] of [
    ["128K", 128000],
    ["32k", 32000],
    ["1M", 1000000],
    ["2.3M", 2300000],
    ["16.384k", 16384],
    [" 8192 ", 8192],
  ] as const) {
    assert.equal(parseModelCapacity(text), count);
    assert.equal(parseModelCapacity(formatModelCapacity(count)), count);
  }
  assert.equal(formatModelCapacity(128000), "128K");
  assert.equal(formatModelCapacity(1000000), "1M");
  assert.equal(formatModelCapacity(16384), "16384");
  assert.equal(formatModelCapacity(undefined), "");
  assert.equal(parseModelCapacity(" "), undefined);
  for (const invalid of [
    "0",
    "-1K",
    "Infinity",
    "1e6",
    "1KB",
    "2.",
    "0.0001K",
    "101M",
  ]) {
    assert.ok(Number.isNaN(parseModelCapacity(invalid)), invalid);
  }
});
