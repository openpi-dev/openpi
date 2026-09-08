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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { Providers } from "../../web/ui/src/app/providers.tsx";
import { Markdown } from "../../web/ui/src/components/Markdown.tsx";
import { OpenPiLogo } from "../../web/ui/src/components/OpenPiLogo.tsx";
import { ActivityBar } from "../../web/ui/src/features/activity/ActivityBar.tsx";
import { Composer } from "../../web/ui/src/features/composer/Composer.tsx";
import { SessionSidebar } from "../../web/ui/src/features/sessions/SessionSidebar.tsx";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { createWebStore, webStore } from "../../web/ui/src/store/web-store.ts";

afterEach(cleanup);

const truncation = {
  bytes: 0,
  maxBytes: 4 * 1024 * 1024,
  messagesTruncated: 0,
  messagePartsOmitted: 0,
  entriesOmitted: 0,
  modelsOmitted: 0,
  sessionsOmitted: 0,
  workspacesOmitted: 0,
  truncated: false,
};

function renderWithI18n(node: ReturnType<typeof createElement>) {
  return render(createElement(I18nextProvider, { i18n }, node));
}

describe("OpenPI React transcript", () => {
  it("renders sanitized GFM and projects images as links", () => {
    const { container } = render(
      createElement(
        Markdown,
        null,
        "# Result\n\n- [x] done\n\n![diagram](https://example.com/a.png)\n\n[bad](javascript:alert(1))",
      ),
    );

    expect(screen.getByRole("heading", { name: "Result" })).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("[image: diagram]").closest("a")?.href).toBe(
      "https://example.com/a.png",
    );
    expect(screen.getByText("bad").closest("a")).toBeNull();
  });

  it("preserves soft line breaks from the frozen Web baseline", () => {
    const { container } = render(
      createElement(Markdown, null, "first line\nsecond line"),
    );

    expect(container.querySelector("br")).toBeTruthy();
  });

  it("matches Session searches after preserving a trailing input space", () => {
    const store = createWebStore();
    store.getState().actions.setQuery("foo ");
    const snapshot: WebSnapshot = {
      protocolVersion: 1,
      preferences: { theme: "system" },
      generatedAt: "2026-09-01T10:00:00Z",
      cursor: 1,
      workspaces: [{ path: "/tmp/ws", name: "ws", current: true }],
      sessions: [
        {
          id: "session-1",
          path: "/tmp/ws/session.jsonl",
          cwd: "/tmp/ws",
          name: "foo bar",
          modified: "2026-09-01T10:00:00Z",
          created: "2026-09-01T10:00:00Z",
          source: "web-session",
          origin: "web",
          controller: "web",
          readOnly: false,
          messageCount: 1,
          firstMessage: "hello",
        },
      ],
      models: [],
      runtime: { status: "idle", capabilities: {} },
      truncation,
    };

    renderWithI18n(
      createElement(SessionSidebar, {
        snapshot,
        selectedPath: null,
        selectedWorkspace: "/tmp/ws",
        collapsed: new Set<string>(),
        query: store.getState().query,
        searchOpen: true,
        mobileOpen: false,
        actions: store.getState().actions,
      }),
    );

    expect(screen.getByRole<HTMLInputElement>("searchbox").value).toBe("foo ");
    expect(screen.getByText("foo bar")).toBeTruthy();
  });

  it("keeps the 16-cell logo animation replayable", () => {
    const { container } = render(createElement(OpenPiLogo, { animated: true }));
    const button = screen.getByRole("button", {
      name: "Replay OpenPI logo animation",
    });
    expect(container.querySelectorAll(".pixel-mark i")).toHaveLength(16);
    const before = container.querySelector(".brand-lockup");
    fireEvent.click(button);
    expect(container.querySelector(".brand-lockup")).not.toBe(before);
  });

  it("pairs tool results, groups ordinary steps, and keeps capability cards visible", () => {
    const entries = [
      {
        type: "message" as const,
        id: "user",
        timestamp: "2026-09-01T10:00:00Z",
        message: { role: "user", content: "inspect it" },
      },
      {
        type: "message" as const,
        id: "assistant",
        timestamp: "2026-09-01T10:00:01Z",
        message: {
          role: "assistant",
          content: "Done.",
          parts: [
            { type: "thinking" as const, text: "Plan" },
            ...Array.from({ length: 4 }, (_, index) => ({
              type: "toolCall" as const,
              id: `tool-${index}`,
              name: "read",
              arguments: JSON.stringify({ path: `/tmp/${index}.ts` }),
            })),
            {
              type: "toolCall" as const,
              id: "subagent-1",
              name: "subagent_spawn",
              arguments: JSON.stringify({ name: "review", prompt: "Review" }),
            },
          ],
        },
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        type: "message" as const,
        id: `result-${index}`,
        timestamp: "2026-09-01T10:00:02Z",
        message: {
          role: "toolResult",
          toolName: "read",
          toolCallId: `tool-${index}`,
          content: `file ${index}`,
          isError: false,
        },
      })),
      {
        type: "message" as const,
        id: "subagent-result",
        timestamp: "2026-09-01T10:00:03Z",
        message: {
          role: "toolResult",
          toolName: "subagent_spawn",
          toolCallId: "subagent-1",
          content: "spawned",
          isError: false,
        },
      },
    ];
    const snapshot: WebSnapshot = {
      protocolVersion: 1,
      preferences: { theme: "system" },
      generatedAt: "2026-09-01T10:00:03Z",
      cursor: 1,
      currentSessionId: "session-1",
      workspaces: [{ path: "/tmp/ws", name: "ws", current: true }],
      sessions: [
        {
          id: "session-1",
          path: "/tmp/s.jsonl",
          cwd: "/tmp/ws",
          modified: "2026-09-01T10:00:03Z",
          created: "2026-09-01T10:00:00Z",
          source: "web-session",
          origin: "web",
          controller: "web",
          readOnly: false,
          messageCount: entries.length,
          firstMessage: "inspect it",
        },
      ],
      selectedSession: {
        id: "session-1",
        path: "/tmp/s.jsonl",
        cwd: "/tmp/ws",
        entries,
        bytes: 1,
        truncation,
      },
      models: [],
      runtime: { status: "idle", capabilities: {} },
      truncation,
    };

    const { container } = renderWithI18n(
      createElement(Transcript, {
        snapshot,
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

    expect(container.querySelectorAll(".tool-group")).toHaveLength(2);
    expect(screen.getAllByText(/4 (steps|个步骤)/u)).toHaveLength(2);
    expect(container.querySelectorAll(".activity-card.subagent")).toHaveLength(
      1,
    );
    expect(screen.getByText("Done.")).toBeTruthy();
    expect(
      container.querySelectorAll("[aria-label=completed]").length,
    ).toBeGreaterThan(0);
  });
});

