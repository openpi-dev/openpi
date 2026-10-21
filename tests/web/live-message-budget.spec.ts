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

it("FAIL: a byte-trimmed live reply is not shown again beside its persisted entry", () => {
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
