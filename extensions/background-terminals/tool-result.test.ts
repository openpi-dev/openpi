import assert from "node:assert/strict";
import test from "node:test";
import { buildCompactTerminalPreview } from "./src/ui/tool-result.ts";

test("background terminal preview keeps only each stream tail", () => {
  const preview = buildCompactTerminalPreview(
    [
      'bt-8 [done] "full suite" (pid 42, 1m11s, exit 0, /repo, stdout 52KB, stderr 3B)',
      "Error: retained warning",
      "",
      "stdout:",
      "test 1 passed",
      "test 2 passed",
      "test 3 passed",
      "test 4 passed",
      "test 5 passed",
      "",
      "stderr:",
      "warning 1",
      "warning 2",
      "warning 3",
    ].join("\n"),
  );

  assert.match(preview.summary, /bt-8 \[done\]/);
  assert.deepEqual(preview.metadata, ["Error: retained warning"]);
  assert.deepEqual(preview.streams, [
    { name: "stdout", lines: ["test 4 passed", "test 5 passed"] },
    { name: "stderr", lines: ["warning 2", "warning 3"] },
  ]);
  assert.equal(preview.hiddenLines, 4);
  assert.equal(preview.unknownEarlierOutput, false);
});

test("background terminal preview reports upstream truncation without showing its long notice", () => {
  const preview = buildCompactTerminalPreview(
    [
      'bt-2 [running] "server"',
      "",
      "stdout:",
      "ready",
      "[stdout truncated: showing last 8KB of 2MB. Read the full log at /tmp/full.log]",
      "",
      "stderr: (empty)",
    ].join("\n"),
  );

  assert.deepEqual(preview.streams, [{ name: "stdout", lines: ["ready"] }]);
  assert.equal(preview.hiddenLines, 0);
  assert.equal(preview.unknownEarlierOutput, true);
});

test("background terminal preview omits empty streams", () => {
  const preview = buildCompactTerminalPreview(
    [
      'bt-1 [done] "quiet"',
      "",
      "stdout: (empty)",
      "",
      "stderr: (empty)",
    ].join("\n"),
  );

  assert.deepEqual(preview.streams, []);
  assert.equal(preview.hiddenLines, 0);
});
