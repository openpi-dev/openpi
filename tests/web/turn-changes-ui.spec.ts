// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import type {
  WebTurnChanges,
  WebTurnChangesDetail,
} from "../../web/protocol/turn-changes.ts";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { TurnChangesCard } from "../../web/ui/src/features/transcript/TurnChangesCard.tsx";
import { WorkbarPanel } from "../../web/ui/src/features/workbar/WorkbarPanel.tsx";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
const emptyDetail: WebTurnChangesDetail = {
  ...changes,
  files: files.map((file) => ({ ...file, diff: "", diffTruncated: false })),
};

function withI18n(element: ReturnType<typeof createElement>) {
  return createElement(I18nextProvider, { i18n }, element);
}

function snapshot(
  entries: NonNullable<WebSnapshot["selectedSession"]>["entries"],
): WebSnapshot {
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
    truncation: {
      truncated: false,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
      modelsOmitted: 0,
      maxBytes: 4 * 1024 * 1024,
      bytes: 0,
    },
    selectedSession: {
      id: "session",
      path: "/tmp/session",
      cwd: "/tmp",
      entries,
      bytes: 1,
      truncation,
    },
  };
}

function transcript(
  entries: NonNullable<WebSnapshot["selectedSession"]>["entries"],
) {
  return withI18n(
    createElement(Transcript, {
      snapshot: snapshot(entries),
      liveMessages: [],
      liveRunning: false,
      livePhase: "idle" as const,
      liveRetry: null,
      thinkingStarts: {},
      thinkingDurations: {},
      scrollToBottom: 0,
      onResend: async () => true,
    }),
  );
}

it("attaches a saved change receipt to its native prompt, not an adjacent turn", () => {
  const entries = [
    {
      id: "prompt-1",
      type: "message" as const,
      timestamp: "2026-09-23T00:00:00Z",
      message: { role: "user", content: "Edit files" },
    },
    {
      id: "answer-1",
      type: "message" as const,
      timestamp: "2026-09-23T00:00:01Z",
      message: { role: "assistant", content: "Done." },
    },
    {
      id: "changes-1",
      type: "custom" as const,
      timestamp: "2026-09-23T00:00:02Z",
      turnChanges: changes,
    },
    {
      id: "prompt-2",
      type: "message" as const,
      timestamp: "2026-09-23T00:00:03Z",
      message: { role: "user", content: "Explain" },
    },
    {
      id: "answer-2",
      type: "message" as const,
      timestamp: "2026-09-23T00:00:04Z",
      message: { role: "assistant", content: "Explanation." },
    },
  ];
  const { container, rerender } = render(transcript(entries));
  const turns = container.querySelectorAll(".conversation-turn");
  expect(turns).toHaveLength(2);
  expect(
    turns[0]
      ?.querySelector(".final-response")
      ?.nextElementSibling?.classList.contains("turn-changes"),
  ).toBe(true);
  expect(turns[0]?.querySelector(".turn-changes")?.textContent).toContain(
    "5 files changed during this turn",
  );
  expect(turns[1]?.querySelector(".turn-changes")).toBeNull();

  rerender(transcript(entries.slice(1)));
  expect(container.querySelector(".turn-changes")).toBeNull();
  rerender(transcript(entries));
  expect(container.querySelectorAll(".turn-changes")).toHaveLength(1);
});

it("shows three file names and line counts, expands locally, and opens the exact saved turn in the workbar", () => {
  const onReview = vi.fn();
  const read = vi.spyOn(WebClient.prototype, "turnChanges");
  const { container } = render(
    withI18n(createElement(TurnChangesCard, { changes, onReview })),
  );
  expect(container.querySelectorAll(".turn-changes-file")).toHaveLength(3);
  expect(screen.queryByText("Modified")).toBeNull();
  expect(screen.getByText("+15")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Show 2 more files/u }));
  fireEvent.click(screen.getByRole("button", { name: /file-5.ts/u }));
  expect(onReview).toHaveBeenLastCalledWith(
    "prompt-1",
    "src/feature/file-5.ts",
  );
  fireEvent.click(screen.getByRole("button", { name: "Review turn changes" }));
  expect(onReview).toHaveBeenLastCalledWith(
    "prompt-1",
    "src/feature/file-1.ts",
  );
  expect(read).not.toHaveBeenCalled();
  expect(container.querySelector(".turn-changes-review")).toBeNull();
});

it("does not claim exact totals for partial evidence or render unknown evidence", () => {
  const { container, rerender } = render(
    withI18n(
      createElement(TurnChangesCard, {
        changes: { ...changes, state: "partial", fileCount: null },
      }),
    ),
  );
  expect(
    screen.getByText("At least 5 files changed during this turn"),
  ).toBeTruthy();
  expect(
    screen.getByText("This turn's change record is incomplete."),
  ).toBeTruthy();
  expect(container.querySelector(".turn-changes-totals")).toBeNull();
  rerender(
    withI18n(
      createElement(TurnChangesCard, {
        changes: {
          ...changes,
          state: "unavailable",
          files: [],
          fileCount: null,
        },
      }),
    ),
  );
  expect(container.querySelector(".turn-changes")).toBeNull();
  expect(
    screen.queryByText("Unable to verify file changes for this turn."),
  ).toBeNull();
  expect(container.textContent).toBe("");
  rerender(
    withI18n(
      createElement(TurnChangesCard, {
        changes: { ...changes, state: "partial", files: [], fileCount: null },
      }),
    ),
  );
  expect(
    screen.queryByText("This turn's change record is incomplete."),
  ).toBeNull();
  expect(container.textContent).toBe("");
  rerender(
    withI18n(
      createElement(TurnChangesCard, {
        changes: {
          ...changes,
          files: [],
          fileCount: 0,
          additions: 0,
          deletions: 0,
        },
      }),
    ),
  );
  expect(container.querySelector(".turn-changes-unavailable")).toBeNull();
});

