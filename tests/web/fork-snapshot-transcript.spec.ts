// @vitest-environment jsdom
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { cleanup, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it } from "vitest";
import {
  WEB_SESSION_FORK,
  WEB_SESSION_FORK_SNAPSHOT,
} from "../../web/protocol/session-fork.ts";
import { projectEntries, type WebSnapshot } from "../../web/protocol/types.ts";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

const timestamp = "2026-10-13T00:00:00.000Z";
const source = {
  sessionId: "source",
  sessionPath: "/tmp/source.jsonl",
  entryId: "source-call",
};
const captured = {
  kind: "persisted-prefix" as const,
  capturedAt: Date.parse(timestamp),
  interrupted: true,
};
const hiddenContext = "Hidden fork boundary instruction for the model.";

function nativeMessage(
  id: string,
  message: Extract<SessionEntry, { type: "message" }>["message"],
) {
  return { type: "message" as const, id, parentId: null, timestamp, message };
}

function prompt(id = "prompt", text = "Source prompt") {
  return nativeMessage(id, {
    role: "user",
    content: text,
    timestamp: Date.parse(timestamp),
  });
}

function boundary(entryId = "prompt") {
  return {
    type: "custom_message" as const,
    id: "fork-boundary",
    parentId: entryId,
    timestamp,
    customType: WEB_SESSION_FORK_SNAPSHOT,
    display: false,
    content: hiddenContext,
    details: { source: { ...source, entryId }, snapshot: captured },
  };
}

function pendingTool(name = "bash", marked = true) {
  return [
    prompt(),
    nativeMessage(
      "source-call",
      fauxAssistantMessage(
        [
          {
            type: "toolCall",
            id: "pending-tool",
            name,
            arguments: {
              command: "sleep 45",
              path: "file.txt",
              prompt: "Read the file",
            },
          },
        ],
        { stopReason: "toolUse" },
      ),
    ),
    nativeMessage("missing-result", {
      role: "toolResult",
      toolCallId: "pending-tool",
      toolName: name,
      isError: true,
      content: [
        {
          type: "text",
          text: "Snapshot boundary: this tool had no persisted result.",
        },
      ],
      timestamp: captured.capturedAt,
      ...(marked
        ? {
            details: {
              openpiForkSnapshot: {
                version: 1,
                source,
                snapshot: captured,
                toolCallId: "pending-tool",
              },
            },
          }
        : {}),
    }),
    boundary("source-call"),
  ];
}

function snapshot(entries: SessionEntry[], running = false): WebSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: timestamp,
    cursor: 1,
    preferences: { theme: "system" },
    currentSessionId: "child",
    currentSessionPath: "/tmp/child.jsonl",
    sessions: [],
    workspaces: [],
    models: [],
    runtime: { status: running ? "running" : "idle", capabilities: {} },
    truncation: {
      truncated: false,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
      modelsOmitted: 0,
      maxBytes: 1024,
      bytes: 0,
    },
    selectedSession: {
      id: "child",
      path: "/tmp/child.jsonl",
      cwd: "/tmp",
      ...projectEntries(entries),
    },
  };
}

function transcript(value: WebSnapshot) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(Transcript, {
      snapshot: value,
      liveMessages: [],
      liveRunning: value.runtime.status === "running",
      livePhase: value.runtime.status === "running" ? "running" : "idle",
      liveRetry: null,
      thinkingStarts: {},
      thinkingDurations: {},
      scrollToBottom: 0,
      onResend: async () => true,
    }),
  );
}

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

it.each(["en", "zh"])(
  "shows the native snapshot boundary as ready to continue in %s without inventing an outcome",
  async (language) => {
    await i18n.changeLanguage(language);
    const value = snapshot([prompt(), boundary()]);
    const before = JSON.stringify(value);
    const { container } = render(transcript(value));
    expect(screen.getByText(i18n.t("turnState_forked"))).toBeTruthy();
    expect(screen.queryByText(i18n.t("turnState_waiting"))).toBeNull();
    expect(
      container.querySelector(
        ".turn-state.running, .turn-state.failed, .turn-state.interrupted, [role=timer]",
      ),
    ).toBeNull();
    expect(container.textContent).not.toContain(hiddenContext);
    expect(JSON.stringify(value)).toBe(before);
  },
);

it("ordinary custom messages and fork metadata alone cannot settle a waiting prompt", () => {
  for (const entry of [
    { ...boundary(), customType: "ordinary-custom-message" },
    {
      ...boundary(),
      details: { source, snapshot: { ...captured, interrupted: false } },
    },
    { ...boundary(), display: true },
    {
      type: "custom" as const,
      id: "metadata",
      parentId: "prompt",
      timestamp,
      customType: WEB_SESSION_FORK,
      data: {
        version: 1,
        source,
        snapshot: captured,
        sessionId: "child",
        cwd: "/tmp",
        workspacePath: "/tmp",
        environment: "local",
      },
    },
  ]) {
    const { unmount } = render(transcript(snapshot([prompt(), entry])));
    expect(screen.queryByText(i18n.t("turnState_forked"))).toBeNull();
    expect(screen.getByText(i18n.t("turnState_waiting"))).toBeTruthy();
    unmount();
  }
});

