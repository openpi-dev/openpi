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
    currentSessionPath: "/tmp/session.jsonl",
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

function error(reason: string) {
  return projectMessage({
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: reason,
  });
}

function turnSnapshot(messages: ReturnType<typeof projectMessage>[]) {
  const state = snapshot(messages[0]!);
  state.selectedSession!.entries = messages.map((message, index) => ({
    id: `entry-${index}`,
    type: "message",
    timestamp: `2026-09-19T00:00:0${index}Z`,
    message,
  }));
  return state;
}

function transcriptNode(
  state: WebSnapshot,
  options: Partial<Parameters<typeof Transcript>[0]> = {},
) {
  return createElement(
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
      onResend: async () => true,
      ...options,
    }),
  );
}

it("keeps recovered failed attempts folded after refreshing a successful run", () => {
  const state = turnSnapshot([
    projectMessage({ role: "user", content: "Run once" }),
    error("first 502"),
    error("second 502"),
    error("third 502"),
    projectMessage({
      role: "assistant",
      content: "Recovered answer",
      stopReason: "stop",
    }),
  ]);
  const { container } = render(transcriptNode(state));
  expect(screen.getByText("Recovered answer")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry prompt" })).toBeNull();
  expect(container.querySelector(".turn-state.failed")).toBeNull();
  const attempts =
    container.querySelector<HTMLDetailsElement>(".provider-attempts")!;
  expect(attempts.open).toBe(false);
  expect(attempts.querySelector("summary")?.textContent).toContain(
    "Request recovered",
  );
  expect(attempts.querySelector("summary")?.textContent).toContain("3");
  fireEvent.click(attempts.querySelector("summary")!);
  expect(attempts.open).toBe(true);
  expect(
    [...attempts.querySelectorAll("li")].map((item) => item.textContent),
  ).toEqual(["first 502", "second 502", "third 502"]);
});

it("updates the failed attempt projection during retry and live recovery without offering resend", () => {
  const state = turnSnapshot([
    projectMessage({ role: "user", content: "Run once" }),
    error("transient 502"),
  ]);
  const { container, rerender } = render(
    transcriptNode(state, {
      liveRunning: true,
      livePhase: "running",
      liveRetry: { attempt: 1, maxAttempts: 3 },
    }),
  );
  expect(container.querySelector(".provider-attempts.retrying")).toBeTruthy();
  expect(
    container.querySelector(".provider-attempts summary")?.textContent,
  ).toBe("Reconnecting 1/3");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry prompt" })).toBeNull();
  expect(container.querySelector(".turn-state.failed")).toBeNull();
  rerender(
    transcriptNode(state, {
      liveRunning: true,
      livePhase: "running",
      liveMessages: [
        {
          key: "success",
          message: projectMessage({
            role: "assistant",
            content: "Live success",
            stopReason: "stop",
          }),
        },
      ],
    }),
  );
  expect(container.querySelector(".provider-attempts.recovered")).toBeTruthy();
  expect(screen.getByText("Live success")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry prompt" })).toBeNull();
});

it("restores an inline native reconnect row after refresh, reveals its reason, and freezes on a Web disconnect", () => {
  const reason =
    "stream disconnected before completion: stream closed before response.completed";
  const state = turnSnapshot([
    projectMessage({ role: "user", content: "Run once" }),
    error(reason),
  ]);
  state.selectedExecution = {
    sessionId: "session",
    sessionPath: "/tmp/session.jsonl",
    status: "running",
    liveTools: [],
    liveToolsOmitted: 0,
    retry: { attempt: 1, maxAttempts: 5, errorMessage: reason },
  };
  const { container, rerender } = render(transcriptNode(state));
  const row =
    container.querySelector<HTMLDetailsElement>(".provider-attempts")!;
  expect(container.querySelectorAll(".provider-attempts")).toHaveLength(1);
  expect(row.open).toBe(false);
  expect(row.querySelector("summary")?.textContent).toBe("Reconnecting 1/5");
  expect(row.querySelector("summary > svg.lucide-wifi")).toBeTruthy();
  expect(row.classList.contains("provider-outcome")).toBe(false);
  fireEvent.click(row.querySelector("summary")!);
  expect(row.open).toBe(true);
  expect(row.querySelector("li")?.textContent).toBe(reason);
  rerender(transcriptNode(state, { activityObserved: false }));
  expect(row.querySelector("summary")?.textContent).toBe(
    "Reconnection status unconfirmed 1/5",
  );
  expect(row.open).toBe(true);
  rerender(transcriptNode(state));
  expect(row.querySelector("summary")?.textContent).toBe("Reconnecting 1/5");
  state.selectedExecution.retry = {
    attempt: 2,
    maxAttempts: 5,
    errorMessage: "second stream failure",
  };
  state.selectedSession!.entries.push({
    id: "second-error",
    type: "message",
    timestamp: "2026-09-19T00:00:03Z",
    message: error("second stream failure"),
  });
  rerender(transcriptNode({ ...state }));
  expect(container.querySelector(".provider-attempts")).toBe(row);
  expect(row.open).toBe(true);
  expect(row.querySelector("summary")?.textContent).toBe("Reconnecting 2/5");
  expect(row.querySelectorAll("li")).toHaveLength(2);
  state.selectedExecution.sessionPath = "/tmp/copied.jsonl";
  rerender(transcriptNode({ ...state }));
  expect(container.querySelector(".provider-attempts.retrying")).toBeNull();
});

it("does not invent retry limits or a reconnect phase from an incomplete model response", () => {
  const state = turnSnapshot([
    projectMessage({ role: "user", content: "Run once" }),
    error("temporary failure"),
  ]);
  const { container, rerender } = render(
    transcriptNode(state, { liveRunning: true, livePhase: "running" }),
  );
  expect(
    container.querySelector(".provider-attempts summary")?.textContent,
  ).toBe("Earlier request errors");
  state.selectedExecution = {
    sessionId: "session",
    sessionPath: "/tmp/session.jsonl",
    status: "running",
    liveTools: [],
    liveToolsOmitted: 0,
    retry: {},
  };
  rerender(transcriptNode(state));
  expect(
    container.querySelector(".provider-attempts summary")?.textContent,
  ).toBe("Reconnecting");
  state.selectedExecution.retry = undefined;
  rerender(
    transcriptNode({ ...state }, { liveRetry: { attempt: 3, maxAttempts: 5 } }),
  );
  expect(
    container.querySelector(".provider-attempts summary")?.textContent,
  ).toBe("Earlier request errors");
});

it("shows an observed native retry even when its failed message is outside the loaded history", () => {
  const state = turnSnapshot([
    projectMessage({ role: "user", content: "Run once" }),
  ]);
  state.selectedExecution = {
    sessionId: "session",
    sessionPath: "/tmp/session.jsonl",
    status: "running",
    liveTools: [],
    liveToolsOmitted: 0,
    retry: {
      attempt: 2,
      maxAttempts: 3,
      errorMessage: "native stream failure",
    },
  };
  const { container } = render(transcriptNode(state));
  expect(container.querySelectorAll(".provider-attempts")).toHaveLength(1);
  expect(
    container.querySelector(".provider-attempts summary")?.textContent,
  ).toBe("Reconnecting 2/3");
  expect(container.querySelector(".provider-attempts li")?.textContent).toBe(
    "native stream failure",
  );
});

it("does not mark completed tools as running while the model reconnects", () => {
  const state = turnSnapshot([
    projectMessage({ role: "user", content: "Run once" }),
    projectMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "read",
          name: "read",
          arguments: { path: "README.md" },
        },
        {
          type: "toolCall",
          id: "bash",
          name: "bash",
          arguments: { command: "node --test" },
        },
      ],
    }),
    projectMessage({
      role: "toolResult",
      toolCallId: "read",
      toolName: "read",
      content: "read output",
      isError: false,
    }),
    projectMessage({
      role: "toolResult",
      toolCallId: "bash",
      toolName: "bash",
      content: "passed",
      isError: false,
    }),
    error("temporary stream failure"),
  ]);
  state.selectedExecution = {
    sessionId: "session",
    sessionPath: "/tmp/session.jsonl",
    status: "running",
    liveTools: [],
    liveToolsOmitted: 0,
    retry: { attempt: 1, maxAttempts: 5 },
  };
  const { container } = render(transcriptNode(state));
  const group =
    container.querySelector<HTMLDetailsElement>(".process-sequence")!;
  expect(group.getAttribute("data-status")).toBe("done");
  expect(group.open).toBe(false);
  expect(group.querySelector(".status-mark.running")).toBeNull();
  expect(
    container.querySelector(".provider-attempts summary")?.textContent,
  ).toBe("Reconnecting 1/5");
});