function activeSnapshot(): WebSnapshot {
  return {
    protocolVersion: 1,
    preferences: { theme: "system" },
    generatedAt: "2026-09-01T10:00:00Z",
    cursor: 1,
    currentSessionId: "session",
    workspaces: [],
    sessions: [],
    models: [],
    runtime: { status: "running", capabilities: {} },
    truncation,
    selectedSession: {
      id: "session",
      path: "/tmp/session",
      cwd: "/tmp",
      bytes: 1,
      truncation,
      entries: [],
    },
  };
}

it("follows same-key streamed growth, preserves reading position, and honors explicit send scroll", () => {
  const snapshot = activeSnapshot();
  const props = {
    snapshot,
    liveRunning: true,
    livePhase: "running" as const,
    liveRetry: null,
    thinkingStarts: {},
    thinkingDurations: {},
    scrollToBottom: 0,
    onResend: async () => true,
  };
  const node = (content: string, scrollToBottom = 0) =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Transcript, {
        ...props,
        scrollToBottom,
        liveMessages: [
          { key: "stream", message: { role: "assistant", content } },
        ],
      }),
    );
  const { container, rerender } = render(node("hello"));
  const viewport = container.querySelector<HTMLElement>(".conversation")!;
  const scroll = vi.fn();
  viewport.scrollTo = scroll;
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(viewport, "clientHeight", {
    configurable: true,
    value: 100,
  });
  rerender(node("hello\nmore streamed content"));
  expect(scroll).toHaveBeenCalledOnce();
  scroll.mockClear();
  viewport.scrollTop = 0;
  fireEvent.scroll(viewport);
  rerender(node("still more streamed content"));
  expect(scroll).not.toHaveBeenCalled();
  rerender(node("after sending", 1));
  expect(scroll).toHaveBeenCalledOnce();
});

it("shows cancellation and queued follow-up receipts on the active session", () => {
  const snapshot = activeSnapshot();
  const store = createWebStore();
  const cancel = vi.fn(async () => {});
  const { rerender } = renderWithI18n(
    createElement(Composer, {
      snapshot,
      selectedWorkspace: "/tmp",
      sessionSwitching: false,
      promptAdmissionPending: false,
      liveRunning: true,
      landing: false,
      activeTurn: { sessionId: "session", commandId: "turn", epoch: 1 },
      turnCancellationPending: false,
      turnTerminalStatus: null,
      pendingFollowUpsReceipt: 2,
      actions: { ...store.getState().actions, cancelActiveTurn: cancel },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: i18n.t("stopTurn") }));
  expect(cancel).toHaveBeenCalledOnce();
  expect(
    screen.getByText(i18n.t("pendingFollowUpsHint", { count: 2 })),
  ).toBeTruthy();
  rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, {
        snapshot,
        selectedWorkspace: "/tmp",
        sessionSwitching: false,
        promptAdmissionPending: false,
        liveRunning: true,
        landing: false,
        activeTurn: { sessionId: "session", commandId: "turn", epoch: 1 },
        turnCancellationPending: true,
        turnTerminalStatus: null,
        pendingFollowUpsReceipt: 2,
        actions: store.getState().actions,
      }),
    ),
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: i18n.t("stopTurn") })
      .disabled,
  ).toBe(true);
});