it("labels native tool edits separately and keeps known files when line counts are unknown", () => {
  const edited: WebTurnChanges = {
    ...changes,
    version: 2,
    source: "file-tools",
    state: "partial",
    fileCount: 2,
    files: [
      { ...files[0]!, additions: 1, deletions: 0 },
      {
        ...files[1]!,
        additions: 0,
        deletions: 0,
        statsUnavailable: "before_unavailable",
      },
    ],
  };
  const { container } = render(
    withI18n(createElement(TurnChangesCard, { changes: edited })),
  );
  expect(screen.getByText("Edited 2 files")).toBeTruthy();
  expect(screen.getByText("Line counts unavailable")).toBeTruthy();
  expect(container.querySelectorAll(".turn-changes-file")).toHaveLength(2);
  expect(container.querySelector(".turn-changes-totals")).toBeNull();
  expect(
    container.querySelectorAll(".turn-changes-file-stats")[1]?.textContent,
  ).not.toContain("+0");
});

function panel(promptEntryId: string, filePath = files[1]!.path) {
  return withI18n(
    createElement(WorkbarPanel, {
      visible: true,
      requestedTool: "review",
      requestRevision: 1,
      sessionId: "session",
      sessionPath: "/tmp/session",
      cwd: "/workspace",
      capabilities: {},
      conversationCollapsed: false,
      onRestoreConversation: () => {},
      onClose: () => {},
      review: {
        result: null,
        loading: false,
        error: null,
        refresh: async () => {},
      },
      reviewTurn: { promptEntryId, filePath, revision: 1 },
    }),
  );
}
it("reads exact saved evidence into the shared workbar without reading live Git", async () => {
  const detail = {
    ...emptyDetail,
    files: emptyDetail.files.map((f, i) => ({
      ...f,
      diff: "@@ -1 +1 @@\\n-old\\n+saved-" + i,
    })),
  };
  const read = vi
    .spyOn(WebClient.prototype, "turnChanges")
    .mockResolvedValue({ ok: true, changes: detail });
  const git = vi.spyOn(WebClient.prototype, "gitReview");
  const { container } = render(panel("prompt-1"));
  await waitFor(() =>
    expect(
      screen.getByRole("figure", { name: "Change diff" }).textContent,
    ).toContain("saved-1"),
  );
  expect(read).toHaveBeenCalledWith(
    "session",
    "/tmp/session",
    "prompt-1",
    expect.any(AbortSignal),
  );
  expect(git).not.toHaveBeenCalled();
  expect(
    container.querySelector(".review-file-context")?.textContent,
  ).toContain("Saved workspace changes during this turn");
  fireEvent.keyDown(container.querySelector(".review-file-preview")!, {
    key: "Escape",
    isComposing: true,
  });
  expect(
    screen.getByRole("figure", { name: "Change diff" }).textContent,
  ).toContain("saved-1");
  fireEvent.keyDown(container.querySelector(".review-file-preview")!, {
    key: "Escape",
  });
  await waitFor(() =>
    expect(container.querySelectorAll(".session-review-file")).toHaveLength(5),
  );
});
it("rejects mismatched saved identity and never falls back to the current workspace", async () => {
  vi.spyOn(WebClient.prototype, "turnChanges").mockResolvedValue({
    ok: true,
    changes: { ...emptyDetail, promptEntryId: "other" },
  });
  const git = vi.spyOn(WebClient.prototype, "gitReview");
  render(panel("prompt-1"));
  await waitFor(() =>
    expect(
      screen.getByText("This turn's saved diff is unavailable."),
    ).toBeTruthy(),
  );
  expect(git).not.toHaveBeenCalled();
});
it("ignores late evidence from a previous turn and does not steal focus on completion", async () => {
  let finish!: (result: { ok: true; changes: WebTurnChangesDetail }) => void;
  vi.spyOn(WebClient.prototype, "turnChanges")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce({
      ok: true,
      changes: { ...emptyDetail, promptEntryId: "prompt-2" },
    });
  const { rerender, container } = render(panel("prompt-1"));
  rerender(panel("prompt-2"));
  const scope = screen.getByRole("combobox");
  scope.focus();
  await waitFor(() =>
    expect(container.querySelector(".review-file-context")).toBeTruthy(),
  );
  await act(async () =>
    finish({
      ok: true,
      changes: {
        ...emptyDetail,
        files: [
          { ...emptyDetail.files[0]!, diff: "@@ -1 +1 @@\\n+wrong-turn" },
        ],
      },
    }),
  );
  expect(screen.queryByText("wrong-turn")).toBeNull();
  expect(document.activeElement).toBe(scope);
});
