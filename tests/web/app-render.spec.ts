// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStore } from "zustand";
import {
  projectEntry,
  WEB_PROMPT_MAX_TEXT_LENGTH,
  type WebSnapshot,
} from "../../web/protocol/types.ts";
import { App } from "../../web/ui/src/app/App.tsx";
import { Providers } from "../../web/ui/src/app/providers.tsx";
import { Markdown } from "../../web/ui/src/components/Markdown.tsx";
import { OpenPiLogo } from "../../web/ui/src/components/OpenPiLogo.tsx";
import { ActivityBar } from "../../web/ui/src/features/activity/ActivityBar.tsx";
import { Composer } from "../../web/ui/src/features/composer/Composer.tsx";
import { SessionSidebar } from "../../web/ui/src/features/sessions/SessionSidebar.tsx";
import { SubagentDetailView } from "../../web/ui/src/features/subagents/SubagentPanel.tsx";
import {
  type SessionReadingCache,
  sessionReadingScope,
} from "../../web/ui/src/features/transcript/session-reading-state.ts";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { ToolEvidence } from "../../web/ui/src/features/transcript/ToolEvidence.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import type { EventStreamOptions } from "../../web/ui/src/protocol/event-stream.ts";
import { createWebStore, webStore } from "../../web/ui/src/store/web-store.ts";
import { installCheckVisibilityFixture } from "./check-visibility-fixture.ts";
import { questionFixture } from "./question-fixtures.ts";

installCheckVisibilityFixture();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("presents fork success as status and a subsequent ordinary error as an alert", () => {
  const initial = webStore.getState();
  const start = vi.spyOn(initial.actions, "start").mockImplementation(() => {});
  const stop = vi.spyOn(initial.actions, "stop").mockImplementation(() => {});
  webStore.setState({
    snapshot: null,
    notice: { kind: "success", message: i18n.t("forkSessionCreated") },
  });
  const view = renderWithI18n(createElement(App));
  try {
    const success = screen
      .getByText(i18n.t("forkSessionCreated"))
      .closest(".notice");
    expect(success?.classList.contains("notice-success")).toBe(true);
    expect(success?.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => webStore.setState({ notice: "Unable to select the model" }));
    const error = screen.getByRole("alert");
    expect(error.textContent).toContain("Unable to select the model");
    expect(error.classList.contains("notice-success")).toBe(false);
    fireEvent.click(
      within(error).getByRole("button", { name: i18n.t("close") }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  } finally {
    view.unmount();
    start.mockRestore();
    stop.mockRestore();
    webStore.setState(initial, true);
  }
});

it("keeps one usage strip with the selected Session when its sibling overview also changes identity", () => {
  const initial = webStore.getState();
  const start = vi.spyOn(initial.actions, "start").mockImplementation(() => {});
  const stop = vi.spyOn(initial.actions, "stop").mockImplementation(() => {});
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  snapshot.usage = {
    input: 6_835,
    output: 6,
    cacheRead: 0,
    cacheWrite: 0,
    total: 6_841,
    context: { tokens: 6_841, contextWindow: 128_000, percent: 5.3 },
  };
  webStore.setState({
    snapshot,
    selectedPath: snapshot.selectedSession!.path,
    selectedWorkspace: "/tmp",
    sessionSwitching: false,
    connection: "connected",
    workspaceDraft: false,
    liveRunning: false,
    liveMessages: [],
  });
  const view = render(createElement(Providers, null, createElement(App)));
  try {
    for (const [index, [id, path]] of [
      ["other", "/tmp/other"],
      ["other", "/tmp/other-copy"],
      ["session", "/tmp/session"],
    ].entries()) {
      const output = 100 + index;
      act(() =>
        webStore.setState({
          selectedPath: path,
          snapshot: {
            ...snapshot,
            currentSessionId: id,
            currentSessionPath: path,
            selectedSession: { ...snapshot.selectedSession!, id, path },
            usage: { ...snapshot.usage!, output },
          },
        }),
      );
      expect(view.container.querySelectorAll(".session-usage")).toHaveLength(1);
      expect(
        view.container.querySelector(".session-usage-trigger")?.textContent,
      ).toContain(String(output));
      expect(
        screen.getAllByRole("button", {
          name: i18n.t("sessionOverview"),
        }),
      ).toHaveLength(1);
    }
    act(() => webStore.setState({ sessionSwitching: true }));
    expect(view.container.querySelector(".session-usage")).toBeNull();
    act(() => webStore.setState({ sessionSwitching: false, snapshot }));
    expect(view.container.querySelectorAll(".session-usage")).toHaveLength(1);
  } finally {
    view.unmount();
    start.mockRestore();
    stop.mockRestore();
    webStore.setState(initial, true);
  }
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
  fireEvent.click(screen.getByRole("button", { name: i18n.t("addContext") }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Plan plan/u }));
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
  fireEvent.click(screen.getByRole("button", { name: i18n.t("addContext") }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Plan plan/u }));
  expect(selectPlanMode).toHaveBeenLastCalledWith(false);
  expect(sendPrompt).not.toHaveBeenCalled();
  rerender("inactive", false);
  expect(input.placeholder).not.toBe(i18n.t("promptPlanMessage"));
  expect(input.value).toBe("Keep my draft");
  rerender("planning", true, true);
  expect(
    screen.queryByRole("button", { name: i18n.t("addContext") }),
  ).toBeNull();
  expect(input.disabled).toBe(true);
  await act(async () => fireEvent.submit(input.closest("form")!));
  expect(sendPrompt).not.toHaveBeenCalled();
});

it("prepares an editable implementation prompt only after confirming draft replacement and never auto-sends", async () => {
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  snapshot.runtime.plan = "ready";
  snapshot.runtime.planRevision = "ready-1";
  const store = createWebStore();
  const approval = {
    sessionId: "session",
    sessionPath: "/tmp/session",
    planRevision: "ready-1",
  };
  const preparePlanImplementation = vi.fn(async () => ({
    prompt: "Implementation prompt",
    ...approval,
  }));
  const sendPrompt = vi.fn(async () => true);
  const renderComposer = (currentSnapshot: WebSnapshot) =>
    createElement(Composer, {
      snapshot: currentSnapshot,
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
      actions: {
        ...store.getState().actions,
        preparePlanImplementation,
        sendPrompt,
      },
    });
  const view = renderWithI18n(renderComposer(snapshot));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: i18n.t("describeTask"),
  });
  fireEvent.change(input, { target: { value: "Keep this draft" } });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const implement = screen.getByRole("button", {
    name: i18n.t("planModeImplement"),
  });
  fireEvent.click(implement);
  expect(preparePlanImplementation).not.toHaveBeenCalled();
  expect(input.value).toBe("Keep this draft");

  confirm.mockReturnValue(true);
  fireEvent.click(implement);
  await waitFor(() => expect(input.value).toBe("Implementation prompt"));
  expect(preparePlanImplementation).toHaveBeenCalledExactlyOnceWith();
  expect(sendPrompt).not.toHaveBeenCalled();

  // Same-ID copied Sessions must not inherit a prepared approval. Returning
  // restores the original draft but requires another explicit preparation.
  const copy = structuredClone(snapshot);
  copy.currentSessionPath = "/tmp/copied-session";
  copy.selectedSession!.path = copy.currentSessionPath;
  view.rerender(createElement(I18nextProvider, { i18n }, renderComposer(copy)));
  expect(input.value).toBe("");
  view.rerender(
    createElement(I18nextProvider, { i18n }, renderComposer(snapshot)),
  );
  expect(input.value).toBe("Implementation prompt");
  sendPrompt.mockResolvedValueOnce(false);
  await act(async () => fireEvent.submit(input.closest("form")!));
  expect(sendPrompt).toHaveBeenCalledExactlyOnceWith("Implementation prompt");
  sendPrompt.mockClear();
  await act(async () => fireEvent.click(implement));
  expect(preparePlanImplementation).toHaveBeenCalledTimes(2);
  await act(async () => fireEvent.submit(input.closest("form")!));
  expect(sendPrompt).toHaveBeenCalledExactlyOnceWith(
    "Implementation prompt",
    undefined,
    approval,
  );
  confirm.mockRestore();
  view.unmount();
});

