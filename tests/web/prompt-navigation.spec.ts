// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  WebSessionProjection,
  WebSessionPromptHistoryPage,
} from "../../web/protocol/types.ts";
import { usePromptNavigation } from "../../web/ui/src/features/transcript/use-prompt-navigation.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const selected = (path = "/s.jsonl", leaf = "leaf"): WebSessionProjection => ({
  id: "s",
  path,
  cwd: "/workspace",
  entries: [],
  bytes: 0,
  history: { leafEntryId: leaf, beforeEntryId: "loaded" },
  truncation: {
    truncated: true,
    entriesOmitted: 10,
    messagesTruncated: 0,
    messagePartsOmitted: 0,
    maxBytes: 1024,
  },
});
const loaded = [
  { entryId: "loaded", title: "Loaded prompt", reply: "Loaded reply" },
];
const page = (
  ids = ["old", "loaded"],
  before: string | null = null,
  next: string | null = null,
): WebSessionPromptHistoryPage => ({
  sessionId: "s",
  sessionPath: "/s.jsonl",
  anchorEntryId: "leaf",
  requestedBeforeEntryId: before,
  entryIds: ids,
  nextBeforeEntryId: next,
});

it("waits for idle and enables all chronological IDs only after complete metadata, without reading bodies", async () => {
  vi.useFakeTimers();
  const history = vi
    .spyOn(WebClient.prototype, "sessionPromptHistory")
    .mockResolvedValueOnce(page(["middle", "loaded"], null, "middle"))
    .mockResolvedValueOnce(page(["old"], "middle"));
  const preview = vi.spyOn(WebClient.prototype, "sessionPromptPreview");
  const body = vi.spyOn(WebClient.prototype, "sessionMessageWindow");
  const view = renderHook(() => usePromptNavigation(selected(), loaded, true), {
    wrapper: StrictMode,
  });
  expect(history).not.toHaveBeenCalled();
  expect(view.result.current.items).toEqual(loaded);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(view.result.current.items.map((item) => item.entryId)).toEqual([
    "old",
    "middle",
    "loaded",
  ]);
  expect(view.result.current.items.at(-1)).toBe(loaded[0]);
  expect(history.mock.calls.map(([, before]) => before)).toEqual([
    null,
    "middle",
  ]);
  expect(preview).not.toHaveBeenCalled();
  expect(body).not.toHaveBeenCalled();
});

it("retains loaded navigation when the ten-page cap is incomplete or metadata identity/cursor is invalid", async () => {
  vi.useFakeTimers();
  const read = vi
    .spyOn(WebClient.prototype, "sessionPromptHistory")
    .mockImplementation(async (anchor, before) => {
      const id = before === null ? "p10" : `p${Number(before.slice(1)) - 1}`;
      return { ...page([id], before, id), anchorEntryId: anchor.entryId };
    });
  const view = renderHook(() => usePromptNavigation(selected(), loaded, true));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(read).toHaveBeenCalledTimes(10);
  expect(view.result.current.items).toEqual(loaded);
  view.unmount();
  read.mockResolvedValue({ ...page(), sessionPath: "/copy.jsonl" });
  const invalid = renderHook(() =>
    usePromptNavigation(selected(), loaded, true),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(invalid.result.current.items).toEqual(loaded);
});

it("loads previews only on demand, reuses loaded text, deduplicates requests, and permits a failed hover to retry", async () => {
  vi.useFakeTimers();
  vi.spyOn(WebClient.prototype, "sessionPromptHistory").mockResolvedValue(
    page(),
  );
  const preview = vi
    .spyOn(WebClient.prototype, "sessionPromptPreview")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({
      sessionId: "s",
      sessionPath: "/s.jsonl",
      anchorEntryId: "leaf",
      entryId: "old",
      prompt: "Historical prompt",
      response: "Historical answer",
    });
  const view = renderHook(() => usePromptNavigation(selected(), loaded, true));
  await act(() => vi.advanceTimersByTimeAsync(0));
  await act(async () => {
    view.result.current.requestPreview("loaded");
    view.result.current.requestPreview("old");
    view.result.current.requestPreview("old");
  });
  expect(preview).toHaveBeenCalledOnce();
  expect(view.result.current.items[0]?.previewState).toBe("unavailable");
  await act(async () => view.result.current.requestPreview("old"));
  expect(preview).toHaveBeenCalledTimes(2);
  expect(view.result.current.items[0]).toMatchObject({
    title: "Historical prompt",
    reply: "Historical answer",
    previewState: "ready",
  });
  await act(async () => view.result.current.requestPreview("old"));
  expect(preview).toHaveBeenCalledTimes(2);
});

it("aborts hidden index reads and discards late responses from the old leaf/path before re-indexing", async () => {
  vi.useFakeTimers();
  let finish!: (result: WebSessionPromptHistoryPage) => void;
  const read = vi
    .spyOn(WebClient.prototype, "sessionPromptHistory")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({
      ...page(["copy-only", "loaded"]),
      sessionPath: "/copy.jsonl",
      anchorEntryId: "copy-leaf",
    });
  const view = renderHook(
    ({ session, active }) => usePromptNavigation(session, loaded, active),
    { initialProps: { session: selected(), active: true } },
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  const signal = read.mock.calls[0]![2];
  view.rerender({ session: selected(), active: false });
  expect(signal.aborted).toBe(true);
  view.rerender({
    session: selected("/copy.jsonl", "copy-leaf"),
    active: true,
  });
  await act(async () => finish(page(["wrong-old", "loaded"])));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(view.result.current.items.map((item) => item.entryId)).toEqual([
    "copy-only",
    "loaded",
  ]);
});
