// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it } from "vitest";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(cleanup);

function transcript(
  inputEntryId?: string,
  commandId = "command-1",
  running = false,
) {
  const snapshot: WebSnapshot = {
    protocolVersion: 1,
    generatedAt: "2026-10-01T00:00:00Z",
    cursor: 1,
    preferences: { theme: "system" },
    currentSessionId: "session",
    currentSessionPath: "/tmp/session.jsonl",
    workspaces: [],
    sessions: [],
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
      id: "session",
      path: "/tmp/session.jsonl",
      cwd: "/tmp",
      bytes: 1,
      truncation: {
        truncated: false,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
        maxBytes: 1024,
      },
      entries: [
        {
          id: "input-1",
          type: "message",
          timestamp: "2026-10-01T00:00:00Z",
          message: {
            role: "user",
            content: "/plan off",
            customType: "openpi-web-command-input",
            commandId: "command-1",
          },
        },
        {
          id: "feedback",
          type: "message",
          timestamp: "2026-10-01T00:00:01Z",
          message: {
            role: "custom",
            content: "A command may report progress before returning.",
            customType: "openpi-web-command-feedback",
          },
        },
        ...(inputEntryId
          ? [
              {
                id: "handled",
                type: "message" as const,
                timestamp: "2026-10-01T00:00:02Z",
                message: {
                  role: "custom" as const,
                  content: "",
                  customType: "openpi-web-command-handled",
                  details: { inputEntryId, commandId },
                },
              },
            ]
          : []),
      ],
    },
  };
  return render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Transcript, {
        snapshot,
        liveMessages: [],
        liveRunning: running,
        livePhase: running ? "running" : "idle",
        liveRetry: null,
        thinkingStarts: {},
        thinkingDurations: {},
        scrollToBottom: 0,
        onResend: async () => true,
      }),
    ),
  );
}

it("keeps waiting when only command feedback is present", () => {
  transcript();
  expect(screen.getByText(i18n.t("turnState_waiting"))).toBeTruthy();
});

it("stops showing waiting after the exact native command handler returned", () => {
  transcript("input-1");
  expect(screen.queryByText(i18n.t("turnState_waiting"))).toBeNull();
  expect(
    screen.getByText("A command may report progress before returning."),
  ).toBeTruthy();
});

it.each([
  ["other-input", "command-1"],
  ["input-1", "other-command"],
])(
  "does not transfer another command's handled receipt (%s/%s)",
  (input, command) => {
    transcript(input, command);
    expect(screen.getByText(i18n.t("turnState_waiting"))).toBeTruthy();
  },
);

it("keeps the native running state visible after a delayed model run starts", () => {
  const { container } = transcript("input-1", "command-1", true);
  expect(container.querySelector(".turn-state.running")).toBeTruthy();
});