it("keeps a workspace draft separate from the old Session UI and retains text after failed sending", async () => {
  const initial = webStore.getState();
  const snapshot = activeSnapshot();
  snapshot.usage = {
    input: 1_200,
    output: 6,
    cacheRead: 0,
    cacheWrite: 0,
    total: 1_206,
    context: { tokens: 1_206, contextWindow: 128_000, percent: 0.9421875 },
  };
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
      screen.queryByRole("button", {
        name: i18n.t("usageOpenDetails", {
          input: "1k",
          output: "6",
          percent: "1%",
          capacity: "128k",
        }),
      }),
    ).toBeNull();
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

it.each([
  { trigger: "providerAvailability", selected: "modelSettings" },
  { trigger: "settings", selected: "generalSettings" },
])(
  "routes the App $trigger entry to $selected and retains question drafts through settings",
  async ({ trigger, selected }) => {
    const original = webStore.getState();
    const isolated = createWebStore().getState();
    const start = vi
      .spyOn(original.actions, "start")
      .mockImplementation(() => {});
    const stop = vi
      .spyOn(original.actions, "stop")
      .mockImplementation(() => {});
    const refresh = vi
      .spyOn(original.actions, "refreshSnapshot")
      .mockResolvedValue(true);
    const showModal = Object.getOwnPropertyDescriptor(
      HTMLDialogElement.prototype,
      "showModal",
    );
    const closeDialog = Object.getOwnPropertyDescriptor(
      HTMLDialogElement.prototype,
      "close",
    );
    const matchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = true;
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value(this: HTMLDialogElement) {
        this.open = false;
      },
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (media: string) => ({
        matches: false,
        media,
        addEventListener() {},
        removeEventListener() {},
      }),
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = new URL(String(input), "http://localhost");
        const responses: Record<string, unknown> = {
          "/api/questions/pending": {
            pending: {
              sessionId: "session",
              requestId: "app-question",
              toolCallId: "app-question-tool",
              expiresAt: Date.now() + 600_000,
              questions: questionFixture,
            },
          },
          "/api/git-review": { ok: false, reason: "not_git_repository" },
          "/api/models/configuration": {
            revision: "entry-fixture",
            models: [],
          },
          "/api/providers/auth-status": {
            providers: [
              {
                id: "fixture-provider",
                name: "Fixture Provider",
                authMethods: ["api_key"],
                configured: false,
                subscription: false,
                nameTruncated: false,
              },
            ],
            truncation: {
              truncated: false,
              providersOmitted: 0,
              namesTruncated: 0,
              maxProviders: 250,
            },
          },
          "/api/settings/catalog": {
            sessionId: "session",
            setup: {
              capabilities: { discovery: "explicit" },
              suggestions: { enabled: false },
              workflows: { concurrency: 6, maxAgentCalls: 64 },
              ui: {
                webTheme: "system",
                webChatWidth: 820,
                webChatFontSize: 14,
                webExpandThinking: false,
                showHeader: false,
                customFooter: true,
                footerStyle: "plain",
                subagentResultDisplay: "compact",
                bashToolDisplay: "compact",
                fileMutationDisplay: "compact",
              },
              postEditConfigured: false,
              subagents: { roleModels: {} },
            },
            resources: {
              skills: [],
              plugins: [],
              totals: { extensions: 0, skills: 0, prompts: 0, themes: 0 },
              diagnostics: { extensionErrors: 0, skillErrors: 0 },
              truncation: {
                truncated: false,
                skillsOmitted: 0,
                pluginsOmitted: 0,
                resourcesOmitted: 0,
              },
            },
          },
        };
        const body = responses[url.pathname];
        if (body === undefined)
          throw new Error(`Unexpected entry fixture request: ${url.pathname}`);
        return new Response(JSON.stringify(body), { status: 200 });
      });
    const snapshot = activeSnapshot();
    snapshot.runtime.status = "idle";
    snapshot.models = [
      {
        provider: "fixture-provider",
        id: "fixture-model",
        name: "Fixture Model",
        label: "Fixture Model",
        current: true,
      },
    ];
    webStore.setState(
      {
        ...isolated,
        actions: original.actions,
        snapshot,
        connection: "connected",
        selectedWorkspace: "/tmp",
        selectedPath: "/tmp/session",
        sidebarCollapsed: false,
        workspaceDraft: false,
        sessionSwitching: false,
      },
      true,
    );
    let view: ReturnType<typeof render> | undefined;
    try {
      view = renderWithI18n(createElement(App));
      fireEvent.click(await screen.findByRole("radio", { name: /完整交互/ }));
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("questionNotes") }),
      );
      fireEvent.change(
        screen.getByRole("textbox", { name: i18n.t("questionNotes") }),
        {
          target: { value: "Keep this question draft across settings" },
        },
      );
      if (trigger === "providerAvailability") {
        fireEvent.click(
          screen.getByRole("button", { name: i18n.t("addContext") }),
        );
        fireEvent.click(
          screen.getByRole("menuitem", { name: /^Model model/u }),
        );
        fireEvent.click(
          await screen.findByRole("button", {
            name: i18n.t("openModelSettings"),
          }),
        );
      } else
        await act(async () =>
          fireEvent.click(
            screen.getByRole("button", { name: i18n.t(trigger) }),
          ),
        );
      const dialog = await screen.findByRole("dialog", {
        name: i18n.t("settings"),
      });
      expect(
        within(dialog).getByRole("tab", {
          name: i18n.t(selected),
          selected: true,
        }),
      ).toBeTruthy();
      expect(
        within(dialog).getByRole("tabpanel", { name: i18n.t(selected) }),
      ).toBeTruthy();
      if (trigger === "providerAvailability")
        expect(
          (
            await within(dialog).findByLabelText<HTMLInputElement>(
              i18n.t("providerApiKey"),
            )
          ).value,
        ).toBe("");
      else
        expect(
          within(dialog).queryByLabelText(i18n.t("providerApiKey")),
        ).toBeNull();
      expect(webStore.getState().snapshot?.selectedSession?.path).toBe(
        "/tmp/session",
      );
      expect(
        (
          await within(dialog).findByRole<HTMLTextAreaElement>("textbox", {
            name: i18n.t("questionNotes"),
          })
        ).value,
      ).toBe("Keep this question draft across settings");
      fireEvent.click(
        within(dialog).getByRole("button", {
          name: i18n.t("close"),
        }),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: i18n.t("settings") }),
        ).toBeNull(),
      );
      expect(
        (
          await screen.findByRole<HTMLTextAreaElement>("textbox", {
            name: i18n.t("questionNotes"),
          })
        ).value,
      ).toBe("Keep this question draft across settings");
    } finally {
      view?.unmount();
      start.mockRestore();
      stop.mockRestore();
      refresh.mockRestore();
      fetch.mockRestore();
      webStore.setState(original, true);
      if (showModal)
        Object.defineProperty(
          HTMLDialogElement.prototype,
          "showModal",
          showModal,
        );
      else Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
      if (closeDialog)
        Object.defineProperty(
          HTMLDialogElement.prototype,
          "close",
          closeDialog,
        );
      else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
      if (matchMedia) Object.defineProperty(window, "matchMedia", matchMedia);
      else Reflect.deleteProperty(window, "matchMedia");
    }
  },
);

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

    const process = container.querySelector<HTMLDetailsElement>(
      ".process-sequence:not(.single-process)",
    );
    expect(process).toBeTruthy();
    expect(process?.open).toBe(false);
    expect(
      process?.querySelector("summary")?.getAttribute("aria-label"),
    ).toContain(i18n.t("processToolCount", { count: 4 }));
    expect(
      process?.querySelector("summary")?.getAttribute("aria-label"),
    ).toContain(i18n.t("processActivityCount", { count: 1 }));
    const counts = process?.querySelector(".process-sequence-counts");
    expect(counts?.textContent).toContain(
      i18n.t("processThinkingCount", { count: 1 }),
    );
    expect(counts?.textContent).toContain(
      i18n.t("processToolCount", { count: 4 }),
    );
    expect(counts?.textContent).toContain(
      i18n.t("processActivityCount", { count: 1 }),
    );
    expect(
      process?.querySelector(".process-step:first-child .thinking-line"),
    ).toBeTruthy();
    expect(
      container.querySelector(".thinking-line summary")?.textContent,
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
      container.querySelectorAll(".status-mark.done").length,
    ).toBeGreaterThan(0);

    fireEvent.click(process!.querySelector("summary")!);
    expect(process?.open).toBe(true);
    expect(process?.querySelectorAll(".process-step")).toHaveLength(6);
  });
});

