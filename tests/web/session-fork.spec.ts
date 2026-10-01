// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import { useStore } from "zustand";
import { projectEntry, type WebSnapshot } from "../../web/protocol/types.ts";
import type { WebSessionForkResult } from "../../web/runtime/types.ts";
import { Composer } from "../../web/ui/src/features/composer/Composer.tsx";
import * as draftStorage from "../../web/ui/src/features/composer/composer-draft-storage.ts";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebApiError, WebClient } from "../../web/ui/src/protocol/client.ts";
import type { EventStreamOptions } from "../../web/ui/src/protocol/event-stream.ts";
import { createWebStore } from "../../web/ui/src/store/web-store.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const anchor = {
  sessionId: "source",
  sessionPath: "/project/source.jsonl",
  entryId: "first",
};
function snapshot(
  id = anchor.sessionId,
  path = anchor.sessionPath,
): WebSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: "2026-09-30T00:00:00Z",
    cursor: 1,
    preferences: { theme: "system" },
    currentSessionId: id,
    currentSessionPath: path,
    workspaces: [{ path: "/project", name: "Project", current: true }],
    sessions: [
      {
        id,
        path,
        cwd: "/project",
        created: "2026-09-30T00:00:00Z",
        modified: "2026-09-30T00:00:00Z",
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
        messageCount: 2,
        firstMessage: "Original question",
      },
    ],
    selectedSession: {
      id,
      path,
      cwd: "/project",
      entries: [
        projectEntry({
          type: "message",
          id: "first",
          parentId: null,
          timestamp: "2026-09-30T00:00:00Z",
          message: { role: "user", content: "Original question", timestamp: 1 },
        }),
        projectEntry({
          type: "message",
          id: "answer",
          parentId: "first",
          timestamp: "2026-09-30T00:00:00Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Original answer" }],
            api: "openai-completions",
            provider: "fixture",
            model: "fixture",
            stopReason: "stop",
            timestamp: 2,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          },
        }),
      ],
      bytes: 200,
      truncation: {
        truncated: false,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
        maxBytes: 2 * 1024 * 1024,
      },
      history: { leafEntryId: "answer", beforeEntryId: null },
    },
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation: {
      bytes: 0,
      maxBytes: 4 * 1024 * 1024,
      truncated: false,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
      modelsOmitted: 0,
    },
  };
}
function mount() {
  const client = new WebClient();
  const store = createWebStore(client);
  store.setState({
    snapshot: snapshot(),
    selectedPath: anchor.sessionPath,
    selectedWorkspace: "/project",
  });
  return { client, store };
}

function rerunChild() {
  const child = snapshot("child", "/project/child.jsonl");
  child.selectedSession!.entries = [];
  child.selectedSession!.history = { leafEntryId: null, beforeEntryId: null };
  child.selectedSession!.rerun = { source: anchor, mode: "edit" };
  return child;
}

it("edits an older saved question, confirms its native child, and sends the prepared full prompt through ordinary admission", async () => {
  const { client, store } = mount();
  const parent = snapshot();
  parent.selectedSession!.entries.push(
    projectEntry({
      type: "message",
      id: "later",
      parentId: "answer",
      timestamp: "2026-10-02T00:00:00Z",
      message: { role: "user", content: "Later question", timestamp: 3 },
    }),
  );
  store.setState({ snapshot: parent });
  const images = [
    {
      data: "iVBORw0KGgo=",
      mimeType: "image/png" as const,
      name: "original.png",
    },
  ];
  const fork = vi
    .spyOn(client, "forkSession")
    .mockImplementation(async (request) => ({
      state: "forked",
      commandId: request.commandId,
      source: anchor,
      sessionId: "child",
      sessionPath: "/project/child.jsonl",
      prompt: {
        content: "Revised question with complete file references",
        images,
      },
    }));
  vi.spyOn(client, "snapshot").mockResolvedValue(rerunChild());
  const prompt = vi
    .spyOn(client, "prompt")
    .mockImplementation(async (_id, _content, commandId) => ({
      id: commandId,
      accepted: true,
    }));
  const edit = store.getState().actions.editMessage;
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Transcript, {
        snapshot: parent,
        liveMessages: [],
        liveRunning: false,
        livePhase: "idle",
        liveRetry: null,
        thinkingStarts: {},
        thinkingDurations: {},
        scrollToBottom: 0,
        onResend: store.getState().actions.sendPrompt,
        onEdit: edit,
        onRegenerate: store.getState().actions.regenerateMessage,
        forkAvailable: true,
      }),
    ),
  );
  expect(
    screen.getAllByRole("button", { name: i18n.t("editMessage") }),
  ).toHaveLength(2);
  fireEvent.click(
    screen.getAllByRole("button", { name: i18n.t("editMessage") })[0]!,
  );
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Revised question" },
  });
  fireEvent.click(screen.getByRole("button", { name: i18n.t("confirmEdit") }));
  await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
  expect(fork).toHaveBeenCalledWith(
    expect.objectContaining({
      ...anchor,
      rerun: { mode: "edit", content: "Revised question" },
    }),
  );
  expect(prompt).toHaveBeenCalledWith(
    "child",
    "Revised question with complete file references",
    expect.any(String),
    "/project/child.jsonl",
    false,
    images,
  );
  expect(store.getState().notice).toEqual({
    kind: "success",
    message: i18n.t("messageRerunStarted"),
  });
});

