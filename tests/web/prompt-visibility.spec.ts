// @vitest-environment jsdom
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { projectMessage, type WebSnapshot } from "../../web/protocol/types.ts";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import type { LiveEntry } from "../../web/ui/src/store/web-store.ts";

afterEach(cleanup);

it("keeps an unaccepted prompt even when another native input matches its text", () => {
  const value = snapshot();
  value.selectedSession!.entries.push({
    id: "other-input",
    timestamp: "2026-09-22T09:01:00Z",
    type: "message",
    message: { role: "user", content: "继续" },
  });
  const pending: LiveEntry = {
    key: "sending",
    message: { role: "user", content: "继续" },
    optimistic: {
      sessionId: "s",
      sessionPath: "/session.jsonl",
      commandId: "sending",
      afterEntryId: "old-answer",
      admitted: false,
    },
  };
  const remember = vi.fn();
  const view = render(node(value, [pending], remember));
  expect(view.container.querySelectorAll(".message-row.user")).toHaveLength(3);
  expect(remember).not.toHaveBeenCalled();
});

it("does not resurrect an already projected prompt after its native entry leaves the latest window", () => {
  const value = snapshot();
  value.selectedSession!.entries.push({
    id: "accepted-input",
    timestamp: "2026-09-22T09:01:00Z",
    type: "message",
    message: projectMessage({
      role: "user",
      content: [{ type: "text", text: "继续" }],
    }),
  });
  const pending: LiveEntry = {
    key: "accepted",
    timestamp: "2026-09-22T09:01:00Z",
    message: { role: "user", content: "继续" },
    optimistic: {
      sessionId: "s",
      sessionPath: "/session.jsonl",
      commandId: "accepted",
      afterEntryId: "old-answer",
      admitted: true,
    },
  };
  const remember = vi.fn();
  const view = render(node(value, [pending], remember));
  expect(remember).toHaveBeenCalledWith("s", "/session.jsonl", [
    { key: "accepted", entryId: "accepted-input" },
  ]);
  const projected: LiveEntry = {
    ...pending,
    message: { role: "user", content: "" },
    optimistic: { ...pending.optimistic!, projectedEntryId: "accepted-input" },
  };
  value.selectedSession!.entries = [
    {
      id: "later",
      timestamp: "2026-09-22T09:02:00Z",
      type: "message",
      message: { role: "assistant", content: "More recent progress" },
    },
  ];
  view.rerender(node(structuredClone(value), [projected], remember));
  expect(view.container.querySelectorAll(".message-row.user")).toHaveLength(0);
  expect(view.container.textContent).not.toContain("继续");
});

it("shows the native queue separately from a persisted identical prompt", () => {
  const value = snapshot();
  value.selectedSession!.entries.push({
    id: "external-followup",
    timestamp: "2026-09-22T09:01:00Z",
    type: "message",
    message: { role: "user", content: "继续" },
  });
  value.selectedExecution = {
    sessionId: "s",
    sessionPath: "/session.jsonl",
    status: "running",
    pendingFollowUps: 2,
    queuedMessages: ["继续", "继续"],
    liveTools: [],
    liveToolsOmitted: 0,
  };
  const pending: LiveEntry[] = ["b", "c"].map((commandId) => ({
    key: `optimistic-${commandId}`,
    message: { role: "user", content: "继续" },
    optimistic: {
      sessionId: "s",
      sessionPath: "/session.jsonl",
      commandId,
      admitted: true,
      afterEntryId: "old-answer",
    },
  }));
  const view = render(node(value, pending));
  expect(view.container.querySelectorAll(".message-row.user")).toHaveLength(2);
  expect(view.container.textContent).toContain(
    i18n.t("pendingFollowUpsHint", { count: 2 }),
  );
});

it("consumes only one local preview per native queued message", () => {
  const value = snapshot();
  value.selectedExecution = {
    sessionId: "s",
    sessionPath: "/session.jsonl",
    status: "running",
    pendingFollowUps: 1,
    queuedMessages: ["继续"],
    liveTools: [],
    liveToolsOmitted: 0,
  };
  const pending: LiveEntry[] = ["first", "second"].map((commandId) => ({
    key: `optimistic-${commandId}`,
    message: { role: "user", content: "继续" },
    optimistic: {
      sessionId: "s",
      sessionPath: "/session.jsonl",
      commandId,
      admitted: true,
      afterEntryId: "old-answer",
    },
  }));
  const view = render(node(value, pending));
  expect(view.container.querySelectorAll(".message-row.user")).toHaveLength(2);
  value.selectedExecution.queuedMessages = [];
  value.selectedExecution.pendingFollowUps = 0;
  view.rerender(node(structuredClone(value), pending));
  expect(view.container.querySelectorAll(".message-row.user")).toHaveLength(3);
});