it("folds saved native searches with ordinary tool groups while retaining provider order and the final answer", () => {
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  const message = {
    role: "assistant",
    stopReason: "stop" as const,
    content:
      "I will check.\nThe registry agrees.\nSlovenia. [IANA](https://www.iana.org/domains/root/db/si.html)",
    parts: [
      { type: "text" as const, text: "I will check." },
      { type: "text" as const, text: "The registry agrees." },
      {
        type: "text" as const,
        text: "Slovenia. [IANA](https://www.iana.org/domains/root/db/si.html)",
      },
    ],
    webSearch: [
      {
        id: "ws",
        query: ".si IANA",
        status: "completed" as const,
        beforePartIndex: 1,
      },
      {
        id: "ws2",
        query: ".si registry",
        status: "completed" as const,
        beforePartIndex: 1,
      },
      {
        id: "ws3",
        query: "ARNES official",
        status: "completed" as const,
        beforePartIndex: 2,
      },
    ],
  };
  snapshot.selectedSession!.entries = [
    {
      id: "prompt",
      type: "message",
      timestamp: "2026-10-10T00:00:00Z",
      message: { role: "user", content: "Check this" },
    },
    {
      id: "native-search",
      type: "message",
      timestamp: "2026-10-10T00:00:39Z",
      message,
    },
    {
      id: "timing",
      type: "custom",
      timestamp: "2026-10-10T00:00:39Z",
      turnTiming: {
        version: 1,
        sessionId: "session",
        commandId: "run",
        epoch: 1,
        promptEntryId: "prompt",
        resultEntryId: "native-search",
        startedAt: 0,
        finishedAt: 39000,
        elapsedMs: 39000,
        outcome: "completed",
      },
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
  const intro = screen.getByText("I will check.");
  const interim = screen.getByText("The registry agrees.");
  const firstSearch = container.querySelector('[data-tool="web_search"]')!;
  const elapsed = container.querySelector<HTMLButtonElement>(
    ".turn-duration-toggle",
  )!;
  expect(elapsed.getAttribute("aria-expanded")).toBe("false");
  expect(intro.closest<HTMLElement>("[hidden]")?.hidden).toBe(true);
  expect(firstSearch.closest<HTMLElement>("[hidden]")?.hidden).toBe(true);
  expect(
    screen.getByRole("link", { name: "IANA" }).closest("[hidden]"),
  ).toBeNull();
  fireEvent.click(elapsed);
  expect(elapsed.getAttribute("aria-expanded")).toBe("true");
  expect(intro.closest("[hidden]")).toBeNull();
  const group = firstSearch.closest<HTMLDetailsElement>(".process-sequence")!;
  expect(group.querySelector("summary")?.getAttribute("aria-label")).toContain(
    i18n.t("processToolCount", { count: 2 }),
  );
  expect(group.dataset.status).toBe("done");
  expect(group.open).toBe(false);
  fireEvent.click(group.querySelector("summary")!);
  expect(group.open).toBe(true);
  expect(firstSearch.querySelector("summary")?.textContent).toContain(
    i18n.t("toolActionDone_web"),
  );
  expect(
    intro.compareDocumentPosition(firstSearch) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    firstSearch.compareDocumentPosition(interim) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const lastSearch = container.querySelectorAll('[data-tool="web_search"]')[2]!;
  expect(
    interim.compareDocumentPosition(lastSearch) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    lastSearch.compareDocumentPosition(
      screen.getByRole("link", { name: "IANA" }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(firstSearch.querySelector("summary")!);
  expect((firstSearch as HTMLDetailsElement).open).toBe(true);
  expect(firstSearch.querySelector(".details-body")?.textContent).toBe(
    ".si IANA",
  );
  fireEvent.click(elapsed);
  expect(intro.closest<HTMLElement>("[hidden]")?.hidden).toBe(true);
  expect(screen.getByRole("link", { name: "IANA" }).getAttribute("href")).toBe(
    "https://www.iana.org/domains/root/db/si.html",
  );
  expect(screen.queryByText("function_call_output")).toBeNull();
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
  snapshot.runtime.liveTools = [
    {
      call: {
        type: "toolCall",
        id: "read-live",
        name: "read",
        arguments: '{"path":"src/index.ts"}',
      },
      state: "running",
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

  const sequence = view.container.querySelector<HTMLDetailsElement>(
    ".process-sequence:not(.single-process)",
  );
  expect(sequence?.open).toBe(true);
  expect(sequence?.dataset.status).toBe("running");
  const process = view.container.querySelector<HTMLElement>(
    ".process-step.running",
  );
  expect(process?.dataset.status).toBe("running");
  expect(
    process?.querySelector(".tool-evidence-card")?.getAttribute("data-state"),
  ).toBe("running");
  expect(view.container.querySelectorAll(".process-step.running")).toHaveLength(
    1,
  );
  expect(view.container.querySelector(".thinking-line.running")).toBeNull();
  expect(view.container.querySelector(".thinking-line.done")).toBeTruthy();
  expect(
    Array.from(sequence!.querySelectorAll(".process-step"), (step) =>
      step.getAttribute("data-status"),
    ),
  ).toEqual(["done", "running"]);
});

it("freezes unobserved activity without changing terminal receipts and resumes on observation", () => {
  const snapshot = activeSnapshot();
  const finished = [
    {
      id: "read-returned",
      name: "read",
      content: "Exact source",
      isError: false,
    },
    {
      id: "bash-failed",
      name: "bash",
      content: "Command exited with code 2",
      isError: true,
    },
    {
      id: "bash-stopped",
      name: "bash",
      content: "Command aborted",
      isError: true,
    },
    {
      id: "bash-timeout",
      name: "bash",
      content: "Command timed out after 10 seconds",
      isError: true,
    },
    {
      id: "background-status",
      name: "bg_status",
      content: "Native background process is still running",
      isError: false,
      details: { status: "running" },
    },
  ];
  const pending = [
    { id: "read-live", name: "read" },
    { id: "generic-live", name: "custom_tool" },
    { id: "workflow-live", name: "workflow_status" },
  ].map((tool) => ({
    type: "toolCall" as const,
    ...tool,
    arguments: '{"path":"src/index.ts","command":"build"}',
  }));
  snapshot.selectedSession!.entries = [
    {
      id: "prompt",
      type: "message",
      timestamp: snapshot.generatedAt,
      message: { role: "user", content: "Inspect it" },
    },
    {
      id: "assistant",
      type: "message",
      timestamp: snapshot.generatedAt,
      message: {
        role: "assistant",
        content: "",
        parts: [
          ...finished.map((tool) => ({
            type: "toolCall" as const,
            id: tool.id,
            name: tool.name,
            arguments: '{"path":"src/index.ts","command":"build"}',
          })),
          ...pending,
        ],
      },
    },
    ...finished.map((tool) => ({
      id: `${tool.id}-receipt`,
      type: "message" as const,
      timestamp: snapshot.generatedAt,
      message: {
        role: "toolResult",
        toolCallId: tool.id,
        toolName: tool.name,
        content: tool.content,
        isError: tool.isError,
        details: tool.details,
      },
    })),
    {
      id: "current-thinking",
      type: "message",
      timestamp: snapshot.generatedAt,
      message: {
        role: "assistant",
        content: "",
        parts: [{ type: "thinking", text: "Inspecting the current activity" }],
      },
    },
  ];
  snapshot.runtime.liveTools = pending.map((call) => ({
    call,
    state: "running",
  }));
  const original = JSON.stringify(snapshot);
  const node = (observed: boolean) =>
    createElement(Transcript, {
      snapshot,
      activityObserved: observed,
      liveMessages: [],
      liveRunning: observed,
      livePhase: "running",
      liveRetry: null,
      thinkingStarts: {},
      thinkingDurations: {},
      scrollToBottom: 0,
      onResend: async () => true,
    });
  const view = renderWithI18n(node(true));
  const statuses = () =>
    Array.from(view.container.querySelectorAll(".process-step"), (step) =>
      step.getAttribute("data-status"),
    );
  const toolStates = () =>
    Array.from(view.container.querySelectorAll(".tool-evidence-card"), (card) =>
      card.getAttribute("data-state"),
    );
  expect(statuses()).toEqual([
    "done",
    "error",
    "error",
    "error",
    "running",
    "running",
    "running",
    "running",
    "running",
  ]);
  expect(toolStates()).toEqual([
    "returned",
    "failed",
    "cancelled",
    "timed_out",
    "running",
    "running",
  ]);

  view.rerender(createElement(I18nextProvider, { i18n }, node(false)));
  expect(statuses()).toEqual([
    "done",
    "error",
    "error",
    "error",
    "unknown",
    "unknown",
    "unknown",
    "unknown",
    "unknown",
  ]);
  expect(toolStates()).toEqual([
    "returned",
    "failed",
    "cancelled",
    "timed_out",
    "unknown",
    "unknown",
  ]);
  expect(view.container.querySelector(".thinking-line.unknown")).toBeTruthy();
  expect(view.container.querySelector(".process-step.running")).toBeNull();
  expect(view.container.querySelector(".status-mark.running")).toBeNull();
  for (const receipt of finished)
    expect(view.container.textContent).toContain(receipt.content);
  expect(JSON.stringify(snapshot)).toBe(original);

  view.rerender(createElement(I18nextProvider, { i18n }, node(true)));
  expect(statuses().slice(4)).toEqual([
    "running",
    "running",
    "running",
    "running",
    "running",
  ]);
  expect(view.container.querySelector(".thinking-line.running")).toBeTruthy();
  expect(toolStates()).toEqual([
    "returned",
    "failed",
    "cancelled",
    "timed_out",
    "running",
    "running",
  ]);
  expect(JSON.stringify(snapshot)).toBe(original);
});

it("freezes untimed turn and navigation presentation when native activity observation is lost", () => {
  const snapshot = activeSnapshot();
  const call = {
    type: "toolCall" as const,
    id: "read-live",
    name: "read",
    arguments: '{"path":"src/index.ts"}',
  };
  snapshot.runtime.liveTools = [{ call, state: "running" }];
  snapshot.selectedSession!.entries = [
    {
      id: "prompt",
      type: "message",
      timestamp: snapshot.generatedAt,
      message: { role: "user", content: "Inspect it" },
    },
    {
      id: "current-assistant",
      type: "message",
      timestamp: snapshot.generatedAt,
      message: {
        role: "assistant",
        content: "",
        parts: [{ type: "thinking", text: "Inspecting the file" }, call],
      },
    },
  ];
  const original = JSON.stringify(snapshot);
  const node = (observed?: boolean) =>
    createElement(Transcript, {
      snapshot,
      activityObserved: observed,
      liveMessages: [],
      liveRunning: true,
      livePhase: "running",
      liveRetry: null,
      thinkingStarts: {},
      thinkingDurations: {},
      scrollToBottom: 0,
      onResend: async () => true,
    });
  const view = renderWithI18n(node());
  expect(snapshot.runtime.activeTurn).toBeUndefined();
  expect(view.container.querySelector(".turn-state.running")).toBeTruthy();
  expect(
    view.container.querySelector(".conversation-execution-status")?.textContent,
  ).toContain(i18n.t("modelRunning"));
  fireEvent.wheel(view.container.querySelector(".conversation")!, {
    deltaY: -20,
  });
  expect(view.container.querySelector(".latest-activity-dots")).toBeTruthy();
  const sequence = view.container.querySelector<HTMLDetailsElement>(
    ".process-sequence:not(.single-process)",
  )!;
  expect(sequence.open).toBe(true);
  view.rerender(createElement(I18nextProvider, { i18n }, node(false)));
  expect(
    view.container.querySelector(".turn-state.unknown")?.textContent,
  ).toContain(i18n.t("toolState_unknown"));
  expect(view.container.querySelector(".turn-state.running")).toBeNull();
  expect(
    view.container.querySelector(".conversation-execution-status"),
  ).toBeNull();
  expect(view.container.querySelector(".latest-activity-dots")).toBeNull();
  expect(
    view.container.querySelector(".jump-to-latest .lucide-arrow-down"),
  ).toBeTruthy();
  expect(
    view.container.querySelector(".process-sequence:not(.single-process)"),
  ).toBe(sequence);
  expect(sequence.open).toBe(true);
  expect(JSON.stringify(snapshot)).toBe(original);
  view.rerender(createElement(I18nextProvider, { i18n }, node(true)));
  expect(view.container.querySelector(".turn-state.running")).toBeTruthy();
  expect(
    view.container.querySelector(".conversation-execution-status")?.textContent,
  ).toContain(i18n.t("modelRunning"));
  expect(view.container.querySelector(".latest-activity-dots")).toBeTruthy();
  expect(JSON.stringify(snapshot)).toBe(original);
});

it("keeps background evidence observed by default and freezes only its nonterminal presentation", () => {
  const call = {
    type: "toolCall" as const,
    id: "background-status",
    name: "bg_status",
    arguments: '{"id":"background-process"}',
  };
  const result = {
    role: "toolResult",
    toolName: call.name,
    toolCallId: call.id,
    content: "Exact native background receipt",
    isError: false,
    details: { status: "running" },
  };
  const original = JSON.stringify(result);
  const view = renderWithI18n(createElement(ToolEvidence, { call, result }));
  const state = () =>
    view.container
      .querySelector(".tool-evidence-card")
      ?.getAttribute("data-state");
  expect(state()).toBe("running");
  view.rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ToolEvidence, { call, result, observed: false }),
    ),
  );
  expect(state()).toBe("unknown");
  expect(JSON.stringify(result)).toBe(original);
  for (const [status, expected] of [
    ["done", "returned"],
    ["failed", "failed"],
    ["killed", "cancelled"],
    ["timed_out", "timed_out"],
  ]) {
    view.rerender(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(ToolEvidence, {
          call,
          result: { ...result, details: { status, exitCode: 2 } },
          observed: false,
        }),
      ),
    );
    expect(state()).toBe(expected);
  }
  expect(view.container.textContent).toContain(result.content);
  expect(JSON.stringify(result)).toBe(original);
});

it("freezes orphan native running receipts after observation loss without changing terminal evidence", () => {
  const snapshot = activeSnapshot();
  const states = [
    "running",
    "done",
    "failed",
    "killed",
    "timed_out",
    "uncertain",
  ];
  snapshot.selectedSession!.entries = states.map((status) => ({
    id: `orphan-${status}`,
    type: "message",
    timestamp: snapshot.generatedAt,
    message: {
      role: "toolResult",
      toolCallId: `trimmed-call-${status}`,
      toolName: "bg_status",
      content: `Exact orphan native receipt: ${status}`,
      isError: false,
      details: { status },
    },
  }));
  const original = JSON.stringify(snapshot);
  const node = (observed?: boolean) =>
    createElement(Transcript, {
      snapshot,
      activityObserved: observed,
      liveMessages: [],
      liveRunning: true,
      livePhase: "running",
      liveRetry: null,
      thinkingStarts: {},
      thinkingDurations: {},
      scrollToBottom: 0,
      onResend: async () => true,
    });
  const view = renderWithI18n(node());
  const statuses = () =>
    Array.from(view.container.querySelectorAll(".process-step"), (step) =>
      step.getAttribute("data-status"),
    );
  expect(statuses()).toEqual([
    "running",
    "done",
    "error",
    "error",
    "error",
    "warn",
  ]);
  expect(view.container.querySelector(".tool-evidence-card")).toBeNull();
  view.rerender(createElement(I18nextProvider, { i18n }, node(false)));
  expect(statuses()).toEqual([
    "unknown",
    "done",
    "error",
    "error",
    "error",
    "warn",
  ]);
  expect(view.container.querySelector(".process-step.running")).toBeNull();
  expect(view.container.querySelector(".status-mark.running")).toBeNull();
  for (const status of states)
    expect(view.container.textContent).toContain(
      `Exact orphan native receipt: ${status}`,
    );
  expect(JSON.stringify(snapshot)).toBe(original);
  view.rerender(createElement(I18nextProvider, { i18n }, node(true)));
  expect(statuses()).toEqual([
    "running",
    "done",
    "error",
    "error",
    "error",
    "warn",
  ]);
  expect(JSON.stringify(snapshot)).toBe(original);
});

it.each([
  { status: "running", outcome: undefined, expected: "unknown" },
  { status: "done", outcome: "completed", expected: "done" },
  { status: "error", outcome: "failed", expected: "error" },
  { status: "error", outcome: "interrupted", expected: "interrupted" },
] as const)(
  "preserves native child $status/$outcome evidence when observation is lost",
  ({ status, outcome, expected }) => {
    const snapshot = activeSnapshot();
    snapshot.runtime.capabilities = {
      ...snapshot.runtime.capabilities,
      subagents: {
        items: [
          { id: "child", title: "Inspect", status, outcome, createdAt: 1 },
        ],
        omitted: 0,
        truncated: false,
      },
    };
    snapshot.selectedSession!.entries = [
      {
        id: "spawn",
        type: "message",
        timestamp: snapshot.generatedAt,
        message: {
          role: "assistant",
          content: "",
          parts: [
            {
              type: "toolCall",
              id: "spawn",
              name: "subagent_spawn",
              arguments: '{"name":"Inspect","prompt":"Inspect"}',
            },
          ],
        },
      },
      {
        id: "spawn-receipt",
        type: "message",
        timestamp: snapshot.generatedAt,
        message: {
          role: "toolResult",
          toolCallId: "spawn",
          toolName: "subagent_spawn",
          content: "Exact native spawn receipt",
          isError: false,
          details: { id: "child" },
        },
      },
    ];
    const original = JSON.stringify(snapshot);
    const node = (observed?: boolean) =>
      createElement(Transcript, {
        snapshot,
        activityObserved: observed,
        liveMessages: [],
        liveRunning: true,
        livePhase: "running",
        liveRetry: null,
        thinkingStarts: {},
        thinkingDurations: {},
        scrollToBottom: 0,
        onResend: async () => true,
      });
    const view = renderWithI18n(node());
    expect(
      view.container.querySelector(
        `.subagent-state.${outcome === "interrupted" ? "interrupted" : status}`,
      ),
    ).toBeTruthy();
    view.rerender(createElement(I18nextProvider, { i18n }, node(false)));
    expect(
      view.container.querySelector(`.subagent-state.${expected}`),
    ).toBeTruthy();
    expect(view.container.querySelector(".subagent-state.running")).toBeNull();
    expect(view.container.textContent).toContain("Exact native spawn receipt");
    expect(JSON.stringify(snapshot)).toBe(original);
  },
);

it("shows an unobserved pending child as unknown while preserving a native failed spawn receipt", () => {
  const snapshot = activeSnapshot();
  snapshot.selectedSession!.entries = [
    {
      id: "spawns",
      type: "message",
      timestamp: snapshot.generatedAt,
      message: {
        role: "assistant",
        content: "",
        parts: ["pending", "failed"].map((id) => ({
          type: "toolCall" as const,
          id,
          name: "subagent_spawn",
          arguments: JSON.stringify({ name: id, prompt: "Inspect" }),
        })),
      },
    },
    {
      id: "failed-spawn",
      type: "message",
      timestamp: snapshot.generatedAt,
      message: {
        role: "toolResult",
        toolCallId: "failed",
        toolName: "subagent_spawn",
        content: "Exact native failed spawn receipt",
        isError: true,
      },
    },
  ];
  const original = JSON.stringify(snapshot);
  const node = (observed?: boolean) =>
    createElement(Transcript, {
      snapshot,
      activityObserved: observed,
      liveMessages: [],
      liveRunning: true,
      livePhase: "running",
      liveRetry: null,
      thinkingStarts: {},
      thinkingDurations: {},
      scrollToBottom: 0,
      onResend: async () => true,
    });
  const view = renderWithI18n(node());
  const labels = () =>
    Array.from(
      view.container.querySelectorAll(".subagent-state"),
      (item) => item.textContent,
    );
  expect(labels()).toEqual([
    i18n.t("subagentStarting"),
    i18n.t("subagentSpawnFailed"),
  ]);
  view.rerender(createElement(I18nextProvider, { i18n }, node(false)));
  expect(labels()).toEqual([
    i18n.t("toolState_unknown"),
    i18n.t("subagentSpawnFailed"),
  ]);
  expect(view.container.textContent).toContain(
    "Exact native failed spawn receipt",
  );
  expect(JSON.stringify(snapshot)).toBe(original);
  view.rerender(createElement(I18nextProvider, { i18n }, node(true)));
  expect(labels()).toEqual([
    i18n.t("subagentStarting"),
    i18n.t("subagentSpawnFailed"),
  ]);
});

it("freezes native running workflow cards while preserving their terminal and uncertain receipts", () => {
  const snapshot = activeSnapshot();
  const states = ["running", "completed", "failed", "aborted", "uncertain"];
  snapshot.selectedSession!.entries = [
    {
      id: "workflow-calls",
      type: "message",
      timestamp: snapshot.generatedAt,
      message: {
        role: "assistant",
        content: "",
        parts: states.map((id) => ({
          type: "toolCall" as const,
          id,
          name: "workflow_status",
          arguments: JSON.stringify({ runId: id }),
        })),
      },
    },
    ...states.map((status) => ({
      id: `workflow-${status}`,
      type: "message" as const,
      timestamp: snapshot.generatedAt,
      message: {
        role: "toolResult",
        toolCallId: status,
        toolName: "workflow_status",
        content: `Exact native workflow receipt: ${status}`,
        isError: false,
        details: { status },
      },
    })),
  ];
  const original = JSON.stringify(snapshot);
  const node = (observed?: boolean) =>
    createElement(Transcript, {
      snapshot,
      activityObserved: observed,
      liveMessages: [],
      liveRunning: true,
      livePhase: "running",
      liveRetry: null,
      thinkingStarts: {},
      thinkingDurations: {},
      scrollToBottom: 0,
      onResend: async () => true,
    });
  const view = renderWithI18n(node());
  const statuses = () =>
    Array.from(
      view.container.querySelectorAll(".activity-card.workflow"),
      (card) =>
        ["running", "done", "error", "warn"].find((status) =>
          card.querySelector(".status-mark")?.classList.contains(status),
        ) ?? "unknown",
    );
  expect(statuses()).toEqual(["running", "done", "error", "error", "warn"]);
  view.rerender(createElement(I18nextProvider, { i18n }, node(false)));
  expect(statuses()).toEqual(["unknown", "done", "error", "error", "warn"]);
  for (const status of states)
    expect(view.container.textContent).toContain(
      `Exact native workflow receipt: ${status}`,
    );
  expect(JSON.stringify(snapshot)).toBe(original);
});

it.each(["stop", "length"] as const)(
  "keeps thinking settled after native %s even while the runtime remains busy",
  (stopReason) => {
    const snapshot = activeSnapshot();
    snapshot.selectedSession!.entries = [
      {
        id: "prompt",
        type: "message",
        timestamp: snapshot.generatedAt,
        message: { role: "user", content: "Inspect it" },
      },
      {
        id: "finished-answer",
        type: "message",
        timestamp: snapshot.generatedAt,
        message: {
          role: "assistant",
          content: "Exact final answer",
          stopReason,
          parts: [{ type: "thinking", text: "Finished inspecting" }],
        },
      },
    ];
    const original = JSON.stringify(snapshot);
    const view = renderWithI18n(
      createElement(Transcript, {
        snapshot,
        liveMessages: [],
        liveRunning: true,
        livePhase: "running",
        liveRetry: null,
        thinkingStarts: {},
        thinkingDurations: {},
        scrollToBottom: 0,
        onResend: async () => true,
      }),
    );
    expect(view.container.querySelector(".thinking-line.running")).toBeNull();
    expect(view.container.querySelector(".thinking-line.done")).toBeTruthy();
    expect(
      view.container
        .querySelector(".thinking-line")
        ?.closest(".process-step")
        ?.getAttribute("data-status"),
    ).toBe("done");
    expect(
      screen.getByText("Exact final answer").closest("[hidden]"),
    ).toBeNull();
    expect(JSON.stringify(snapshot)).toBe(original);
  },
);

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

it.each([false, true])(
  "reconciles persisted setup messages with timestamped live echoes (new episode: %s)",
  (newEpisode) => {
    const snapshot = activeSnapshot();
    snapshot.runtime.status = "idle";
    const content = "/openpi-setup set width to 1040";
    const command = projectEntry({
      id: "command",
      parentId: null,
      type: "custom",
      customType: "openpi-web-command-input",
      timestamp: "2026-09-29T02:44:28Z",
      data: { text: content, commandId: "width-command" },
    });
    const setup = projectEntry({
      id: "setup",
      parentId: "command",
      type: "custom_message",
      customType: "openpi-setup-request",
      timestamp: "2026-09-29T02:44:28Z",
      content: "Internal setup instructions",
      display: true,
      details: {
        command: "openpi-setup",
        request: "set width to 1040",
        requestId: "setup-2",
      },
    });
    const closed = projectEntry({
      id: "closed",
      parentId: "answer",
      type: "custom_message",
      customType: "openpi-setup-closed",
      timestamp: "2026-09-29T02:44:58Z",
      content: "Setup episode closed",
      display: true,
      details: { reason: "closed" },
    });
    snapshot.selectedSession!.entries = [
      command,
      setup,
      {
        id: "answer",
        type: "message",
        timestamp: "2026-09-29T02:44:57Z",
        message: { role: "assistant", content: "Width saved" },
      },
      closed,
    ];
    const view = renderWithI18n(
      createElement(Transcript, {
        snapshot,
        liveMessages: [
          {
            key: "live-closed",
            message: { ...closed.message!, timestamp: 1790649898000 },
          },
          {
            key: "live-setup",
            message: {
              ...setup.message!,
              timestamp: 1790649868000,
              ...(newEpisode
                ? {
                    details: {
                      ...(setup.message!.details as object),
                      requestId: "setup-3",
                    },
                  }
                : {}),
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
      }),
    );
    expect(
      view.container.querySelectorAll(".message-row.user .message-body"),
    ).toHaveLength(newEpisode ? 2 : 1);
    expect(
      screen.getAllByText("Setup episode closed", { selector: "pre" }),
    ).toHaveLength(1);
    expect(screen.getByText("Width saved")).toBeTruthy();
  },
);

it.each([false, true])(
  "pairs generic setup calls with their exact result while keeping orphan results (error: %s)",
  (isError) => {
    const snapshot = activeSnapshot();
    const content = isError ? "Configuration failed" : "Saved OpenPI setup";
    snapshot.selectedSession!.entries = [
      {
        id: "call",
        type: "message",
        timestamp: "2026-09-29T02:44:44Z",
        message: {
          role: "assistant",
          content: "",
          parts: [
            {
              type: "toolCall",
              id: "width-call",
              name: "configure_my_pi_setup",
              arguments: '{"ui_web_chat_width":1040}',
            },
          ],
        },
      },
      {
        id: "result",
        type: "message",
        timestamp: "2026-09-29T02:44:45Z",
        message: {
          role: "toolResult",
          toolName: "configure_my_pi_setup",
          toolCallId: "width-call",
          content,
          isError,
        },
      },
      {
        id: "orphan",
        type: "message",
        timestamp: "2026-09-29T02:44:46Z",
        message: {
          role: "toolResult",
          toolName: "legacy_tool",
          toolCallId: "missing-call",
          content: "Orphan evidence",
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
      screen.getAllByText("configure_my_pi_setup", { exact: true }),
    ).toHaveLength(1);
    expect(
      screen.getByLabelText(i18n.t("toolCallArguments")).textContent,
    ).toContain('"ui_web_chat_width":1040');
    expect(screen.getByLabelText(i18n.t("toolCallOutput")).textContent).toBe(
      content,
    );
    expect(
      screen
        .getByLabelText(i18n.t("toolCallOutput"))
        .closest("details")
        ?.classList.contains(isError ? "error" : "done"),
    ).toBe(true);
    expect(view.container.textContent).toContain("Orphan evidence");
  },
);

it.each([0, 1, 2, -1])(
  "only folds a setup echo linked through exact native system ancestry (%s)",
  (systems) => {
    const linked = systems >= 0;
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
      ...Array.from({ length: Math.max(0, systems) }, (_, index) =>
        projectEntry({
          id: `system-${index}`,
          parentId: index === 0 ? "command-entry" : `system-${index - 1}`,
          type: "message",
          timestamp: "2026-09-22T00:00:00Z",
          message: {
            role: "system",
            content: "Native tool context",
            timestamp: 0,
          },
        }),
      ),
      projectEntry({
        id: "setup-entry",
        parentId: linked
          ? systems
            ? `system-${systems - 1}`
            : "command-entry"
          : "other-entry",
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

it("keeps background Session files, trajectory and activity scoped to the selected identity", async () => {
  const original = webStore.getState();
  const start = vi
    .spyOn(original.actions, "start")
    .mockImplementation(() => {});
  const stop = vi.spyOn(original.actions, "stop").mockImplementation(() => {});
  const review = vi.spyOn(WebClient.prototype, "gitReview").mockResolvedValue({
    ok: false,
    reason: "not_git_repository",
  });
  const listing = vi
    .spyOn(WebClient.prototype, "workspaceFiles")
    .mockResolvedValue({
      path: ".",
      entries: [{ name: "b.txt", path: "b.txt", kind: "file" }],
      truncated: false,
    });
  const snapshot = activeSnapshot();
  snapshot.currentSessionId = "active-a";
  snapshot.currentSessionPath = "/tmp/a";
  snapshot.runtime.activeTurn = {
    sessionId: "active-a",
    sessionPath: "/tmp/a",
    commandId: "turn-a",
    epoch: 1,
  };
  snapshot.runtime.capabilities = {
    "background-terminals": {
      items: [
        { id: "terminal-a", title: "A build", status: "running", createdAt: 1 },
      ],
      omitted: 0,
      truncated: false,
    },
  };
  snapshot.workspaces = [{ path: "/tmp", name: "Workspace", current: true }];
  snapshot.selectedSession = {
    ...snapshot.selectedSession!,
    id: "background-b",
    path: "/tmp/b",
    entries: [
      {
        id: "b-call",
        type: "message",
        timestamp: snapshot.generatedAt,
        message: {
          role: "assistant",
          content: "",
          parts: [
            {
              type: "toolCall",
              id: "write-b",
              name: "write",
              arguments: '{"path":"b.txt"}',
            },
          ],
        },
      },
      {
        id: "b-result",
        type: "message",
        timestamp: snapshot.generatedAt,
        message: {
          role: "toolResult",
          toolCallId: "write-b",
          content: "saved",
          isError: false,
        },
      },
    ],
  };
  snapshot.selectedExecution = {
    sessionId: "background-b",
    sessionPath: "/tmp/b",
    status: "running",
    liveTools: [
      {
        call: { type: "toolCall", name: "bash", arguments: "{}" },
        state: "running",
      },
    ],
    liveToolsOmitted: 0,
  };
  webStore.setState({
    snapshot,
    selectedPath: "/tmp/b",
    selectedWorkspace: "/tmp",
    connection: "connected",
    workspaceDraft: false,
    sessionSwitching: false,
    liveRunning: true,
    activeTurn: snapshot.runtime.activeTurn,
    liveMessages: [
      {
        key: "a-call",
        message: {
          role: "assistant",
          content: "",
          parts: [
            {
              type: "toolCall",
              id: "write-a",
              name: "write",
              arguments: '{"path":"a.txt"}',
            },
          ],
        },
      },
      {
        key: "a-result",
        message: {
          role: "toolResult",
          toolCallId: "write-a",
          content: "saved",
          isError: false,
        },
      },
    ],
  });
  const view = renderWithI18n(createElement(App));
  try {
    expect(screen.getByText(i18n.t("backgroundSessionRunning"))).toBeTruthy();
    expect(
      screen.getByText(i18n.t("observedSessionTools", { count: 1 })),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Runtime activity")).toBeNull();
    expect(
      screen.queryByRole("button", { name: i18n.t("stopTurn") }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: i18n.t("trajectory") }));
    expect(screen.getByText(i18n.t("trajectoryRunning"))).toBeTruthy();
    act(() =>
      webStore.setState({
        snapshot: {
          ...snapshot,
          selectedExecution: { ...snapshot.selectedExecution!, status: "idle" },
        },
      }),
    );
    expect(screen.queryByText(i18n.t("trajectoryRunning"))).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: i18n.t("chatView") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("openTools") }));
    fireEvent.click(
      screen.getByRole("button", {
        name: new RegExp(i18n.t("files"), "u"),
      }),
    );
    const files = view.container.querySelector<HTMLElement>(".file-tree")!;
    await within(files).findByRole("button", { name: "b.txt" });
    expect(listing).toHaveBeenCalledWith(
      "background-b",
      "/tmp/b",
      ".",
      "",
      expect.any(AbortSignal),
    );
    expect(files.textContent).toContain("b.txt");
    expect(files.textContent).not.toContain("a.txt");
  } finally {
    view.unmount();
    start.mockRestore();
    stop.mockRestore();
    review.mockRestore();
    listing.mockRestore();
    webStore.setState(original, true);
  }
});

it("refreshes background Session Git review while a different Session runs", async () => {
  vi.useFakeTimers();
  const original = webStore.getState();
  const start = vi
    .spyOn(original.actions, "start")
    .mockImplementation(() => {});
  const stop = vi.spyOn(original.actions, "stop").mockImplementation(() => {});
  const review = vi.spyOn(WebClient.prototype, "gitReview").mockResolvedValue({
    ok: false,
    reason: "not_git_repository",
  });
  const snapshot = activeSnapshot();
  snapshot.currentSessionId = "running-a";
  snapshot.currentSessionPath = "/tmp/a";
  snapshot.selectedSession = {
    ...snapshot.selectedSession!,
    id: "idle-b",
    path: "/tmp/b",
  };
  snapshot.selectedExecution = {
    sessionId: "idle-b",
    sessionPath: "/tmp/b",
    status: "idle",
    liveTools: [],
    liveToolsOmitted: 0,
  };
  webStore.setState({
    snapshot,
    selectedPath: "/tmp/b",
    selectedWorkspace: "/tmp",
    workspaceDraft: false,
    sessionSwitching: false,
    liveRunning: true,
    liveMessages: [],
    activeTurn: {
      sessionId: "running-a",
      sessionPath: "/tmp/a",
      commandId: "a",
      epoch: 1,
    },
  });
  const view = renderWithI18n(createElement(App));
  try {
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(review).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledWith(
      "idle-b",
      "/tmp/b",
      expect.any(AbortSignal),
      expect.any(Object),
    );
    act(() => webStore.setState({ snapshot: { ...snapshot, cursor: 2 } }));
    await act(async () => vi.advanceTimersByTimeAsync(2_100));
    expect(review).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    start.mockRestore();
    stop.mockRestore();
    review.mockRestore();
    webStore.setState(original, true);
  }
});

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
    const viewport = view.container.querySelector<HTMLElement>(
      '.conversation[role="log"]',
    )!;
    await act(async () => fireEvent.wheel(viewport, { deltaY: -100 }));
    expect(screen.getByText("Earlier answer")).toBeTruthy();
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

function renderEditableTranscript(
  onResend: (content: string) => Promise<boolean> = vi.fn(async () => false),
) {
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  snapshot.selectedSession!.entries = [
    projectEntry({
      type: "message",
      id: "saved-edit",
      parentId: null,
      timestamp: "2026-10-02T00:00:00Z",
      message: { role: "user", content: "Original message", timestamp: 1 },
    }),
  ];
  return renderWithI18n(
    createElement(Transcript, {
      snapshot,
      liveMessages: [],
      liveRunning: false,
      livePhase: "idle",
      liveRetry: null,
      thinkingStarts: {},
      thinkingDurations: {},
      scrollToBottom: 0,
      onResend,
      onEdit: (_anchor, content) => onResend(content),
      forkAvailable: true,
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

it("restores the same native entry offset after leaving a Session, without sharing it with a copied path", () => {
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  snapshot.selectedSession!.history = {
    leafEntryId: "e3",
    beforeEntryId: "e2",
  };
  snapshot.selectedSession!.entries = [
    {
      id: "e2",
      type: "message",
      timestamp: snapshot.generatedAt,
      message: { role: "user", content: "Read this prompt" },
    },
    {
      id: "e3",
      parentId: "e2",
      type: "message",
      timestamp: snapshot.generatedAt,
      message: { role: "assistant", content: "Read this answer" },
    },
  ];
  const cache: SessionReadingCache = new Map();
  let returned = false;
  const bounds = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("conversation"))
        return new DOMRect(0, 10, 300, 100);
      if (this.dataset.historyEntry === "e2") {
        const scrollTop = this.closest(".conversation")?.scrollTop ?? 0;
        return new DOMRect(0, (returned ? 200 : 155) - scrollTop, 300, 50);
      }
      return new DOMRect();
    });
  const scrollHeight = vi
    .spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockReturnValue(1000);
  const clientHeight = vi
    .spyOn(HTMLElement.prototype, "clientHeight", "get")
    .mockReturnValue(100);
  const originalScroll = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollTo",
  );
  const scroll = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
    this.scrollTop = options.top ?? 0;
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: scroll,
  });
  const node = (path = snapshot.selectedSession!.path, scrollToBottom = 0) =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Transcript, {
        key: path,
        snapshot: {
          ...snapshot,
          selectedSession: { ...snapshot.selectedSession!, path },
        },
        readingCache: cache,
        liveMessages: [],
        liveRunning: false,
        livePhase: "idle",
        liveRetry: null,
        thinkingStarts: {},
        thinkingDurations: {},
        scrollToBottom,
        onResend: async () => true,
      }),
    );
  try {
    const view = render(node());
    const viewport =
      view.container.querySelector<HTMLElement>(".conversation")!;
    viewport.scrollTop = 150;
    fireEvent.scroll(viewport);
    view.rerender(node("/tmp/copied-session"));
    expect(
      view.container.querySelector<HTMLElement>(".conversation")!.scrollTop,
    ).toBe(1000);
    const saved = cache.get(sessionReadingScope(snapshot.selectedSession))!;
    expect(saved.window?.anchor).toBe("e3");
    expect(saved.position).toMatchObject({
      key: "e2",
      entryId: "e2",
      offset: -5,
      scrollTop: 150,
      pinned: false,
    });
    returned = true;
    view.rerender(node());
    expect(
      view.container.querySelector<HTMLElement>(".conversation")!.scrollTop,
    ).toBe(195);
    expect(
      screen.getByRole("button", { name: i18n.t("jumpToLatest") }),
    ).toBeTruthy();
    view.rerender(node(snapshot.selectedSession!.path, 1));
    expect(
      view.container.querySelector<HTMLElement>(".conversation")!.scrollTop,
    ).toBe(1000);
    expect(cache.has(sessionReadingScope(snapshot.selectedSession))).toBe(
      false,
    );
    view.unmount();
  } finally {
    bounds.mockRestore();
    scrollHeight.mockRestore();
    clientHeight.mockRestore();
    if (originalScroll)
      Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScroll);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  }
});

it("keeps the App reader through switching and trajectory without transferring it to another Session", () => {
  const original = webStore.getState();
  const start = vi
    .spyOn(original.actions, "start")
    .mockImplementation(() => {});
  const stop = vi.spyOn(original.actions, "stop").mockImplementation(() => {});
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  snapshot.selectedSession!.entries = [
    {
      id: "e1",
      type: "message",
      timestamp: snapshot.generatedAt,
      message: { role: "user", content: "Reader A" },
    },
  ];
  snapshot.selectedSession!.history = {
    leafEntryId: "e1",
    beforeEntryId: null,
  };
  snapshot.sessions = [
    {
      id: "session",
      path: "/tmp/session",
      cwd: "/tmp",
      created: snapshot.generatedAt,
      modified: snapshot.generatedAt,
      messageCount: 1,
      firstMessage: "Reader A",
      source: "web-session",
      origin: "web",
      controller: "web",
      readOnly: false,
    },
  ];
  const scrollHeight = vi
    .spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockReturnValue(1000);
  const clientHeight = vi
    .spyOn(HTMLElement.prototype, "clientHeight", "get")
    .mockReturnValue(100);
  const originalScroll = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollTo",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = options.top ?? 0;
    },
  });
  try {
    webStore.setState({
      snapshot,
      selectedPath: "/tmp/session",
      selectedWorkspace: "/tmp",
      workspaceDraft: false,
      sessionSwitching: false,
      connection: "connected",
      liveRunning: false,
      liveMessages: [],
    });
    const view = render(createElement(Providers, null, createElement(App)));
    const scroller = () =>
      view.container.querySelector<HTMLElement>(".conversation")!;
    scroller().scrollTop = 180;
    fireEvent.scroll(scroller());
    fireEvent.click(screen.getByRole("button", { name: i18n.t("trajectory") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("chatView") }));
    expect(scroller().scrollTop).toBe(180);
    act(() =>
      webStore.setState({ sessionSwitching: true, selectedPath: "/tmp/other" }),
    );
    act(() =>
      webStore.setState({
        sessionSwitching: false,
        snapshot: {
          ...snapshot,
          selectedSession: {
            ...snapshot.selectedSession!,
            id: "other",
            path: "/tmp/other",
          },
        },
      }),
    );
    expect(scroller().scrollTop).toBe(1000);
    act(() =>
      webStore.setState({
        sessionSwitching: true,
        selectedPath: "/tmp/session",
      }),
    );
    act(() => webStore.setState({ sessionSwitching: false, snapshot }));
    expect(scroller().scrollTop).toBe(180);
    for (const id of ["C", "D", "E", "F"]) {
      act(() =>
        webStore.setState({
          selectedPath: `/tmp/${id}`,
          snapshot: {
            ...snapshot,
            selectedSession: {
              ...snapshot.selectedSession!,
              id,
              path: `/tmp/${id}`,
            },
          },
        }),
      );
    }
    act(() => webStore.setState({ selectedPath: "/tmp/session", snapshot }));
    expect(scroller().scrollTop).toBe(180);
    view.unmount();
  } finally {
    webStore.setState(original, true);
    start.mockRestore();
    stop.mockRestore();
    scrollHeight.mockRestore();
    clientHeight.mockRestore();
    if (originalScroll)
      Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScroll);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  }
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

it("shows Pi's queued messages above the composer after reload and in a background session", () => {
  const snapshot = activeSnapshot();
  const selected = snapshot.selectedSession!;
  const firstMessage = `First follow-up ${"x".repeat(90)} complete queued text`;
  snapshot.currentSessionId = "another-session";
  snapshot.selectedExecution = {
    sessionId: selected.id,
    sessionPath: selected.path,
    status: "running",
    pendingFollowUps: 2,
    queuedMessages: [firstMessage, ""],
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
  expect(queued.closest("form.composer")).toBeNull();
  expect(queued.querySelector("ol")).toBeNull();
  expect(queued.textContent).toContain("First follow-up");
  expect(queued.textContent).toContain(i18n.t("queuedImage"));
  expect(
    screen.getByRole("button", {
      name: `${i18n.t("queuedMessageExpand")}: ${i18n.t("queuedImage")}`,
    }),
  ).toBeTruthy();
  const first = screen.getByRole("button", {
    name: /First follow-up/,
  });
  expect(first.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(first);
  expect(
    screen
      .getByRole("button", {
        name: `${i18n.t("queuedMessageCollapse")}: ${firstMessage}`,
      })
      .getAttribute("aria-expanded"),
  ).toBe("true");
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
  expect(
    view.container.querySelector<HTMLDetailsElement>(
      ".process-sequence.single-process",
    )?.open,
  ).toBe(true);
});

it("keeps completed groups collapsed independently of the thinking preference", () => {
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
    {
      id: "result-2",
      type: "message",
      timestamp: "2026-09-19T00:00:03Z",
      message: {
        role: "toolResult",
        toolName: "read",
        toolCallId: "read-2",
        content: "package configuration",
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
    view.container.querySelector<HTMLDetailsElement>(
      ".process-sequence:not(.single-process)",
    )?.open,
  ).toBe(false);
  expect(
    view.container.querySelector<HTMLDetailsElement>(".thinking-line")?.open,
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

it("loads archived history even when its workspace summary was omitted", async () => {
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
  const read = vi
    .spyOn(WebClient.prototype, "listArchivedSessions")
    .mockResolvedValue({
      sessions: snapshot.sessions,
      truncation: {
        truncated: false,
        matchesOmitted: 0,
        recordsUnscanned: 0,
        maxPageSize: 100,
        maxScanned: 2000,
      },
    });
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
  expect(await screen.findByText("Archived work")).toBeTruthy();
  expect(screen.getAllByText("/omitted").length).toBeGreaterThan(0);
  expect(read).toHaveBeenCalledWith(
    { query: "", limit: 25 },
    expect.any(AbortSignal),
  );
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
  read.mockRestore();
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

  const trigger = screen.getByRole("button", {
    name: "provider-alpha/model-a",
  });
  expect(within(trigger).getByText("model-a", { exact: true })).toBeTruthy();
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
  return `${i18n.t("configureModels")}, ${i18n.t("thinkingLevel")}: ${level}`;
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
    expect(container.querySelector(".model-picker-thinking")).toBeNull();
  });

  it("keeps model selection available without a separate unsupported thinking control", () => {
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
      name: i18n.t("configureModels"),
    });
    expect(picker.disabled).toBe(false);
    expect(container.querySelector(".model-picker-thinking")).toBeNull();
    fireEvent.click(picker);
    expect(screen.getByRole("dialog")).toBeTruthy();
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
      container.querySelector(".model-picker-wrap")?.getAttribute("title"),
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
      container.querySelector(".model-picker-wrap")?.getAttribute("title"),
    ).toBe(i18n.t("thinkingLockedRunning"));
  });

  it("opens a slider with the native supported range and confirmed level", () => {
    renderWithI18n(
      createElement(Composer, thinkingProps(idleThinkingSnapshot())),
    );
    const picker = screen.getByRole<HTMLButtonElement>("button", {
      name: thinkingPickerName("medium"),
    });
    expect(picker.disabled).toBe(false);
    expect(picker.textContent).toContain("Medium");
    fireEvent.click(picker);
    expect(
      screen.getByRole("dialog", { name: thinkingPickerName("medium") }),
    ).toBeTruthy();
    const slider = screen.getByRole<HTMLInputElement>("slider", {
      name: i18n.t("thinkingLevel"),
    });
    expect(slider.value).toBe("3");
    expect(slider.max).toBe("4");
    expect(slider.getAttribute("aria-valuetext")).toBe("Medium");
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
      const slider = screen.getByRole("slider", {
        name: i18n.t("thinkingLevel"),
      });
      fireEvent.change(slider, { target: { value: "3" } });
      fireEvent.pointerUp(slider);
      expect(client.thinkings).toEqual([]);
      expect(selectThinking).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.change(slider, { target: { value: "4" } });
        fireEvent.pointerUp(slider);
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

  it("discards an unfinished slider edit when the session controller changes", () => {
    const snapshot = idleThinkingSnapshot();
    const props = thinkingProps(snapshot);
    const selectThinking = vi.fn();
    props.actions = { ...props.actions, selectThinking };
    const view = renderWithI18n(createElement(Composer, props));
    fireEvent.click(
      screen.getByRole("button", { name: thinkingPickerName("medium") }),
    );
    const slider = screen.getByRole("slider", {
      name: i18n.t("thinkingLevel"),
    });
    fireEvent.change(slider, { target: { value: "4" } });
    expect(slider.getAttribute("aria-valuetext")).toBe("High");
    view.rerender(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(Composer, {
          ...props,
          snapshot: { ...snapshot, currentSessionId: "another-session" },
        }),
      ),
    );
    fireEvent.pointerUp(slider);
    expect(selectThinking).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a pending picker interactive while the send button is disabled", () => {
    const snapshot = idleThinkingSnapshot();
    const props = thinkingProps(snapshot);
    const view = renderWithI18n(
      createElement(Composer, { ...props, thinkingPendingLevel: "high" }),
    );
    const picker = screen.getByRole<HTMLButtonElement>("button", {
      name: /Thinking level: high/u,
    });
    expect(picker.disabled).toBe(false);
    expect(
      view.container
        .querySelector(".model-picker-wrap")
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
        .querySelector(".model-picker-wrap")
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
  const selectModel = vi.fn(async (_value: string) => true);
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
  expect(searchModels).toHaveBeenCalledTimes(1);
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

it("retains an over-limit draft, explains the exact trimmed limit, and sends nothing", async () => {
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  const store = createWebStore();
  const send = vi.fn(async () => false);
  const view = renderWithI18n(
    createElement(Composer, {
      ...thinkingProps(snapshot),
      actions: { ...store.getState().actions, sendPrompt: send },
    }),
  );
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: i18n.t("describeTask"),
  });
  const content = "\ud83d\ude42".repeat(WEB_PROMPT_MAX_TEXT_LENGTH / 2 + 1);
  fireEvent.change(input, { target: { value: `  ${content}  ` } });
  expect(input.value).toBe(`  ${content}  `);
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByRole("alert").textContent).toBe(
    i18n.t("promptTooLong", {
      count: content.length,
      limit: WEB_PROMPT_MAX_TEXT_LENGTH,
    }),
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: i18n.t("send") })
      .disabled,
  ).toBe(true);
  fireEvent.submit(view.container.querySelector("form")!);
  expect(send).not.toHaveBeenCalled();

  const atLimit = `  ${"x".repeat(WEB_PROMPT_MAX_TEXT_LENGTH)}  `;
  fireEvent.change(input, { target: { value: atLimit } });
  expect(input.value).toBe(atLimit);
  expect(input.getAttribute("aria-invalid")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: i18n.t("send") })
      .disabled,
  ).toBe(false);
  await act(async () =>
    fireEvent.submit(view.container.querySelector("form")!),
  );
  expect(send).toHaveBeenCalledWith(atLimit);
});

it("retries only the original uncertain request and retains the current revised composer draft", async () => {
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  snapshot.sessions = [
    {
      ...snapshot.selectedSession!,
      source: "web-session",
      origin: "web",
      controller: "web",
      readOnly: false,
      created: snapshot.generatedAt,
      modified: snapshot.generatedAt,
      messageCount: 0,
      firstMessage: "",
    },
  ];
  const client = new WebClient();
  vi.spyOn(client, "snapshot").mockResolvedValue(snapshot);
  const receipt = deferred<{ id: string; accepted: boolean }>();
  const prompt = vi
    .spyOn(client, "prompt")
    .mockRejectedValueOnce(new TypeError("lost receipt"))
    .mockReturnValueOnce(receipt.promise);
  const store = createWebStore(client);
  await store.getState().actions.refreshSnapshot();
  function ConnectedComposer() {
    const state = useStore(store);
    return createElement(Composer, {
      ...thinkingProps(state.snapshot!, state.actions),
      selectedWorkspace: state.selectedWorkspace,
      promptAdmissionPending: state.promptAdmissionPending,
      promptAdmissionRecovery: state.promptAdmissionRecovery,
      promptAdmissionResolution: state.promptAdmissionResolution,
      liveRunning: state.liveRunning,
      activeTurn: state.activeTurn,
    });
  }
  try {
    const view = renderWithI18n(createElement(ConnectedComposer));
    const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: i18n.t("describeTask"),
    });
    fireEvent.change(input, { target: { value: "original" } });
    await act(async () =>
      fireEvent.submit(view.container.querySelector("form")!),
    );
    expect(prompt).toHaveBeenCalledOnce();
    expect(input.value).toBe("original");
    expect(store.getState().promptAdmissionRecovery?.retryable).toBe(true);
    fireEvent.change(input, { target: { value: "edited current draft" } });
    fireEvent.submit(view.container.querySelector("form")!);
    expect(prompt).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("retryOriginalAdmission") }),
    );
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(prompt.mock.calls[1]).toEqual([
      "session",
      "original",
      prompt.mock.calls[0]![2],
      "/tmp/session",
      true,
      [],
    ]);
    fireEvent.change(input, { target: { value: "edited again during retry" } });
    await act(async () =>
      receipt.resolve({ id: prompt.mock.calls[0]![2], accepted: true }),
    );
    expect(input.value).toBe("edited again during retry");
    expect(store.getState().promptAdmissionRecovery).toBeNull();
    expect(store.getState().promptAdmissionResolution).toBeNull();
    expect(store.getState().liveMessages).toHaveLength(1);
    expect(store.getState().liveMessages[0]!.message.content).toBe("original");
  } finally {
    store.getState().actions.stop();
  }
});