it("regenerates a successful answer from its saved user prompt, while optimistic prompts and failed answers cannot offer rerun", async () => {
  const parent = snapshot();
  const regenerate = vi.fn(async () => true);
  const props = {
    snapshot: parent,
    liveMessages: [],
    liveRunning: false,
    livePhase: "idle" as const,
    liveRetry: null,
    thinkingStarts: {},
    thinkingDurations: {},
    scrollToBottom: 0,
    onResend: async () => true,
    onEdit: async () => true,
    onRegenerate: regenerate,
    forkAvailable: true,
  };
  const view = render(
    createElement(I18nextProvider, { i18n }, createElement(Transcript, props)),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("regenerateMessage") }),
  );
  expect(regenerate).toHaveBeenCalledExactlyOnceWith(anchor);
  parent.selectedSession!.entries = [];
  view.rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Transcript, {
        ...props,
        snapshot: { ...parent },
        liveMessages: [
          {
            key: "optimistic",
            message: { role: "user", content: "Pending question" },
            optimistic: {
              sessionId: anchor.sessionId,
              sessionPath: anchor.sessionPath,
              commandId: "pending",
              afterEntryId: null,
              admitted: false,
            },
          },
        ],
      }),
    ),
  );
  expect(
    screen.queryByRole("button", { name: i18n.t("editMessage") }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: i18n.t("regenerateMessage") }),
  ).toBeNull();
});

it("returns to the exact source message through native branch provenance", async () => {
  const open = vi.fn(async () => true);
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Transcript, {
        snapshot: rerunChild(),
        liveMessages: [],
        liveRunning: false,
        livePhase: "idle",
        liveRetry: null,
        thinkingStarts: {},
        thinkingDurations: {},
        scrollToBottom: 0,
        onResend: async () => true,
        onOpenOriginal: open,
      }),
    ),
  );
  fireEvent.click(
    screen.getByRole("button", { name: i18n.t("openOriginalConversation") }),
  );
  expect(open).toHaveBeenCalledExactlyOnceWith(anchor);
  expect(screen.getByText(i18n.t("messageRerunWorkspaceHint"))).toBeTruthy();
});

it("restores a rejected rerun's revised draft and original image in the new composer without describing rejection as uncertainty", async () => {
  vi.spyOn(draftStorage, "createBrowserComposerDraftStorage").mockReturnValue({
    read: async () => [],
    write: async () => undefined,
  });
  const { client, store } = mount();
  const images = [
    {
      data: "iVBORw0KGgo=",
      mimeType: "image/png" as const,
      name: "original.png",
    },
  ];
  vi.spyOn(client, "forkSession").mockImplementation(async (request) => ({
    state: "forked",
    commandId: request.commandId,
    source: anchor,
    sessionId: "child",
    sessionPath: "/project/child.jsonl",
    prompt: { content: "Keep this revised draft", images },
  }));
  vi.spyOn(client, "snapshot").mockResolvedValue(rerunChild());
  vi.spyOn(client, "prompt").mockRejectedValue(
    new WebApiError("Input hook rejected", 422, "PROMPT_REJECTED"),
  );
  function NewComposer() {
    const state = useStore(store);
    return createElement(
      I18nextProvider,
      { i18n },
      createElement(Composer, {
        snapshot: state.snapshot,
        selectedPath: state.selectedPath,
        selectedWorkspace: state.selectedWorkspace,
        sessionSwitching: state.sessionSwitching,
        promptAdmissionPending: state.promptAdmissionPending,
        promptAdmissionRecovery: state.promptAdmissionRecovery,
        restoredPromptDraft: state.restoredPromptDraft,
        thinkingPendingLevel: null,
        liveRunning: state.liveRunning,
        landing: false,
        activeTurn: null,
        turnCancellationPending: false,
        turnTerminalStatus: null,
        pendingFollowUpsReceipt: null,
        actions: state.actions,
      }),
    );
  }
  render(createElement(NewComposer));
  expect(
    await store
      .getState()
      .actions.editMessage(anchor, "Keep this revised draft"),
  ).toBe(false);
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLTextAreaElement>("textbox", {
        name: i18n.t("describeTask"),
      }).value,
    ).toBe("Keep this revised draft"),
  );
  expect(screen.getByText("original.png")).toBeTruthy();
  expect(store.getState().promptAdmissionRecovery).toBeNull();
  expect(screen.queryByText(i18n.t("promptAdmissionUnknown"))).toBeNull();
});

