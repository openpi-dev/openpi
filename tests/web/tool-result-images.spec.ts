// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it } from "vitest";
import type { LiveToolEvidence } from "../../web/protocol/evidence.ts";
import {
  projectMessage,
  WEB_MAX_MESSAGE_PARTS,
  WEB_PROMPT_IMAGE_MAX_BASE64_CHARS,
  type WebLiveMessage,
  type WebMessagePart,
  type WebSnapshot,
} from "../../web/protocol/types.ts";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

const truncation = {
  truncated: false,
  sessionsOmitted: 0,
  workspacesOmitted: 0,
  modelsOmitted: 0,
  maxBytes: 4_000_000,
  bytes: 0,
} as const;

function tool(
  id: string,
  name: string,
  args = "{}",
): Extract<WebMessagePart, { type: "toolCall" }> {
  return { type: "toolCall", id, name, arguments: args };
}

function snapshot({
  tools,
  results = [],
  liveTools = [],
  running = false,
}: {
  tools: Extract<WebMessagePart, { type: "toolCall" }>[];
  results?: WebLiveMessage[];
  liveTools?: LiveToolEvidence[];
  running?: boolean;
}) {
  return {
    protocolVersion: 1,
    generatedAt: "2026-09-08T00:00:00Z",
    cursor: 0,
    preferences: { theme: "system" },
    currentSessionId: "session",
    workspaces: [],
    sessions: [
      {
        id: "session",
        path: "/session.jsonl",
        cwd: "/workspace",
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
        modified: "2026-09-08T00:00:00Z",
        created: "2026-09-08T00:00:00Z",
        messageCount: results.length + 2,
        firstMessage: "Look",
      },
    ],
    models: [],
    runtime: {
      status: running ? "running" : "idle",
      capabilities: {},
      liveTools,
    },
    selectedSession: {
      id: "session",
      path: "/session.jsonl",
      cwd: "/workspace",
      bytes: 0,
      truncation: {
        truncated: false,
        entriesOmitted: 0,
        messagePartsOmitted: 0,
        messagesTruncated: 0,
        maxBytes: 2_000_000,
      },
      entries: [
        {
          id: "prompt",
          type: "message",
          timestamp: "2026-09-08T00:00:00Z",
          message: { role: "user", content: "Look" },
        },
        ...(tools.length > 0
          ? [
              {
                id: "assistant",
                type: "message" as const,
                timestamp: "2026-09-08T00:00:01Z",
                message: {
                  role: "assistant",
                  content: "",
                  parts: tools,
                  stopReason: "toolUse" as const,
                },
              },
            ]
          : []),
        ...results.map((message, index) => ({
          id: `result-${index}`,
          type: "message" as const,
          timestamp: "2026-09-08T00:00:02Z",
          message,
        })),
      ],
    },
    truncation,
  } satisfies WebSnapshot;
}

