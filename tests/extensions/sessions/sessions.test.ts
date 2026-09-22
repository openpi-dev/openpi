import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildSessionDescription,
  buildSessionLabel,
  buildSessionPreview,
  deleteSessionFile,
  filterSessionEntries,
  parseLimit,
  type SessionInfoLike,
  selectSessionStatsWindow,
} from "../../../extensions/sessions/sessions.ts";

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

test("session stats window follows the SelectList centered viewport", () => {
  const sessions = Array.from({ length: 20 }, (_, index) => ({
    ...session,
    id: `session-${index}`,
    path: `/tmp/session-${index}.jsonl`,
  }));

  assert.deepEqual(
    selectSessionStatsWindow(sessions, sessions[0]!.path, 5).map(
      (entry) => entry.path,
    ),
    sessions.slice(0, 5).map((entry) => entry.path),
  );
  assert.deepEqual(
    selectSessionStatsWindow(sessions, sessions[10]!.path, 5).map(
      (entry) => entry.path,
    ),
    sessions.slice(8, 13).map((entry) => entry.path),
  );
  assert.deepEqual(
    selectSessionStatsWindow(sessions, sessions[19]!.path, 5).map(
      (entry) => entry.path,
    ),
    sessions.slice(15).map((entry) => entry.path),
  );
  assert.equal(
    selectSessionStatsWindow(sessions, "/missing.jsonl", 5)[0]?.path,
    sessions[0]!.path,
  );
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

test("bounded preview reports omitted messages and content bytes", () => {
  const preview = buildSessionPreview(
    session,
    [
      { role: "user", content: "recent one" },
      { role: "assistant", content: "recent two" },
    ],
    { totalMessages: 100, truncatedBytes: 2048 },
  );

  assert.deepEqual(preview.blocks.slice(0, 2), [
    { kind: "notice", text: "… 98 earlier messages omitted" },
    { kind: "notice", text: "… 2048 bytes of preview content omitted" },
  ]);
  assert.match(preview.subtitle, /100 messages/);
});

test("deleteSessionFile removes an existing file", async () => {
  const file = path.join(tmpdir(), `openpi-del-test-${Date.now()}.jsonl`);
  await writeFile(file, "{}");
  assert.equal(existsSync(file), true);

  const result = await deleteSessionFile(file);
  assert.equal(result.ok, true);
  assert.equal(existsSync(file), false);
});

test("deleteSessionFile returns error on non-existent file", async () => {
  const file = path.join(tmpdir(), `nonexistent-${Date.now()}.jsonl`);
  const result = await deleteSessionFile(file);
  assert.equal(result.ok, false);
});

test("deleteSessionFile is asynchronous and bounds execution timeout", async () => {
  const file = path.join(tmpdir(), `openpi-del-async-${Date.now()}.jsonl`);
  await writeFile(file, "{}");

  let timerFired = false;
  setTimeout(() => {
    timerFired = true;
  }, 1);

  const result = await deleteSessionFile(file, { timeoutMs: 100 });
  assert.equal(result.ok, true);
  assert.equal(existsSync(file), false);

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(timerFired, true);
});
