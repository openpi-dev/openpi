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
import { projectEntry, type WebSnapshot } from "../../web/protocol/types.ts";
import { App } from "../../web/ui/src/app/App.tsx";
import { Providers } from "../../web/ui/src/app/providers.tsx";
import { Markdown } from "../../web/ui/src/components/Markdown.tsx";
import { OpenPiLogo } from "../../web/ui/src/components/OpenPiLogo.tsx";
import { ActivityBar } from "../../web/ui/src/features/activity/ActivityBar.tsx";
import { Composer } from "../../web/ui/src/features/composer/Composer.tsx";
import { SessionSidebar } from "../../web/ui/src/features/sessions/SessionSidebar.tsx";
import { SubagentDetailView } from "../../web/ui/src/features/subagents/SubagentPanel.tsx";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import type { EventStreamOptions } from "../../web/ui/src/protocol/event-stream.ts";
import { createWebStore, webStore } from "../../web/ui/src/store/web-store.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("Plan controls preserve drafts without sending prompts, and the placeholder follows confirmed planning messages", async () => {
  const snapshot = activeSnapshot();
  snapshot.runtime.plan = "inactive";
  snapshot.runtime.status = "idle";
  snapshot.runtime.planRevision = null;
  const store = createWebStore();
  const selectPlanMode = vi.fn(async () => {});
  const sendPrompt = vi.fn(async () => true);
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
    thinkingPendingLevel: null,
    actions: { ...store.getState().actions, selectPlanMode, sendPrompt },
  };
  const view = renderWithI18n(createElement(Composer, props));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: i18n.t("describeTask"),
  });
  fireEvent.change(input, { target: { value: "Keep my draft" } });
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("planModeEnter") }),
  );
  expect(selectPlanMode).toHaveBeenCalledWith(true);
  expect(sendPrompt).not.toHaveBeenCalled();
  expect(input.value).toBe("Keep my draft");
  const rerender = (
    plan: "planning" | "inactive",
    hasPrompt: boolean,
    pending = false,
  ) =>
    view.rerender(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(Composer, {
          ...props,
          planSelectionPending: pending,
          snapshot: {
            ...snapshot,
            runtime: { ...snapshot.runtime, plan, planHasPrompt: hasPrompt },
          },
        }),
      ),
    );
  rerender("planning", false);
  expect(input.placeholder).not.toBe(i18n.t("promptPlanMessage"));
  rerender("planning", true);
  expect(input.placeholder).toBe(i18n.t("promptPlanMessage"));
  fireEvent.click(screen.getByRole("button", { name: i18n.t("planModeExit") }));
  expect(selectPlanMode).toHaveBeenLastCalledWith(false);
  expect(sendPrompt).not.toHaveBeenCalled();
  rerender("inactive", false);
  expect(input.placeholder).not.toBe(i18n.t("promptPlanMessage"));
  expect(input.value).toBe("Keep my draft");
  rerender("planning", true, true);
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: i18n.t("planModeExit"),
    }).disabled,
  ).toBe(true);
  await act(async () => fireEvent.submit(input.closest("form")!));
  expect(sendPrompt).not.toHaveBeenCalled();
});