it("does not send prepared rerun content when the confirmed child has lost runtime authority", async () => {
  const { client, store } = mount();
  vi.spyOn(client, "forkSession").mockImplementation(async (request) => ({
    state: "forked",
    commandId: request.commandId,
    source: anchor,
    sessionId: "child",
    sessionPath: "/project/child.jsonl",
    prompt: { content: "Never send to another Session", images: [] },
  }));
  vi.spyOn(client, "snapshot").mockResolvedValue({
    ...rerunChild(),
    currentSessionId: "other",
    currentSessionPath: "/project/other.jsonl",
  });
  const prompt = vi.spyOn(client, "prompt");
  expect(await store.getState().actions.editMessage(anchor, "Revision")).toBe(
    false,
  );
  expect(prompt).not.toHaveBeenCalled();
  expect(store.getState().notice).toBe(i18n.t("forkSessionUncertain"));
});

it("forks the exact message into a new empty composer, preserves the original draft, and sends no prompt", async () => {
  vi.spyOn(draftStorage, "createBrowserComposerDraftStorage").mockReturnValue({
    read: async () => [],
    write: async () => undefined,
  });
  const { client, store } = mount();
  const fork = vi
    .spyOn(client, "forkSession")
    .mockImplementation(async (request) => ({
      state: "forked",
      commandId: request.commandId,
      source: anchor,
      sessionId: "child",
      sessionPath: "/project/child.jsonl",
    }));
  let confirmChild!: (value: WebSnapshot) => void;
  vi.spyOn(client, "snapshot").mockImplementation(
    () =>
      new Promise((done) => {
        confirmChild = done;
      }),
  );
  const prompt = vi.spyOn(client, "prompt");
  function Conversation() {
    const state = useStore(store);
    return createElement(
      I18nextProvider,
      { i18n },
      createElement(
        "div",
        null,
        createElement(Transcript, {
          snapshot: state.snapshot!,
          liveMessages: state.liveMessages,
          liveRunning: state.liveRunning,
          livePhase: state.livePhase,
          liveRetry: state.liveRetry,
          thinkingStarts: {},
          thinkingDurations: {},
          scrollToBottom: state.scrollToBottom,
          onResend: state.actions.sendPrompt,
          onFork: state.actions.forkMessage,
          forkAvailable: true,
          forkPending: state.sessionForkPending,
        }),
        createElement(Composer, {
          snapshot: state.snapshot,
          selectedPath: state.selectedPath,
          selectedWorkspace: state.selectedWorkspace,
          sessionSwitching: state.sessionSwitching,
          promptAdmissionPending: state.promptAdmissionPending,
          thinkingPendingLevel: null,
          liveRunning: state.liveRunning,
          landing: false,
          activeTurn: null,
          turnCancellationPending: false,
          turnTerminalStatus: null,
          pendingFollowUpsReceipt: null,
          actions: state.actions,
        }),
      ),
    );
  }
  render(createElement(Conversation));
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: i18n.t("describeTask"),
  });
  fireEvent.change(input, { target: { value: "Keep original draft" } });
  const button = screen.getAllByRole("button", {
    name: i18n.t("forkMessage"),
  })[0]!;
  expect(button.title).toBe(i18n.t("forkMessageHint"));
  fireEvent.click(button);
  await waitFor(() =>
    expect(store.getState().selectedPath).toBe("/project/child.jsonl"),
  );
  expect(store.getState().notice).toBeNull();
  expect(input.value).toBe("Keep original draft");
  confirmChild(snapshot("child", "/project/child.jsonl"));
  await waitFor(() => expect(input.value).toBe(""));
  expect(store.getState().notice).toEqual({
    kind: "success",
    message: i18n.t("forkSessionCreated"),
  });
  expect(fork).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(anchor));
  expect(prompt).not.toHaveBeenCalled();
  store.setState({ snapshot: snapshot(), selectedPath: anchor.sessionPath });
  await waitFor(() => expect(input.value).toBe("Keep original draft"));
  store.setState({ liveRunning: true });
  expect(await store.getState().actions.forkMessage(anchor)).toBe(false);
  expect(store.getState().notice).toBe(i18n.t("forkSessionUnavailable"));
});

