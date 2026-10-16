// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it } from "vitest";
import type { WebLiveMessage, WebSnapshot } from "../../web/protocol/types.ts";
import {
  observeTranscriptRowRenders,
  Transcript,
} from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(() => {
  cleanup();
  observeTranscriptRowRenders(undefined);
});

const truncation = {
  bytes: 0,
  maxBytes: 1024,
  messagesTruncated: 0,
  messagePartsOmitted: 0,
  entriesOmitted: 0,
  modelsOmitted: 0,
  sessionsOmitted: 0,
  workspacesOmitted: 0,
  truncated: false,
};

const onResend = async () => true;

function historyMessage(
  id: string,
  content: string,
): NonNullable<WebSnapshot["selectedSession"]>["entries"][number] {
  const message: WebLiveMessage = {
    role: "assistant",
    timestamp: Number(id.slice(1)),
    content,
    stopReason: "stop",
    parts: [{ type: "text", text: content }],
  };
  return {
    id,
    parentId: null,
    type: "message",
    timestamp: "2026-10-16T00:00:00Z",
    message,
  };
}

function snapshot(
  entries: NonNullable<WebSnapshot["selectedSession"]>["entries"],
): WebSnapshot {
  return {
    protocolVersion: 1,
    preferences: { theme: "system" },
    generatedAt: "2026-10-16T00:00:00Z",
    cursor: 1,
    currentSessionId: "s",
    currentSessionPath: "/s.jsonl",
    workspaces: [],
    sessions: [],
    models: [],
    truncation,
    runtime: { status: "running", capabilities: {} },
    selectedSession: {
      id: "s",
      path: "/s.jsonl",
      cwd: "/",
      entries,
      bytes: 0,
      truncation,
    },
  };
}

function transcript(state: WebSnapshot, live: string) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(Transcript, {
      snapshot: state,
      liveMessages: [
        {
          key: "live-current",
          message: {
            role: "assistant",
            content: live,
            parts: [{ type: "text", text: live }],
          },
        },
      ],
      liveRunning: true,
      livePhase: "running",
      liveRetry: null,
      thinkingStarts: {},
      thinkingDurations: {},
      scrollToBottom: 0,
      onResend,
    }),
  );
}

it("keeps history text, selection anchors, and findable copy while a live token updates only the live row", () => {
  const entries = [
    historyMessage("e0", "HISTORY_0"),
    historyMessage("e1", "HISTORY_1"),
    historyMessage("e2", "HISTORY_FIND_ME"),
  ];
  const state = snapshot(entries);
  const seen: string[] = [];
  observeTranscriptRowRenders((key) => {
    seen.push(key);
  });
  const view = render(transcript(state, "LIVE_0"));
  const historyAnchor = view.container.querySelector(
    '[data-history-entry="e0-text-0"]',
  );
  expect(historyAnchor?.textContent).toContain("HISTORY_0");
  expect(view.container.textContent).toContain("HISTORY_FIND_ME");
  expect(view.container.textContent).toContain("LIVE_0");
  seen.length = 0;

  view.rerender(transcript(state, "LIVE_1"));

  expect(view.container.textContent).toContain("HISTORY_0");
  expect(view.container.textContent).toContain("HISTORY_1");
  expect(view.container.textContent).toContain("HISTORY_FIND_ME");
  expect(view.container.textContent).toContain("LIVE_1");
  expect(view.container.textContent).not.toContain("LIVE_0");
  expect(view.container.querySelector('[data-history-entry="e0-text-0"]')).toBe(
    historyAnchor,
  );
  expect(seen.filter((key) => key.startsWith("e"))).toEqual([]);
  expect(seen.some((key) => key.startsWith("live-current"))).toBe(true);
});

it("re-renders only the history row whose message changed", () => {
  const kept = historyMessage("e0", "HISTORY_KEEP");
  const edited = historyMessage("e1", "HISTORY_OLD");
  const after = historyMessage("e2", "HISTORY_AFTER");
  const first = snapshot([kept, edited, after]);
  const seen: string[] = [];
  observeTranscriptRowRenders((key) => {
    seen.push(key);
  });
  const view = render(transcript(first, "LIVE_0"));
  seen.length = 0;
  const replacement = historyMessage("e1", "HISTORY_NEW");
  view.rerender(
    transcript(
      {
        ...first,
        selectedSession: {
          ...first.selectedSession!,
          entries: [kept, replacement, after],
        },
      },
      "LIVE_0",
    ),
  );
  expect(view.container.textContent).toContain("HISTORY_KEEP");
  expect(view.container.textContent).toContain("HISTORY_NEW");
  expect(view.container.textContent).toContain("HISTORY_AFTER");
  expect(view.container.textContent).not.toContain("HISTORY_OLD");
  expect(seen.filter((key) => key.startsWith("e0"))).toEqual([]);
  expect(seen.filter((key) => key.startsWith("e2"))).toEqual([]);
  expect(seen.some((key) => key.startsWith("e1"))).toBe(true);
});

it("shows a newly arrived tool result on its call row without re-rendering unrelated history", () => {
  const kept = historyMessage("e0", "HISTORY_KEEP");
  const call = historyMessage("e1", "");
  call.message = {
    role: "assistant",
    timestamp: 1,
    content: "",
    parts: [
      {
        type: "toolCall",
        id: "call-1",
        name: "read",
        arguments: '{"path":"a.ts"}',
      },
    ],
  };
  const state = snapshot([kept, call]);
  const seen: string[] = [];
  observeTranscriptRowRenders((key) => {
    seen.push(key);
  });
  const view = render(transcript(state, "LIVE_0"));
  expect(view.container.textContent).toContain("HISTORY_KEEP");
  expect(view.container.textContent).not.toContain("RESULT_BODY");
  seen.length = 0;

  view.rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Transcript, {
        snapshot: state,
        liveMessages: [
          {
            key: "live-current",
            message: {
              role: "assistant",
              content: "LIVE_0",
              parts: [{ type: "text", text: "LIVE_0" }],
            },
          },
          {
            key: "live-result",
            message: {
              role: "toolResult",
              toolCallId: "call-1",
              toolName: "read",
              content: "RESULT_BODY",
              isError: false,
            },
          },
        ],
        liveRunning: true,
        livePhase: "running",
        liveRetry: null,
        thinkingStarts: {},
        thinkingDurations: {},
        scrollToBottom: 0,
        onResend,
      }),
    ),
  );

  expect(view.container.textContent).toContain("HISTORY_KEEP");
  expect(view.container.textContent).toContain("RESULT_BODY");
  expect(seen.filter((key) => key.startsWith("e0"))).toEqual([]);
  expect(seen.some((key) => key.startsWith("e1"))).toBe(true);
});