it("keeps a workspace draft separate from the old Session UI and retains text after failed sending", async () => {
  const initial = webStore.getState();
  const snapshot = activeSnapshot();
  snapshot.workspaces.push({ path: "/tmp/repo-b", name: "B", current: false });
  snapshot.models = [
    {
      provider: "test",
      id: "model",
      name: "model",
      label: "Draft model",
      current: true,
    },
  ];
  const start = vi.spyOn(initial.actions, "start").mockImplementation(() => {});
  const stop = vi.spyOn(initial.actions, "stop").mockImplementation(() => {});
  const send = vi.spyOn(initial.actions, "sendPrompt").mockResolvedValue(false);
  webStore.setState({
    snapshot,
    selectedWorkspace: "/tmp/repo-b",
    workspaceDraft: true,
    sessionSwitching: false,
    pendingFollowUpsReceipt: 4,
    turnCancellationPending: false,
  });
  const view = renderWithI18n(createElement(App));
  try {
    expect(view.container.querySelector(".landing-conversation")).toBeTruthy();
    expect(
      view.container.querySelector(".conversation-view-switch"),
    ).toBeNull();
    expect(screen.queryByLabelText("Runtime activity")).toBeNull();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Draft model (test/model)",
      }).disabled,
    ).toBe(false);
    expect(
      screen.queryByRole("button", { name: i18n.t("stopTurn") }),
    ).toBeNull();
    expect(
      screen.queryByText(i18n.t("pendingFollowUpsHint", { count: 4 })),
    ).toBeNull();
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: i18n.t("describeTask"),
    });
    fireEvent.change(input, { target: { value: "Only change B" } });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: i18n.t("send") })),
    );
    expect(send).toHaveBeenCalledWith("Only change B");
    expect(input.value).toBe("Only change B");
  } finally {
    view.unmount();
    start.mockRestore();
    stop.mockRestore();
    send.mockRestore();
    webStore.setState(initial, true);
  }
});

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

  it("copies only fenced code and leaves inline code without an action", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = renderWithI18n(
      createElement(
        Markdown,
        null,
        "Use `inline()` here.\n\n```ts\nconst value = 42;\nconsole.log(value);\n```",
      ),
    );

    expect(container.querySelectorAll(".markdown-code-block")).toHaveLength(1);
    expect(
      screen.getAllByRole("button", { name: i18n.t("copyCode") }),
    ).toHaveLength(1);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: i18n.t("copyCode") })),
    );
    expect(writeText).toHaveBeenCalledWith(
      "const value = 42;\nconsole.log(value);\n",
    );
    expect(
      screen.getByRole("button", { name: i18n.t("copiedCode") }),
    ).toBeTruthy();
  });

  it("keeps a failed code copy visible", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });
    renderWithI18n(createElement(Markdown, null, "```\nvalue\n```"));

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: i18n.t("copyCode") })),
    );
    expect(screen.getByRole("status").textContent).toBe(
      i18n.t("copyCodeFailed"),
    );
    expect(
      screen.getByRole("button", { name: i18n.t("copyCode") }),
    ).toBeTruthy();
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
        settingsDisabled: false,
        onOpenSettings: vi.fn(),
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

    const process =
      container.querySelector<HTMLDetailsElement>(".process-sequence");
    expect(process).toBeTruthy();
    expect(process?.open).toBe(false);
    expect(screen.getByText(/4 (tool calls|次工具调用)/u)).toBeTruthy();
    expect(screen.getByText(/1 (agent activity|项 Agent 活动)/u)).toBeTruthy();
    expect(
      container.querySelector(".process-sequence-preview")?.textContent,
    ).not.toMatch(/[*_`]/u);
    expect(container.querySelectorAll(".tool-evidence-card")).toHaveLength(4);
    expect(
      container.querySelectorAll(".tool-evidence-card .tool-name"),
    ).toHaveLength(4);
    expect(container.querySelectorAll(".activity-card.subagent")).toHaveLength(
      1,
    );
    expect(screen.getByText("Done.")).toBeTruthy();
    expect(
      container.querySelectorAll("[aria-label=completed]").length,
    ).toBeGreaterThan(0);

    fireEvent.click(process!.querySelector("summary")!);
    expect(process?.open).toBe(true);
    expect(process?.querySelectorAll(".process-step")).toHaveLength(6);
  });
});

it("marks only live execution evidence for shimmer styling", () => {
  const snapshot = activeSnapshot();
  snapshot.selectedSession!.entries = [
    {
      id: "prompt",
      type: "message",
      timestamp: "2026-09-19T10:00:00Z",
      message: { role: "user", content: "Inspect it" },
    },
    {
      id: "assistant",
      type: "message",
      timestamp: "2026-09-19T10:00:01Z",
      message: {
        role: "assistant",
        content: "",
        parts: [
          { type: "thinking", text: "Checking the current state." },
          {
            type: "toolCall",
            id: "read-live",
            name: "read",
            arguments: '{"path":"src/index.ts"}',
          },
        ],
      },
    },
  ];

  const view = renderWithI18n(
    createElement(Transcript, {
      snapshot,
      liveMessages: [],
      liveRunning: true,
      livePhase: "running",
      liveRetry: null,
      thinkingStarts: { assistant: Date.now() },
      thinkingDurations: {},
      scrollToBottom: 0,
      onResend: async () => true,
    }),
  );

  const process = view.container.querySelector<HTMLDetailsElement>(
    ".process-sequence.running",
  );
  expect(process?.dataset.status).toBe("running");
  expect(process?.open).toBe(true);
  expect(process?.querySelectorAll(".process-step.running")).toHaveLength(2);
});

it("folds legacy setup instructions while keeping results and subsequent task messages visible", () => {
  const snapshot = activeSnapshot();
  snapshot.selectedSession!.entries = [
    {
      id: "before-user",
      type: "message",
      timestamp: "2026-09-19T10:00:00Z",
      message: { role: "user", content: "Keep this task message" },
    },
    {
      id: "before-assistant",
      type: "message",
      timestamp: "2026-09-19T10:00:01Z",
      message: { role: "assistant", content: "Visible task response" },
    },
    {
      id: "setup-command",
      type: "message",
      timestamp: "2026-09-19T10:00:02Z",
      message: {
        role: "user",
        content: "/openpi-setup Apply a dark theme",
        customType: "openpi-web-command-input",
        commandId: "setup-command-id",
      },
    },
    projectEntry({
      id: "setup-request",
      parentId: "before-assistant",
      type: "custom_message",
      timestamp: "2026-09-19T10:00:02Z",
      customType: "openpi-setup-request",
      content: "Apply a dark theme",
      display: false,
    }),
    {
      id: "setup-assistant",
      type: "message",
      timestamp: "2026-09-19T10:00:03Z",
      message: {
        role: "assistant",
        content: "Hidden configuration response",
      },
    },
    {
      id: "setup-result",
      type: "message",
      timestamp: "2026-09-19T10:00:04Z",
      message: {
        role: "toolResult",
        toolName: "configure_my_pi_setup",
        toolCallId: "setup-call",
        content: "Hidden configuration evidence",
        isError: false,
      },
    },
    {
      id: "after-user",
      type: "message",
      timestamp: "2026-09-19T10:00:05Z",
      message: { role: "user", content: "Continue the actual task" },
    },
    {
      id: "after-assistant",
      type: "message",
      timestamp: "2026-09-19T10:00:06Z",
      message: { role: "assistant", content: "Visible continuation" },
    },
  ];

  renderWithI18n(
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

  expect(screen.getAllByText("Keep this task message").length).toBeGreaterThan(
    0,
  );
  expect(screen.getByText("Visible task response")).toBeTruthy();
  expect(
    screen.getAllByText("Continue the actual task").length,
  ).toBeGreaterThan(0);
  expect(screen.getByText("Visible continuation")).toBeTruthy();
  expect(screen.getByText("Hidden configuration response")).toBeTruthy();
  expect(
    screen.getAllByText("Hidden configuration evidence").length,
  ).toBeGreaterThan(0);
  expect(
    screen.getByText("/openpi-setup Apply a dark theme", {
      selector: ".message-body",
    }),
  ).toBeTruthy();
  expect(screen.queryByText("Apply a dark theme")).toBeNull();
});

it.each([true, false])(
  "only folds a setup echo linked to its exact native command parent (%s)",
  (linked) => {
    const snapshot = activeSnapshot();
    snapshot.runtime.status = "idle";
    const content = "/openpi-setup set theme to dark";
    snapshot.selectedSession!.entries = [
      projectEntry({
        id: "command-entry",
        parentId: null,
        timestamp: "2026-09-22T00:00:00Z",
        type: "custom",
        customType: "openpi-web-command-input",
        data: { text: content, commandId: "command-one" },
      }),
      projectEntry({
        id: "setup-entry",
        parentId: linked ? "command-entry" : "other-entry",
        timestamp: "2026-09-22T00:00:01Z",
        type: "custom_message",
        customType: "openpi-setup-request",
        display: true,
        content: "Expanded internal configuration instructions",
        details: {
          requestId: "setup-one",
          command: "openpi-setup",
          request: "set theme to dark",
        },
      }),
      {
        id: "result-entry",
        timestamp: "2026-09-22T00:00:02Z",
        type: "message",
        message: { role: "assistant", content: "The theme is now dark." },
      },
    ];
    const projected = vi.fn();
    const view = renderWithI18n(
      createElement(Transcript, {
        snapshot,
        liveMessages: [
          {
            key: "optimistic-command-one",
            message: { role: "user", content },
            optimistic: {
              sessionId: "session",
              sessionPath: "/tmp/session",
              commandId: "command-one",
              afterEntryId: null,
              admitted: true,
            },
          },
        ],
        liveRunning: false,
        livePhase: "idle",
        liveRetry: null,
        thinkingStarts: {},
        thinkingDurations: {},
        scrollToBottom: 0,
        onResend: async () => true,
        onPromptProjection: projected,
      }),
    );
    expect(
      view.container.querySelectorAll(".message-row.user .message-body"),
    ).toHaveLength(linked ? 1 : 2);
    expect(
      screen.queryByText("Expanded internal configuration instructions"),
    ).toBeNull();
    expect(screen.getByText("The theme is now dark.")).toBeTruthy();
    expect(projected).toHaveBeenCalledWith("session", "/tmp/session", [
      { key: "optimistic-command-one", entryId: "command-entry" },
    ]);
  },
);

it("does not consume a later identical command draft using an older native command id", () => {
  const snapshot = activeSnapshot();
  const content = "/usage";
  snapshot.selectedSession!.entries = [
    projectEntry({
      id: "older-command",
      parentId: null,
      timestamp: "2026-09-22T00:00:00Z",
      type: "custom",
      customType: "openpi-web-command-input",
      data: { text: content, commandId: "old-command-id" },
    }),
  ];
  const projected = vi.fn();
  const view = renderWithI18n(
    createElement(Transcript, {
      snapshot,
      liveMessages: [
        {
          key: "optimistic-new-command-id",
          message: { role: "user", content },
          optimistic: {
            sessionId: "session",
            sessionPath: "/tmp/session",
            commandId: "new-command-id",
            afterEntryId: "older-command",
            admitted: true,
          },
        },
      ],
      liveRunning: true,
      livePhase: "running",
      liveRetry: null,
      thinkingStarts: {},
      thinkingDurations: {},
      scrollToBottom: 0,
      onResend: async () => true,
      onPromptProjection: projected,
    }),
  );
  expect(
    view.container.querySelectorAll(".message-row.user .message-body"),
  ).toHaveLength(2);
  expect(projected).not.toHaveBeenCalled();
});

it.each([1, 2])(
  "reconciles timestamp-free live users once while keeping native history ids (%s copies)",
  (copies) => {
    const snapshot = activeSnapshot();
    snapshot.runtime.status = "idle";
    const content = "New user request while reading old history";
    snapshot.selectedSession!.entries = [
      {
        id: "before-request",
        type: "message",
        timestamp: "2026-09-22T00:00:00Z",
        message: {
          role: "assistant",
          content: "Previous answer",
          timestamp: 100,
        },
      },
      {
        id: "native-request",
        parentId: "before-request",
        type: "message",
        timestamp: "2026-09-22T00:00:01Z",
        message: {
          role: "user",
          content,
          timestamp: 200,
          parts: [{ type: "text", text: content }],
        },
      },
    ];
    const projected = vi.fn();
    const view = renderWithI18n(
      createElement(Transcript, {
        snapshot,
        liveMessages: [
          {
            key: "optimistic-new-command",
            message: { role: "user", content },
            optimistic: {
              sessionId: "session",
              sessionPath: "/tmp/session",
              commandId: "new-command",
              afterEntryId: "before-request",
              admitted: true,
            },
          },
          ...Array.from({ length: copies }, (_, index) => ({
            key: `legacy-user-${index}`,
            message: { role: "user", content },
          })),
        ],
        liveRunning: false,
        livePhase: "idle",
        liveRetry: null,
        thinkingStarts: {},
        thinkingDurations: {},
        scrollToBottom: 0,
        onResend: async () => true,
        onPromptProjection: projected,
      }),
    );
    expect(
      view.container.querySelectorAll(".message-row.user .message-body"),
    ).toHaveLength(copies);
    expect(
      view.container
        .querySelector(".message-row.user")
        ?.getAttribute("data-history-entry"),
    ).toBe("native-request");
    expect(projected).toHaveBeenCalledWith("session", "/tmp/session", [
      { key: "optimistic-new-command", entryId: "native-request" },
    ]);
  },
);

it.each(["openpi-setup", "my-pi-setup"])(
  "shows the original /%s request once and retries the command instead of the internal prompt",
  async (command) => {
    const snapshot = activeSnapshot();
    snapshot.runtime = { status: "idle", capabilities: {} };
    const request = "set theme to dark";
    const content = `/${command} ${request}`;
    snapshot.selectedSession!.entries = [
      projectEntry({
        id: "setup",
        parentId: null,
        type: "custom_message",
        customType: "openpi-setup-request",
        timestamp: "2026-09-22T00:00:00Z",
        content: "INTERNAL EXPANDED CONFIGURATION PROMPT",
        display: true,
        details: { requestId: "setup-1", command, request },
      }),
      {
        id: "result",
        type: "message",
        timestamp: "2026-09-22T00:00:01Z",
        message: {
          role: "toolResult",
          toolName: "configure_my_pi_setup",
          toolCallId: "setup-call",
          content: "Configuration write failed",
          isError: true,
        },
      },
      {
        id: "answer",
        type: "message",
        timestamp: "2026-09-22T00:00:02Z",
        message: {
          role: "assistant",
          content: "Configuration could not be completed",
          stopReason: "error",
          errorMessage: "Fixture provider error",
        },
      },
      {
        id: "timing",
        type: "custom",
        timestamp: "2026-09-22T00:00:03Z",
        turnTiming: {
          version: 1,
          sessionId: "session",
          commandId: "web-command",
          epoch: 1,
          startedAt: 1000,
          finishedAt: 4000,
          elapsedMs: 3000,
          outcome: "failed",
        },
      },
    ];
    const resend = vi.fn(async () => true);
    const view = renderWithI18n(
      createElement(Transcript, {
        snapshot,
        liveMessages: [
          { key: "optimistic-web-command", message: { role: "user", content } },
        ],
        liveRunning: false,
        livePhase: "idle",
        liveRetry: null,
        thinkingStarts: {},
        thinkingDurations: {},
        scrollToBottom: 0,
        onResend: resend,
      }),
    );
    const users = view.container.querySelectorAll(
      ".message-row.user .message-body",
    );
    expect(users).toHaveLength(1);
    expect(users[0]?.textContent).toBe(content);
    expect(
      screen.queryByText("INTERNAL EXPANDED CONFIGURATION PROMPT"),
    ).toBeNull();
    expect(
      screen.getAllByText("Configuration write failed").length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Fixture provider error")).toBeTruthy();
    expect(
      view.container.querySelector(".turn-duration")?.textContent,
    ).toContain("3s");
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("retryPrompt") }),
      );
    });
    expect(resend).toHaveBeenCalledWith(content);
  },
);

it("does not retry an unrelated user task when a legacy setup request has no original-command metadata", () => {
  const snapshot = activeSnapshot();
  snapshot.runtime = { status: "idle", capabilities: {} };
  snapshot.selectedSession!.entries = [
    {
      id: "user",
      type: "message",
      timestamp: "2026-09-22T00:00:00Z",
      message: { role: "user", content: "Unrelated earlier task" },
    },
    projectEntry({
      id: "setup",
      parentId: "user",
      type: "custom_message",
      customType: "openpi-setup-request",
      timestamp: "2026-09-22T00:00:01Z",
      content: "Legacy expanded setup prompt",
      display: true,
    }),
    {
      id: "error",
      type: "message",
      timestamp: "2026-09-22T00:00:02Z",
      message: {
        role: "assistant",
        content: "",
        stopReason: "error",
        errorMessage: "Visible setup failure",
      },
    },
  ];
  renderWithI18n(
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
  expect(screen.getByText("Visible setup failure")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: i18n.t("retryPrompt") }),
  ).toBeNull();
});

it("renders side conversation messages with transcript role styling", async () => {
  const client = new WebClient();
  const detail = vi.spyOn(client, "subagentDetail").mockResolvedValue({
    sessionId: "session",
    detail: {
      kind: "subagents",
      id: "btw-1",
      title: "Aside",
      origin: "btw",
      status: "done",
      outcome: "completed",
      createdAt: 1,
      settledAt: 2,
      cwd: "/tmp",
      model: "test/model",
      prompt: "Initial question",
      transcript: [
        { kind: "user", text: "Right aligned question" },
        {
          kind: "assistant",
          parts: [
            { type: "text", text: "Natural assistant answer" },
            { type: "thinking", text: "Checked the evidence" },
            {
              type: "toolCall",
              toolId: "tool-live",
              name: "read",
              argsPreview: "src/index.ts",
            },
          ],
        },
      ],
      liveTools: [
        {
          toolId: "tool-live",
          name: "read",
          argsPreview: "src/index.ts",
          done: false,
        },
      ],
      finalText: "",
      truncated: false,
      omittedEntries: 0,
    },
  });

  const view = renderWithI18n(
    createElement(SubagentDetailView, {
      sessionId: "session",
      id: "btw-1",
      client,
      liveAvailable: true,
      fullView: false,
      readOnlyNote: false,
    }),
  );

  const user = await screen.findByText("Right aligned question");
  const assistant = await screen.findByText("Natural assistant answer");
  expect(
    user.closest<HTMLElement>(".subagent-message.user")?.dataset.role,
  ).toBe("user");
  expect(
    assistant.closest<HTMLElement>(".subagent-message.assistant")?.dataset.role,
  ).toBe("assistant");
  expect(view.container.querySelector(".subagent-thinking.done")).toBeTruthy();
  expect(view.container.querySelector(".subagent-tool.running")).toBeTruthy();
  expect(detail).toHaveBeenCalledWith(
    "session",
    "btw-1",
    expect.any(AbortSignal),
  );
});

function activeSnapshot(): WebSnapshot {
  return {
    protocolVersion: 1,
    preferences: { theme: "system" },
    generatedAt: "2026-09-01T10:00:00Z",
    cursor: 1,
    currentSessionId: "session",
    currentSessionPath: "/tmp/session",
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

it("keeps the reader mounted across an external controller change and revokes input until refreshed", async () => {
  const original = webStore.getState();
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  snapshot.workspaces = [{ path: "/tmp", name: "Workspace", current: true }];
  snapshot.sessions = [
    {
      id: "session",
      path: "/tmp/session",
      cwd: "/tmp",
      name: "Reading A",
      created: snapshot.generatedAt,
      modified: snapshot.generatedAt,
      source: "web-session",
      origin: "web",
      controller: "web",
      readOnly: false,
      messageCount: 4,
      firstMessage: "Earlier question",
    },
  ];
  const entry = (
    id: string,
    role: string,
    content: string,
    parentId: string | null,
  ) => ({
    id,
    parentId,
    type: "message" as const,
    timestamp: snapshot.generatedAt,
    message: { role, content },
  });
  snapshot.selectedSession!.entries = [
    entry("latest", "assistant", "Recent answer", "older-answer"),
  ];
  snapshot.selectedSession!.history = {
    leafEntryId: "latest",
    beforeEntryId: "latest",
  };
  snapshot.selectedSession!.truncation = {
    ...truncation,
    truncated: true,
    entriesOmitted: 2,
  };
  let eventStream!: EventStreamOptions;
  const client = new WebClient();
  let completeRefresh!: (next: WebSnapshot) => void;
  const refresh = vi.spyOn(client, "snapshot").mockReturnValue(
    new Promise((resolve) => {
      completeRefresh = resolve;
    }),
  );
  const prompt = vi.spyOn(client, "prompt");
  const history = vi
    .spyOn(WebClient.prototype, "sessionHistory")
    .mockResolvedValue({
      ...snapshot.selectedSession!,
      entries: [
        entry("older-user", "user", "Earlier question", null),
        entry("older-answer", "assistant", "Earlier answer", "older-user"),
      ],
      anchorEntryId: "latest",
      requestedBeforeEntryId: "latest",
      truncation: { ...truncation, entriesOmitted: 0 },
      history: {
        leafEntryId: "latest",
        beforeEntryId: null,
        anchorEntryId: "latest",
        anchorOnBranch: true,
      },
    });
  const store = createWebStore(client, {
    consumeEvents: (options) => {
      eventStream = options;
      options.onConnected();
      return new Promise<void>((resolve) =>
        options.signal.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
    },
  });
  store.setState({
    snapshot,
    cursor: 1,
    selectedPath: "/tmp/session",
    selectedWorkspace: "/tmp",
    workspaceDraft: false,
  });
  webStore.setState(store.getState(), true);
  const unsubscribe = store.subscribe((next) => webStore.setState(next, true));
  const view = renderWithI18n(createElement(App));
  try {
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("historyLoadOlder") }),
      ),
    );
    expect(screen.getByText("Earlier answer")).toBeTruthy();
    const viewport = view.container.querySelector<HTMLElement>(
      '.conversation[role="log"]',
    )!;
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 200,
    });
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    const anchor = store.getState().historyAnchor;
    expect(anchor?.entryId).toBe("latest");
    act(() =>
      eventStream.onEvent({
        protocolVersion: 1,
        sequence: 2,
        timestamp: snapshot.generatedAt,
        type: "session_switched",
        detail: { sessionId: "controller-b", sessionPath: "/tmp/b" },
      }),
    );
    expect(view.container.querySelector('.conversation[role="log"]')).toBe(
      viewport,
    );
    expect(screen.getByText("Earlier answer")).toBeTruthy();
    expect(store.getState().historyAnchor).toEqual(anchor);
    expect(
      view.container.querySelector<HTMLTextAreaElement>(".composer textarea")
        ?.disabled,
    ).toBe(true);
    expect(
      await store.getState().actions.sendPrompt("Must not reach old A"),
    ).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledWith("/tmp/session", anchor);
    const next = structuredClone(snapshot);
    next.cursor = 2;
    next.currentSessionId = "controller-b";
    next.currentSessionPath = "/tmp/b";
    next.sessions[0]!.controller = "none";
    next.sessions.push({
      ...next.sessions[0]!,
      id: "controller-b",
      path: "/tmp/b",
      controller: "web",
    });
    next.selectedSession!.history = {
      ...next.selectedSession!.history!,
      anchorEntryId: "latest",
      anchorOnBranch: true,
    };
    await act(async () => completeRefresh(next));
    expect(view.container.querySelector('.conversation[role="log"]')).toBe(
      viewport,
    );
    expect(screen.getByText("Earlier answer")).toBeTruthy();
    expect(viewport.scrollTop).toBe(100);
    expect(store.getState().historyAnchor).toEqual(anchor);
    expect(history).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    store.getState().actions.stop();
    unsubscribe();
    refresh.mockRestore();
    prompt.mockRestore();
    history.mockRestore();
    webStore.setState(original, true);
  }
});

it("groups transcript turns with state and confirmed file change receipts", () => {
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  snapshot.selectedSession!.entries = [
    {
      id: "prompt-1",
      type: "message",
      timestamp: "2026-09-18T00:00:00Z",
      message: { role: "user", content: "Update report" },
    },
    {
      id: "call-1",
      type: "message",
      timestamp: "2026-09-18T00:00:01Z",
      message: {
        role: "assistant",
        content: "",
        parts: [
          {
            type: "toolCall",
            id: "edit-1",
            name: "edit",
            arguments: '{"path":"src/report.ts"}',
          },
        ],
      },
    },
    {
      id: "result-1",
      type: "message",
      timestamp: "2026-09-18T00:00:02Z",
      message: {
        role: "toolResult",
        toolCallId: "edit-1",
        content: "updated",
        isError: false,
        details: { diff: "@@ -1 +1 @@\n-old\n+new" },
      },
    },
    {
      id: "answer-1",
      type: "message",
      timestamp: "2026-09-18T00:00:03Z",
      message: { role: "assistant", content: "Report updated." },
    },
    {
      id: "prompt-2",
      type: "message",
      timestamp: "2026-09-18T00:00:04Z",
      message: { role: "user", content: "Explain it" },
    },
    {
      id: "answer-2",
      type: "message",
      timestamp: "2026-09-18T00:00:05Z",
      message: { role: "assistant", content: "Explanation." },
    },
  ];
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

  const turns = container.querySelectorAll(".conversation-turn");
  expect(turns).toHaveLength(2);
  expect(turns[0]?.textContent).toContain("Update report");
  expect(turns[0]?.textContent).toContain("Report updated.");
  expect(turns[1]?.textContent).toContain("Explain it");
  expect(container.querySelectorAll(".final-response")).toHaveLength(2);
  expect(container.querySelectorAll(".turn-heading")).toHaveLength(0);
});

function renderEditableTranscript(onResend = vi.fn(async () => false)) {
  const snapshot = activeSnapshot();
  return renderWithI18n(
    createElement(Transcript, {
      snapshot,
      liveMessages: [
        {
          key: "user-edit",
          message: { role: "user", content: "Original message" },
        },
      ],
      liveRunning: false,
      livePhase: "idle",
      liveRetry: null,
      thinkingStarts: {},
      thinkingDurations: {},
      scrollToBottom: 0,
      onResend,
    }),
  );
}

it("discards cancelled message edits when reopening the editor", () => {
  renderEditableTranscript();
  fireEvent.click(screen.getByRole("button", { name: i18n.t("editMessage") }));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Cancelled draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("cancel") }));
  fireEvent.click(screen.getByRole("button", { name: i18n.t("editMessage") }));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe(
    "Original message",
  );
});

it("locks message edits during admission and retains rejected edits for retry", async () => {
  const result = deferred<boolean>();
  const resend = vi.fn(() => result.promise);
  renderEditableTranscript(resend);
  fireEvent.click(screen.getByRole("button", { name: i18n.t("editMessage") }));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "Edited message" } });
  const confirm = screen.getByRole<HTMLButtonElement>("button", {
    name: i18n.t("confirmEdit"),
  });
  fireEvent.click(confirm);
  expect(input.readOnly).toBe(true);
  expect(confirm.disabled).toBe(true);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(resend).toHaveBeenCalledTimes(1);
  await act(async () => {
    result.resolve(false);
    await result.promise;
  });
  expect(input.value).toBe("Edited message");
  expect(input.readOnly).toBe(false);
  expect(confirm.disabled).toBe(false);
  fireEvent.change(input, { target: { value: "   " } });
  expect(confirm.disabled).toBe(true);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(resend).toHaveBeenCalledTimes(1);
});

it("resizes the composer when a session switch clears a tall draft", () => {
  const snapshot = activeSnapshot();
  const props = {
    snapshot,
    selectedPath: "/tmp/session",
    selectedWorkspace: "/tmp",
    sessionSwitching: false,
    promptAdmissionPending: false,
    liveRunning: false,
    landing: false,
    activeTurn: null,
    turnCancellationPending: false,
    turnTerminalStatus: null,
    pendingFollowUpsReceipt: null,
    thinkingPendingLevel: null,
    actions: createWebStore().getState().actions,
  };
  const node = (path: string) =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, {
        ...props,
        selectedPath: path,
        snapshot: {
          ...snapshot,
          selectedSession: { ...snapshot.selectedSession!, path },
        },
      }),
    );
  const view = render(node("/tmp/session"));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  Object.defineProperty(input, "scrollHeight", {
    configurable: true,
    get: () => (input.value ? 400 : 52),
  });
  fireEvent.change(input, { target: { value: "Long draft" } });
  expect(input.style.height).toBe("220px");
  view.rerender(node("/tmp/other-session"));
  expect(input.value).toBe("");
  expect(input.style.height).toBe("52px");
  expect(input.style.overflowY).toBe("hidden");
});

it("keeps a pinned transcript at the bottom on viewport resize without moving a reader", () => {
  let resized: ResizeObserverCallback | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resized = callback;
      }
      observe() {}
      disconnect = disconnect;
    },
  );
  try {
    const view = renderEditableTranscript();
    const viewport = screen.getByRole("log");
    const scroll = vi.fn();
    viewport.scrollTo = scroll;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 300 },
    });
    expect(resized).toBeDefined();
    act(() => resized?.([], {} as ResizeObserver));
    expect(scroll).toHaveBeenCalledWith({ top: 1000, behavior: "instant" });
    scroll.mockClear();
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);
    act(() => resized?.([], {} as ResizeObserver));
    expect(scroll).not.toHaveBeenCalled();
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

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
      thinkingPendingLevel: null,
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
        thinkingPendingLevel: null,
        actions: store.getState().actions,
      }),
    ),
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: i18n.t("stopTurn") })
      .disabled,
  ).toBe(true);
});

it("shows Pi's queued messages beside the composer after reload and in a background session", () => {
  const snapshot = activeSnapshot();
  const selected = snapshot.selectedSession!;
  snapshot.currentSessionId = "another-session";
  snapshot.selectedExecution = {
    sessionId: selected.id,
    sessionPath: selected.path,
    status: "running",
    pendingFollowUps: 2,
    queuedMessages: ["First follow-up", "Second follow-up"],
    liveTools: [],
    liveToolsOmitted: 0,
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
    thinkingPendingLevel: null,
    actions: store.getState().actions,
  };
  const view = renderWithI18n(createElement(Composer, props));
  const queued = screen.getByRole("region", {
    name: i18n.t("pendingFollowUpsHint", { count: 2 }),
  });
  expect(queued.textContent).toContain("First follow-up");
  expect(queued.textContent).toContain("Second follow-up");
  expect(
    screen.queryByText(i18n.t("pendingFollowUpsHint", { count: 2 }), {
      selector: ".composer-hint",
    }),
  ).toBeNull();

  snapshot.selectedExecution = {
    ...snapshot.selectedExecution!,
    pendingFollowUps: 0,
    queuedMessages: [],
  };
  view.rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, {
        ...props,
        snapshot: structuredClone(snapshot),
      }),
    ),
  );
  expect(
    screen.queryByRole("region", {
      name: i18n.t("pendingFollowUpsHint", { count: 2 }),
    }),
  ).toBeNull();
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
      snapshot: {
        ...snapshot,
        preferences: {
          theme: "pine",
          chatWidth: 960,
          chatFontSize: 16,
          expandThinking: true,
        },
      },
    }),
  );
  expect(document.documentElement.dataset.theme).toBe("pine");
  expect(
    document.documentElement.style.getPropertyValue(
      "--conversation-content-width",
    ),
  ).toBe("960px");
  expect(
    document.documentElement.style.getPropertyValue("--conversation-font-size"),
  ).toBe("16px");
  unmount();
  webStore.setState({ snapshot: initial });
  vi.unstubAllGlobals();
});

it("opens recorded thinking by default only when the canonical preference is enabled", () => {
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  snapshot.preferences.expandThinking = true;
  snapshot.selectedSession!.entries = [
    {
      id: "prompt",
      type: "message",
      timestamp: "2026-09-19T00:00:00Z",
      message: { role: "user", content: "Inspect it" },
    },
    {
      id: "answer",
      type: "message",
      timestamp: "2026-09-19T00:00:01Z",
      message: {
        role: "assistant",
        content: "Done.",
        parts: [{ type: "thinking", text: "Check the implementation." }],
      },
    },
  ];

  const view = renderWithI18n(
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

  expect(
    view.container.querySelector<HTMLDetailsElement>(".thinking-line")?.open,
  ).toBe(true);
});

it("applies the thinking preference to grouped completed process evidence", () => {
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  snapshot.preferences.expandThinking = true;
  snapshot.selectedSession!.entries = [
    {
      id: "prompt",
      type: "message",
      timestamp: "2026-09-19T00:00:00Z",
      message: { role: "user", content: "Inspect it" },
    },
    {
      id: "answer",
      type: "message",
      timestamp: "2026-09-19T00:00:01Z",
      message: {
        role: "assistant",
        content: "Done.",
        parts: [
          { type: "thinking", text: "Check the implementation." },
          {
            type: "toolCall",
            id: "read-1",
            name: "read",
            arguments: '{"path":"src/index.ts"}',
          },
        ],
      },
    },
    {
      id: "result",
      type: "message",
      timestamp: "2026-09-19T00:00:02Z",
      message: {
        role: "toolResult",
        toolName: "read",
        toolCallId: "read-1",
        content: "source",
        isError: false,
      },
    },
  ];

  const view = renderWithI18n(
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

  expect(
    view.container.querySelector<HTMLDetailsElement>(".process-sequence")?.open,
  ).toBe(true);
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
    thinkingPendingLevel: null,
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
      settingsDisabled: false,
      onOpenSettings: vi.fn(),
      actions: store.getState().actions,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Archived" }));
  expect(screen.getByText("Archived work")).toBeTruthy();
  expect(screen.getAllByText("/omitted").length).toBeGreaterThan(0);
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
    thinkingPendingLevel: null,
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
    screen.getByRole("option", {
      name: "Shared model (provider-alpha/a)",
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole("option", {
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
      thinkingPendingLevel: null,
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

class ThinkingClient extends WebClient {
  thinkings: Array<{ sessionId: string; level: string }> = [];

  override setThinkingLevel(sessionId: string, level: string) {
    this.thinkings.push({ sessionId, level });
    return Promise.resolve({
      sessionId,
      level,
      available: ["off", "minimal", "low", "medium", "high"],
      supported: true,
      revision: 2,
    });
  }

  override snapshot() {
    return Promise.resolve(activeSnapshot());
  }
}

function idleThinkingSnapshot(
  overrides: Partial<WebSnapshot> = {},
): WebSnapshot {
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  snapshot.thinking = {
    level: "medium",
    available: ["off", "minimal", "low", "medium", "high"],
    supported: true,
    revision: 1,
  };
  return { ...snapshot, ...overrides };
}

function thinkingProps(
  snapshot: WebSnapshot,
  actions = createWebStore().getState().actions,
) {
  return {
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
    thinkingPendingLevel: null as string | null,
    actions,
  };
}

function thinkingPickerName(level: string) {
  return `${i18n.t("thinkingLevel")}: ${level}`;
}

it.each([null, "/tmp/copy"])(
  "disables the stale composer until file selection %s is confirmed",
  (selectedPath) => {
    const snapshot = idleThinkingSnapshot();
    const { rerender } = renderWithI18n(
      createElement(Composer, {
        ...thinkingProps(snapshot),
        selectedPath,
      }),
    );
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: i18n.t("describeTask"),
      }).disabled,
    ).toBe(true);
    rerender(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(Composer, {
          ...thinkingProps(snapshot),
          selectedPath: snapshot.selectedSession!.path,
        }),
      ),
    );
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: i18n.t("describeTask"),
      }).disabled,
    ).toBe(false);
  },
);

describe("thinking level picker", () => {
  it("renders nothing when the snapshot has no thinking projection", () => {
    const snapshot = idleThinkingSnapshot();
    delete snapshot.thinking;
    const { container } = renderWithI18n(
      createElement(Composer, thinkingProps(snapshot)),
    );
    expect(container.querySelector(".thinking-picker")).toBeNull();
  });

  it("keeps a disabled placeholder with a reason when thinking is unsupported", () => {
    const snapshot = idleThinkingSnapshot();
    snapshot.thinking = {
      level: "off",
      available: [],
      supported: false,
      revision: 1,
    };
    const { container } = renderWithI18n(
      createElement(Composer, thinkingProps(snapshot)),
    );
    const picker = screen.getByRole<HTMLButtonElement>("button", {
      name: i18n.t("thinkingUnsupported"),
    });
    expect(picker.disabled).toBe(true);
    expect(
      container.querySelector(".thinking-picker-wrap")?.getAttribute("title"),
    ).toBe(i18n.t("thinkingUnsupportedHint"));
  });

  it("prepares a native session when opening thinking from a workspace draft", async () => {
    const props = thinkingProps(idleThinkingSnapshot());
    const prepareSession = vi.fn(async () => null);
    renderWithI18n(
      createElement(Composer, {
        ...props,
        workspaceDraft: true,
        actions: { ...props.actions, prepareSession },
      }),
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: thinkingPickerName("medium"),
      }).disabled,
    ).toBe(false);
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: thinkingPickerName("medium") }),
      ),
    );
    expect(prepareSession).toHaveBeenCalledOnce();
  });

  it("hides the controller's picker while viewing a non-current session", () => {
    const props = thinkingProps(
      idleThinkingSnapshot({ currentSessionId: "another-session" }),
    );
    const { container } = renderWithI18n(createElement(Composer, props));
    expect(
      screen.queryByRole("button", {
        name: thinkingPickerName("medium"),
      }),
    ).toBeNull();
    expect(
      container.querySelector(".thinking-picker-wrap")?.getAttribute("title"),
    ).toBe(i18n.t("thinkingInactiveHint"));
  });

  it("disables the picker while a turn is running", () => {
    const snapshot = idleThinkingSnapshot();
    snapshot.runtime.status = "running";
    const { container } = renderWithI18n(
      createElement(Composer, thinkingProps(snapshot)),
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: thinkingPickerName("medium"),
      }).disabled,
    ).toBe(true);
    expect(
      container.querySelector(".thinking-picker-wrap")?.getAttribute("title"),
    ).toBe(i18n.t("thinkingLockedRunning"));
  });

  it("opens the active picker under a section titled by the thinking level", () => {
    renderWithI18n(
      createElement(Composer, thinkingProps(idleThinkingSnapshot())),
    );
    const picker = screen.getByRole<HTMLButtonElement>("button", {
      name: thinkingPickerName("medium"),
    });
    expect(picker.disabled).toBe(false);
    expect(picker.getAttribute("aria-label")).toBe(
      thinkingPickerName("medium"),
    );
    fireEvent.click(picker);
    expect(
      screen.getByRole("group", { name: i18n.t("thinkingLevel") }),
    ).toBeTruthy();
    expect(screen.getByText(i18n.t("thinkingLevel"))).toBeTruthy();
    for (const level of ["off", "minimal", "low", "medium", "high"])
      expect(screen.getByRole("menuitem", { name: level })).toBeTruthy();
  });

  it("sends nothing for the confirmed level and one request for another", async () => {
    vi.useFakeTimers();
    const snapshot = idleThinkingSnapshot();
    const client = new ThinkingClient();
    const store = createWebStore(client);
    store.setState({ snapshot, selectedPath: snapshot.selectedSession!.path });
    const selectThinking = vi.spyOn(store.getState().actions, "selectThinking");
    try {
      renderWithI18n(
        createElement(
          Composer,
          thinkingProps(snapshot, store.getState().actions),
        ),
      );
      fireEvent.click(
        screen.getByRole("button", { name: thinkingPickerName("medium") }),
      );
      fireEvent.click(screen.getByRole("menuitem", { name: "medium" }));
      expect(client.thinkings).toEqual([]);
      expect(selectThinking).toHaveBeenCalledTimes(1);

      fireEvent.click(
        screen.getByRole("button", { name: thinkingPickerName("medium") }),
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "high" }));
      });
      expect(selectThinking).toHaveBeenLastCalledWith("high");
      expect(client.thinkings).toEqual([
        { sessionId: "session", level: "high" },
      ]);
    } finally {
      store.getState().actions.stop();
      vi.useRealTimers();
    }
  });

  it("keeps a pending picker interactive while the send button is disabled", () => {
    const snapshot = idleThinkingSnapshot();
    const props = thinkingProps(snapshot);
    const view = renderWithI18n(
      createElement(Composer, { ...props, thinkingPendingLevel: "high" }),
    );
    const picker = screen.getByRole<HTMLButtonElement>("button", {
      name: /^Thinking level: high/u,
    });
    expect(picker.disabled).toBe(false);
    expect(
      view.container
        .querySelector(".thinking-picker-wrap")
        ?.getAttribute("data-pending"),
    ).toBe("true");
    fireEvent.change(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: i18n.t("describeTask"),
      }),
      { target: { value: "hello" } },
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: i18n.t("send"),
      }).disabled,
    ).toBe(true);
    view.rerender(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(Composer, { ...props, thinkingPendingLevel: null }),
      ),
    );
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: i18n.t("send"),
      }).disabled,
    ).toBe(false);
  });

  it("keeps the stop button enabled while thinking is pending", () => {
    const snapshot = idleThinkingSnapshot();
    snapshot.runtime.status = "running";
    renderWithI18n(
      createElement(Composer, {
        ...thinkingProps(snapshot),
        liveRunning: true,
        activeTurn: { sessionId: "session", commandId: "turn", epoch: 1 },
        thinkingPendingLevel: "high",
      }),
    );
    const stop = screen.getByRole<HTMLButtonElement>("button", {
      name: i18n.t("stopTurn"),
    });
    expect(stop.disabled).toBe(false);
    expect(screen.getByText(i18n.t("thinkingPendingHint"))).toBeTruthy();
  });

  it("warns when the confirmed level is not offered by the current model", () => {
    const snapshot = idleThinkingSnapshot();
    snapshot.thinking = {
      level: "ultra",
      available: ["off", "low"],
      supported: true,
      revision: 1,
    };
    const { container } = renderWithI18n(
      createElement(Composer, thinkingProps(snapshot)),
    );
    expect(
      container
        .querySelector(".thinking-picker-wrap")
        ?.getAttribute("data-warning"),
    ).toBe("true");
    fireEvent.click(
      screen.getByRole("button", { name: thinkingPickerName("ultra") }),
    );
    expect(screen.getByText(i18n.t("thinkingLevelMismatch"))).toBeTruthy();
  });
});

it("debounces bounded model search when the snapshot omitted models", async () => {
  vi.useFakeTimers();
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  snapshot.models = [
    {
      provider: "provider-visible",
      id: "visible",
      name: "Visible model",
      label: "Visible model",
      current: true,
    },
  ];
  snapshot.truncation = {
    ...truncation,
    modelsOmitted: 2,
    truncated: true,
  };
  const baseStore = createWebStore();
  const searchModels = vi.fn(async (_query: string) => {});
  const selectModel = vi.fn(async (_value: string) => {});
  const actions = {
    ...baseStore.getState().actions,
    searchModels,
    selectModel,
  };
  const initialSearch = baseStore.getState().modelSearch;
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
    thinkingPendingLevel: null,
    actions,
    modelSearch: initialSearch,
  };
  const { rerender } = renderWithI18n(createElement(Composer, props));

  fireEvent.click(
    screen.getByRole("button", {
      name: "Visible model (provider-visible/visible)",
    }),
  );
  expect(
    screen.getByText(
      "Showing 1 models. 2 more are available; search to find them.",
    ),
  ).toBeTruthy();
  const searchInput = screen.getByPlaceholderText(
    "Search provider, model name, or ID...",
  );
  fireEvent.change(searchInput, { target: { value: "h" } });
  fireEvent.change(searchInput, { target: { value: "hidden" } });
  expect(searchModels).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(249));
  expect(searchModels).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(searchModels).toHaveBeenCalledOnce();
  expect(searchModels).toHaveBeenCalledWith("hidden");

  const refreshedSnapshot = {
    ...snapshot,
    generatedAt: "2026-09-03T00:00:01Z",
  };
  rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, {
        ...props,
        snapshot: refreshedSnapshot,
      }),
    ),
  );
  await act(() => vi.advanceTimersByTimeAsync(250));
  expect(searchModels).toHaveBeenCalledTimes(2);
  expect(searchModels).toHaveBeenLastCalledWith("hidden");

  rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, {
        ...props,
        snapshot: refreshedSnapshot,
        modelSearch: {
          ...initialSearch,
          query: "hidden",
          status: "ready",
          models: [
            {
              provider: "provider-hidden",
              id: "hidden/model",
              name: "Hidden model",
              label: "Hidden model",
              current: false,
            },
          ],
          totalMatches: 1,
        },
      }),
    ),
  );
  fireEvent.click(
    screen.getByRole("option", {
      name: "Hidden model (provider-hidden/hidden/model)",
    }),
  );
  expect(selectModel).toHaveBeenCalledWith("provider-hidden/hidden/model");
  vi.useRealTimers();
});

it("cancels a pending model search when the picker closes", async () => {
  vi.useFakeTimers();
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  snapshot.models = [
    {
      provider: "provider-visible",
      id: "visible",
      name: "Visible model",
      label: "Visible model",
      current: true,
    },
  ];
  snapshot.truncation = {
    ...truncation,
    modelsOmitted: 1,
    truncated: true,
  };
  const baseStore = createWebStore();
  const searchModels = vi.fn(async (_query: string) => {});
  const actions = {
    ...baseStore.getState().actions,
    searchModels,
  };
  renderWithI18n(
    createElement(Composer, {
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
      thinkingPendingLevel: null,
      actions,
      modelSearch: baseStore.getState().modelSearch,
    }),
  );

  fireEvent.click(
    screen.getByRole("button", {
      name: "Visible model (provider-visible/visible)",
    }),
  );
  const searchInput = screen.getByPlaceholderText(
    "Search provider, model name, or ID...",
  );
  fireEvent.change(searchInput, { target: { value: "hidden" } });
  fireEvent.keyDown(searchInput, { key: "Escape" });
  await act(() => vi.advanceTimersByTimeAsync(250));

  expect(searchModels).not.toHaveBeenCalled();
});

it("shows empty and error feedback for bounded model search", () => {
  vi.useFakeTimers();
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  snapshot.models = [
    {
      provider: "provider-visible",
      id: "visible",
      name: "Visible model",
      label: "Visible model",
      current: true,
    },
  ];
  snapshot.truncation = {
    ...truncation,
    modelsOmitted: 1,
    truncated: true,
  };
  const baseStore = createWebStore();
  const initialSearch = baseStore.getState().modelSearch;
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
    thinkingPendingLevel: null,
    actions: baseStore.getState().actions,
    modelSearch: initialSearch,
  };
  const { rerender } = renderWithI18n(createElement(Composer, props));

  fireEvent.click(
    screen.getByRole("button", {
      name: "Visible model (provider-visible/visible)",
    }),
  );
  fireEvent.change(
    screen.getByPlaceholderText("Search provider, model name, or ID..."),
    { target: { value: "missing" } },
  );
  rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, {
        ...props,
        modelSearch: {
          ...initialSearch,
          query: "missing",
          status: "ready",
          totalMatches: 0,
        },
      }),
    ),
  );
  expect(screen.getByText("No matching models")).toBeTruthy();

  rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, {
        ...props,
        modelSearch: {
          ...initialSearch,
          query: "missing",
          status: "error",
          error: "Model lookup failed",
        },
      }),
    ),
  );
  expect(screen.getByRole("alert").textContent).toBe("Model lookup failed");
});

it("renders explicit choices for an unknown prompt admission", () => {
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  const store = createWebStore();
  renderWithI18n(
    createElement(Composer, {
      snapshot,
      selectedWorkspace: "/tmp",
      sessionSwitching: false,
      promptAdmissionPending: false,
      promptAdmissionRecovery: {
        sessionId: "session",
        sessionPath: snapshot.selectedSession!.path,
        content: "keep this draft",
        commandId: "unknown-command",
        optimisticKey: "optimistic-unknown-command",
        phase: "ready",
      },
      liveRunning: false,
      landing: false,
      activeTurn: null,
      turnCancellationPending: false,
      turnTerminalStatus: null,
      pendingFollowUpsReceipt: null,
      thinkingPendingLevel: null,
      actions: store.getState().actions,
    }),
  );

  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.getByDisplayValue("keep this draft")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Refresh status" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Don't resend for now" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Send as new message" }),
  ).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("requires another canonical check after admission verification fails", () => {
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  const store = createWebStore();
  const check = vi.fn(async () => {});
  renderWithI18n(
    createElement(Composer, {
      snapshot,
      selectedWorkspace: "/tmp",
      sessionSwitching: false,
      promptAdmissionPending: false,
      promptAdmissionRecovery: {
        sessionId: "session",
        sessionPath: snapshot.selectedSession!.path,
        content: "keep this draft",
        commandId: "unknown-command",
        optimisticKey: "optimistic-unknown-command",
        phase: "verification-failed",
      },
      liveRunning: false,
      landing: false,
      activeTurn: null,
      turnCancellationPending: false,
      turnTerminalStatus: null,
      pendingFollowUpsReceipt: null,
      thinkingPendingLevel: null,
      actions: {
        ...store.getState().actions,
        checkPromptAdmissionRecovery: check,
      },
    }),
  );

  const sendAsNew = screen.getByRole<HTMLButtonElement>("button", {
    name: "Send as new message",
  });
  expect(sendAsNew.disabled).toBe(true);
  expect(
    screen.getByText(
      "Could not refresh the latest Session history and runtime status. Check again before sending as a new message.",
    ),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  expect(check).toHaveBeenCalledOnce();
});

it.each(["keep this draft", "  keep this draft  ", "\nkeep this draft\n"])(
  "clears a recovered draft matching admitted content %j when late evidence arrives",
  (draft) => {
    const snapshot = activeSnapshot();
    snapshot.runtime.status = "idle";
    const store = createWebStore();
    const acknowledge = vi.fn();
    const baseProps = {
      snapshot,
      selectedWorkspace: "/tmp",
      sessionSwitching: false,
      promptAdmissionPending: false,
      promptAdmissionRecovery: {
        sessionId: "session",
        sessionPath: snapshot.selectedSession!.path,
        content: "keep this draft",
        commandId: "unknown-command",
        optimisticKey: "optimistic-unknown-command",
        phase: "ready" as const,
      },
      liveRunning: false,
      landing: false,
      activeTurn: null,
      turnCancellationPending: false,
      turnTerminalStatus: null,
      pendingFollowUpsReceipt: null,
      thinkingPendingLevel: null,
      actions: {
        ...store.getState().actions,
        acknowledgePromptAdmissionResolution: acknowledge,
      },
    };
    const { rerender } = renderWithI18n(createElement(Composer, baseProps));
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: i18n.t("describeTask"),
    });
    expect(input.value).toBe("keep this draft");
    fireEvent.change(input, { target: { value: draft } });

    rerender(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(Composer, {
          ...baseProps,
          promptAdmissionRecovery: null,
          promptAdmissionResolution: {
            commandId: "unknown-command",
            content: "keep this draft",
          },
        }),
      ),
    );

    expect(input.value).toBe("");
    expect(acknowledge).toHaveBeenCalledWith("unknown-command");
  },
);

it("keeps an emptied recovery draft empty across verification and submission phases", () => {
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  const store = createWebStore();
  const sendAsNew = vi.fn(async () => false);
  const baseProps = {
    snapshot,
    selectedWorkspace: "/tmp",
    sessionSwitching: false,
    promptAdmissionPending: false,
    promptAdmissionRecovery: {
      sessionId: "session",
      sessionPath: snapshot.selectedSession!.path,
      content: "original",
      commandId: "unknown-command",
      optimisticKey: "optimistic-unknown-command",
      phase: "verification-failed" as const,
    },
    liveRunning: false,
    landing: false,
    activeTurn: null,
    turnCancellationPending: false,
    turnTerminalStatus: null,
    pendingFollowUpsReceipt: null,
    thinkingPendingLevel: null,
    actions: { ...store.getState().actions, sendPromptAsNew: sendAsNew },
  };
  const { rerender } = renderWithI18n(createElement(Composer, baseProps));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: i18n.t("describeTask"),
  });
  expect(input.value).toBe("original");
  fireEvent.change(input, { target: { value: "" } });

  for (const phase of [
    "checking",
    "verification-failed",
    "checking",
    "ready",
    "submitting",
    "ready",
  ] as const) {
    rerender(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(Composer, {
          ...baseProps,
          promptAdmissionRecovery: {
            ...baseProps.promptAdmissionRecovery,
            phase,
          },
        }),
      ),
    );
    expect(input.value).toBe("");
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: phase === "submitting" ? "Sending…" : "Send as new message",
    });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(sendAsNew).not.toHaveBeenCalled();
  }

  rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, {
        ...baseProps,
        promptAdmissionRecovery: {
          ...baseProps.promptAdmissionRecovery,
          commandId: "next-command",
          optimisticKey: "optimistic-next-command",
          content: "next draft",
        },
      }),
    ),
  );
  expect(input.value).toBe("next draft");
});

it("preserves an edited recovered draft when late evidence arrives", () => {
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  const store = createWebStore();
  const acknowledge = vi.fn();
  const baseProps = {
    snapshot,
    selectedWorkspace: "/tmp",
    sessionSwitching: false,
    promptAdmissionPending: false,
    promptAdmissionRecovery: {
      sessionId: "session",
      sessionPath: snapshot.selectedSession!.path,
      content: "original",
      commandId: "unknown-command",
      optimisticKey: "optimistic-unknown-command",
      phase: "ready" as const,
    },
    liveRunning: false,
    landing: false,
    activeTurn: null,
    turnCancellationPending: false,
    turnTerminalStatus: null,
    pendingFollowUpsReceipt: null,
    thinkingPendingLevel: null,
    actions: {
      ...store.getState().actions,
      acknowledgePromptAdmissionResolution: acknowledge,
    },
  };
  const { rerender } = renderWithI18n(createElement(Composer, baseProps));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: i18n.t("describeTask"),
  });
  fireEvent.change(input, { target: { value: "edited" } });

  rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, {
        ...baseProps,
        promptAdmissionRecovery: null,
        promptAdmissionResolution: {
          commandId: "unknown-command",
          content: "original",
        },
      }),
    ),
  );

  expect(input.value).toBe("edited");
  expect(acknowledge).toHaveBeenCalledWith("unknown-command");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

it("keeps a retyped draft when an earlier send settles", async () => {
  const result = deferred<boolean>();
  const store = createWebStore();
  const sendPrompt = vi.fn(() => result.promise);
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  const props = {
    snapshot,
    selectedPath: "/tmp/session",
    selectedWorkspace: "/tmp",
    sessionSwitching: false,
    promptAdmissionPending: false,
    liveRunning: false,
    landing: false,
    activeTurn: null,
    turnCancellationPending: false,
    turnTerminalStatus: null,
    pendingFollowUpsReceipt: null,
    thinkingPendingLevel: null,
    actions: { ...store.getState().actions, sendPrompt },
  };
  renderWithI18n(createElement(Composer, props));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");

  fireEvent.change(input, { target: { value: "first" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("send") }));
  fireEvent.change(input, { target: { value: "second" } });
  fireEvent.change(input, { target: { value: "first" } });

  await act(async () => {
    result.resolve(true);
    await result.promise;
  });

  expect(input.value).toBe("first");
});

it("keeps a draft after a failed send", async () => {
  const result = deferred<boolean>();
  const store = createWebStore();
  const sendPrompt = vi.fn(() => result.promise);
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  renderWithI18n(
    createElement(Composer, {
      snapshot,
      selectedPath: "/tmp/session",
      selectedWorkspace: "/tmp",
      sessionSwitching: false,
      promptAdmissionPending: false,
      liveRunning: false,
      landing: false,
      activeTurn: null,
      turnCancellationPending: false,
      turnTerminalStatus: null,
      pendingFollowUpsReceipt: null,
      thinkingPendingLevel: null,
      actions: { ...store.getState().actions, sendPrompt },
    }),
  );
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");

  fireEvent.change(input, { target: { value: "keep me" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("send") }));
  await act(async () => {
    result.resolve(false);
    await result.promise;
  });

  expect(input.value).toBe("keep me");
});

it("clears an old session draft without letting its late send clear the new one", async () => {
  const result = deferred<boolean>();
  const store = createWebStore();
  const sendPrompt = vi.fn(() => result.promise);
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  const props = {
    snapshot,
    selectedPath: "/tmp/session",
    selectedWorkspace: "/tmp",
    sessionSwitching: false,
    promptAdmissionPending: false,
    liveRunning: false,
    landing: false,
    activeTurn: null,
    turnCancellationPending: false,
    turnTerminalStatus: null,
    pendingFollowUpsReceipt: null,
    thinkingPendingLevel: null,
    actions: { ...store.getState().actions, sendPrompt },
  };
  const view = renderWithI18n(createElement(Composer, props));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "old session" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("send") }));

  const nextSnapshot = {
    ...snapshot,
    currentSessionId: "next-session",
    currentSessionPath: "/tmp/next-session",
    selectedSession: {
      ...snapshot.selectedSession!,
      id: "next-session",
      path: "/tmp/next-session",
    },
  };
  view.rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, {
        ...props,
        snapshot: nextSnapshot,
        selectedPath: "/tmp/next-session",
      }),
    ),
  );
  expect(input.value).toBe("");

  fireEvent.change(input, { target: { value: "new session" } });
  await act(async () => {
    result.resolve(true);
    await result.promise;
  });

  expect(input.value).toBe("new session");
});

it("clears an active Session draft when switching to another workspace", () => {
  const store = createWebStore();
  const snapshot = activeSnapshot();
  snapshot.workspaces = [
    { path: "/tmp", name: "A", current: true },
    { path: "/tmp/other", name: "B", current: false },
  ];
  const props = {
    snapshot,
    selectedPath: "/tmp/session",
    selectedWorkspace: "/tmp",
    sessionSwitching: false,
    promptAdmissionPending: false,
    liveRunning: false,
    landing: false,
    activeTurn: null,
    turnCancellationPending: false,
    turnTerminalStatus: null,
    pendingFollowUpsReceipt: null,
    thinkingPendingLevel: null,
    actions: store.getState().actions,
  };
  const view = renderWithI18n(createElement(Composer, props));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "Session A draft" } });

  view.rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, {
        ...props,
        selectedWorkspace: "/tmp/other",
        workspaceDraft: true,
        selectedPath: "/tmp/session",
      }),
    ),
  );

  expect(input.value).toBe("");
});

it("transfers an unsent draft through manual new-session creation", () => {
  const store = createWebStore();
  const snapshot = activeSnapshot();
  const props = {
    snapshot,
    selectedPath: "/tmp/session",
    selectedWorkspace: "/tmp",
    sessionSwitching: false,
    promptAdmissionPending: false,
    liveRunning: false,
    landing: false,
    activeTurn: null,
    turnCancellationPending: false,
    turnTerminalStatus: null,
    pendingFollowUpsReceipt: null,
    thinkingPendingLevel: null,
    actions: store.getState().actions,
  };
  const view = renderWithI18n(createElement(Composer, props));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "keep this draft" } });

  view.rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, {
        ...props,
        workspaceDraft: true,
        selectedPath: null,
        sessionSwitching: true,
      }),
    ),
  );
  expect(input.value).toBe("keep this draft");

  const createdSnapshot = {
    ...snapshot,
    currentSessionId: "created-session",
    selectedSession: {
      ...snapshot.selectedSession!,
      id: "created-session",
      path: "/tmp/created-session",
    },
  };
  view.rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, {
        ...props,
        snapshot: createdSnapshot,
        selectedPath: "/tmp/created-session",
        sessionSwitching: false,
      }),
    ),
  );
  expect(input.value).toBe("keep this draft");
});

it("ignores a rapid second Enter while admission is pending", async () => {
  const result = deferred<boolean>();
  const store = createWebStore();
  const sendPrompt = vi.fn(() => result.promise);
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  renderWithI18n(
    createElement(Composer, {
      snapshot,
      selectedPath: "/tmp/session",
      selectedWorkspace: "/tmp",
      sessionSwitching: false,
      promptAdmissionPending: false,
      liveRunning: false,
      landing: false,
      activeTurn: null,
      turnCancellationPending: false,
      turnTerminalStatus: null,
      pendingFollowUpsReceipt: null,
      thinkingPendingLevel: null,
      actions: { ...store.getState().actions, sendPrompt },
    }),
  );
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "once" } });
  fireEvent.keyDown(input, {
    key: "Enter",
    nativeEvent: { isComposing: false },
  });
  fireEvent.keyDown(input, {
    key: "Enter",
    nativeEvent: { isComposing: false },
  });

  expect(sendPrompt).toHaveBeenCalledOnce();
  await act(async () => {
    result.resolve(true);
    await result.promise;
  });
  expect(input.value).toBe("");
});

it("transfers a new-session draft until its first send is accepted", async () => {
  const result = deferred<boolean>();
  const store = createWebStore();
  const sendPrompt = vi.fn(() => result.promise);
  const draftSnapshot = activeSnapshot();
  draftSnapshot.runtime.status = "idle";
  delete draftSnapshot.currentSessionId;
  delete draftSnapshot.selectedSession;
  draftSnapshot.sessions = [];
  const props = {
    snapshot: draftSnapshot,
    selectedPath: null,
    selectedWorkspace: "/tmp",
    sessionSwitching: false,
    promptAdmissionPending: false,
    liveRunning: false,
    landing: true,
    activeTurn: null,
    turnCancellationPending: false,
    turnTerminalStatus: null,
    pendingFollowUpsReceipt: null,
    thinkingPendingLevel: null,
    actions: { ...store.getState().actions, sendPrompt },
  };
  const view = renderWithI18n(createElement(Composer, props));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "first prompt" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("send") }));

  const createdSnapshot = {
    ...draftSnapshot,
    currentSessionId: "created-session",
    selectedSession: {
      id: "created-session",
      path: "/tmp/created-session",
      cwd: "/tmp",
      entries: [],
      bytes: 0,
      truncation,
    },
  };
  view.rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, {
        ...props,
        snapshot: createdSnapshot,
        selectedPath: "/tmp/created-session",
        sessionSwitching: true,
        landing: false,
      }),
    ),
  );
  expect(input.value).toBe("first prompt");

  await act(async () => {
    result.resolve(true);
    await result.promise;
  });
  expect(input.value).toBe("");
});

it("keeps a retyped recovery draft when sending as new settles", async () => {
  const result = deferred<boolean>();
  const store = createWebStore();
  const sendPrompt = vi.fn(() => result.promise);
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  const props = {
    snapshot,
    selectedPath: "/tmp/session",
    selectedWorkspace: "/tmp",
    sessionSwitching: false,
    promptAdmissionPending: false,
    promptAdmissionRecovery: {
      sessionId: "session",
      sessionPath: snapshot.selectedSession!.path,
      content: "first",
      commandId: "unknown-command",
      optimisticKey: "optimistic-unknown-command",
      phase: "ready" as const,
    },
    liveRunning: false,
    landing: false,
    activeTurn: null,
    turnCancellationPending: false,
    turnTerminalStatus: null,
    pendingFollowUpsReceipt: null,
    thinkingPendingLevel: null,
    actions: { ...store.getState().actions, sendPromptAsNew: sendPrompt },
  };
  renderWithI18n(createElement(Composer, props));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");

  fireEvent.change(input, { target: { value: "first" } });
  fireEvent.click(screen.getByRole("button", { name: "Send as new message" }));
  fireEvent.change(input, { target: { value: "second" } });
  fireEvent.change(input, { target: { value: "first" } });

  await act(async () => {
    result.resolve(true);
    await result.promise;
  });

  expect(input.value).toBe("first");
});

it("keeps the draft when a creation path arrives before failed canonical confirmation", async () => {
  const result = deferred<boolean>();
  const snapshot = idleThinkingSnapshot();
  const base = thinkingProps(snapshot);
  const props = {
    ...base,
    workspaceDraft: true,
    selectedPath: null as string | null,
    actions: { ...base.actions, sendPrompt: vi.fn(() => result.promise) },
  };
  const view = renderWithI18n(createElement(Composer, props));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "keep creation draft" } });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("send") }));
  view.rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, {
        ...props,
        selectedPath: "/tmp/created-session.jsonl",
      }),
    ),
  );
  expect(input.value).toBe("keep creation draft");
  await act(async () => {
    result.resolve(false);
    await result.promise;
  });
  expect(input.value).toBe("keep creation draft");
});