it("seals only the inherited turn while a new child prompt runs and completes", () => {
  const entries = [prompt(), boundary()];
  const { container, rerender } = render(transcript(snapshot(entries)));
  const nextEntries = [...entries, prompt("child-prompt", "Continue here")];
  rerender(transcript(snapshot(nextEntries, true)));
  const turns = container.querySelectorAll<HTMLElement>(".conversation-turn");
  expect(turns).toHaveLength(2);
  expect(within(turns[0]!).getByText(i18n.t("turnState_forked"))).toBeTruthy();
  expect(within(turns[0]!).queryByText(i18n.t("turnState_running"))).toBeNull();
  expect(turns[1]!.querySelector(".turn-state.running")).toBeTruthy();
  expect(within(turns[1]!).queryByText(i18n.t("turnState_forked"))).toBeNull();
  const timed = snapshot(nextEntries, true);
  timed.runtime.activeTurn = {
    sessionId: "child",
    sessionPath: "/tmp/child.jsonl",
    commandId: "child-run",
    epoch: 1,
    promptEntryId: "child-prompt",
    startedAt: captured.capturedAt,
    elapsedMs: 4200,
  };
  rerender(transcript(timed));
  const timedTurns =
    container.querySelectorAll<HTMLElement>(".conversation-turn");
  expect(timedTurns).toHaveLength(2);
  expect(within(timedTurns[0]!).queryByRole("timer")).toBeNull();
  expect(within(timedTurns[1]!).getByRole("timer")).toBeTruthy();
  rerender(
    transcript(
      snapshot([
        ...nextEntries,
        nativeMessage("answer", fauxAssistantMessage("Child answer")),
      ]),
    ),
  );
  expect(screen.getByText("Child answer")).toBeTruthy();
  expect(screen.getByText(i18n.t("turnState_forked"))).toBeTruthy();
  expect(container.querySelector(".turn-state.running")).toBeNull();
  expect(screen.queryByText(i18n.t("turnState_waiting"))).toBeNull();
});

it("does not interpret the copied retry attempt as a terminal child failure", () => {
  const attempt = nativeMessage(
    "retry-attempt",
    fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "Temporary provider error",
    }),
  );
  const { rerender } = render(
    transcript(snapshot([prompt(), attempt, boundary("retry-attempt")])),
  );
  expect(screen.getByText(i18n.t("modelEarlierAttempts"))).toBeTruthy();
  expect(
    screen.queryByRole("alert", { name: i18n.t("modelRequestFailed") }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: i18n.t("retryPrompt") }),
  ).toBeNull();
  rerender(transcript(snapshot([prompt(), attempt])));
  expect(
    screen.getByRole("alert", { name: i18n.t("modelRequestFailed") })
      .textContent,
  ).toContain("Temporary provider error");
});

it.each(["bash", "read", "write", "subagent_spawn", "workflow", "plugin_tool"])(
  "renders an unfinished inherited %s result as unknown, preserving real failures",
  (name) => {
    const { container, rerender } = render(
      transcript(snapshot(pendingTool(name))),
    );
    expect(
      screen.getByText(i18n.t("toolSnapshotMissingResult"), {
        selector: "summary .evidence-status",
      }),
    ).toBeTruthy();
    expect(
      container.querySelector(
        ".process-step.error, .status-mark.error, [data-state=failed], .subagent-card.failed",
      ),
    ).toBeNull();
    expect(
      container.querySelector(".process-step[data-status=unknown]"),
    ).toBeTruthy();
    expect(container.textContent).not.toContain(
      i18n.t("toolActivity_failed", { action: i18n.t("toolAction_command") }),
    );
    rerender(transcript(snapshot(pendingTool(name, false))));
    expect(screen.queryByText(i18n.t("toolSnapshotMissingResult"))).toBeNull();
    if (name === "subagent_spawn") {
      expect(screen.getByText(i18n.t("subagentSpawnFailed"))).toBeTruthy();
    } else {
      expect(
        container.querySelector(
          name === "workflow"
            ? ".activity-card.workflow .status-mark.error"
            : ".process-step.error",
        ),
      ).toBeTruthy();
    }
  },
);

it("keeps an orphaned synthetic tool result neutral when the call is outside the loaded transcript", () => {
  const entries = pendingTool("subagent_spawn");
  const { container } = render(
    transcript(snapshot([entries[0]!, entries[2]!, entries[3]!])),
  );
  expect(screen.getByText(i18n.t("toolSnapshotMissingResult"))).toBeTruthy();
  expect(
    container.querySelector(
      ".process-step.error, .status-mark.error, [data-state=failed]",
    ),
  ).toBeNull();
  expect(
    container.querySelector(".process-step[data-status=unknown]"),
  ).toBeTruthy();
});