it.each([
  ["unchanged", "prompt_accepted"],
  ["retyped", "prompt_accepted"],
  ["edited", "prompt_accepted"],
  ["unchanged", "prompt_failed"],
  ["retyped", "prompt_failed"],
  ["edited", "prompt_failed"],
])(
  "settles a %s submission when recovery and late %s are batched into one render",
  async (revision, type) => {
    const snapshot = activeSnapshot();
    snapshot.runtime.status = "idle";
    snapshot.sessions = [
      {
        ...snapshot.selectedSession!,
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
        created: snapshot.generatedAt,
        modified: snapshot.generatedAt,
        messageCount: 0,
        firstMessage: "",
      },
    ];
    let stream!: EventStreamOptions;
    let loseReceipt!: (error: unknown) => void;
    const receipt = new Promise<{ id: string; accepted: boolean }>(
      (_resolve, reject) => {
        loseReceipt = reject;
      },
    );
    const client = new WebClient();
    const prompt = vi.spyOn(client, "prompt").mockReturnValue(receipt);
    vi.spyOn(client, "snapshot")
      .mockResolvedValueOnce(snapshot)
      .mockImplementationOnce(async () => {
        stream.onEvent({
          protocolVersion: 1,
          sequence: 2,
          timestamp: snapshot.generatedAt,
          type,
          detail: {
            sessionId: "session",
            sessionPath: "/tmp/session",
            commandId: prompt.mock.calls[0]![2],
            error: "Native execution failed",
          },
        });
        return snapshot;
      })
      .mockResolvedValue(snapshot);
    const store = createWebStore(client, {
      consumeEvents: (options) => {
        stream = options;
        options.onConnected();
        return new Promise<void>((resolve) =>
          options.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
      },
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();
    function ConnectedComposer() {
      const state = useStore(store);
      return createElement(Composer, {
        ...thinkingProps(state.snapshot!, state.actions),
        selectedWorkspace: state.selectedWorkspace,
        promptAdmissionPending: state.promptAdmissionPending,
        promptAdmissionRecovery: state.promptAdmissionRecovery,
        promptAdmissionResolution: state.promptAdmissionResolution,
      });
    }
    try {
      const view = renderWithI18n(createElement(ConnectedComposer));
      const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: i18n.t("describeTask"),
      });
      fireEvent.change(input, { target: { value: "original" } });
      fireEvent.submit(view.container.querySelector("form")!);
      expect(prompt).toHaveBeenCalledOnce();
      if (revision !== "unchanged") {
        fireEvent.change(input, { target: { value: "edited" } });
        if (revision === "retyped")
          fireEvent.change(input, { target: { value: "original" } });
      }
      await act(async () => loseReceipt(new TypeError("lost receipt")));
      expect(store.getState().promptAdmissionRecovery).toBeNull();
      expect(store.getState().promptAdmissionResolution).toBeNull();
      if (type === "prompt_failed")
        expect(store.getState().notice).toBe("Native execution failed");
      expect(input.value).toBe(
        revision === "unchanged"
          ? ""
          : revision === "retyped"
            ? "original"
            : "edited",
      );
      expect(prompt).toHaveBeenCalledOnce();
    } finally {
      store.getState().actions.stop();
    }
  },
);

it("does not lend a rejected composer submission's revision to an external admission", async () => {
  const snapshot = activeSnapshot();
  snapshot.runtime.status = "idle";
  const actions = {
    ...createWebStore().getState().actions,
    sendPrompt: vi.fn(async () => false),
  };
  const props = thinkingProps(snapshot, actions);
  const view = renderWithI18n(createElement(Composer, props));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: i18n.t("describeTask"),
  });
  fireEvent.change(input, { target: { value: "unrelated rejected draft" } });
  await act(async () =>
    fireEvent.submit(view.container.querySelector("form")!),
  );
  const recovery = {
    sessionId: "session",
    sessionPath: "/tmp/session",
    commandId: "external-setup-card",
    optimisticKey: "optimistic-external-setup-card",
    content: "/openpi-setup repair",
    phase: "ready" as const,
    retryable: true,
  };
  view.rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, { ...props, promptAdmissionRecovery: recovery }),
    ),
  );
  expect(input.value).toBe("unrelated rejected draft");
  view.rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, {
        ...props,
        promptAdmissionResolution: {
          sessionId: recovery.sessionId,
          sessionPath: recovery.sessionPath,
          commandId: recovery.commandId,
          content: recovery.content,
        },
      }),
    ),
  );
  expect(input.value).toBe("unrelated rejected draft");
});

