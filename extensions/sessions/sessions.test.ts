import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionDescription,
  buildSessionLabel,
  buildSessionPreview,
  filterSessionEntries,
  formatRelativeTime,
  formatTimestamp,
  getSessionPaneLayout,
  parseLimit,
  type SessionInfoLike,
} from "./sessions.ts";

const session: SessionInfoLike = {
  id: "1234567890",
  name: "  API work  ",
  cwd: "/tmp/project",
  modified: new Date(),
  firstMessage: "Implement OAuth",
  path: "/tmp/session.jsonl",
};

test("session labels prefer names and limits reject invalid input", () => {
  assert.equal(buildSessionLabel(session), "API work");
  assert.equal(parseLimit("20"), 20);
  assert.equal(parseLimit("nope", 12), 12);
});

test("session search matches normalized metadata", () => {
  const entries = [
    {
      session,
      searchText: "api work implement oauth /tmp/project",
    },
  ];
  assert.equal(filterSessionEntries(entries, "oauth").length, 1);
  assert.equal(filterSessionEntries(entries, "billing").length, 0);
});

test("persisted session labels and preview content are terminal-safe", () => {
  const hostile = {
    ...session,
    name: "API\u202e work\u202c \u001b[31mred\u001b[0m",
    cwd: "/tmp/\u001b]52;c;payload\u0007project\nspoof",
    firstMessage: "find \u001b_unterminated APC",
  };
  assert.equal(buildSessionLabel(hostile), "API work red");
  assert.match(
    buildSessionDescription(hostile),
    /find — \/tmp\/project spoof$/,
  );

  const preview = buildSessionPreview(hostile, [
    {
      role: "assistant",
      content: [
        { type: "text", text: "safe \u001bPsecret\u001b\\text 👩\u200d💻" },
        {
          type: "toolCall",
          name: "read\u202eignored\u202c",
          arguments: { path: "\u001b]52;c;payload\u0007/tmp/file" },
        },
      ],
    },
    {
      role: "toolResult",
      toolName: "read\u001b[31m",
      content: "before\u0090unterminated DCS",
    },
    {
      role: "bashExecution",
      command: "printf\u202e spoof\u202c",
      output: "ok\u001b[2Jdone",
    },
  ]);

  assert.equal(preview.subtitle.endsWith("/tmp/project spoof"), true);
  assert.deepEqual(preview.blocks[0], {
    kind: "assistant",
    text: "safe text 👩\u200d💻",
  });
  assert.deepEqual(preview.blocks[1], {
    kind: "toolCall",
    name: "readignored",
    args: '{"path":"/tmp/file"}',
  });
  assert.deepEqual(preview.blocks[2], {
    kind: "toolResult",
    name: "read",
    text: "before",
    isError: undefined,
  });
  assert.deepEqual(preview.blocks[3], {
    kind: "bash",
    command: "printf spoof",
    output: "okdone",
    isError: undefined,
  });
});

test("parseLimit clamps to positive integers with default fallback", () => {
  assert.equal(parseLimit(undefined), 5);
  assert.equal(parseLimit("10"), 10);
  assert.equal(parseLimit("0"), 5);
  assert.equal(parseLimit("-3"), 5);
  assert.equal(parseLimit("abc"), 5);
  assert.equal(parseLimit("7", 3), 7);
});

test("formatTimestamp renders local YYYY-MM-DD HH:mm", () => {
  const date = new Date(2026, 7, 13, 9, 5);
  assert.equal(formatTimestamp(date), "2026-08-13 09:05");
});

test("formatRelativeTime buckets seconds/minutes/hours/days", () => {
  const now = Date.now();
  assert.equal(formatRelativeTime(new Date(now - 30_000)), "Just now");
  assert.equal(formatRelativeTime(new Date(now - 5 * 60_000)), "5m ago");
  assert.equal(formatRelativeTime(new Date(now - 3 * 3_600_000)), "3h ago");
  assert.equal(formatRelativeTime(new Date(now - 26 * 3_600_000)), "Yesterday");
  assert.equal(formatRelativeTime(new Date(now - 3 * 86_400_000)), "3d ago");
});

test("getSessionPaneLayout adapts to width", () => {
  assert.equal(getSessionPaneLayout(60).mode, "single");
  const mid = getSessionPaneLayout(100);
  assert.equal(mid.mode, "split");
  assert.ok(mid.listWidth < 100 && mid.previewWidth > 0);
  const wide = getSessionPaneLayout(200);
  // The list pane is a bounded narrow rail; the preview takes the rest.
  assert.equal(wide.listWidth, 58);
  assert.ok(wide.previewWidth > wide.listWidth);
});
