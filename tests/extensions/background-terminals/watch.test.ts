import assert from "node:assert/strict";
import test from "node:test";
import {
  assertWatchableOutput,
  compileWatchPattern,
  createChunkMatcher,
  matchCapturedOutput,
  WATCH_CARRY_MAX_BYTES,
  WATCH_LINE_MAX_CHARS,
} from "../../../extensions/background-terminals/src/watch.ts";

test("matches within a single chunk and reports the containing line", () => {
  const m = createChunkMatcher(compileWatchPattern("Ready in"));
  const hit = m.push("booting...\nReady in 231ms\nserving\n", "stdout");
  assert.equal(hit?.line, "Ready in 231ms");
  assert.equal(hit?.stream, "stdout");
});

test("matches retained output when armed after a fast process spoke", () => {
  const matcher = createChunkMatcher(compileWatchPattern("Ready|FAILED"));
  assert.deepEqual(
    matchCapturedOutput(
      matcher,
      { text: "boot\nReady\n", truncatedBytes: 0 },
      { text: "", truncatedBytes: 0 },
    ),
    { line: "Ready", stream: "stdout" },
  );
});

test("refuses to arm after eviction makes future control state unknowable", () => {
  assert.throws(
    () =>
      assertWatchableOutput(
        { text: "payload tail", truncatedBytes: 1_000 },
        { text: "", truncatedBytes: 0 },
      ),
    /Cannot safely arm a watch/,
  );
  assert.doesNotThrow(() =>
    assertWatchableOutput(
      { text: "complete", truncatedBytes: 0 },
      { text: "", truncatedBytes: 0 },
    ),
  );
});

test("skips retained streams whose missing head makes control state unknowable", () => {
  const matcher = createChunkMatcher(compileWatchPattern("READY_SECRET"));
  assert.equal(
    matchCapturedOutput(
      matcher,
      { text: "READY_SECRET\u0007visible", truncatedBytes: 1_000 },
      { text: "", truncatedBytes: 0 },
    ),
    undefined,
  );
  assert.equal(
    matcher.push("READY_SECRET visible\n", "stdout")?.line,
    "READY_SECRET visible",
  );
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

test("matches literal signatures without exposing the regex hot path", () => {
  const matcher = createChunkMatcher(compileWatchPattern("(a+)+$"));
  assert.equal(matcher.push("aaaa!\n", "stdout"), undefined);
  assert.equal(
    matcher.push("literal (a+)+$ text\n", "stdout")?.line,
    "literal (a+)+$ text",
  );
  assert.ok(compileWatchPattern("Ready in|Traceback|ERROR"));
});

test("rejects unsafe or ambiguous signature lists", () => {
  assert.throws(() => compileWatchPattern("Ready||ERROR"), /cannot be empty/);
  assert.throws(() => compileWatchPattern("Ready\nERROR"), /control/);
  assert.throws(
    () => compileWatchPattern("\u001b]52;c;payload\u0007"),
    /control/,
  );
  assert.throws(() => compileWatchPattern("a".repeat(201)), /too long/);
});

test("keeps stdout and stderr carries separate", () => {
  const m = createChunkMatcher(compileWatchPattern("Ready in"));
  // A shared buffer would splice these into "Read" + "y in" and fire.
  assert.equal(m.push("Read", "stdout"), undefined);
  assert.equal(m.push("y in 5ms\n", "stderr"), undefined);
  // A real straddling match on one stream still lands.
  assert.equal(m.push("y in 9ms\n", "stdout")?.line, "Ready in 9ms");
});

test("strips ANSI, OSC, and C1 control bytes from the reported line", () => {
  const m = createChunkMatcher(compileWatchPattern("Ready"));
  const hit = m.push(
    "\u001b[32m\u009b2JReady\u001b[0m in 5ms\u001b]52;c;payload\u0007\n",
    "stdout",
  );
  assert.equal(hit?.line, "Ready in 5ms");
  assert.doesNotMatch(hit?.line ?? "", /[\u001b\u0080-\u009f]/);
});

test("never matches signatures hidden inside terminal control payloads", () => {
  const m = createChunkMatcher(compileWatchPattern("Ready"));
  assert.equal(
    m.push("\u001b]52;c;Ready\u0007still booting\n", "stdout"),
    undefined,
  );
  // BEL does not terminate DCS; only the later ST exposes normal text.
  assert.equal(
    m.push("\u001bPprefix\u0007Ready\u001b\\still booting\n", "stdout"),
    undefined,
  );
  assert.equal(
    m.push("Ready for traffic\n", "stdout")?.line,
    "Ready for traffic",
  );
});

test("keeps split long control payloads hidden across the carry bound", () => {
  const m = createChunkMatcher(compileWatchPattern("READY_SECRET"));
  assert.equal(
    m.push(`\u001b]52;c;${"x".repeat(WATCH_CARRY_MAX_BYTES + 10)}`, "stdout"),
    undefined,
  );
  assert.equal(m.push("READY_SECRET\u0007visible\n", "stdout"), undefined);
});

test("bounds the reported line when the stream has no newline", () => {
  const m = createChunkMatcher(compileWatchPattern("MATCH"));
  const hit = m.push(`${"x".repeat(3000)}MATCH${"y".repeat(3000)}`, "stdout");
  assert.ok(hit);
  assert.ok(hit.line.length <= WATCH_LINE_MAX_CHARS + 1);
});