function snapshot(): WebSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: "2026-09-22T09:00:00Z",
    cursor: 1,
    preferences: { theme: "light" },
    currentSessionId: "s",
    currentSessionPath: "/session.jsonl",
    workspaces: [],
    sessions: [],
    models: [],
    selectedSession: {
      id: "s",
      path: "/session.jsonl",
      cwd: "/workspace",
      bytes: 0,
      entries: [
        {
          id: "old-question",
          timestamp: "2026-09-22T09:00:00Z",
          type: "message",
          message: { role: "user", content: "继续" },
        },
        {
          id: "old-answer",
          timestamp: "2026-09-22T09:00:01Z",
          type: "message",
          message: {
            role: "assistant",
            content: "已完成上一轮。",
            stopReason: "stop",
          },
        },
      ],
      truncation: {
        truncated: false,
        maxBytes: 2097152,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
      },
    },
    runtime: { status: "running", capabilities: {} },
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

function node(
  value: WebSnapshot,
  live: LiveEntry[],
  onPromptProjection?: (
    sessionId: string,
    sessionPath: string,
    pairs: { key: string; entryId: string }[],
  ) => void,
) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(Transcript, {
      snapshot: value,
      liveMessages: live,
      liveRunning: value.runtime.status === "running",
      livePhase: value.runtime.status === "running" ? "running" : "idle",
      liveRetry: null,
      thinkingStarts: {},
      thinkingDurations: {},
      scrollToBottom: 0,
      onResend: async () => true,
      onPromptProjection,
    }),
  );
}

it("does not use an old identical prompt as acknowledgement of a newly submitted message", () => {
  const value = snapshot();
  const live: LiveEntry & {
    optimistic: { commandId: string; afterEntryId: string | null };
  } = {
    key: "optimistic-new",
    message: { role: "user", content: "继续" },
    optimistic: {
      sessionId: "s",
      sessionPath: "/session.jsonl",
      commandId: "new",
      admitted: true,
      afterEntryId: "old-answer",
    },
  };
  const view = render(node(value, [live]));
  expect(view.container.querySelectorAll(".message-row.user")).toHaveLength(2);
  value.selectedSession!.entries.push({
    id: "new-question",
    timestamp: "2026-09-22T08:59:00Z",
    type: "message",
    message: projectMessage({
      role: "user",
      content: [{ type: "text", text: "继续" }],
    }),
  });
  view.rerender(node(structuredClone(value), [live]));
  expect(view.container.querySelectorAll(".message-row.user")).toHaveLength(2);
});

it("consumes each new persisted acknowledgement once when identical follow-ups share an anchor", () => {
  const value = snapshot();
  const live: Array<
    LiveEntry & {
      optimistic: { commandId: string; afterEntryId: string | null };
    }
  > = ["a", "b"].map((commandId) => ({
    key: `optimistic-${commandId}`,
    message: { role: "user", content: "继续" },
    optimistic: {
      sessionId: "s",
      sessionPath: "/session.jsonl",
      commandId,
      admitted: true,
      afterEntryId: "old-answer",
    },
  }));
  value.selectedSession!.entries.push({
    id: "new-a",
    timestamp: "2026-09-22T09:00:02Z",
    type: "message",
    message: { role: "user", content: "继续" },
  });
  const view = render(node(value, live));
  expect(view.container.querySelectorAll(".message-row.user")).toHaveLength(3);
});

it("keeps a pending message and its sent time when its original anchor is outside the visible window", () => {
  const value = snapshot();
  const sent = "2026-09-22T09:02:00Z";
  const live: LiveEntry = {
    key: "optimistic-pending",
    timestamp: sent,
    message: { role: "user", content: "继续" },
    optimistic: {
      sessionId: "s",
      sessionPath: "/session.jsonl",
      commandId: "pending",
      admitted: true,
      afterEntryId: "outside-window",
    },
  };
  const view = render(node(value, [live]));
  expect(view.container.querySelectorAll(".message-row.user")).toHaveLength(2);
  expect(
    view.container
      .querySelector(".message-row.user:last-of-type time")
      ?.getAttribute("datetime"),
  ).toBe(sent);
  value.cursor++;
  view.rerender(node(structuredClone(value), [live]));
  const messages = view.container.querySelectorAll(".message-row.user");
  expect(messages).toHaveLength(2);
  expect(messages[1]?.querySelector("time")?.getAttribute("datetime")).toBe(
    sent,
  );
});