it("offers one final retry after exhaustion while folding the earlier attempts", () => {
  const state = turnSnapshot([
    projectMessage({ role: "user", content: "Retry this task" }),
    error("first 502"),
    error("second 502"),
    error("exhausted 502"),
  ]);
  const { container } = render(transcriptNode(state));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert").textContent).toContain("exhausted 502");
  expect(screen.getAllByRole("button", { name: "Retry prompt" })).toHaveLength(
    1,
  );
  expect(container.querySelector(".turn-state.failed")).toBeTruthy();
  expect(container.querySelector(".provider-attempts li")?.textContent).toBe(
    "first 502",
  );
  expect(container.querySelectorAll(".provider-attempts li")).toHaveLength(2);
});

it("uses a persisted cancelled run to stop retry controls even without an aborted assistant", () => {
  const state = turnSnapshot([
    projectMessage({ role: "user", content: "Stopped task" }),
    error("502 before cancellation"),
  ]);
  state.selectedSession!.entries.push({
    id: "cancelled-timing",
    type: "custom",
    timestamp: "2026-09-19T00:00:02Z",
    turnTiming: {
      version: 1,
      sessionId: "session",
      commandId: "stopped",
      epoch: 1,
      startedAt: 0,
      finishedAt: 2000,
      elapsedMs: 2000,
      outcome: "cancelled",
    },
  });
  const { container } = render(transcriptNode(state));
  expect(
    container.querySelector(".provider-attempts.interrupted"),
  ).toBeTruthy();
  expect(
    container.querySelector(".provider-attempts summary")?.textContent,
  ).toContain("Model request stopped");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry prompt" })).toBeNull();
  expect(
    container.querySelector('.turn-duration[data-outcome="cancelled"]'),
  ).toBeTruthy();
});

