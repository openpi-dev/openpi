// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createElement, Fragment } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { App } from "../../web/ui/src/app/App.tsx";
import { SessionSidebar } from "../../web/ui/src/features/sessions/SessionSidebar.tsx";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { createWebStore, webStore } from "../../web/ui/src/store/web-store.ts";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const truncation = {
  maxBytes: 1024,
  truncated: false,
  entriesOmitted: 0,
  messagesTruncated: 0,
  messagePartsOmitted: 0,
};
function snapshot(id = "A", commandId = "turn-1", finishedAt = 2): WebSnapshot {
  const path = `/sessions/${id}.jsonl`;
  const resultEntryId = `result-${commandId}`;
  const timing = {
    version: 1 as const,
    sessionId: id,
    commandId,
    epoch: 1,
    startedAt: 1,
    finishedAt,
    elapsedMs: 1,
    outcome: "completed" as const,
    resultEntryId,
  };
  return {
    protocolVersion: 1,
    cursor: 1,
    generatedAt: "2026-09-30T00:00:00Z",
    preferences: { theme: "system" },
    currentSessionId: id,
    currentSessionPath: path,
    runtime: { status: "idle", capabilities: {} },
    models: [],
    workspaces: [{ path: "/project", name: "Project", current: true }],
    sessions: [
      {
        id,
        path,
        cwd: "/project",
        name: id,
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
        modified: "2026-09-30T00:00:00Z",
        created: "2026-09-30T00:00:00Z",
        firstMessage: "Question",
        messageCount: 2,
        execution: {
          status: "idle",
          lastTurn: {
            commandId,
            finishedAt,
            outcome: "completed",
            resultEntryId,
          },
        },
      },
    ],
    selectedSession: {
      id,
      path,
      cwd: "/project",
      bytes: 100,
      truncation,
      history: { leafEntryId: `timing-${commandId}`, beforeEntryId: null },
      entries: [
        {
          type: "message",
          id: "user",
          parentId: null,
          timestamp: "2026-09-30T00:00:00Z",
          message: { role: "user", content: "Question" },
        },
        {
          type: "message",
          id: resultEntryId,
          parentId: "user",
          timestamp: "2026-09-30T00:00:00Z",
          message: {
            role: "assistant",
            content: "Final answer",
            parts: [{ type: "text", text: "Final answer" }],
            stopReason: "stop",
          },
        },
        {
          type: "custom",
          id: `timing-${commandId}`,
          parentId: resultEntryId,
          timestamp: "2026-09-30T00:00:00Z",
          turnTiming: timing,
        },
      ],
    },
    truncation: {
      ...truncation,
      bytes: 0,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
      modelsOmitted: 0,
    },
  };
}

const actions = createWebStore().getState().actions;
function Conversation({
  value,
  enabled = true,
  selectedPath = value.selectedSession?.path ?? null,
  connected = true,
}: {
  value: WebSnapshot;
  enabled?: boolean;
  selectedPath?: string | null;
  connected?: boolean;
}) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(
      Fragment,
      null,
      createElement(SessionSidebar, {
        snapshot: value,
        selectedPath,
        selectedWorkspace: "/project",
        collapsed: new Set<string>(),
        query: "",
        searchOpen: false,
        mobileOpen: false,
        settingsDisabled: false,
        connected,
        sessionViewVisible: enabled,
        onOpenSettings: () => {},
        actions,
      }),
      value.selectedSession &&
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
    ),
  );
}
function unread() {
  return document.querySelectorAll(".session-state-completed");
}

it("acknowledges the loaded selection immediately, independently of title, mtime and result position", () => {
  const value = snapshot();
  const mounted = render(createElement(Conversation, { value }));
  expect(unread()).toHaveLength(0);
  const renamed = {
    ...value,
    sessions: value.sessions.map((session) => ({
      ...session,
      name: "Renamed",
      modified: "2030-01-01T00:00:00Z",
    })),
  };
  mounted.rerender(createElement(Conversation, { value: renamed }));
  expect(unread()).toHaveLength(0);
  expect(sessionStorage.getItem("openpi.seen-completions")).toContain("turn-1");
  const next = snapshot("A", "turn-2", 3);
  mounted.rerender(
    createElement(Conversation, { value: next, enabled: false }),
  );
  expect(unread()).toHaveLength(1);
  mounted.rerender(createElement(Conversation, { value: next }));
  expect(unread()).toHaveLength(0);
  expect(sessionStorage.getItem("openpi.seen-completions")).toContain("turn-2");
});

it("keeps a background tab unread and acknowledges its loaded selection when it becomes visible", () => {
  let visibility = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  render(createElement(Conversation, { value: snapshot() }));
  expect(unread()).toHaveLength(1);
  visibility = "visible";
  fireEvent(document, new Event("visibilitychange"));
  expect(unread()).toHaveLength(0);
});

