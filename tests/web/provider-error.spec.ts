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
import { projectMessage, type WebSnapshot } from "../../web/protocol/types.ts";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(cleanup);

function snapshot(message: ReturnType<typeof projectMessage>): WebSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: "2026-09-19T00:00:00Z",
    cursor: 1,
    preferences: { theme: "system" },
    currentSessionId: "session",
    sessions: [],
    workspaces: [],
    models: [],
    selectedSession: {
      id: "session",
      path: "/tmp/session.jsonl",
      cwd: "/tmp",
      entries: [
        {
          type: "message",
          id: "error",
          timestamp: "2026-09-19T00:00:00Z",
          message,
        },
      ],
      bytes: 0,
      truncation: {
        truncated: false,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
        maxBytes: 2 * 1024 * 1024,
      },
    },
    runtime: { status: "idle", capabilities: {} },
    truncation: {
      truncated: false,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
      modelsOmitted: 0,
      maxBytes: 4 * 1024 * 1024,
      bytes: 0,
    },
  };
}

function show(
  message: ReturnType<typeof projectMessage>,
  liveMessages: Array<{
    key: string;
    message: ReturnType<typeof projectMessage>;
  }> = [],
) {
  return render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Transcript, {
        snapshot: snapshot(message),
        liveMessages,
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

it("renders a persisted provider error with no body after refresh", () => {
  show(
    projectMessage({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "gateway_concurrency_limit (429)",
    }),
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "gateway_concurrency_limit (429)",
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "Model request failed",
  );
  expect(screen.queryByRole("button", { name: "Retry prompt" })).toBeNull();
});

it("retries the user prompt from its provider failure", async () => {
  let finish!: (value: boolean) => void;
  const onResend = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const state = snapshot(
    projectMessage({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "provider capacity reached",
    }),
  );
  state.selectedSession?.entries.unshift({
    type: "message",
    id: "user",
    timestamp: "2026-09-19T00:00:00Z",
    message: projectMessage({ role: "user", content: "Try this task" }),
  });
  state.selectedSession?.entries.unshift(
    {
      type: "message",
      id: "old-user",
      timestamp: "2026-09-18T23:59:58Z",
      message: projectMessage({ role: "user", content: "Old task" }),
    },
    {
      type: "message",
      id: "old-error",
      timestamp: "2026-09-18T23:59:59Z",
      message: projectMessage({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "old failure",
      }),
    },
  );
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Transcript, {
        snapshot: state,
        liveMessages: [],
        liveRunning: false,
        livePhase: "idle",
        liveRetry: null,
        thinkingStarts: {},
        thinkingDurations: {},
        scrollToBottom: 0,
        onResend,
      }),
    ),
  );

  const retry = screen.getByRole<HTMLButtonElement>("button", {
    name: "Retry prompt",
  });
  expect(screen.getAllByRole("button", { name: "Retry prompt" })).toHaveLength(
    1,
  );
  fireEvent.click(retry);
  expect(onResend).toHaveBeenCalledWith("Try this task");
  expect(retry.disabled).toBe(true);
  finish(true);
  await waitFor(() => expect(retry.disabled).toBe(false));
});

it("does not drop a new failed response with the same partial text as a saved answer", () => {
  show(projectMessage({ role: "assistant", content: "same text" }), [
    {
      key: "live-error",
      message: projectMessage({
        role: "assistant",
        content: "same text",
        stopReason: "error",
        errorMessage: "provider capacity reached",
      }),
    },
  ]);
  expect(screen.getAllByText("same text")).toHaveLength(2);
  expect(screen.getByRole("alert").textContent).toContain(
    "provider capacity reached",
  );
});

it("keeps a partial answer and a distinct cancelled terminal state", () => {
  show(
    projectMessage({
      role: "assistant",
      content: [{ type: "text", text: "partial answer" }],
      stopReason: "aborted",
    }),
  );
  expect(screen.getByText("partial answer")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain(
    "Model request stopped",
  );
  expect(screen.queryByRole("alert")).toBeNull();
});