it("keeps background terminal activity and omission receipts visible", () => {
  const snapshot = activeSnapshot();
  snapshot.runtime.capabilities = {
    "background-terminals": {
      items: [
        {
          id: "terminal",
          title: "Build",
          status: "failed",
          createdAt: 1,
          settledAt: 2,
        },
      ],
      omitted: 3,
      truncated: true,
    },
  };
  render(createElement(ActivityBar, { snapshot }));
  expect(screen.getByText(/Build/)).toBeTruthy();
  expect(screen.getByText("+3")).toBeTruthy();
});

it("resolves canonical system theme changes and explicit overrides", () => {
  const initial = webStore.getState().snapshot;
  const media = new EventTarget();
  const query = Object.assign(media, { matches: false });
  vi.stubGlobal("matchMedia", () => query);
  const snapshot = activeSnapshot();
  webStore.setState({ snapshot });
  const { unmount } = render(
    createElement(Providers, null, createElement("span", null, "theme")),
  );
  expect(document.documentElement.dataset.theme).toBe("light");
  act(() => {
    query.matches = true;
    query.dispatchEvent(new Event("change"));
  });
  expect(document.documentElement.dataset.theme).toBe("dark");
  act(() =>
    webStore.setState({
      snapshot: { ...snapshot, preferences: { theme: "light" } },
    }),
  );
  expect(document.documentElement.dataset.theme).toBe("light");
  unmount();
  webStore.setState({ snapshot: initial });
  vi.unstubAllGlobals();
});

it("does not attribute current runtime activity to a historical session", () => {
  const snapshot = activeSnapshot();
  snapshot.runtime.capabilities = {
    "background-terminals": {
      items: [
        {
          id: "terminal",
          title: "Current build",
          status: "running",
          createdAt: 1,
        },
      ],
      omitted: 0,
      truncated: false,
    },
    subagents: {
      items: [
        {
          id: "agent",
          title: "Current agent",
          status: "running",
          createdAt: 1,
        },
      ],
      omitted: 0,
      truncated: false,
    },
    workflows: {
      items: [
        {
          runId: "run",
          name: "Current workflow",
          status: "running",
          startedAt: 1,
          agents: { total: 1, running: 1, done: 0, error: 0, uncertain: 0 },
        },
      ],
      omitted: 0,
      truncated: false,
    },
  };
  const store = createWebStore();
  const props = {
    snapshot,
    selectedWorkspace: "/tmp",
    sessionSwitching: false,
    promptAdmissionPending: false,
    liveRunning: false,
    landing: false,
    activeTurn: null,
    turnCancellationPending: false,
    turnTerminalStatus: null,
    pendingFollowUpsReceipt: null,
    actions: store.getState().actions,
  };
  const { rerender } = renderWithI18n(createElement(Composer, props));
  expect(screen.getByLabelText("Runtime activity")).toBeTruthy();
  rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, {
        ...props,
        snapshot: { ...snapshot, currentSessionId: "another-session" },
      }),
    ),
  );
  expect(screen.queryByLabelText("Runtime activity")).toBeNull();
  expect(
    screen.queryByText(/Current build|Current agent|Current workflow/),
  ).toBeNull();
});

