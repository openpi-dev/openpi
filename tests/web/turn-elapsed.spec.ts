// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { formatTurnDuration } from "../../web/ui/src/features/transcript/TurnElapsed.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
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
function snapshot(): WebSnapshot {
  return {
    protocolVersion: 1,
    preferences: { theme: "system" },
    generatedAt: new Date().toISOString(),
    cursor: 1,
    currentSessionId: "session",
    currentSessionPath: "/session.jsonl",
    workspaces: [],
    sessions: [],
    models: [],
    truncation,
    runtime: {
      status: "running",
      capabilities: {},
      activeTurn: {
        sessionId: "session",
        sessionPath: "/session.jsonl",
        commandId: "a",
        epoch: 1,
        startedAt: 10000,
        elapsedMs: 100000,
      },
    },
    selectedSession: {
      id: "session",
      path: "/session.jsonl",
      cwd: "/",
      entries: [],
      bytes: 0,
      truncation,
    },
  };
}
function node(value: WebSnapshot) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(Transcript, {
      snapshot: value,
      liveMessages: [],
      liveRunning: false,
      livePhase: "idle",
      liveRetry: null,
      thinkingStarts: {},
      thinkingDurations: {},
      scrollToBottom: 0,
      onResend: async () => true,
    }),
  );
}