it.each([
  ["abandon", "unchanged"],
  ["abandon", "edited"],
  ["abandon", "retyped"],
  ["cached-rejection", "unchanged"],
  ["cached-rejection", "edited"],
  ["cached-rejection", "retyped"],
  ["navigation", "unchanged"],
  ["navigation", "edited"],
  ["navigation", "retyped"],
])(
  "settles the next %s submission with a %s revision despite a previous recovery capture",
  async (previous, revision) => {
    const snapshot = activeSnapshot();
    snapshot.runtime.status = "idle";
    const send = vi.fn(async () => false);
    const abandon = vi.fn();
    const retry = vi.fn(async () => false);
    const acknowledge = vi.fn();
    const props = thinkingProps(snapshot, {
      ...createWebStore().getState().actions,
      sendPrompt: send,
      abandonPromptAdmission: abandon,
      retryPromptAdmission: retry,
      acknowledgePromptAdmissionResolution: acknowledge,
    });
    const view = renderWithI18n(createElement(Composer, props));
    let input = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: i18n.t("describeTask"),
    });
    fireEvent.change(input, { target: { value: "first X" } });
    await act(async () =>
      fireEvent.submit(view.container.querySelector("form")!),
    );
    const recovery = {
      sessionId: "session",
      sessionPath: "/tmp/session",
      commandId: "X",
      optimisticKey: "optimistic-X",
      content: "first X",
      retryable: true,
      phase: "ready" as const,
    };
    view.rerender(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(Composer, {
          ...props,
          promptAdmissionRecovery: recovery,
        }),
      ),
    );
    if (previous === "cached-rejection") {
      await act(async () =>
        fireEvent.click(
          screen.getByRole("button", {
            name: i18n.t("retryOriginalAdmission"),
          }),
        ),
      );
      expect(retry).toHaveBeenCalledExactlyOnceWith();
    } else {
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("abandonAdmission") }),
      );
      expect(abandon).toHaveBeenCalledOnce();
    }
    view.rerender(
      createElement(I18nextProvider, { i18n }, createElement(Composer, props)),
    );
    expect(input.value).toBe("first X");

    fireEvent.change(input, { target: { value: "second Y" } });
    await act(async () =>
      fireEvent.submit(view.container.querySelector("form")!),
    );
    expect(send).toHaveBeenCalledTimes(2);
    if (previous === "navigation") {
      const other = {
        ...snapshot,
        currentSessionId: "other",
        currentSessionPath: "/tmp/other",
        selectedSession: {
          ...snapshot.selectedSession!,
          id: "other",
          path: "/tmp/other",
        },
      };
      view.rerender(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(Composer, { ...props, snapshot: other }),
        ),
      );
      expect(
        screen.getByRole<HTMLTextAreaElement>("textbox", {
          name: i18n.t("describeTask"),
        }).value,
      ).toBe("");
      view.rerender(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(Composer, props),
        ),
      );
      input = screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: i18n.t("describeTask"),
      });
      expect(input.value).toBe("second Y");
    }
    if (revision !== "unchanged") {
      fireEvent.change(input, { target: { value: "third revision" } });
      if (revision === "retyped")
        fireEvent.change(input, { target: { value: "second Y" } });
    }
    view.rerender(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(Composer, {
          ...props,
          promptAdmissionResolution: {
            sessionId: "session",
            sessionPath: "/tmp/session",
            commandId: "Y",
            content: "second Y",
            images: [],
          },
        }),
      ),
    );
    expect(input.value).toBe(
      revision === "unchanged"
        ? ""
        : revision === "retyped"
          ? "second Y"
          : "third revision",
    );
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith("Y");
  },
);

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
  "clears only an unchanged recovered draft when late evidence arrives (%j)",
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
            sessionId: "session",
            sessionPath: snapshot.selectedSession!.path,
            commandId: "unknown-command",
            content: "keep this draft",
          },
        }),
      ),
    );

    expect(input.value).toBe(draft === "keep this draft" ? "" : draft);
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
          sessionId: "session",
          sessionPath: snapshot.selectedSession!.path,
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
    currentSessionPath: "/tmp/created-session",
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
        createdSession: {
          epoch: 1,
          sessionId: "created-session",
          sessionPath: "/tmp/created-session",
          workspacePath: "/tmp",
        },
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
