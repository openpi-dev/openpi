import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  buildCompactTerminalPreview,
  renderTerminalBatchResult,
  renderTerminalResult,
} from "../../../extensions/background-terminals/src/ui/tool-result.ts";

initTheme("dark", false);

const theme = {
  fg: (_color: string, text: string) => text,
} as Theme;

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

test("compact renderer stays bounded, shows the tail, and advertises expansion", () => {
  const content = [
    'bt-8 [done] "full suite"',
    "",
    "stdout:",
    ...Array.from({ length: 20 }, (_, index) => `test ${index + 1} passed`),
    "",
    "stderr: (empty)",
  ].join("\n");

  const rendered = renderTerminalResult(content, false, theme).render(80);
  assert.equal(rendered.length, 4);
  assert.match(rendered[1] ?? "", /test 19 passed/);
  assert.match(rendered[2] ?? "", /test 20 passed/);
  assert.match(rendered[3] ?? "", /18 earlier lines hidden/);
  assert.match(rendered[3] ?? "", /expand/);
  assert.doesNotMatch(rendered.join("\n"), /test 1 passed/);

  const expanded = renderTerminalResult(content, true, theme)
    .render(120)
    .join("\n");
  assert.match(expanded, /test 1 passed/);
  assert.match(expanded, /test 20 passed/);
});

test("batched terminal rendering preserves identity without inventing a singular terminal", () => {
  const results = [
    { id: "bt-1", title: "tests", status: "done", exitCode: 0 },
    { id: "bt-2", title: "build", status: "failed", exitCode: 1 },
  ];
  const content = [
    'bt-1 [done] "tests"',
    "stdout:",
    "passed",
    "",
    'bt-2 [failed] "build"',
    "stderr:",
    "compile error",
  ].join("\n");

  const compact = renderTerminalBatchResult(content, false, theme, results, 3)
    .render(100)
    .join("\n");
  assert.match(compact, /2 background terminals completed/);
  assert.match(compact, /bt-1 · tests · exit 0/);
  assert.match(compact, /bt-2 · build · exit 1/);
  assert.doesNotMatch(compact, /terminal \?/);
  assert.doesNotMatch(compact, /compile error/);
  assert.match(compact, /3 older results omitted/);
  assert.match(compact, /expand/);

  const expanded = renderTerminalBatchResult(content, true, theme, results)
    .render(120)
    .join("\n");
  assert.match(expanded, /bt-1 \[done\]/);
  assert.match(expanded, /bt-2 \[failed\]/);
  assert.match(expanded, /compile error/);
});

test("background terminal preview omits empty streams", () => {
  const preview = buildCompactTerminalPreview(
    ['bt-1 [done] "quiet"', "", "stdout: (empty)", "", "stderr: (empty)"].join(
      "\n",
    ),
  );

  assert.deepEqual(preview.streams, []);
  assert.equal(preview.hiddenLines, 0);
});