function view(value: WebSnapshot) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(Transcript, {
      snapshot: value,
      activityObserved: true,
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

function imageMessage(content: unknown, extra: Record<string, unknown> = {}) {
  return projectMessage({
    role: "toolResult",
    toolName: "read",
    toolCallId: "read-image",
    isError: false,
    content,
    ...extra,
  });
}

afterEach(cleanup);

it("shows the image a read tool returned instead of success with no output", () => {
  const result = imageMessage([
    {
      type: "image",
      data: "synthetic-image-data",
      mimeType: "image/png",
      name: "shot.png",
    },
  ]);
  const { container } = render(
    view(
      snapshot({
        tools: [tool("read-image", "read", '{"path":"shot.png"}')],
        results: [result],
      }),
    ),
  );
  const card = container.querySelector<HTMLElement>('[data-tool="read"]')!;
  const summary = card.querySelector("summary")!;
  expect(summary.textContent).toContain(
    i18n.t("toolResultImageSummary", { count: 1, types: "image/png" }),
  );
  expect(summary.textContent).toContain(
    i18n.t("toolResultImagePreviewUnavailable"),
  );
  expect(card.textContent).not.toContain("no output");
  expect(card.textContent).not.toContain("synthetic-image-data");
  expect(card.getAttribute("data-state")).toBe("returned");
  fireEvent.click(summary);
  expect(card.textContent).toContain("shot.png");
  expect(card.textContent).toContain(i18n.t("toolResultImagePreviewDetail"));
  expect(card.textContent).not.toContain(
    i18n.t("toolResultImageOversizedDetail", { limit: "10 MB" }),
  );
});

it("shows an unpaired image-only result on the visible line, still completed", () => {
  const result = imageMessage([
    { type: "image", data: "synthetic-image-data", mimeType: "image/png" },
  ]);
  const { container } = render(
    view(snapshot({ tools: [], results: [result] })),
  );
  const row = container.querySelector<HTMLElement>(
    "[data-tool='read'], .tool-line-empty",
  )!;
  expect(row.querySelector("summary")?.textContent).toContain(
    i18n.t("toolResultImageSummary", { count: 1, types: "image/png" }),
  );
  expect(row.textContent).not.toContain("no output");
  expect(row.textContent).not.toContain("synthetic-image-data");
  expect(
    row.querySelector(`[aria-label="${i18n.t("execution_done")}"]`),
  ).toBeTruthy();
  expect(row.querySelector(".status-mark.error")).toBeNull();
});

it("keeps caption text with every image type and does not call that no output", () => {
  const result = imageMessage([
    { type: "text", text: "Chart caption" },
    { type: "image", data: "synthetic-image-data", mimeType: "image/png" },
    { type: "image", data: "second-image-data", mimeType: "image/jpeg" },
  ]);
  const { container } = render(
    view(
      snapshot({
        tools: [tool("read-image", "read", '{"path":"chart.png"}')],
        results: [result],
      }),
    ),
  );
  const card = container.querySelector<HTMLElement>('[data-tool="read"]')!;
  expect(card.textContent).toContain("Chart caption");
  expect(card.querySelector("summary")?.textContent).toContain(
    i18n.t("toolResultImageSummary", {
      count: 2,
      types: "image/png, image/jpeg",
    }),
  );
  expect(card.textContent).not.toContain("no output");
  expect(card.textContent).not.toContain("synthetic-image-data");
  expect(card.textContent).not.toContain("second-image-data");
});

it("explains an unsupported block without copying its payload", () => {
  const result = imageMessage([
    { type: "image", data: "synthetic-image-data", mimeType: "image/png" },
    { type: "audio", data: "secret-audio-bytes" },
    null,
  ]);
  const { container } = render(
    view(
      snapshot({
        tools: [tool("read-image", "read")],
        results: [result],
      }),
    ),
  );
  const card = container.querySelector<HTMLElement>('[data-tool="read"]')!;
  expect(card.querySelector("summary")?.textContent).toContain(
    i18n.t("toolResultUnsupportedParts", { count: 2 }),
  );
  expect(card.textContent).not.toContain("secret-audio-bytes");
  expect(card.textContent).not.toContain("no output");
});

it("keeps display-limit, omitted parts, and tool failure independent", () => {
  const oversized = imageMessage([
    {
      type: "image",
      mimeType: "image/png",
      data: "A".repeat(WEB_PROMPT_IMAGE_MAX_BASE64_CHARS + 1),
    },
  ]);
  const omitted = projectMessage({
    role: "toolResult",
    toolName: "capture",
    toolCallId: "capture-1",
    isError: false,
    content: Array.from({ length: WEB_MAX_MESSAGE_PARTS + 1 }, () => ({
      type: "image",
      mimeType: "image/webp",
      data: "tiny",
    })),
  });
  const failed = projectMessage({
    role: "toolResult",
    toolName: "read",
    toolCallId: "read-failed",
    isError: true,
    content: [
      { type: "image", data: "synthetic-image-data", mimeType: "image/gif" },
    ],
  });
  const { container } = render(
    view(
      snapshot({
        tools: [
          tool("read-image", "read", '{"path":"big.png"}'),
          tool("capture-1", "capture"),
          tool("read-failed", "read", '{"path":"missing.gif"}'),
        ],
        results: [
          oversized,
          { ...omitted, toolCallId: "capture-1", toolName: "capture" },
          failed,
        ],
      }),
    ),
  );
  const cards = [...container.querySelectorAll<HTMLElement>("[data-tool]")];
  const readCards = cards.filter(
    (card) => card.getAttribute("data-tool") === "read",
  );
  const big = readCards.find((card) => card.textContent?.includes("big.png"))!;
  const broken = readCards.find((card) =>
    card.textContent?.includes("missing.gif"),
  )!;
  const capture = cards.find(
    (card) => card.getAttribute("data-tool") === "capture",
  )!;
  expect(big.getAttribute("data-state")).toBe("returned");
  expect(big.querySelector("summary")?.textContent).toContain(
    i18n.t("toolResultImageOversized", { count: 1 }),
  );
  expect(big.querySelector("summary")?.textContent).not.toContain(
    i18n.t("toolResultImagePreviewUnavailable"),
  );
  expect(big.textContent).not.toContain("A".repeat(80));
  expect(capture.querySelector("summary")?.textContent).toContain(
    i18n.t("toolResultImageSummary", {
      count: WEB_MAX_MESSAGE_PARTS,
      types: "image/webp",
    }),
  );
  expect(capture.querySelector("summary")?.textContent).toContain(
    i18n.t("toolResultPartsOmitted", { count: 1 }),
  );
  expect(capture.querySelector(".status-mark.done")).toBeTruthy();
  expect(capture.querySelector(".status-mark.error")).toBeNull();
  expect(broken.getAttribute("data-state")).toBe("failed");
  expect(broken.querySelector("summary")?.textContent).toContain(
    i18n.t("toolResultImageSummary", { count: 1, types: "image/gif" }),
  );
  expect(broken.textContent).not.toContain("no output");
  expect(broken.textContent).not.toContain("synthetic-image-data");
});

it("still calls a genuinely empty read no output", () => {
  const result = projectMessage({
    role: "toolResult",
    toolName: "read",
    toolCallId: "read-empty",
    isError: false,
    content: [{ type: "text", text: "" }],
  });
  const { container } = render(
    view(
      snapshot({
        tools: [tool("read-empty", "read", '{"path":"empty.txt"}')],
        results: [result],
      }),
    ),
  );
  const card = container.querySelector<HTMLElement>('[data-tool="read"]')!;
  expect(card.textContent).toContain("no output");
  expect(card.textContent).not.toContain(
    i18n.t("toolResultImagePreviewUnavailable"),
  );
});

it("shows the same image evidence from a live result and the refreshed snapshot", () => {
  const result = imageMessage([
    { type: "image", data: "synthetic-image-data", mimeType: "image/png" },
  ]);
  const call = tool("read-image", "read", '{"path":"shot.png"}');
  const liveTools: LiveToolEvidence[] = [{ call, state: "returned", result }];
  const ui = render(
    view(snapshot({ tools: [call], liveTools, running: true })),
  );
  const liveSummary = ui.container.querySelector(
    '[data-tool="read"] summary',
  )?.textContent;
  expect(liveSummary).toContain(
    i18n.t("toolResultImageSummary", { count: 1, types: "image/png" }),
  );
  expect(ui.container.textContent).not.toContain("no output");
  ui.rerender(
    view(snapshot({ tools: [call], results: [result], running: false })),
  );
  expect(
    ui.container.querySelector('[data-tool="read"] summary')?.textContent,
  ).toBe(liveSummary);
  expect(ui.container.textContent).not.toContain("synthetic-image-data");
});
