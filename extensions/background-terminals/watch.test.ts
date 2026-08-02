import assert from "node:assert/strict";
import test from "node:test";
import {
  compileWatchPattern,
  createChunkMatcher,
  WATCH_CARRY_MAX_BYTES,
} from "./src/watch.ts";

test("matches within a single chunk and reports the containing line", () => {
  const m = createChunkMatcher(compileWatchPattern("Ready in"));
  const hit = m.push("booting...\nReady in 231ms\nserving\n", "stdout");
  assert.equal(hit?.line, "Ready in 231ms");
  assert.equal(hit?.stream, "stdout");
});

test("matches a pattern that straddles two chunks", () => {
  const m = createChunkMatcher(compileWatchPattern("Ready in"));
  assert.equal(m.push("some log\nRead", "stdout"), undefined);
  const hit = m.push("y in 5ms\n", "stdout");
  assert.equal(hit?.line, "Ready in 5ms");
});

test("is one-shot: never fires twice even without disarming", () => {
  const m = createChunkMatcher(compileWatchPattern("ERROR"));
  assert.ok(m.push("ERROR first\n", "stderr"));
  assert.equal(m.push("ERROR second\n", "stderr"), undefined);
});

test("supports an alternation covering failure signatures", () => {
  // The 'silence is not success' pattern: progress OR failure signatures.
  const m = createChunkMatcher(
    compileWatchPattern("Ready in|Traceback|FAILED|OOM"),
  );
  const hit = m.push(
    "worker 1\nTraceback (most recent call last):\n",
    "stderr",
  );
  assert.equal(hit?.line, "Traceback (most recent call last):");
});

test("bounds retained carry so a firehose cannot grow memory", () => {
  const m = createChunkMatcher(compileWatchPattern("NEVERMATCHES"));
  for (let i = 0; i < 20; i++) m.push("x".repeat(1024), "stdout");
  // Next chunk still matches against only the bounded tail plus the chunk.
  const hit = m.push(`${"y".repeat(10)}NEVERMATCHES\n`, "stdout");
  assert.ok(hit);
  assert.ok(hit.line.length <= WATCH_CARRY_MAX_BYTES + 64);
});

test("reports a clear error for an invalid pattern", () => {
  assert.throws(() => compileWatchPattern("("), /Invalid watch pattern/);
});

test("rejects catastrophic-backtracking and over-long patterns", () => {
  // Nested quantifiers exec on the output hot path, so they are refused.
  assert.throws(() => compileWatchPattern("(a+)+"), /nested quantifier/);
  assert.throws(() => compileWatchPattern("(x*)*"), /nested quantifier/);
  // A normal alternation of signatures is unaffected.
  assert.ok(compileWatchPattern("Ready in|Traceback|ERROR"));
  assert.throws(() => compileWatchPattern("a".repeat(201)), /too long/);
});
