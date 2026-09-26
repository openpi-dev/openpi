import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSessionDescription,
  buildSessionLabel,
  buildSessionPreview,
  buildSessionSearchEntries,
  filterSessionEntries,
  formatRelativeTime,
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

test("formatRelativeTime deterministically formats relative hours and calendar dates with frozen clocks", () => {
  const baseNow = new Date("2026-09-21T12:00:00");
  const tenMins = new Date("2026-09-21T11:50:00");
  const twoHours = new Date("2026-09-21T10:00:00");
  const almostOneDay = new Date("2026-09-20T12:01:00");
  const oneDay = new Date("2026-09-20T12:00:00");
  const threeDays = new Date("2026-09-18T12:00:00");
  const twelveDays = new Date("2026-09-09T12:00:00");

  assert.equal(formatRelativeTime(tenMins, baseNow), "11:50 (10m ago)");
  assert.equal(formatRelativeTime(twoHours, baseNow), "10:00 (2h ago)");
  assert.equal(formatRelativeTime(almostOneDay, baseNow), "12:01 (23h ago)");
  assert.equal(formatRelativeTime(oneDay, baseNow), "09-20 (1d ago)");
  assert.equal(formatRelativeTime(threeDays, baseNow), "09-18 (3d ago)");
  assert.equal(formatRelativeTime(twelveDays, baseNow), "09-09 (12d ago)");

  // Midnight boundary test case: 10 minutes ago across midnight (23:55 viewed at 00:05)
  const midnightNow = new Date("2026-09-21T00:05:00");
  const midnightTenMinsAgo = new Date("2026-09-20T23:55:00");
  assert.equal(
    formatRelativeTime(midnightTenMinsAgo, midnightNow),
    "23:55 (10m ago)",
  );

  // Cross-year boundary test case: New Year 00:05 viewing New Year's Eve 23:55
  const janNow = new Date("2027-01-01T00:05:00");
  const decEve = new Date("2026-12-31T23:55:00");
  assert.equal(formatRelativeTime(decEve, janNow), "23:55 (10m ago)");

  // Cross-year within 60 days
  const jan3rd = new Date("2027-01-03T12:00:00");
  const dec30 = new Date("2026-12-30T12:00:00");
  assert.equal(formatRelativeTime(dec30, jan3rd), "12-30 (4d ago)");

  // Over 1 year ago
  const twoYearsLater = new Date("2028-09-21T12:00:00");
  assert.equal(formatRelativeTime(baseNow, twoYearsLater), "2026-09 (2y ago)");
});

test("formatRelativeTime keeps a date and relative age within narrow list rows", () => {
  const now = new Date("2026-09-21T12:00:00");
  const tenMins = new Date("2026-09-21T11:50:00");
  const threeDays = new Date("2026-09-18T12:00:00");
  const twoYears = new Date("2024-09-21T12:00:00");

  assert.equal(formatRelativeTime(tenMins, now, 9), "09-21 10m");
  assert.equal(formatRelativeTime(threeDays, now, 12), "09-18 3d ago");
  assert.equal(formatRelativeTime(threeDays, now, 9), "09-18 3d");
  assert.equal(formatRelativeTime(twoYears, now, 10), "2024-09 2y");
});

test("session search matches formatted dates and years", () => {
  const sample = {
    ...session,
    modified: new Date("2026-09-06T10:00:00Z"),
  };
  const entries = buildSessionSearchEntries([sample]);
  assert.equal(filterSessionEntries(entries, "2026").length, 1);
  assert.equal(filterSessionEntries(entries, "09-06").length, 1);
});