it("keeps the source and reuses the command after an uncertain transport result", async () => {
  const { client, store } = mount();
  const fork = vi
    .spyOn(client, "forkSession")
    .mockRejectedValueOnce(new Error("connection lost"))
    .mockImplementation(async (request) => ({
      state: "cancelled",
      commandId: request.commandId,
      source: anchor,
    }));
  expect(await store.getState().actions.forkMessage(anchor)).toBe(false);
  expect(store.getState().selectedPath).toBe(anchor.sessionPath);
  expect(store.getState().notice).toBe(i18n.t("forkSessionUncertain"));
  expect(await store.getState().actions.forkMessage(anchor)).toBe(false);
  expect(fork.mock.calls[0]![0].commandId).toBe(
    fork.mock.calls[1]![0].commandId,
  );
  expect(store.getState().notice).toBe(i18n.t("forkSessionCancelled"));
});

it("does not fork a running Session and leaves a newer workspace selection untouched by a late receipt", async () => {
  const { client, store } = mount();
  let resolve!: (result: WebSessionForkResult) => void;
  const fork = vi.spyOn(client, "forkSession").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  store.setState({ liveRunning: true });
  expect(await store.getState().actions.forkMessage(anchor)).toBe(false);
  expect(fork).not.toHaveBeenCalled();
  store.setState({ liveRunning: false });
  const pending = store.getState().actions.forkMessage(anchor);
  const commandId = fork.mock.calls[0]![0].commandId;
  expect(await store.getState().actions.sendPrompt("Draft still here")).toBe(
    false,
  );
  store.getState().actions.setWorkspace("/other");
  resolve({
    state: "forked",
    commandId,
    source: anchor,
    sessionId: "child",
    sessionPath: "/project/child.jsonl",
  });
  expect(await pending).toBe(false);
  expect(store.getState().selectedWorkspace).toBe("/other");
  expect(store.getState().selectedPath).not.toBe("/project/child.jsonl");
});

it("offers a fresh command after a definite idle gate rejection", async () => {
  const { client, store } = mount();
  const fork = vi
    .spyOn(client, "forkSession")
    .mockRejectedValue(
      new WebApiError("busy", 409, "SESSION_FORK_UNAVAILABLE"),
    );
  await store.getState().actions.forkMessage(anchor);
  await store.getState().actions.forkMessage(anchor);
  expect(fork.mock.calls[0]![0].commandId).not.toBe(
    fork.mock.calls[1]![0].commandId,
  );
  expect(store.getState().notice).toBe(i18n.t("forkSessionUnavailable"));
});

it("accepts a fork receipt after its native switch event and ignores an older source refresh", async () => {
  const client = new WebClient();
  let events!: EventStreamOptions;
  const store = createWebStore(client, {
    consumeEvents: (options) => {
      events = options;
      options.onConnected();
      return new Promise<void>((done) => {
        options.signal.addEventListener("abort", () => done(), { once: true });
      });
    },
  });
  store.setState({
    snapshot: snapshot(),
    selectedPath: anchor.sessionPath,
    selectedWorkspace: "/project",
    cursor: 1,
  });
  let resolveFork!: (result: WebSessionForkResult) => void;
  const fork = vi.spyOn(client, "forkSession").mockImplementation(
    () =>
      new Promise((done) => {
        resolveFork = done;
      }),
  );
  let resolveSource!: (source: WebSnapshot) => void;
  const refresh = vi
    .spyOn(client, "snapshot")
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolveSource = done;
        }),
    )
    .mockResolvedValue(snapshot("child", "/project/child.jsonl"));
  store.getState().actions.start();
  try {
    const pending = store.getState().actions.forkMessage(anchor);
    const commandId = fork.mock.calls[0]![0].commandId;
    events.onEvent({
      protocolVersion: 1,
      sequence: 2,
      type: "session_switched",
      timestamp: "2026-09-30T00:00:00Z",
      detail: {
        commandId,
        sessionId: "child",
        sessionPath: "/project/child.jsonl",
      },
    });
    expect(store.getState().selectedPath).toBe(anchor.sessionPath);
    expect(store.getState().snapshot?.currentSessionId).toBeUndefined();
    expect(await store.getState().actions.sendPrompt("Keep this draft")).toBe(
      false,
    );
    resolveFork({
      state: "forked",
      commandId,
      source: anchor,
      sessionId: "child",
      sessionPath: "/project/child.jsonl",
    });
    expect(await pending).toBe(true);
    expect(refresh).toHaveBeenNthCalledWith(1, anchor.sessionPath);
    expect(refresh).toHaveBeenNthCalledWith(2, "/project/child.jsonl");
    resolveSource(snapshot());
    await Promise.resolve();
    expect(store.getState().selectedPath).toBe("/project/child.jsonl");
    expect(store.getState().snapshot?.currentSessionId).toBe("child");
    expect(store.getState().sessionForkPending).toBe(false);
  } finally {
    store.getState().actions.stop();
  }
});
