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
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type { WebHistoryAnchor } from "../../web/protocol/types.ts";
import type { WebTranscriptSearchResponse } from "../../web/search/transcript-search.ts";
import { TranscriptSearchDialog } from "../../web/ui/src/features/sessions/TranscriptSearchDialog.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
afterAll(() => {
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

function response(
  snippet: string,
  partial = false,
): WebTranscriptSearchResponse {
  return {
    matches: [
      {
        sessionId: "id-a",
        sessionPath: "/sessions/a.jsonl",
        sessionName: "UI notes",
        workspace: "/project",
        sessionSource: "web",
        messageId: "entry-a",
        source: "assistant",
        snippet,
        snippetFormat: "plain-text",
        snippetTruncated: false,
        lineOffset: 120,
      },
    ],
    scannedFiles: 1,
    scannedBytes: 200,
    skippedFiles: 0,
    malformedLines: 0,
    partial,
    partialReasons: partial ? ["file-limit"] : [],
    limits: {
      maxFiles: 250,
      maxTotalBytes: 16 * 1024 * 1024,
      maxFileBytes: 4 * 1024 * 1024,
      maxLineBytes: 256 * 1024,
      maxResults: 100,
      maxSnippetBytes: 512,
      maxDurationMs: 1000,
    },
  };
}
function mount(query = "needle", includeArchived = false) {
  const onClose = vi.fn();
  const onOpenMessage = vi.fn(
    async (_anchor: WebHistoryAnchor, _signal?: AbortSignal) => true,
  );
  const node = (open = true) =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(TranscriptSearchDialog, {
        open,
        initialQuery: query,
        initialIncludeArchived: includeArchived,
        onClose,
        onOpenMessage,
      }),
    );
  const view = render(node());
  return { onClose, onOpenMessage, node, view };
}

it("opens the exact native message and renders snippets as text", async () => {
  const search = vi
    .spyOn(WebClient.prototype, "searchTranscripts")
    .mockResolvedValue(response('<img src=x onerror="alert(1)"> needle'));
  const { onClose, onOpenMessage } = mount();
  const result = await screen.findByRole("button", {
    name: "Open message from assistant in UI notes",
  });
  expect(search).toHaveBeenCalledWith(
    "needle",
    expect.objectContaining({ includeArchived: false }),
  );
  expect(
    screen.getByText('<img src=x onerror="alert(1)"> needle'),
  ).not.toBeNull();
  expect(document.querySelector(".transcript-search-results img")).toBeNull();
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowDown" });
  expect(document.activeElement).toBe(result);
  fireEvent.click(result);
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(onOpenMessage).toHaveBeenCalledExactlyOnceWith(
    {
      sessionId: "id-a",
      sessionPath: "/sessions/a.jsonl",
      entryId: "entry-a",
    },
    expect.any(AbortSignal),
  );
});

it("ignores stale search replies and searches the archive scope explicitly", async () => {
  let resolve!: (value: WebTranscriptSearchResponse) => void;
  const old = new Promise<WebTranscriptSearchResponse>((done) => {
    resolve = done;
  });
  const search = vi
    .spyOn(WebClient.prototype, "searchTranscripts")
    .mockReturnValueOnce(old)
    .mockResolvedValue(response("new result", true));
  mount("old");
  await waitFor(() => expect(search).toHaveBeenCalledOnce());
  const firstSignal = search.mock.calls[0]![1]!.signal!;
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new" } });
  await screen.findByText("new result");
  await act(async () => resolve(response("stale result")));
  expect(firstSignal.aborted).toBe(true);
  expect(screen.queryByText("stale result")).toBeNull();
  expect(
    screen.getByText(
      "Some history could not be searched. Results may be incomplete.",
    ),
  ).not.toBeNull();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Include archived conversations" }),
  );
  await waitFor(() =>
    expect(search).toHaveBeenLastCalledWith(
      "new",
      expect.objectContaining({ includeArchived: true }),
    ),
  );
});

it("keeps the search open when a message moved, and offers retry after search failure", async () => {
  vi.spyOn(WebClient.prototype, "searchTranscripts")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(response("needle"));
  const { onClose, onOpenMessage } = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Retry search" }));
  const result = await screen.findByRole("button", {
    name: "Open message from assistant in UI notes",
  });
  onOpenMessage.mockResolvedValue(false);
  fireEvent.click(result);
  await screen.findByText(
    "This message could not be opened. It may have moved or belong to another branch.",
  );
  expect(onClose).not.toHaveBeenCalled();
});

it("cancels an old message opening when the query changes and preserves the newer opening", async () => {
  vi.spyOn(WebClient.prototype, "searchTranscripts").mockImplementation(
    async (query) => {
      const result = response(`${query} result`);
      result.matches[0]!.messageId = query;
      return result;
    },
  );
  const { onClose, onOpenMessage } = mount("A");
  let resolveFirst!: (value: boolean) => void;
  let resolveSecond!: (value: boolean) => void;
  onOpenMessage
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    )
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSecond = resolve;
      }),
    );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Open message from assistant in UI notes",
    }),
  );
  const firstSignal = onOpenMessage.mock.calls[0]![1]!;
  expect(firstSignal.aborted).toBe(false);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "B" } });
  expect(firstSignal.aborted).toBe(true);
  await screen.findByText("B result");
  const second = screen.getByRole<HTMLButtonElement>("button", {
    name: "Open message from assistant in UI notes",
  });
  expect(second.disabled).toBe(false);
  fireEvent.click(second);
  const secondSignal = onOpenMessage.mock.calls[1]![1]!;
  await act(async () => resolveFirst(true));
  expect(onClose).not.toHaveBeenCalled();
  expect(second.disabled).toBe(true);
  expect(second.querySelector(".is-spinning")).not.toBeNull();
  expect(secondSignal.aborted).toBe(false);
  await act(async () => resolveSecond(true));
  expect(onClose).toHaveBeenCalledOnce();
});

it("cancels opening when the archive scope changes and ignores an obsolete failure", async () => {
  vi.spyOn(WebClient.prototype, "searchTranscripts").mockResolvedValue(
    response("needle"),
  );
  const { onClose, onOpenMessage } = mount();
  let reject!: (reason: Error) => void;
  onOpenMessage.mockReturnValueOnce(
    new Promise((_resolve, rejectPromise) => {
      reject = rejectPromise;
    }),
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Open message from assistant in UI notes",
    }),
  );
  const signal = onOpenMessage.mock.calls[0]![1]!;
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Include archived conversations" }),
  );
  expect(signal.aborted).toBe(true);
  await act(async () => reject(new Error("Old window failed")));
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Open message from assistant in UI notes",
      }).disabled,
    ).toBe(false),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
});

it.each(["close", "unmount"])(
  "aborts a pending native message read on dialog %s",
  async (action) => {
    vi.spyOn(WebClient.prototype, "searchTranscripts").mockResolvedValue(
      response("needle"),
    );
    const { onClose, onOpenMessage, node, view } = mount();
    let resolve!: (value: boolean) => void;
    onOpenMessage.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open message from assistant in UI notes",
      }),
    );
    const signal = onOpenMessage.mock.calls[0]![1]!;
    if (action === "close") view.rerender(node(false));
    else view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(true));
    expect(onClose).not.toHaveBeenCalled();
  },
);
