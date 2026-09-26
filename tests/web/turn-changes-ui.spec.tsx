// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import type { WebTurnChanges, WebTurnChangesDetail } from "../../web/protocol/turn-changes.ts";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { TurnChangesCard } from "../../web/ui/src/features/transcript/TurnChangesCard.tsx";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const files = Array.from({ length: 5 }, (_, index) => ({
  path: `src/feature/file-${index + 1}.ts`,
  status: "modified" as const,
  additions: index + 1,
  deletions: 1,
}));

const changes: WebTurnChanges = {
  version: 1,
  sessionId: "session",
  promptEntryId: "prompt-1",
  state: "complete",
  fileCount: 5,
  files,
  additions: 15,
  deletions: 5,
};

function withI18n(element: ReturnType<typeof createElement>) {
  return createElement(I18nextProvider, { i18n }, element);
}

function snapshot(entries: NonNullable<WebSnapshot["selectedSession"]>["entries"]): WebSnapshot {
  const truncation = {
    truncated: false,
    entriesOmitted: 0,
    messagesTruncated: 0,
    messagePartsOmitted: 0,
    maxBytes: 2 * 1024 * 1024,
  };
  return {
    protocolVersion: 1,
    preferences: { theme: "system" },
    generatedAt: "2026-09-23T00:00:00Z",
    cursor: 1,
    currentSessionId: "session",
    currentSessionPath: "/tmp/session",
    workspaces: [],
    sessions: [],
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation: { truncated: false, sessionsOmitted: 0, workspacesOmitted: 0, modelsOmitted: 0, maxBytes: 4 * 1024 * 1024, bytes: 0 },
    selectedSession: { id: "session", path: "/tmp/session", cwd: "/tmp", entries, bytes: 1, truncation },
  };
}

function transcript(entries: NonNullable<WebSnapshot["selectedSession"]>["entries"]) {
  return withI18n(createElement(Transcript, {
    snapshot: snapshot(entries),
    liveMessages: [],
    liveRunning: false,
    livePhase: "idle" as const,
    liveRetry: null,
    thinkingStarts: {},
    thinkingDurations: {},
    scrollToBottom: 0,
    onResend: async () => true,
  }));
}

it("attaches a saved change receipt to its native prompt, not an adjacent turn", () => {
  const entries = [
    { id: "prompt-1", type: "message" as const, timestamp: "2026-09-23T00:00:00Z", message: { role: "user", content: "Edit files" } },
    { id: "answer-1", type: "message" as const, timestamp: "2026-09-23T00:00:01Z", message: { role: "assistant", content: "Done." } },
    { id: "changes-1", type: "custom" as const, timestamp: "2026-09-23T00:00:02Z", turnChanges: changes },
    { id: "prompt-2", type: "message" as const, timestamp: "2026-09-23T00:00:03Z", message: { role: "user", content: "Explain" } },
    { id: "answer-2", type: "message" as const, timestamp: "2026-09-23T00:00:04Z", message: { role: "assistant", content: "Explanation." } },
  ];
  const { container, rerender } = render(transcript(entries));
  const turns = container.querySelectorAll(".conversation-turn");
  expect(turns).toHaveLength(2);
  expect(turns[0]?.querySelector(".final-response")?.nextElementSibling?.classList.contains("turn-changes")).toBe(true);
  expect(turns[0]?.querySelector(".turn-changes")?.textContent).toContain("5 files changed during this turn");
  expect(turns[1]?.querySelector(".turn-changes")).toBeNull();

  rerender(transcript(entries.slice(1)));
  expect(container.querySelector(".turn-changes")).toBeNull();
  rerender(transcript(entries));
  expect(container.querySelectorAll(".turn-changes")).toHaveLength(1);
});

it("shows a bounded file summary and reviews the saved turn diff on demand", async () => {
  const detail: WebTurnChangesDetail = {
    ...changes,
    files: files.map((file, index) => ({ ...file, diff: `@@ -1 +1 @@\n-old\n+saved-turn-${index}`, diffTruncated: false, diffLoaded: true })),
  };
  const read = vi.spyOn(WebClient.prototype, "turnChanges")
    .mockResolvedValueOnce({ ok: true, changes: detail });
  const { container } = render(withI18n(createElement(TurnChangesCard, {
    changes, sessionId: "session", sessionPath: "/tmp/session",
  })));
  expect(container.querySelectorAll(".turn-changes-list .turn-changes-file")).toHaveLength(3);
  expect(screen.getByText("+15")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Show 2 more files/u }));
  expect(container.querySelectorAll(".turn-changes-list .turn-changes-file")).toHaveLength(5);
  fireEvent.click(screen.getByRole("button", { name: "Review turn changes" }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(read).toHaveBeenNthCalledWith(1, "session", "/tmp/session", "prompt-1", expect.any(AbortSignal));
  expect(read).toHaveBeenCalledTimes(1);
  expect(within(screen.getByRole("figure", { name: "Change diff" })).getByText("saved-turn-0")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back to turn changes" }));
  expect(container.querySelectorAll(".turn-changes-list .turn-changes-file")).toHaveLength(5);
});

it("does not claim exact totals for partial evidence or render unknown evidence", () => {
  const { container, rerender } = render(withI18n(createElement(TurnChangesCard, {
    changes: { ...changes, state: "partial", fileCount: null }, sessionId: "session", sessionPath: "/tmp/session",
  })));
  expect(screen.getByText("At least 5 files changed during this turn")).toBeTruthy();
  expect(screen.getByText("This turn's change record is incomplete.")).toBeTruthy();
  expect(container.querySelector(".turn-changes-totals")).toBeNull();
  rerender(withI18n(createElement(TurnChangesCard, {
    changes: { ...changes, state: "unavailable", files: [], fileCount: null }, sessionId: "session", sessionPath: "/tmp/session",
  })));
  expect(container.querySelector(".turn-changes")).toBeNull();
  expect(screen.getByText("Unable to verify file changes for this turn.")).toBeTruthy();
  rerender(withI18n(createElement(TurnChangesCard, {
    changes: { ...changes, state: "partial", files: [], fileCount: null }, sessionId: "session", sessionPath: "/tmp/session",
  })));
  expect(screen.getByText("This turn's change record is incomplete.")).toBeTruthy();
  rerender(withI18n(createElement(TurnChangesCard, {
    changes: { ...changes, files: [], fileCount: 0, additions: 0, deletions: 0 }, sessionId: "session", sessionPath: "/tmp/session",
  })));
  expect(container.querySelector(".turn-changes-unavailable")).toBeNull();
});
