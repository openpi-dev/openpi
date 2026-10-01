// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createElement, Fragment, useState } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { App } from "../../web/ui/src/app/App.tsx";
import { SessionSidebar } from "../../web/ui/src/features/sessions/SessionSidebar.tsx";
import {
  type CompletedResultExposure,
  Transcript,
} from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { createWebStore, webStore } from "../../web/ui/src/store/web-store.ts";

const originalScrollTo = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTo",
);

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalScrollTo)
    Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
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

function geometry() {
  let resultTop = 100;
  let visibility = "visible";
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  const cancel = vi.fn((id: number) => frames.delete(id));
  vi.stubGlobal("cancelAnimationFrame", cancel);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains("conversation"))
        return new DOMRect(0, 0, 400, 500);
      if (this.classList.contains("message-content"))
        return new DOMRect(0, resultTop, 400, 80);
      return new DOMRect(0, 0, 400, 80);
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  return {
    cancel,
    hide() {
      visibility = "hidden";
      fireEvent(document, new Event("visibilitychange"));
    },
    show() {
      visibility = "visible";
      fireEvent(document, new Event("visibilitychange"));
    },
    move(top: number) {
      resultTop = top;
      fireEvent(document.querySelector(".conversation")!, new Event("scroll"));
    },
    flush() {
      act(() => {
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback(performance.now());
      });
    },
  };
}

const actions = createWebStore().getState().actions;
function Conversation({
  value,
  enabled = true,
  showTranscript = true,
  hidden = false,
}: {
  value: WebSnapshot;
  enabled?: boolean;
  showTranscript?: boolean;
  hidden?: boolean;
}) {
  const [seen, setSeen] = useState<CompletedResultExposure | null>(null);
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(
      Fragment,
      null,
      createElement(SessionSidebar, {
        snapshot: value,
        selectedPath: value.selectedSession!.path,
        selectedWorkspace: "/project",
        collapsed: new Set<string>(),
        query: "",
        searchOpen: false,
        mobileOpen: false,
        settingsDisabled: false,
        connected: true,
        completedResultSeen: seen,
        onOpenSettings: () => {},
        actions,
      }),
      showTranscript &&
        createElement(
          "main",
          { hidden },
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
            onCompletedResultSeen: setSeen,
            resultExposureEnabled: enabled,
          }),
        ),
    ),
  );
}
function unread() {
  return document.querySelectorAll(".session-state-completed");
}

it("acknowledges the exact visible current result immediately, independently of title and mtime", () => {
  const view = geometry();
  const value = snapshot();
  const mounted = render(createElement(Conversation, { value }));
  expect(unread()).toHaveLength(1);
  view.flush();
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
  view.flush();
  expect(unread()).toHaveLength(0);
  view.move(600);
  mounted.rerender(
    createElement(Conversation, { value: snapshot("A", "turn-2", 3) }),
  );
  view.flush();
  expect(unread()).toHaveLength(1);
  view.move(100);
  view.flush();
  expect(unread()).toHaveLength(0);
});

it("does not acknowledge a hidden tab or a result outside the viewport, then acknowledges actual exposure", () => {
  const view = geometry();
  view.hide();
  render(createElement(Conversation, { value: snapshot() }));
  view.flush();
  expect(unread()).toHaveLength(1);
  view.move(600);
  view.show();
  view.flush();
  expect(unread()).toHaveLength(1);
  view.move(100);
  view.flush();
  expect(unread()).toHaveLength(0);
});