it("does not let a new user turn erase a previous failure or retry the wrong prompt", () => {
  const state = turnSnapshot([
    projectMessage({ role: "user", content: "Earlier task" }),
    error("earlier final failure"),
    projectMessage({ role: "user", content: "Different task" }),
    projectMessage({
      role: "assistant",
      content: "Different success",
      stopReason: "stop",
    }),
  ]);
  const { container } = render(transcriptNode(state));
  expect(screen.getByRole("alert").textContent).toContain(
    "earlier final failure",
  );
  expect(screen.queryByRole("button", { name: "Retry prompt" })).toBeNull();
  expect(container.querySelector(".provider-attempts.recovered")).toBeNull();
});

it("does not treat a partial streaming answer as successful recovery", () => {
  const state = turnSnapshot([
    projectMessage({ role: "user", content: "Run once" }),
    error("transient 502"),
  ]);
  const { container } = render(
    transcriptNode(state, {
      liveRunning: true,
      livePhase: "running",
      liveMessages: [
        {
          key: "stream",
          message: projectMessage({ role: "assistant", content: "Partial" }),
        },
      ],
    }),
  );
  expect(container.querySelector(".provider-attempts.recovered")).toBeNull();
  expect(container.querySelector(".provider-attempts.retrying")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry prompt" })).toBeNull();
});

it("keeps partial output from failed attempts inside their disclosure after recovery", () => {
  const state = turnSnapshot([
    projectMessage({ role: "user", content: "Run once" }),
    projectMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Interrupted reasoning" },
        { type: "text", text: "Interrupted partial answer" },
      ],
      stopReason: "error",
      errorMessage: "stream disconnected",
    }),
    projectMessage({
      role: "assistant",
      content: "Complete answer",
      stopReason: "stop",
    }),
  ]);
  const { container } = render(transcriptNode(state));
  const partial = screen.getByText("Interrupted partial answer");
  const attempts = partial.closest<HTMLDetailsElement>(".provider-attempts")!;
  expect(attempts).toBeTruthy();
  expect(attempts.open).toBe(false);
  expect(attempts.textContent).toContain("Interrupted reasoning");
  expect(
    screen.getByText("Complete answer").closest(".provider-attempts"),
  ).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    container.querySelector('[data-history-highlighted="true"]'),
  ).toBeNull();
});
