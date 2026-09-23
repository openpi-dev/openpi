// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { FullMessageText } from "../../web/ui/src/features/transcript/FullMessageText.tsx";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { copyText } from "../../web/ui/src/lib/clipboard.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

vi.mock("../../web/ui/src/lib/clipboard.ts", () => ({ copyText: vi.fn(async () => true) }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });

function withI18n(element: ReturnType<typeof createElement>) {
  return createElement(I18nextProvider, { i18n }, element);
}

it("loads exact native message text in explicit pages and replaces the preview", async () => {
  const read = vi.spyOn(WebClient.prototype, "sessionItem")
    .mockResolvedValueOnce({ entryId: "answer", text: "Full first part ", nextCursor: 16, totalChars: 27 })
    .mockResolvedValueOnce({ entryId: "answer", text: "and second", nextCursor: null, totalChars: 27 });
  const { container } = render(withI18n(createElement(FullMessageText, {
    preview: "Truncated preview", sessionId: "session", sessionPath: "/tmp/session", entryId: "answer", markdown: true,
  })));
  expect(container.textContent).toContain("Truncated preview");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load full message" })); });
  expect(container.textContent).toContain("Full first part");
  expect(container.textContent).not.toContain("Truncated preview");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Load more" })); });
  expect(container.textContent).toContain("Full first part and second");
  expect(read).toHaveBeenNthCalledWith(1, "session", "/tmp/session", "answer", 0, expect.any(AbortSignal));
  expect(read).toHaveBeenNthCalledWith(2, "session", "/tmp/session", "answer", 16, expect.any(AbortSignal));
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

it("aborts a late page when the native message identity changes", async () => {
  let finish!: (page: { entryId: string; text: string; nextCursor: null; totalChars: number }) => void;
  const read = vi.spyOn(WebClient.prototype, "sessionItem").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const component = (entryId: string) => withI18n(createElement(FullMessageText, {
    key: entryId, preview: `Preview ${entryId}`, sessionId: "session", sessionPath: "/tmp/session", entryId, markdown: false,
  }));
  const { rerender, container } = render(component("first"));
  fireEvent.click(screen.getByRole("button", { name: "Load full message" }));
  const signal = read.mock.calls[0]![4];
  rerender(component("second"));
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ entryId: "first", text: "Stale", nextCursor: null, totalChars: 5 }));
  expect(container.textContent).toContain("Preview second");
  expect(container.textContent).not.toContain("Stale");
});

it("offers recovery only for clipped visible text, not bounded tool evidence", () => {
  const truncation = { truncated: true, entriesOmitted: 0, messagesTruncated: 2, messagePartsOmitted: 0, maxBytes: 2 * 1024 * 1024 };
  const snapshot: WebSnapshot = {
    protocolVersion: 1, preferences: { theme: "system" }, generatedAt: "2026-09-23T00:00:00Z", cursor: 1,
    currentSessionId: "session", currentSessionPath: "/tmp/session", workspaces: [], sessions: [], models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation: { truncated: false, sessionsOmitted: 0, workspacesOmitted: 0, modelsOmitted: 0, maxBytes: 4 * 1024 * 1024, bytes: 0 },
    selectedSession: { id: "session", path: "/tmp/session", cwd: "/tmp", bytes: 1, truncation, entries: [
      { id: "prompt", type: "message", timestamp: "2026-09-23T00:00:00Z", message: { role: "user", content: "Question", truncation: { truncated: true, text: true } } },
      { id: "result", type: "message", timestamp: "2026-09-23T00:00:01Z", message: { role: "toolResult", content: "Bounded tool output", toolName: "bash", truncation: { truncated: true, text: true } } },
      { id: "answer", type: "message", timestamp: "2026-09-23T00:00:02Z", message: { role: "assistant", content: "Answer preview", truncation: { truncated: true, text: true, visibleText: true } } },
    ] },
  };
  render(withI18n(createElement(Transcript, {
    snapshot, liveMessages: [], liveRunning: false, livePhase: "idle", liveRetry: null,
    thinkingStarts: {}, thinkingDurations: {}, scrollToBottom: 0, onResend: async () => true,
  })));
  expect(screen.getAllByRole("button", { name: "Load full message" })).toHaveLength(1);
  expect(screen.queryByText("Some message contents exceed the preview limit and are truncated.")).toBeNull();
  expect(screen.queryByText("Beginning of conversation")).toBeNull();
});

it("uses the complete native text for copy and edit only after recovery finishes", async () => {
  const read = vi.spyOn(WebClient.prototype, "sessionItem").mockResolvedValue({
    entryId: "prompt", text: "The complete question after recovery", nextCursor: null, totalChars: 36,
  });
  const snapshot: WebSnapshot = {
    protocolVersion: 1, preferences: { theme: "system" }, generatedAt: "2026-09-23T00:00:00Z", cursor: 1,
    currentSessionId: "session", currentSessionPath: "/tmp/session", workspaces: [], sessions: [], models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation: { truncated: false, sessionsOmitted: 0, workspacesOmitted: 0, modelsOmitted: 0, maxBytes: 4 * 1024 * 1024, bytes: 0 },
    selectedSession: { id: "session", path: "/tmp/session", cwd: "/tmp", bytes: 1,
      truncation: { truncated: true, entriesOmitted: 0, messagesTruncated: 1, messagePartsOmitted: 0, maxBytes: 2 * 1024 * 1024 },
      entries: [{ id: "prompt", type: "message", timestamp: "2026-09-23T00:00:00Z", message: { role: "user", content: "Question preview", truncation: { truncated: true, visibleText: true } } }],
    },
  };
  const { container, rerender } = render(withI18n(createElement(Transcript, {
    snapshot, liveMessages: [], liveRunning: false, livePhase: "idle", liveRetry: null,
    thinkingStarts: {}, thinkingDurations: {}, scrollToBottom: 0, onResend: async () => true,
  })));
  const question = container.querySelector<HTMLElement>(".message-row.user")!;
  expect(within(question).getByRole<HTMLButtonElement>("button", { name: "Copy message" }).disabled).toBe(true);
  expect(within(question).queryByRole("button", { name: "Edit message" })).toBeNull();
  await act(async () => fireEvent.click(within(question).getByRole("button", { name: "Load full message" })));
  expect(read).toHaveBeenCalledOnce();
  expect(within(question).getByRole<HTMLButtonElement>("button", { name: "Copy message" }).disabled).toBe(false);
  await act(async () => fireEvent.click(within(question).getByRole("button", { name: "Copy message" })));
  expect(copyText).toHaveBeenCalledWith("The complete question after recovery");
  fireEvent.click(within(question).getByRole("button", { name: "Edit message" }));
  expect(within(question).getByRole<HTMLTextAreaElement>("textbox", { name: "Edit message" }).value).toBe("The complete question after recovery");

  rerender(withI18n(createElement(Transcript, {
    snapshot: { ...snapshot, cursor: 2 }, liveMessages: [], liveRunning: false, livePhase: "idle", liveRetry: null,
    thinkingStarts: {}, thinkingDurations: {}, scrollToBottom: 0, onResend: async () => true,
  })));
  expect(within(question).getByRole<HTMLTextAreaElement>("textbox", { name: "Edit message" }).value).toBe("The complete question after recovery");
});