it("does not acknowledge a covered, collapsed or replaced transcript", () => {
  const view = geometry();
  const value = snapshot();
  const mounted = render(
    createElement(Conversation, { value, enabled: false }),
  );
  view.flush();
  expect(unread()).toHaveLength(1);
  mounted.rerender(createElement(Conversation, { value, hidden: true }));
  view.flush();
  expect(unread()).toHaveLength(1);
  mounted.rerender(
    createElement(Conversation, { value, showTranscript: false }),
  );
  view.flush();
  expect(unread()).toHaveLength(1);
  const dialog = document.createElement("dialog");
  dialog.open = true;
  document.body.append(dialog);
  mounted.rerender(createElement(Conversation, { value }));
  view.flush();
  expect(unread()).toHaveLength(1);
  dialog.open = false;
  fireEvent(dialog, new Event("close"));
  view.flush();
  expect(unread()).toHaveLength(0);
  dialog.remove();
});

it.each([
  "empty",
  "clipped-result",
  "missing-timing",
  "wrong-command",
  "wrong-result",
  "tool-use",
] as const)(
  "requires exact native timing and rendered result evidence: %s",
  (missing) => {
    const view = geometry();
    const value = snapshot();
    const selected = value.selectedSession!;
    if (missing === "empty") selected.entries = [];
    if (missing === "clipped-result")
      selected.entries = selected.entries.filter(
        (entry) => entry.id !== "result-turn-1",
      );
    if (missing === "missing-timing")
      selected.entries = selected.entries.filter((entry) => !entry.turnTiming);
    if (missing === "wrong-command")
      selected.entries[2]!.turnTiming!.commandId = "other-turn";
    if (missing === "wrong-result")
      selected.entries[2]!.turnTiming!.resultEntryId = "other-result";
    if (missing === "tool-use")
      selected.entries[1]!.message!.stopReason = "toolUse";
    render(createElement(Conversation, { value }));
    view.flush();
    expect(unread()).toHaveLength(1);
    expect(sessionStorage.getItem("openpi.seen-completions")).toBeNull();
  },
);

it("retains background unread results, cancels a switched-view callback and persists only the viewed exact completion", () => {
  const view = geometry();
  const a = snapshot();
  const b = snapshot("B");
  b.sessions.unshift(a.sessions[0]!);
  const mounted = render(createElement(Conversation, { value: a }));
  mounted.rerender(createElement(Conversation, { value: b }));
  view.flush();
  expect(view.cancel).toHaveBeenCalled();
  expect(unread()).toHaveLength(1);
  expect(sessionStorage.getItem("openpi.seen-completions")).toContain(
    "/sessions/B.jsonl",
  );
  expect(sessionStorage.getItem("openpi.seen-completions")).not.toContain(
    "/sessions/A.jsonl",
  );
  mounted.rerender(createElement(Conversation, { value: a }));
  view.flush();
  expect(unread()).toHaveLength(0);
  mounted.unmount();
  const restored = render(
    createElement(Conversation, { value: a, enabled: false }),
  );
  view.flush();
  expect(unread()).toHaveLength(0);
  const copied = snapshot();
  copied.selectedSession!.path = "/sessions/copied.jsonl";
  copied.sessions[0]!.path = copied.selectedSession!.path;
  restored.rerender(
    createElement(Conversation, { value: copied, enabled: false }),
  );
  view.flush();
  expect(unread()).toHaveLength(1);
});

it("can expose a proven legacy timing receipt without an optional stored result id", () => {
  const view = geometry();
  const value = snapshot();
  delete value.selectedSession!.entries[2]!.turnTiming!.resultEntryId;
  render(createElement(Conversation, { value }));
  view.flush();
  expect(unread()).toHaveLength(0);
});

it("the App does not acknowledge trajectory browsing, then acknowledges returning to the exact chat result", () => {
  const view = geometry();
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
  });
  const mounted = render(
    createElement(I18nextProvider, { i18n }, createElement(App)),
  );
  try {
    fireEvent.click(screen.getByRole("button", { name: i18n.t("trajectory") }));
    view.flush();
    expect(unread()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("chatView") }));
    view.flush();
    expect(unread()).toHaveLength(0);
  } finally {
    mounted.unmount();
    start.mockRestore();
    stop.mockRestore();
    webStore.setState(initial, true);
  }
});