it("uses one monotonic ticker, reconciles without going backward, and cleans up for another Session", () => {
  vi.useFakeTimers();
  const intervals = vi.spyOn(window, "setInterval");
  const clearedIntervals = vi.spyOn(window, "clearInterval");
  let clock = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const value = snapshot();
  value.selectedSession!.entries = [
    {
      id: "thinking",
      type: "message",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: "",
        parts: [
          { type: "thinking", text: "First step" },
          { type: "thinking", text: "Second step" },
        ],
      },
    },
  ];
  const view = render(node(value));
  expect(screen.getByRole("timer").textContent).toContain("1m40s");
  expect(intervals).toHaveBeenCalledOnce();
  act(() => {
    clock += 2000;
    vi.advanceTimersByTime(2000);
  });
  expect(screen.getByRole("timer").textContent).toContain("1m42s");
  vi.setSystemTime(new Date(1));
  view.rerender(
    node({
      ...value,
      runtime: {
        ...value.runtime,
        activeTurn: { ...value.runtime.activeTurn!, elapsedMs: 90000 },
      },
    }),
  );
  expect(screen.getByRole("timer").textContent).toContain("1m42s");
  expect(vi.getTimerCount()).toBe(1);
  view.rerender(
    node({
      ...value,
      selectedSession: {
        ...value.selectedSession!,
        path: "/copied-session.jsonl",
      },
    }),
  );
  expect(screen.queryByRole("timer")).toBeNull();
  expect(clearedIntervals).toHaveBeenCalledWith(
    intervals.mock.results[0]!.value,
  );
  // jsdom queues a one-shot toggle event when the old process details close.
  // It is not the elapsed interval; flush only that immediate DOM task.
  act(() => vi.advanceTimersByTime(0));
  expect(intervals).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("recovers the elapsed value on refresh and resets only for a different turn identity", () => {
  vi.useFakeTimers();
  const value = snapshot();
  const view = render(node(value));
  expect(screen.getByRole("timer").textContent).toContain("1m40s");
  view.rerender(
    node({
      ...value,
      runtime: {
        ...value.runtime,
        activeTurn: {
          ...value.runtime.activeTurn!,
          commandId: "b",
          epoch: 2,
          elapsedMs: 3000,
        },
      },
    }),
  );
  expect(screen.getByRole("timer").textContent).toContain("3s");
  expect(vi.getTimerCount()).toBe(1);
});

it.each(["completed", "failed", "cancelled", "uncertain"] as const)(
  "shows fixed persisted elapsed time for a %s run",
  (outcome) => {
    vi.useFakeTimers();
    const value = snapshot();
    value.runtime = { status: "idle", capabilities: {} };
    value.selectedSession!.entries = [
      {
        id: "timing",
        type: "custom",
        timestamp: "2026-09-22T00:00:00Z",
        turnTiming: {
          version: 1,
          sessionId: "session",
          commandId: "a",
          epoch: 1,
          startedAt: 10000,
          finishedAt: 167000,
          elapsedMs: 157000,
          outcome,
        },
      },
    ];
    const view = render(node(value));
    expect(
      screen.getByText(i18n.t("turnElapsedFinished", { duration: "2m37s" })),
    ).toBeTruthy();
    expect(
      view.container
        .querySelector(".turn-duration")
        ?.getAttribute("data-outcome"),
    ).toBe(outcome);
    act(() => vi.advanceTimersByTime(60000));
    expect(
      screen.getByText(i18n.t("turnElapsedFinished", { duration: "2m37s" })),
    ).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("does not invent a duration from old timestamps or incomplete runtime evidence", () => {
  const value = snapshot();
  value.runtime.activeTurn = {
    sessionId: "session",
    commandId: "legacy",
    epoch: 1,
  };
  value.selectedSession!.entries = [
    {
      id: "old-user",
      type: "message",
      timestamp: "2020-01-01T00:00:00Z",
      message: { role: "user", content: "Old question" },
    },
  ];
  const view = render(node(value));
  expect(screen.queryByRole("timer")).toBeNull();
  expect(view.container.querySelector(".turn-duration")).toBeNull();
});

it("places settled duration after execution details and before the final text response", () => {
  const value = snapshot();
  value.runtime = { status: "idle", capabilities: {} };
  value.selectedSession!.entries = [
    {
      id: "user",
      type: "message",
      timestamp: "2026-09-22T00:00:00Z",
      message: { role: "user", content: "Question" },
    },
    {
      id: "answer",
      type: "message",
      timestamp: "2026-09-22T00:02:36Z",
      message: {
        role: "assistant",
        content: "Final answer",
        stopReason: "stop",
        parts: [{ type: "thinking", text: "Verifying the result" }],
      },
    },
    {
      id: "timing",
      type: "custom",
      timestamp: "2026-09-22T00:02:37Z",
      turnTiming: {
        version: 1,
        sessionId: "session",
        commandId: "a",
        epoch: 1,
        startedAt: 10000,
        finishedAt: 167000,
        elapsedMs: 157000,
        outcome: "completed",
      },
    },
  ];
  const view = render(node(value));
  const process = view.container.querySelector(".process-sequence")!;
  const duration = view.container.querySelector(".turn-duration")!;
  const answer = view.container.querySelector(".final-response")!;
  expect(
    process.compareDocumentPosition(duration) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    duration.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});

it("does not move a duration backward across a user or another timing record", () => {
  const value = snapshot();
  value.runtime = { status: "idle", capabilities: {} };
  const timing = {
    version: 1 as const,
    sessionId: "session",
    commandId: "a",
    epoch: 1,
    startedAt: 1000,
    finishedAt: 2000,
    elapsedMs: 1000,
    outcome: "completed" as const,
  };
  value.selectedSession!.entries = [
    {
      id: "answer",
      type: "message",
      timestamp: "2026-09-22T00:00:01Z",
      message: {
        role: "assistant",
        content: "Previous answer",
        stopReason: "stop",
      },
    },
    {
      id: "timing-a",
      type: "custom",
      timestamp: "2026-09-22T00:00:02Z",
      turnTiming: timing,
    },
    {
      id: "timing-b",
      type: "custom",
      timestamp: "2026-09-22T00:00:03Z",
      turnTiming: { ...timing, commandId: "b", epoch: 2, elapsedMs: 2000 },
    },
    {
      id: "user",
      type: "message",
      timestamp: "2026-09-22T00:00:04Z",
      message: { role: "user", content: "Next question" },
    },
    {
      id: "timing-c",
      type: "custom",
      timestamp: "2026-09-22T00:00:05Z",
      turnTiming: { ...timing, commandId: "c", epoch: 3, elapsedMs: 3000 },
    },
  ];
  const view = render(node(value));
  const ordered = [
    ...view.container.querySelectorAll(
      ".turn-duration, .message-row.user .message-body, .message-row.response .message-content",
    ),
  ].map((element) => element.textContent?.trim());
  expect(ordered).toEqual([
    i18n.t("turnElapsedFinished", { duration: "1s" }),
    "Previous answer",
    i18n.t("turnElapsedFinished", { duration: "2s" }),
    "Next question",
    i18n.t("turnElapsedFinished", { duration: "3s" }),
  ]);
});

it("formats the requested running and settled duration styles", () => {
  expect(formatTurnDuration(2142000, "zh-CN", true)).toBe("35分钟42秒");
  expect(formatTurnDuration(157000, "zh-CN", false)).toBe("2m37s");
  expect(formatTurnDuration(3601000, "en", true)).toBe("1h0m1s");
});