it("does not acknowledge hidden, covered or disconnected views", () => {
  const value = snapshot();
  const mounted = render(
    createElement(Conversation, { value, enabled: false }),
  );
  expect(unread()).toHaveLength(1);
  mounted.rerender(createElement(Conversation, { value, connected: false }));
  expect(unread()).toHaveLength(1);
  const dialog = document.createElement("dialog");
  dialog.open = true;
  document.body.append(dialog);
  mounted.rerender(createElement(Conversation, { value }));
  expect(unread()).toHaveLength(1);
  dialog.open = false;
  fireEvent(dialog, new Event("close"));
  expect(unread()).toHaveLength(0);
  dialog.remove();
});

it.each(["no-projection", "pending-path", "copied-id"] as const)(
  "does not acknowledge a requested selection until its exact native path and id load: %s",
  (pending) => {
    const value = snapshot();
    let selectedPath = value.selectedSession!.path;
    if (pending === "no-projection") delete value.selectedSession;
    if (pending === "pending-path") selectedPath = "/sessions/not-loaded.jsonl";
    if (pending === "copied-id")
      value.selectedSession!.path = "/sessions/copied.jsonl";
    render(createElement(Conversation, { value, selectedPath }));
    expect(unread()).toHaveLength(1);
    expect(sessionStorage.getItem("openpi.seen-completions")).toBeNull();
  },
);

it("acknowledges a bounded loaded history without requiring its final result to be in the visible page", () => {
  const value = snapshot();
  value.selectedSession!.entries = [value.selectedSession!.entries[0]!];
  value.selectedSession!.truncation = {
    ...value.selectedSession!.truncation,
    entriesOmitted: 2,
    truncated: true,
  };
  render(createElement(Conversation, { value }));
  expect(unread()).toHaveLength(0);
});

it("keeps background completions unread and persists only the exact visited session and turn", () => {
  const a = snapshot();
  const b = snapshot("B");
  b.sessions.unshift(a.sessions[0]!);
  const mounted = render(createElement(Conversation, { value: b }));
  expect(unread()).toHaveLength(1);
  expect(sessionStorage.getItem("openpi.seen-completions")).toContain(
    "/sessions/B.jsonl",
  );
  expect(sessionStorage.getItem("openpi.seen-completions")).not.toContain(
    "/sessions/A.jsonl",
  );
  mounted.rerender(createElement(Conversation, { value: a }));
  expect(unread()).toHaveLength(0);
  mounted.unmount();
  const restored = render(
    createElement(Conversation, { value: a, enabled: false }),
  );
  expect(unread()).toHaveLength(0);
  const copied = snapshot();
  copied.selectedSession!.path = "/sessions/copied.jsonl";
  copied.sessions[0]!.path = copied.selectedSession!.path;
  restored.rerender(
    createElement(Conversation, { value: copied, enabled: false }),
  );
  expect(unread()).toHaveLength(1);
});

it("uses the native completion identity when legacy summaries have no result entry id", () => {
  const value = snapshot();
  delete value.sessions[0]!.execution!.lastTurn!.resultEntryId;
  value.selectedSession!.entries = [value.selectedSession!.entries[0]!];
  render(createElement(Conversation, { value }));
  expect(unread()).toHaveLength(0);
});

it.each(["failed", "cancelled", "uncertain"] as const)(
  "never records a %s outcome as a completed read",
  (outcome) => {
    const value = snapshot();
    value.sessions[0]!.execution!.lastTurn!.outcome = outcome;
    render(createElement(Conversation, { value }));
    expect(sessionStorage.getItem("openpi.seen-completions")).toBeNull();
  },
);

it("the App defers acknowledgement during selection and marks the loaded reader in chat or trajectory", () => {
  const initial = webStore.getState();
  const start = vi.spyOn(initial.actions, "start").mockImplementation(() => {});
  const stop = vi.spyOn(initial.actions, "stop").mockImplementation(() => {});
  const value = snapshot();
  webStore.setState({
    ...createWebStore().getState(),
    actions: initial.actions,
    snapshot: value,
    selectedPath: value.selectedSession!.path,
    selectedWorkspace: "/project",
    connection: "connected",
    sessionSwitching: true,
  });
  const mounted = render(
    createElement(I18nextProvider, { i18n }, createElement(App)),
  );
  try {
    expect(unread()).toHaveLength(1);
    act(() => webStore.setState({ sessionSwitching: false }));
    expect(unread()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("trajectory") }));
    const next = snapshot("A", "turn-2", 3);
    act(() => webStore.setState({ snapshot: next }));
    expect(unread()).toHaveLength(0);
    expect(sessionStorage.getItem("openpi.seen-completions")).toContain(
      "turn-2",
    );
  } finally {
    mounted.unmount();
    start.mockRestore();
    stop.mockRestore();
    webStore.setState(initial, true);
  }
});
