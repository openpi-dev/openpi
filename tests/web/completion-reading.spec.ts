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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { App } from "../../web/ui/src/app/App.tsx";
import { SessionSidebar } from "../../web/ui/src/features/sessions/SessionSidebar.tsx";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { createWebStore, webStore } from "../../web/ui/src/store/web-store.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.spyOn(actions, "setSessionRead").mockResolvedValue();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
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
    preferences: { theme: "system", projectsInRecents: false },
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
        unread: true,
        readRevision: `revision:${path}:${commandId}:${finishedAt}`,
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

function readSnapshot(value: WebSnapshot) {
  return {
    ...value,
    sessions: value.sessions.map((session) =>
      session.path === value.selectedSession?.path &&
      session.id === value.selectedSession?.id
        ? {
            ...session,
            unread: false,
            readRevision: `${session.readRevision}:read`,
          }
        : session,
    ),
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

it("requests reading the loaded revision independently of title and mtime, and clears unread only after backend confirmation", () => {
  const value = snapshot();
  const mounted = render(createElement(Conversation, { value }));
  expect(actions.setSessionRead).toHaveBeenCalledExactlyOnceWith(
    value.sessions[0]!.path,
    value.sessions[0]!.id,
    true,
    value.sessions[0]!.readRevision,
  );
  expect(unread()).toHaveLength(1);
  const renamed = {
    ...value,
    sessions: value.sessions.map((session) => ({
      ...session,
      name: "Renamed",
      modified: "2030-01-01T00:00:00Z",
    })),
  };
  mounted.rerender(createElement(Conversation, { value: renamed }));
  expect(actions.setSessionRead).toHaveBeenCalledOnce();
  expect(unread()).toHaveLength(1);
  mounted.rerender(
    createElement(Conversation, { value: readSnapshot(renamed) }),
  );
  expect(unread()).toHaveLength(0);
  const next = snapshot("A", "turn-2", 3);
  mounted.rerender(
    createElement(Conversation, { value: next, enabled: false }),
  );
  expect(unread()).toHaveLength(1);
  expect(actions.setSessionRead).toHaveBeenCalledOnce();
  mounted.rerender(createElement(Conversation, { value: next }));
  expect(actions.setSessionRead).toHaveBeenCalledTimes(2);
  expect(actions.setSessionRead).toHaveBeenLastCalledWith(
    next.sessions[0]!.path,
    next.sessions[0]!.id,
    true,
    next.sessions[0]!.readRevision,
  );
  expect(unread()).toHaveLength(1);
  mounted.rerender(createElement(Conversation, { value: readSnapshot(next) }));
  expect(unread()).toHaveLength(0);
});

it("keeps a background tab unread and acknowledges its loaded selection when it becomes visible", () => {
  let visibility = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  render(createElement(Conversation, { value: snapshot() }));
  expect(unread()).toHaveLength(1);
  expect(actions.setSessionRead).not.toHaveBeenCalled();
  visibility = "visible";
  fireEvent(document, new Event("visibilitychange"));
  expect(actions.setSessionRead).toHaveBeenCalledExactlyOnceWith(
    "/sessions/A.jsonl",
    "A",
    true,
    snapshot().sessions[0]!.readRevision,
  );
  expect(unread()).toHaveLength(1);
});

it("does not acknowledge hidden, covered or disconnected views", () => {
  const value = snapshot();
  const mounted = render(
    createElement(Conversation, { value, enabled: false }),
  );
  expect(unread()).toHaveLength(1);
  expect(actions.setSessionRead).not.toHaveBeenCalled();
  mounted.rerender(createElement(Conversation, { value, connected: false }));
  expect(unread()).toHaveLength(1);
  expect(actions.setSessionRead).not.toHaveBeenCalled();
  const dialog = document.createElement("dialog");
  dialog.open = true;
  document.body.append(dialog);
  mounted.rerender(createElement(Conversation, { value }));
  expect(unread()).toHaveLength(1);
  expect(actions.setSessionRead).not.toHaveBeenCalled();
  dialog.open = false;
  fireEvent(dialog, new Event("close"));
  expect(actions.setSessionRead).toHaveBeenCalledOnce();
  expect(unread()).toHaveLength(1);
  dialog.remove();
});

it.each([
  "no-projection",
  "pending-path",
  "copied-path",
  "reused-path",
] as const)(
  "does not acknowledge a requested selection until its exact native path and id load: %s",
  (pending) => {
    const value = snapshot();
    let selectedPath = value.selectedSession!.path;
    if (pending === "no-projection") delete value.selectedSession;
    if (pending === "pending-path") selectedPath = "/sessions/not-loaded.jsonl";
    if (pending === "copied-path")
      value.selectedSession!.path = "/sessions/copied.jsonl";
    if (pending === "reused-path") value.selectedSession!.id = "different-id";
    render(createElement(Conversation, { value, selectedPath }));
    expect(unread()).toHaveLength(1);
    expect(actions.setSessionRead).not.toHaveBeenCalled();
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
  expect(actions.setSessionRead).toHaveBeenCalledExactlyOnceWith(
    value.sessions[0]!.path,
    value.sessions[0]!.id,
    true,
    value.sessions[0]!.readRevision,
  );
  expect(unread()).toHaveLength(1);
});

it("keeps background completions unread and restores only the backend's exact visited-session projection", () => {
  const a = snapshot();
  const b = snapshot("B");
  b.sessions.unshift(a.sessions[0]!);
  const mounted = render(createElement(Conversation, { value: b }));
  expect(actions.setSessionRead).toHaveBeenCalledExactlyOnceWith(
    "/sessions/B.jsonl",
    "B",
    true,
    b.sessions[1]!.readRevision,
  );
  expect(unread()).toHaveLength(2);
  mounted.rerender(createElement(Conversation, { value: readSnapshot(b) }));
  expect(unread()).toHaveLength(1);
  mounted.rerender(createElement(Conversation, { value: a }));
  expect(actions.setSessionRead).toHaveBeenCalledTimes(2);
  expect(actions.setSessionRead).toHaveBeenLastCalledWith(
    "/sessions/A.jsonl",
    "A",
    true,
    a.sessions[0]!.readRevision,
  );
  expect(unread()).toHaveLength(1);
  const confirmed = readSnapshot(a);
  mounted.rerender(createElement(Conversation, { value: confirmed }));
  expect(unread()).toHaveLength(0);
  mounted.unmount();
  const restored = render(
    createElement(Conversation, { value: confirmed, enabled: false }),
  );
  expect(unread()).toHaveLength(0);
  const copied = snapshot();
  copied.selectedSession!.path = "/sessions/copied.jsonl";
  copied.sessions[0]!.path = copied.selectedSession!.path;
  restored.rerender(
    createElement(Conversation, { value: copied, enabled: false }),
  );
  expect(unread()).toHaveLength(1);
  expect(actions.setSessionRead).toHaveBeenCalledTimes(2);
});

it("uses the backend revision when a summary has no result entry id", () => {
  const value = snapshot();
  delete value.sessions[0]!.execution!.lastTurn!.resultEntryId;
  value.selectedSession!.entries = [value.selectedSession!.entries[0]!];
  render(createElement(Conversation, { value }));
  expect(actions.setSessionRead).toHaveBeenCalledExactlyOnceWith(
    value.sessions[0]!.path,
    value.sessions[0]!.id,
    true,
    value.sessions[0]!.readRevision,
  );
});

it("does not automatically acknowledge a legacy summary without a read revision", () => {
  const value = snapshot();
  delete value.sessions[0]!.readRevision;
  render(createElement(Conversation, { value }));
  expect(unread()).toHaveLength(1);
  expect(actions.setSessionRead).not.toHaveBeenCalled();
});

it.each(["failed", "cancelled", "uncertain"] as const)(
  "reads an explicitly unread %s result without changing its runtime outcome",
  (outcome) => {
    const value = snapshot();
    value.sessions[0]!.execution!.lastTurn!.outcome = outcome;
    const mounted = render(createElement(Conversation, { value }));
    expect(actions.setSessionRead).toHaveBeenCalledExactlyOnceWith(
      value.sessions[0]!.path,
      value.sessions[0]!.id,
      true,
      value.sessions[0]!.readRevision,
    );
    expect(document.querySelectorAll(".session-row.is-unread")).toHaveLength(1);
    const confirmed = readSnapshot(value);
    mounted.rerender(createElement(Conversation, { value: confirmed }));
    expect(document.querySelectorAll(".session-row.is-unread")).toHaveLength(0);
    expect(confirmed.sessions[0]!.execution!.lastTurn!.outcome).toBe(outcome);
  },
);

it("the App defers acknowledgement during selection and trajectory until the loaded chat is visible", () => {
  const initial = webStore.getState();
  const start = vi.spyOn(initial.actions, "start").mockImplementation(() => {});
  const stop = vi.spyOn(initial.actions, "stop").mockImplementation(() => {});
  const read = vi.spyOn(initial.actions, "setSessionRead").mockResolvedValue();
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
    expect(read).not.toHaveBeenCalled();
    act(() => webStore.setState({ sessionSwitching: false }));
    expect(read).toHaveBeenCalledExactlyOnceWith(
      value.sessions[0]!.path,
      value.sessions[0]!.id,
      true,
      value.sessions[0]!.readRevision,
    );
    expect(unread()).toHaveLength(1);
    act(() => webStore.setState({ snapshot: readSnapshot(value) }));
    expect(unread()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("trajectory") }));
    const next = snapshot("A", "turn-2", 3);
    act(() => webStore.setState({ snapshot: next }));
    expect(read).toHaveBeenCalledOnce();
    expect(unread()).toHaveLength(1);
    expect(
      screen
        .getByRole("button", { name: i18n.t("trajectory") })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("chatView") }));
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith(
      next.sessions[0]!.path,
      next.sessions[0]!.id,
      true,
      next.sessions[0]!.readRevision,
    );
    expect(unread()).toHaveLength(1);
    act(() => webStore.setState({ snapshot: readSnapshot(next) }));
    expect(unread()).toHaveLength(0);
  } finally {
    mounted.unmount();
    start.mockRestore();
    stop.mockRestore();
    webStore.setState(initial, true);
  }
});