it("acknowledges an admitted prompt whose clipped anchor is its native parent", () => {
  const value = snapshot();
  value.selectedSession!.entries = [
    {
      id: "new-question",
      parentId: "outside-window",
      timestamp: "2026-09-22T09:02:00Z",
      type: "message",
      message: { role: "user", content: "New request" },
    },
  ];
  const pending: LiveEntry = {
    key: "optimistic-new",
    message: { role: "user", content: "New request" },
    optimistic: {
      sessionId: "s",
      sessionPath: "/session.jsonl",
      commandId: "new",
      afterEntryId: "outside-window",
      admitted: true,
    },
  };
  const remember = vi.fn();
  const view = render(node(value, [pending], remember));
  expect(view.container.querySelectorAll(".message-row.user")).toHaveLength(1);
  expect(remember).toHaveBeenCalledWith("s", "/session.jsonl", [
    { key: "optimistic-new", entryId: "new-question" },
  ]);

  value.selectedSession!.entries[0]!.parentId = "different-branch";
  view.rerender(node(structuredClone(value), [pending], remember));
  expect(view.container.querySelectorAll(".message-row.user")).toHaveLength(2);
});

it("keeps the local admission visible while a live user event awaits native projection", () => {
  const value = snapshot();
  const pending: LiveEntry = {
    key: "optimistic-new",
    message: { role: "user", content: "New request" },
    optimistic: {
      sessionId: "s",
      sessionPath: "/session.jsonl",
      commandId: "new",
      afterEntryId: "old-answer",
      admitted: true,
    },
  };
  const event: LiveEntry = {
    key: "native-event",
    message: { role: "user", content: "New request" },
  };
  const view = render(node(value, [pending, event]));
  expect(view.container.querySelectorAll(".message-row.user")).toHaveLength(2);
  expect(view.container.textContent).toContain("New request");

  view.rerender(
    node(structuredClone(value), [
      pending,
      event,
      { ...event, key: "another-user-event" },
    ]),
  );
  expect(view.container.querySelectorAll(".message-row.user")).toHaveLength(3);

  const unadmitted: LiveEntry = {
    ...pending,
    optimistic: { ...pending.optimistic!, admitted: false },
  };
  view.rerender(node(structuredClone(value), [unadmitted, event]));
  expect(view.container.querySelectorAll(".message-row.user")).toHaveLength(3);
});

it("keeps the running marker on the native turn while follow-up messages are still pending", () => {
  const value = snapshot();
  value.selectedSession!.entries[1]!.message = {
    role: "assistant",
    content: "",
    stopReason: "toolUse",
    parts: [
      { type: "toolCall", id: "active-git", name: "bash", arguments: "{}" },
    ],
  };
  value.runtime.activeTurn = {
    sessionId: "s",
    sessionPath: "/session.jsonl",
    commandId: "original",
    epoch: 1,
  };
  const live: LiveEntry[] = ["后续 A", "后续 B"].map((content, index) => ({
    key: `optimistic-${index}`,
    message: { role: "user", content },
    optimistic: {
      sessionId: "s",
      sessionPath: "/session.jsonl",
      commandId: `queued-${index}`,
      admitted: true,
      afterEntryId: "old-answer",
    },
  }));
  const view = render(node(value, live));
  expect(
    view.container.querySelector('[data-turn="1"] .turn-state.running'),
  ).not.toBeNull();
  expect(
    view.container.querySelector('[data-turn="2"] .turn-state.running'),
  ).toBeNull();
  expect(
    view.container.querySelector('[data-turn="3"] .turn-state.running'),
  ).toBeNull();
});

it("shows the selected background session's execution without mixing in the controller's messages", () => {
  const value = snapshot();
  value.currentSessionId = "controller";
  value.runtime = { status: "idle", capabilities: {} };
  value.selectedExecution = {
    sessionId: "s",
    sessionPath: "/session.jsonl",
    status: "running",
    pendingFollowUps: 2,
    liveTools: [],
    liveToolsOmitted: 0,
    activeTurn: {
      sessionId: "s",
      sessionPath: "/session.jsonl",
      commandId: "background",
      epoch: 1,
      startedAt: Date.now(),
      elapsedMs: 5000,
    },
  };
  const view = render(
    node(value, [
      {
        key: "controller-live",
        message: {
          role: "assistant",
          content: "Only the other Session should see this",
        },
      },
    ]),
  );
  expect(view.container.textContent).not.toContain(
    "Only the other Session should see this",
  );
  expect(
    view.container.querySelector(".conversation-running")?.textContent,
  ).toContain(i18n.t("backgroundSessionRunning"));
  expect(view.container.textContent).toContain(
    i18n.t("pendingFollowUpsHint", { count: 2 }),
  );
  expect(view.getByRole("timer")).toBeTruthy();
  expect(
    view.queryByRole("button", { name: i18n.t("editMessage") }),
  ).toBeNull();

  value.selectedExecution.sessionPath = "/different-copy.jsonl";
  view.rerender(node(structuredClone(value), []));
  expect(view.container.querySelector(".conversation-running")).toBeNull();
  expect(view.queryByRole("timer")).toBeNull();
});
