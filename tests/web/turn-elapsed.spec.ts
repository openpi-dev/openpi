// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
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
function node(
  value: WebSnapshot,
  extra: Partial<Parameters<typeof Transcript>[0]> = {},
) {
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
      ...extra,
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
  expect(intervals).toHaveBeenCalledOnce();
  expect(clearedIntervals).not.toHaveBeenCalled();
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
  expect(clearedIntervals).toHaveBeenCalledOnce();
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
  "shows fixed persisted elapsed time and the appropriate process default for a %s run",
  (outcome) => {
    vi.useFakeTimers();
    const value = snapshot();
    value.runtime = { status: "idle", capabilities: {} };
    value.selectedSession!.entries = [
      {
        id: "update",
        type: "message",
        timestamp: "2026-09-22T00:00:00Z",
        message: { role: "assistant", content: "Run evidence" },
      },
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
    expect(
      view.container.querySelector<HTMLElement>(".turn-response-body")?.hidden,
    ).toBe(outcome === "completed");
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

it("defaults completed execution to folded, keeps the final answer visible and preserves nested tool groups", () => {
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
      id: "first-update",
      type: "message",
      timestamp: "2026-09-22T00:00:01Z",
      message: {
        role: "assistant",
        content: "First update",
        parts: [
          { type: "text", text: "First update" },
          { type: "thinking", text: "Verifying the result" },
          {
            type: "toolCall",
            id: "read-1",
            name: "read",
            arguments: '{"path":"README.md"}',
          },
          {
            type: "toolCall",
            id: "read-2",
            name: "read",
            arguments: '{"path":"package.json"}',
          },
        ],
      },
    },
    {
      id: "read-result",
      type: "message",
      timestamp: "2026-09-22T00:00:02Z",
      message: {
        role: "toolResult",
        toolName: "read",
        toolCallId: "read-1",
        content: "Source",
        isError: false,
      },
    },
    {
      id: "read-result-2",
      type: "message",
      timestamp: "2026-09-22T00:00:02Z",
      message: {
        role: "toolResult",
        toolName: "read",
        toolCallId: "read-2",
        content: "Package source",
        isError: false,
      },
    },
    {
      id: "second-update",
      type: "message",
      timestamp: "2026-09-22T00:00:03Z",
      message: {
        role: "assistant",
        content: "Second update",
        parts: [
          { type: "text", text: "Second update" },
          {
            type: "toolCall",
            id: "bash-1",
            name: "bash",
            arguments: '{"command":"npm test"}',
          },
          {
            type: "toolCall",
            id: "bash-2",
            name: "bash",
            arguments: '{"command":"git diff --check"}',
          },
        ],
      },
    },
    {
      id: "bash-result",
      type: "message",
      timestamp: "2026-09-22T00:00:04Z",
      message: {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "bash-1",
        content: "All tests passed",
        isError: false,
      },
    },
    {
      id: "bash-result-2",
      type: "message",
      timestamp: "2026-09-22T00:00:04Z",
      message: {
        role: "toolResult",
        toolName: "bash",
        toolCallId: "bash-2",
        content: "",
        isError: false,
      },
    },
    {
      id: "answer",
      type: "message",
      timestamp: "2026-09-22T00:02:36Z",
      message: {
        role: "assistant",
        content: "Final answer",
        stopReason: "stop",
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
  const body = view.container.querySelector<HTMLElement>(
    ".turn-response-body",
  )!;
  const duration = view.container.querySelector(".turn-duration")!;
  const answer = view.container.querySelector(".final-response")!;
  expect(
    duration.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(body.hidden).toBe(true);
  expect(answer.closest("[hidden]")).toBeNull();
  const toggle = screen.getByRole("button", { name: "Worked for 2m37s" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(body.hidden).toBe(false);
  const groups = [
    ...body.querySelectorAll<HTMLDetailsElement>(".process-sequence"),
  ];
  expect(groups).toHaveLength(2);
  expect(groups.every((group) => !group.open)).toBe(true);
  expect(groups[0]?.querySelector("summary")?.textContent).toContain(
    i18n.t("toolActionGroup_read"),
  );
  expect(groups[1]?.querySelector("summary")?.textContent).toContain(
    i18n.t("toolActionGroup_command"),
  );
  expect(body.querySelector(".thinking-line summary")?.textContent).toBe(
    "Verifying the result",
  );
  groups[0]!.open = true;
  fireEvent(groups[0]!, new Event("toggle"));
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.getAttribute("aria-controls")).toBe(body.id);
  fireEvent.click(toggle);
  expect(body.hidden).toBe(true);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  for (const text of ["First update", "Second update"])
    expect(screen.getByText(text).closest("[hidden]")).toBe(body);
  expect(answer.closest("[hidden]")).toBeNull();
  expect(screen.getByText("Question").closest("[hidden]")).toBeNull();
  fireEvent.click(toggle);
  expect(body.hidden).toBe(false);
  expect(groups[0]!.open).toBe(true);
  expect(groups[1]!.open).toBe(false);
  expect(view.container.querySelectorAll(".turn-duration")).toHaveLength(1);
  expect(
    duration.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(toggle);
  view.rerender(
    node(value, {
      historyNavigation: {
        sessionId: value.selectedSession!.id,
        sessionPath: value.selectedSession!.path,
        entryId: "first-update",
        revision: 1,
        session: value.selectedSession!,
      },
    }),
  );
  expect(
    view.container.querySelector<HTMLElement>(".turn-response-body")!.hidden,
  ).toBe(false);
  expect(screen.getByText("Final answer").closest("[hidden]")).toBeNull();
  fireEvent.click(toggle);
  view.rerender(
    node(value, {
      historyNavigation: {
        sessionId: value.selectedSession!.id,
        sessionPath: value.selectedSession!.path,
        entryId: "answer",
        revision: 2,
        session: value.selectedSession!,
      },
    }),
  );
  expect(body.hidden).toBe(true);
  expect(screen.getByText("Final answer").closest("[hidden]")).toBeNull();
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

it("folds one native execution across steering while preserving user inputs, its exact final answer and chronology", () => {
  const value = snapshot();
  const entries: NonNullable<WebSnapshot["selectedSession"]>["entries"] = [
    {
      id: "initial",
      type: "message",
      timestamp: "2026-09-22T00:00:00Z",
      message: { role: "user", content: "Initial task" },
    },
    {
      id: "progress-1",
      type: "message",
      timestamp: "2026-09-22T00:00:01Z",
      message: {
        role: "assistant",
        content: "First progress",
        stopReason: "stop",
      },
    },
    {
      id: "steering-1",
      type: "message",
      timestamp: "2026-09-22T00:00:02Z",
      message: { role: "user", content: "First additional detail" },
    },
    {
      id: "progress-2",
      type: "message",
      timestamp: "2026-09-22T00:00:03Z",
      message: {
        role: "assistant",
        content: "Second progress",
        parts: [{ type: "thinking", text: "Complete available thought" }],
      },
    },
    {
      id: "steering-2",
      type: "message",
      timestamp: "2026-09-22T00:00:04Z",
      message: { role: "user", content: "Second additional detail" },
    },
    {
      id: "answer",
      type: "message",
      timestamp: "2026-09-22T00:00:05Z",
      message: {
        role: "assistant",
        content: "Native final answer",
        stopReason: "stop",
      },
    },
  ];
  value.selectedSession!.entries = entries;
  value.runtime.activeTurn = {
    ...value.runtime.activeTurn!,
    promptEntryId: "initial",
  };
  const view = render(node(value));
  const button = view.container.querySelector<HTMLButtonElement>(
    ".turn-duration-toggle",
  )!;
  expect(view.container.querySelectorAll(".turn-duration")).toHaveLength(1);
  fireEvent.click(button);
  for (const text of [
    "First progress",
    "Second progress",
    "Native final answer",
  ])
    expect(
      screen.getByText(text).closest<HTMLElement>("[hidden]")?.hidden,
    ).toBe(true);
  for (const text of [
    "Initial task",
    "First additional detail",
    "Second additional detail",
  ])
    expect(screen.getByText(text).closest("[hidden]")).toBeNull();

  const settled = structuredClone(value);
  settled.runtime = { status: "idle", capabilities: {} };
  settled.selectedSession!.entries.push({
    id: "timing",
    type: "custom",
    timestamp: "2026-09-22T00:00:06Z",
    turnTiming: {
      version: 1,
      sessionId: "session",
      commandId: "a",
      epoch: 1,
      startedAt: 10000,
      finishedAt: 11000,
      elapsedMs: 1000,
      outcome: "completed",
      promptEntryId: "initial",
      resultEntryId: "answer",
    },
  });
  view.rerender(node(settled));
  expect(view.container.querySelectorAll(".turn-duration")).toHaveLength(1);
  expect(
    screen.getByText("Native final answer").closest("[hidden]"),
  ).toBeNull();
  expect(
    screen.getByText("First progress").closest<HTMLElement>("[hidden]")?.hidden,
  ).toBe(true);
  fireEvent.click(button);
  expect(
    [
      ...view.container.querySelectorAll<HTMLElement>(".turn-response-body"),
    ].every((body) => !body.hidden),
  ).toBe(true);
  const visible = [
    ...view.container.querySelectorAll(
      ".turn-duration, .message-row .message-content",
    ),
  ].map((element) => element.textContent?.trim());
  expect(visible).toEqual([
    "Initial task",
    i18n.t("turnElapsedFinished", { duration: "1s" }),
    "First progress",
    "First additional detail",
    "Complete available thought",
    "Second progress",
    "Second additional detail",
    "Native final answer",
  ]);
  const controlled = button.getAttribute("aria-controls")!.split(" ");
  expect(controlled).toHaveLength(2);
  expect(
    controlled.every((id) =>
      document.getElementById(id)?.classList.contains("turn-response-body"),
    ),
  ).toBe(true);
});

it("does not fold an earlier execution when a native timing input is missing from the visible branch", () => {
  const value = snapshot();
  value.runtime = { status: "idle", capabilities: {} };
  value.selectedSession!.entries = [
    {
      id: "old-input",
      type: "message",
      timestamp: "2026-09-22T00:00:00Z",
      message: { role: "user", content: "Earlier input" },
    },
    {
      id: "old-progress",
      type: "message",
      timestamp: "2026-09-22T00:00:01Z",
      message: { role: "assistant", content: "Earlier visible progress" },
    },
    {
      id: "new-input",
      type: "message",
      timestamp: "2026-09-22T00:00:02Z",
      message: { role: "user", content: "New input" },
    },
    {
      id: "new-progress",
      type: "message",
      timestamp: "2026-09-22T00:00:03Z",
      message: { role: "assistant", content: "New hidden progress" },
    },
    {
      id: "timing",
      type: "custom",
      timestamp: "2026-09-22T00:00:04Z",
      turnTiming: {
        version: 1,
        sessionId: "session",
        commandId: "a",
        epoch: 1,
        startedAt: 10000,
        finishedAt: 11000,
        elapsedMs: 1000,
        outcome: "completed",
        promptEntryId: "missing-input",
      },
    },
  ];
  render(node(value));
  expect(
    screen.getByText("Earlier visible progress").closest("[hidden]"),
  ).toBeNull();
  expect(
    screen.getByText("New hidden progress").closest<HTMLElement>("[hidden]")
      ?.hidden,
  ).toBe(true);
});

it("offers animated latest activity only while reading above the bottom and replaces it with an arrow at settlement", () => {
  const originalScroll = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollTo",
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(300);
  const scrollTo = vi.fn(function (
    this: HTMLElement,
    options: ScrollToOptions,
  ) {
    this.scrollTop = Math.min(options.top ?? 0, 600);
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: scrollTo,
  });
  try {
    const value = snapshot();
    value.selectedSession!.entries = [
      {
        id: "prompt",
        type: "message",
        timestamp: "2026-09-22T00:00:00Z",
        message: { role: "user", content: "Question" },
      },
    ];
    const view = render(node(value));
    const viewport =
      view.container.querySelector<HTMLElement>(".conversation")!;
    expect(
      screen.queryByRole("button", { name: i18n.t("jumpToLatest") }),
    ).toBeNull();
    expect(view.container.querySelector(".conversation-running")).toBeNull();
    expect(
      view.container
        .querySelector(".conversation-execution-status")
        ?.classList.contains("sr-only"),
    ).toBe(true);
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    const jump = screen.getByRole("button", { name: i18n.t("jumpToLatest") });
    expect(jump.querySelectorAll(".latest-activity-dots i")).toHaveLength(3);
    expect(jump.closest(".transcript-surface")).toBe(viewport.parentElement);
    fireEvent.click(jump);
    expect(viewport.scrollTop).toBe(600);
    expect(
      screen.queryByRole("button", { name: i18n.t("jumpToLatest") }),
    ).toBeNull();
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    view.rerender(
      node({ ...value, runtime: { status: "idle", capabilities: {} } }),
    );
    const settled = screen.getByRole("button", {
      name: i18n.t("jumpToLatest"),
    });
    expect(settled.querySelector(".latest-activity-dots")).toBeNull();
    expect(settled.querySelector("svg")).toBeTruthy();
  } finally {
    if (originalScroll)
      Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScroll);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  }
});

it("formats readable localized durations for both running and settled turns", () => {
  expect(formatTurnDuration(2142000, "zh-CN")).toBe("35m 42s");
  expect(formatTurnDuration(157000, "zh-CN")).toBe("2m 37s");
  expect(formatTurnDuration(3601000, "en")).toBe("1h0m1s");
});

it("keeps one top timer through streaming, manual folding, settlement, and a late running notification", () => {
  const value = snapshot();
  const entries = [
    {
      id: "prompt",
      type: "message" as const,
      message: { role: "user", content: "Question" },
    },
    {
      id: "step-1",
      type: "message" as const,
      message: {
        role: "assistant",
        content: "First update",
        parts: [{ type: "thinking" as const, text: "Check one" }],
      },
    },
    {
      id: "step-2",
      type: "message" as const,
      message: {
        role: "assistant",
        content: "Final answer",
        parts: [{ type: "thinking" as const, text: "Check two" }],
      },
    },
  ].map((entry) => ({ ...entry, timestamp: "2026-09-22T00:00:00Z" }));
  value.selectedSession!.entries = entries;
  const view = render(node(value));
  const header = view.container.querySelector(".turn-duration")!;
  const prompt = screen.getByText("Question");
  expect(
    prompt.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    header.compareDocumentPosition(screen.getByText("First update")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    view.container.querySelector(".conversation-running [role=timer]"),
  ).toBeNull();
  const toggle = view.container.querySelector<HTMLButtonElement>(
    ".turn-duration-toggle",
  )!;
  const body = view.container.querySelector<HTMLElement>(
    ".turn-response-body",
  )!;
  expect(toggle.getAttribute("aria-controls")).toBe(body.id);
  expect(body.hidden).toBe(false);
  fireEvent.click(toggle);
  expect(body.hidden).toBe(true);
  view.rerender(node({ ...value, cursor: 2 }));
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByText("First update").closest("[hidden]")).toBe(body);
  expect(screen.getByText("Final answer").closest("[hidden]")).toBe(body);
  fireEvent.click(toggle);
  expect(body.hidden).toBe(false);

  const settled = {
    ...value,
    selectedSession: {
      ...value.selectedSession!,
      entries: [
        ...entries.map((entry) =>
          entry.id === "step-2"
            ? {
                ...entry,
                message: { ...entry.message, stopReason: "stop" as const },
              }
            : entry,
        ),
        {
          id: "timing",
          type: "custom" as const,
          timestamp: "2026-09-22T00:02:37Z",
          turnTiming: {
            version: 1 as const,
            sessionId: "session",
            commandId: "a",
            epoch: 1,
            startedAt: 10000,
            finishedAt: 167000,
            elapsedMs: 157000,
            outcome: "completed" as const,
          },
        },
      ],
    },
  };
  // Settlement evidence is already available, but the status is still running.
  view.rerender(node(settled));
  expect(body.hidden).toBe(true);
  expect(screen.getByText("Final answer").closest("[hidden]")).toBeNull();
  expect(screen.queryByRole("timer")).toBeNull();
  expect(view.container.querySelectorAll(".turn-duration")).toHaveLength(1);
  expect(
    screen
      .getByRole("button", { name: "Worked for 2m37s" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  view.rerender(
    node({ ...settled, runtime: { status: "idle", capabilities: {} } }),
  );
  expect(view.container.querySelectorAll(".turn-duration")).toHaveLength(1);
});

it("leaves a final-only answer visible without an empty execution disclosure", () => {
  const value = snapshot();
  value.runtime = { status: "idle", capabilities: {} };
  value.selectedSession!.entries = [
    {
      id: "answer",
      type: "message",
      timestamp: "2026-09-22T00:00:00Z",
      message: {
        role: "assistant",
        content: "Plain answer",
        stopReason: "stop",
      },
    },
    {
      id: "timing",
      type: "custom",
      timestamp: "2026-09-22T00:00:01Z",
      turnTiming: {
        version: 1,
        sessionId: "session",
        commandId: "a",
        epoch: 1,
        startedAt: 0,
        finishedAt: 1000,
        elapsedMs: 1000,
        outcome: "completed",
      },
    },
  ];
  const view = render(node(value));
  const duration = view.container.querySelector(".turn-duration")!;
  expect(
    duration.compareDocumentPosition(screen.getByText("Plain answer")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(duration.querySelector("button")).toBeNull();
  expect(view.container.querySelector(".turn-response-body")).toBeNull();
  expect(screen.getByText("Plain answer").closest("[hidden]")).toBeNull();
});
