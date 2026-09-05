// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { Markdown } from "../../web/ui/src/components/Markdown.tsx";
import { OpenPiLogo } from "../../web/ui/src/components/OpenPiLogo.tsx";
import { SessionSidebar } from "../../web/ui/src/features/sessions/SessionSidebar.tsx";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { createWebStore } from "../../web/ui/src/store/web-store.ts";

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
