// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import { projectEntry, type WebSnapshot } from "../../web/protocol/types.ts";
import { Providers } from "../../web/ui/src/app/providers.tsx";
import { ActivityBar } from "../../web/ui/src/features/activity/ActivityBar.tsx";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

afterEach(cleanup);

function snapshot(
  entries: NonNullable<WebSnapshot["selectedSession"]>["entries"],
) {
  return {
    protocolVersion: 1,
    generatedAt: "2026-09-30T00:00:00Z",
    cursor: 0,
    currentSessionId: "parent",
    preferences: { theme: "system" },
    workspaces: [],
    models: [],
    sessions: [
      {
        id: "parent",
        path: "/parent.jsonl",
        cwd: "/workspace",
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
        modified: "2026-09-30T00:00:00Z",
        created: "2026-09-30T00:00:00Z",
        messageCount: entries.length,
        firstMessage: "Use three subagents",
      },
    ],
    runtime: { status: "idle", capabilities: {} },
    selectedSession: {
      id: "parent",
      path: "/parent.jsonl",
      cwd: "/workspace",
      bytes: 0,
      entries,
      truncation: {
        truncated: false,
        entriesOmitted: 0,
        messagePartsOmitted: 0,
        messagesTruncated: 0,
        maxBytes: 2_000_000,
      },
    },
    truncation: {
      truncated: false,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
      modelsOmitted: 0,
      maxBytes: 4_000_000,
      bytes: 0,
    },
  } satisfies WebSnapshot;
}

function view(value: WebSnapshot) {
  return createElement(
    Providers,
    null,
    createElement(Transcript, {
      snapshot: value,
      liveMessages: [],
      liveRunning: false,
      livePhase: "idle",
      liveRetry: null,
      thinkingStarts: {},
      thinkingDurations: { "opaque-thinking": 11_000 },
      scrollToBottom: 0,
      onResend: async () => true,
    }),
    createElement(ActivityBar, {
      snapshot: value,
      onInspectSubagent: () => {},
    }),
  );
}

const receipt = (
  id: string,
  details: Record<string, unknown>,
  content = "Native visible result",
) =>
  projectEntry({
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-09-30T00:00:00Z",
    customType: "subagent-result",
    data: { content, details },
  });

it("shows exact background result batches once and keeps the parent's historical text intact", () => {
  const results = [1, 2, 3].map((number) => ({
    id: `sa-${number}`,
    title: `agent-${number}`,
    status: "done",
    outcome: "completed",
  }));
  const value = snapshot([
    {
      type: "message",
      id: "prompt",
      timestamp: "2026-09-30T00:00:00Z",
      message: { role: "user", content: "Use three subagents" },
    },
    receipt(
      "first-batch",
      { count: 2, results: results.slice(0, 2) },
      "Native result one\n\nNative result two",
    ),
    {
      type: "message",
      id: "opaque-thinking",
      timestamp: "2026-09-30T00:00:01Z",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: "The third agent was still running.",
        parts: [
          { type: "thinking", text: "" },
          { type: "text", text: "The third agent was still running." },
        ],
      },
    },
    receipt("third-result", results[2]!, "Native result three"),
    projectEntry({
      type: "custom_message",
      id: "hidden-follow-up",
      parentId: "third-result",
      timestamp: "2026-09-30T00:00:02Z",
      customType: "subagent-result",
      content: "Do not repeat the model transport instruction",
      display: false,
      details: results[2]!,
    }),
  ]);
  const { container } = render(view(value));
  expect(screen.getByText("The third agent was still running.")).toBeTruthy();
  expect(screen.getAllByText("Native result three")).toHaveLength(1);
  expect(container.textContent).not.toContain("model transport instruction");
  const cards = container.querySelectorAll(".activity-card.subagent");
  expect(cards).toHaveLength(2);
  expect(cards[0]?.querySelector('[aria-label="completed"]')).toBeTruthy();
  expect(cards[1]?.querySelector('[aria-label="completed"]')).toBeTruthy();
  expect(cards[0]?.querySelector("summary")?.textContent).toContain(
    i18n.t("subagentBackgroundResult", { count: 2 }),
  );
  expect(
    screen.getByRole("button", {
      name: i18n.t("subagentProgress", { running: 0, completed: 3 }),
    }),
  ).toBeTruthy();
  expect(container.querySelector(".thinking-line")).toBeNull();
  expect(container.querySelector(".process-sequence")).toBeNull();
});

it.each([
  [{ status: "error" }, "error"],
  [{ status: "error", outcome: "interrupted" }, "warn"],
  [{ status: "running" }, "running"],
  [{}, "unknown"],
] as const)(
  "does not mark a mixed result batch completed when any native receipt is unsettled or failed (%s)",
  (result, expected) => {
    const value = snapshot([
      receipt("batch", {
        results: [
          { id: "sa-1", status: "done" },
          { id: "sa-2", ...result },
        ],
      }),
    ]);
    const { container } = render(view(value));
    if (expected !== "unknown")
      expect(
        container.querySelector(`.activity-card .status-mark.${expected}`),
      ).toBeTruthy();
    else
      expect(container.querySelector(".activity-card .status-mark")).toBeNull();
    if ("outcome" in result && result.outcome === "interrupted")
      expect(
        container.querySelector(".activity-card summary")?.textContent,
      ).toContain(i18n.t("subagentState_interrupted"));
    expect(
      container.querySelector('.activity-card [aria-label="completed"]'),
    ).toBeNull();
  },
);

it("keeps visible reasoning evidence while ignoring whitespace-only provider parts", () => {
  const value = snapshot([
    {
      type: "message",
      id: "answer",
      timestamp: "2026-09-30T00:00:00Z",
      message: {
        role: "assistant",
        content: "Done",
        parts: [
          { type: "thinking", text: " \n" },
          { type: "thinking", text: "Checked the tools." },
          { type: "text", text: "Done" },
        ],
      },
    },
  ]);
  const { container } = render(view(value));
  expect(container.querySelectorAll(".thinking-line")).toHaveLength(1);
  expect(container.querySelector(".thinking-line .markdown")).toBeNull();
  expect(
    container.querySelector(".thinking-line summary")?.textContent,
  ).toContain("Checked the tools.");
  expect(container.querySelector(".process-sequence small")?.textContent).toBe(
    i18n.t("processThinkingCount", { count: 1 }),
  );
});