it("reports failed copy honestly, supports retry, and cleans up feedback on unmount", async () => {
  vi.useFakeTimers();
  const scheduled = vi.spyOn(window, "setTimeout");
  const cleared = vi.spyOn(window, "clearTimeout");
  const writeText = vi
    .fn()
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  const view = renderWithI18n(
    createElement(Transcript, {
      snapshot,
      liveMessages: [
        {
          key: "answer",
          message: { role: "assistant", content: "**original**" },
        },
      ],
      liveRunning: false,
      livePhase: "idle",
      liveRetry: null,
      thinkingStarts: {},
      thinkingDurations: {},
      scrollToBottom: 0,
      onResend: async () => true,
    }),
  );
  try {
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("copyMessage") }),
      ),
    );
    expect(screen.getByRole("status").textContent).toBe(i18n.t("copyFailed"));
    expect(
      screen.queryByRole("button", { name: i18n.t("copiedMessage") }),
    ).toBeNull();
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("copyMessage") }),
      ),
    );
    expect(writeText).toHaveBeenLastCalledWith("**original**");
    expect(
      screen.getByRole("button", { name: i18n.t("copiedMessage") }),
    ).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    const timerIndex = scheduled.mock.calls.findIndex(
      (call) => call[1] === 1_200,
    );
    expect(timerIndex).toBeGreaterThanOrEqual(0);
    const timer = scheduled.mock.results[timerIndex].value;
    view.unmount();
    expect(cleared).toHaveBeenCalledWith(timer);
  } finally {
    view.unmount();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("shows bounded archive history even when its workspace summary was omitted", async () => {
  const store = createWebStore();
  const restore = vi
    .spyOn(store.getState().actions, "unarchiveSession")
    .mockResolvedValue(false);
  const snapshot: WebSnapshot = {
    protocolVersion: 1,
    preferences: { theme: "system" },
    generatedAt: "2026-09-01T10:00:00Z",
    cursor: 1,
    workspaces: [],
    sessions: [
      {
        id: "archived",
        path: "/omitted/a.jsonl",
        cwd: "/omitted",
        name: "Archived work",
        archived: true,
        modified: "2026-09-01T10:00:00Z",
        created: "2026-09-01T10:00:00Z",
        source: "web-session",
        origin: "web",
        controller: "none",
        readOnly: false,
        messageCount: 1,
        firstMessage: "saved",
      },
    ],
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation: {
      ...truncation,
      sessionsOmitted: 20,
      workspacesOmitted: 1,
      truncated: true,
    },
  };
  renderWithI18n(
    createElement(SessionSidebar, {
      snapshot,
      selectedPath: null,
      selectedWorkspace: null,
      collapsed: new Set<string>(),
      query: "",
      searchOpen: false,
      mobileOpen: false,
      actions: store.getState().actions,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  expect(screen.getByText("Archived work")).toBeTruthy();
  expect(screen.getByText("/omitted")).toBeTruthy();
  expect(
    screen.getByText(
      "20 more sessions and 1 workspace summaries are not loaded. Search covers the loaded list only.",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Conversation options" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Restore conversation" }),
  );
  expect(
    await screen.findByText(
      "Could not confirm restoration. Refresh and try again.",
    ),
  ).toBeTruthy();
  expect(restore).toHaveBeenCalledWith("/omitted/a.jsonl");
  expect(screen.getByText("Archived work")).toBeTruthy();
});

it("shows complete model identities before workspace selection", () => {
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  delete snapshot.selectedSession;
  delete snapshot.currentSessionId;
  snapshot.workspaces = [];
  snapshot.sessions = [];
  snapshot.runtime.status = "idle";
  snapshot.models = [
    {
      provider: "provider-alpha",
      id: "a",
      label: "Shared model",
      name: "A",
      current: true,
    },
    {
      provider: "provider-beta",
      id: "b",
      label: "Shared model",
      name: "B",
      current: false,
    },
  ];
  const store = createWebStore();
  const props = {
    snapshot,
    selectedWorkspace: null,
    sessionSwitching: false,
    promptAdmissionPending: false,
    liveRunning: false,
    landing: true,
    activeTurn: null,
    turnCancellationPending: false,
    turnTerminalStatus: null,
    pendingFollowUpsReceipt: null,
    actions: store.getState().actions,
    draftModel: snapshot.models[1],
  };
  const { rerender } = renderWithI18n(createElement(Composer, props));
  const modelButton = screen.getByRole("button", {
    name: "Shared model (provider-beta/b)",
  }) as HTMLButtonElement;
  expect(modelButton.disabled).toBe(false);
  fireEvent.click(modelButton);
  expect(
    screen.getByRole("menuitem", {
      name: "Shared model (provider-alpha/a)",
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole("menuitem", {
      name: "Shared model (provider-beta/b)",
    }),
  ).toBeTruthy();
  rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, { ...props, modelSelectionPending: true }),
    ),
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Shared model (provider-beta/b)",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("does not repeat a provider identity used as the fallback model label", () => {
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  snapshot.models = [
    {
      provider: "provider-alpha",
      id: "model-a",
      label: "provider-alpha/model-a",
      name: "",
      current: true,
    },
  ];
  const store = createWebStore();
  renderWithI18n(
    createElement(Composer, {
      snapshot,
      selectedWorkspace: "/tmp/ws",
      sessionSwitching: false,
      promptAdmissionPending: false,
      liveRunning: false,
      landing: false,
      activeTurn: null,
      turnCancellationPending: false,
      turnTerminalStatus: null,
      pendingFollowUpsReceipt: null,
      actions: store.getState().actions,
    }),
  );

  expect(
    screen.getByRole("button", { name: "provider-alpha/model-a" }).textContent,
  ).toBe("provider-alpha/model-a");
  expect(
    screen.queryByText("provider-alpha/model-a (provider-alpha/model-a)"),
  ).toBeNull();
});
