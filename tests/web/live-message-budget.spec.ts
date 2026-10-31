// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it } from "vitest";
import {
  fitLiveMessage,
  projectMessage,
  WEB_MAX_EVENT_BYTES,
  type WebLiveMessage,
  type WebSnapshot,
} from "../../web/protocol/types.ts";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import {
  buildEntries,
  displayedThinkingDuration,
} from "../../web/ui/src/features/transcript/transcript-entries.ts";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(cleanup);

const native = {
  role: "assistant",
  content: [{ type: "text", text: "中".repeat(11_500) }],
  stopReason: "stop",
  timestamp: 1_792_022_400_000,
};

function snapshotWith(
  entries: NonNullable<WebSnapshot["selectedSession"]>["entries"],
): WebSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: "2026-10-15T00:00:00Z",
    cursor: 1,
    preferences: { theme: "system" },
    currentSessionId: "current",
    currentSessionPath: "/tmp/current.jsonl",
    workspaces: [],
    sessions: [],
    models: [],
    selectedSession: {
      id: "current",
      path: "/tmp/current.jsonl",
      cwd: "/tmp",
      entries,
      bytes: 0,
      truncation: {
        truncated: false,
        maxBytes: 2097152,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
      },
    },
    runtime: { status: "idle", capabilities: {} },
    truncation: {
      truncated: false,
      maxBytes: 4194304,
      bytes: 0,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
      modelsOmitted: 0,
    },
  };
}

function responseRows(snapshot: WebSnapshot, live: WebLiveMessage) {
  const { container } = render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Transcript, {
        snapshot,
        liveMessages: [{ key: "live-1", message: live }],
        liveRunning: false,
        livePhase: "idle" as const,
        liveRetry: null,
        thinkingStarts: {},
        thinkingDurations: {},
        scrollToBottom: 0,
        onResend: async () => true,
      }),
    ),
  );
  return container.querySelectorAll(".message-row.assistant.response").length;
}

const persisted = projectMessage(native);
const live = fitLiveMessage(persisted, WEB_MAX_EVENT_BYTES - 200);
const persistedEntry = (message: WebLiveMessage) => ({
  id: "reply",
  timestamp: "2026-10-15T00:00:00Z",
  type: "message" as const,
  message,
});

it("a byte-trimmed live reply is not shown again beside its persisted entry", () => {
  expect(live.truncation?.transport).toBe(true);
  expect(responseRows(snapshotWith([persistedEntry(persisted)]), live)).toBe(1);
});

it("a byte-trimmed live reply still renders before it is persisted", () => {
  expect(responseRows(snapshotWith([]), live)).toBe(1);
});

it("a byte-trimmed live reply does not hide a different reply that shares its timestamp", () => {
  const other = projectMessage({
    ...native,
    content: [{ type: "text", text: "另一条回答" }],
  });
  expect(responseRows(snapshotWith([persistedEntry(other)]), live)).toBe(2);
});

const thinking = projectMessage({
  role: "assistant",
  timestamp: 42,
  content: [
    { type: "thinking", thinking: "思".repeat(12_000) },
    { type: "thinking", thinking: "考".repeat(12_000) },
  ],
});
const shortThinking = fitLiveMessage(thinking, WEB_MAX_EVENT_BYTES - 200);
const presentation = () => ({
  nativeRowKeys: new Map<string, string>(),
  ambiguousTimingIds: new Set<string>(),
});

it("does not hide a transport-trimmed pure-thinking reply behind unrelated same-timestamp thinking", () => {
  const other = projectMessage({
    role: "assistant",
    timestamp: 42,
    content: [{ type: "thinking", thinking: "Earlier reasoning" }],
  });
  expect(shortThinking.content).toBe("");
  expect(shortThinking.truncation?.transport).toBe(true);
  const { entries } = buildEntries(
    snapshotWith([persistedEntry(other)]),
    [{ key: "live", message: shortThinking }],
    presentation(),
  );
  expect(entries.map((entry) => entry.key)).toEqual(["reply", "live"]);
  expect(
    displayedThinkingDuration(entries[0]!, { "message-assistant-42": 1234 }),
  ).toBeUndefined();
});

it.each([undefined, 42])(
  "reconciles transport projections without losing thinking timing (timestamp %s)",
  (timestamp) => {
    const message = { ...thinking, timestamp };
    const live = fitLiveMessage(message, WEB_MAX_EVENT_BYTES - 200);
    const keys = presentation();
    const state = snapshotWith([persistedEntry(message)]);
    for (const liveMessages of [[{ key: "live", message: live }], []]) {
      const { entries } = buildEntries(state, liveMessages, keys);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.entryId).toBe("reply");
      expect(displayedThinkingDuration(entries[0]!, { live: 1234 })).toBe(1234);
    }
  },
);

it("collapses a timestamp-free byte-trimmed user message", () => {
  const message = projectMessage({
    role: "user",
    content: "中".repeat(12_000),
  });
  const live = fitLiveMessage(message, 20_000);
  expect(live.truncation?.transport).toBe(true);
  expect(
    buildEntries(
      snapshotWith([persistedEntry(message)]),
      [{ key: "live", message: live }],
      presentation(),
    ).entries,
  ).toHaveLength(1);
});

it("qualifies thinking parts even when visible reply prefixes agree", () => {
  const message = projectMessage({
    role: "assistant",
    timestamp: 42,
    content: [
      { type: "text", text: "中".repeat(12_000) },
      { type: "thinking", thinking: "思".repeat(12_000) },
    ],
  });
  const other = {
    ...message,
    parts: message.parts?.map((part) =>
      part.type === "thinking"
        ? { ...part, text: "Different reasoning" }
        : part,
    ),
  };
  const live = fitLiveMessage(message, 20_000);
  expect(
    buildEntries(
      snapshotWith([persistedEntry(other)]),
      [{ key: "live", message: live }],
      presentation(),
    ).entries,
  ).toHaveLength(2);
});

it("does not assign transport timing when native candidates or live owners are indistinguishable", () => {
  for (const duplicate of ["native", "live"]) {
    const state = snapshotWith([
      persistedEntry(thinking),
      ...(duplicate === "native"
        ? [{ ...persistedEntry(thinking), id: "second" }]
        : []),
    ]);
    const keys = presentation();
    const { entries } = buildEntries(
      state,
      [
        { key: "live", message: shortThinking },
        ...(duplicate === "live"
          ? [{ key: "other-live", message: shortThinking }]
          : []),
      ],
      keys,
    );
    const durations = {
      live: 1234,
      "other-live": 2345,
      "message-assistant-42": 3456,
    };
    for (const entry of entries.filter((entry) => entry.entryId))
      expect(displayedThinkingDuration(entry, durations)).toBeUndefined();
    for (const entry of buildEntries(state, [], keys).entries)
      expect(displayedThinkingDuration(entry, durations)).toBeUndefined();
  }
});
