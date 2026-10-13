// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import type {
  WebHistoryAnchor,
  WebSessionSummary,
  WebWorkspaceSummary,
} from "../../web/protocol/types.ts";
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
  vi.useRealTimers();
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
function session(id: string, options: Partial<WebSessionSummary> = {}) {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: "/project",
    source: "web-session",
    origin: "web",
    controller: "none",
    readOnly: false,
    name: id,
    modified: "2026-10-12T00:00:00.000Z",
    created: "2026-10-10T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "First message",
    ...options,
  } satisfies WebSessionSummary;
}

function mount(
  query = "needle",
  includeArchived = false,
  options: {
    sessions?: WebSessionSummary[];
    workspaces?: WebWorkspaceSummary[];
    onCreateSession?: () => void;
  } = {},
) {
  const onClose = vi.fn();
  const onOpenSession = vi.fn(
    async (_path: string, _signal?: AbortSignal) => true,
  );
  const onOpenMessage = vi.fn(
    async (_anchor: WebHistoryAnchor, _signal?: AbortSignal) => true,
  );
  const node = (
    open = true,
    scope: { initialQuery?: string; initialIncludeArchived?: boolean } = {},
  ) =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(TranscriptSearchDialog, {
        open,
        initialQuery: query,
        initialIncludeArchived: includeArchived,
        ...scope,
        ...options,
        onClose,
        onOpenSession: options.sessions ? onOpenSession : undefined,
        onOpenMessage,
      }),
    );
  const view = render(node());
  return { onClose, onOpenSession, onOpenMessage, node, view };
}

it("shows loaded recent conversations without a transcript request and opens the newest with Enter", async () => {
  vi.useFakeTimers();
  const search = vi.spyOn(WebClient.prototype, "searchTranscripts");
  const { onOpenSession, onOpenMessage, onClose } = mount("", false, {
    sessions: [
      session("Earlier", { modified: "2026-10-11T00:00:00.000Z" }),
      session("Archived", { archived: true }),
      session("Latest"),
    ],
  });
  const input = screen.getByRole("searchbox");
  expect(document.activeElement).toBe(input);
  expect(
    screen.getByRole("group", { name: "Recent conversations" }),
  ).not.toBeNull();
  expect(
    screen
      .getAllByRole("option", { name: /^Open conversation / })
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(["Open conversation Latest", "Open conversation Earlier"]);
  expect(
    screen.queryByRole("option", { name: "Open conversation Archived" }),
  ).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(search).not.toHaveBeenCalled();
  await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
  expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(
    "/sessions/Latest.jsonl",
    expect.any(AbortSignal),
  );
  expect(onOpenMessage).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});

it("groups pinned conversations separately from recent history and merges them when searching", () => {
  vi.spyOn(WebClient.prototype, "searchTranscripts");
  mount("", false, {
    sessions: [
      session("Pinned second", { pinOrder: 1 }),
      session("Recent"),
      session("Pinned first", {
        pinOrder: 0,
        modified: "2026-10-10T00:00:00.000Z",
      }),
    ],
  });
  expect(
    within(screen.getByRole("group", { name: "Pinned" }))
      .getAllByRole("option")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual([
    "Open conversation Pinned first",
    "Open conversation Pinned second",
  ]);
  const recent = within(
    screen.getByRole("group", { name: "Recent conversations" }),
  );
  expect(recent.getAllByRole("option")).toHaveLength(1);
  expect(
    recent.getByRole("option", { name: "Open conversation Recent" }),
  ).not.toBeNull();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "pinned" },
  });
  expect(screen.queryByRole("group", { name: "Pinned" })).toBeNull();
  expect(
    screen.queryByRole("group", { name: "Recent conversations" }),
  ).toBeNull();
  expect(
    within(screen.getByRole("group", { name: "Conversations" })).getAllByRole(
      "option",
    ),
  ).toHaveLength(2);
});

it("keeps every pin, previews ten recent conversations and limits matching titles to nine without clipping message results", async () => {
  const matches = Array.from({ length: 12 }, (_, index) => ({
    ...response(`Message ${index}`).matches[0]!,
    messageId: `entry-${index}`,
  }));
  vi.spyOn(WebClient.prototype, "searchTranscripts").mockResolvedValue({
    ...response("", true),
    matches,
  });
  const entries = Array.from({ length: 12 }, (_, index) =>
    session(`Topic ${String(index).padStart(2, "0")}`),
  );
  mount("", false, {
    sessions: [
      ...entries,
      ...entries.map((entry, index) => ({
        ...entry,
        path: `/pins/${index}.jsonl`,
        pinOrder: index,
      })),
    ],
  });
  expect(
    within(screen.getByRole("group", { name: "Pinned" })).getAllByRole(
      "option",
    ),
  ).toHaveLength(12);
  expect(
    within(
      screen.getByRole("group", { name: "Recent conversations" }),
    ).getAllByRole("option"),
  ).toHaveLength(10);
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "Topic" },
  });
  expect(
    within(screen.getByRole("group", { name: "Conversations" })).getAllByRole(
      "option",
    ),
  ).toHaveLength(9);
  await screen.findByText("Message 11");
  const results = within(screen.getByRole("group", { name: "Conversations" }));
  expect(
    results.getAllByRole("option", { name: /^Open conversation / }),
  ).toHaveLength(9);
  expect(
    results.getAllByRole("option", { name: /^Open message / }),
  ).toHaveLength(12);
  expect(screen.queryByRole("group", { name: "Message contents" })).toBeNull();
  expect(
    screen.getByText(
      "Some history could not be searched. Results may be incomplete.",
    ),
  ).not.toBeNull();
});

it("keeps the native dialog mounted but removes the closed body and restores it on reopening", () => {
  const { node, view } = mount("", false, { sessions: [session("Recent")] });
  const dialog = screen.getByRole("dialog");
  expect(
    screen.getByRole("option", { name: "Open conversation Recent" }),
  ).not.toBeNull();
  view.rerender(node(false));
  expect(document.querySelector("dialog")).toBe(dialog);
  expect(screen.queryByText("Recent")).toBeNull();
  expect(dialog.querySelector("input")).toBeNull();
  view.rerender(node(true));
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(
    screen.getByRole("option", { name: "Open conversation Recent" }),
  ).not.toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("searchbox"));
});

it.each(["click", "Enter"])(
  "opens the existing new-conversation action with %s when the loaded history is empty",
  (action) => {
    const onCreateSession = vi.fn();
    const { onClose, onOpenSession, onOpenMessage } = mount("", false, {
      sessions: [],
      onCreateSession,
    });
    if (action === "click")
      fireEvent.click(screen.getByRole("button", { name: "New session" }));
    else fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onCreateSession).toHaveBeenCalledOnce();
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(onOpenMessage).not.toHaveBeenCalled();
  },
);

it("matches titles and project names immediately and leaves them usable after a transcript failure", async () => {
  const search = vi
    .spyOn(WebClient.prototype, "searchTranscripts")
    .mockRejectedValue(new Error("offline"));
  const { onOpenSession, onClose } = mount("PlAtFoRm", false, {
    sessions: [session("Build notes"), session("Other", { cwd: "/another" })],
    workspaces: [{ path: "/project", name: "Platform team", current: true }],
  });
  const result = screen.getByRole("option", {
    name: "Open conversation Build notes",
  });
  expect(search).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("option", { name: "Open conversation Other" }),
  ).toBeNull();
  await screen.findByRole("button", { name: "Retry search" });
  onOpenSession.mockResolvedValueOnce(false);
  fireEvent.click(result);
  await screen.findByText("Could not open this conversation. Try again.");
  expect(screen.getByRole("button", { name: "Retry search" })).not.toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "BUILD" },
  });
  expect(
    screen.getByRole("option", { name: "Open conversation Build notes" }),
  ).not.toBeNull();
  expect(
    screen.queryByText("Could not open this conversation. Try again."),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("option", { name: "Open conversation Build notes" }),
  );
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

it("keeps typing focus while selecting, scrolling and opening a native message with the keyboard", async () => {
  vi.spyOn(WebClient.prototype, "searchTranscripts").mockResolvedValue(
    response("needle in message"),
  );
  const { onOpenSession, onOpenMessage } = mount("needle", false, {
    sessions: [session("Needle notes")],
  });
  const input = screen.getByRole("searchbox");
  const local = screen.getByRole("option", {
    name: "Open conversation Needle notes",
  });
  const message = await screen.findByRole("option", {
    name: "Open message from assistant in UI notes",
  });
  const scroll = vi.fn();
  message.scrollIntoView = scroll;
  const expectSelected = (option: HTMLElement) => {
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-activedescendant")).toBe(option.id);
    expect(option.getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByRole("option", { selected: true })).toEqual([option]);
  };
  expect(input.getAttribute("aria-controls")).toBe(
    screen.getByRole("listbox").id,
  );
  expectSelected(local);
  fireEvent.keyDown(input, { key: "ArrowDown", isComposing: true });
  expectSelected(local);
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  expect(onOpenSession).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expectSelected(message);
  expect(scroll).toHaveBeenLastCalledWith({ block: "nearest" });
  fireEvent.keyDown(input, { key: "ArrowUp" });
  expectSelected(local);
  fireEvent.keyDown(input, { key: "End" });
  expectSelected(message);
  fireEvent.keyDown(input, { key: "Home" });
  expectSelected(local);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
  expect(onOpenMessage).toHaveBeenCalledExactlyOnceWith(
    {
      sessionId: "id-a",
      sessionPath: "/sessions/a.jsonl",
      entryId: "entry-a",
    },
    expect.any(AbortSignal),
  );
  expect(onOpenSession).not.toHaveBeenCalled();
});

it("allows typing after keyboard or pointer selection and selects an available result as the query changes", async () => {
  vi.spyOn(WebClient.prototype, "searchTranscripts").mockResolvedValue({
    ...response(""),
    matches: [],
  });
  const { onOpenSession } = mount("", false, {
    sessions: [session("Notes A"), session("Notes B"), session("Other")],
  });
  const input = screen.getByRole("searchbox");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(screen.getByRole("option", { selected: true }).textContent).toContain(
    "Notes B",
  );
  const other = screen.getByRole("option", {
    name: "Open conversation Other",
  });
  fireEvent.pointerMove(other);
  fireEvent.mouseDown(other);
  expect(document.activeElement).toBe(input);
  expect(input.getAttribute("aria-activedescendant")).toBe(other.id);
  fireEvent.change(input, { target: { value: "Notes" } });
  expect(document.activeElement).toBe(input);
  expect(
    screen.queryByRole("option", { name: "Open conversation Other" }),
  ).toBeNull();
  const first = screen.getByRole("option", {
    name: "Open conversation Notes A",
  });
  expect(input.getAttribute("aria-activedescendant")).toBe(first.id);
  fireEvent.change(input, { target: { value: "No matching conversation" } });
  expect(input.getAttribute("aria-activedescendant")).toBeNull();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onOpenSession).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "Notes" } });
  fireEvent.keyDown(input, { key: "End" });
  await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
  expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(
    "/sessions/Notes B.jsonl",
    expect.any(AbortSignal),
  );
});

it("inherits the archive scope from its entry point without an extra filter control", () => {
  vi.spyOn(WebClient.prototype, "searchTranscripts");
  const { node, view } = mount("", false, {
    sessions: [session("Archived", { archived: true })],
  });
  expect(screen.getByText("No conversations yet")).not.toBeNull();
  expect(screen.queryByRole("checkbox")).toBeNull();
  view.rerender(node(true, { initialIncludeArchived: true }));
  expect(
    screen.getByRole("option", { name: "Open conversation Archived" }),
  ).not.toBeNull();
  expect(WebClient.prototype.searchTranscripts).not.toHaveBeenCalled();
});

it.each(["Escape", "outside click"])(
  "uses native dialog %s dismissal and restores focus to its trigger",
  (action) => {
    const trigger = document.createElement("button");
    trigger.textContent = "Search";
    document.body.append(trigger);
    trigger.focus();
    const { onClose, node, view } = mount("");
    const input = screen.getByRole("searchbox");
    expect(document.activeElement).toBe(input);
    fireEvent.click(input);
    expect(onClose).not.toHaveBeenCalled();
    if (action === "Escape") fireEvent.keyDown(input, { key: "Escape" });
    else fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(node(false));
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  },
);

it("cancels a pending conversation open when the query changes and ignores its late success", async () => {
  vi.spyOn(WebClient.prototype, "searchTranscripts").mockResolvedValue({
    ...response(""),
    matches: [],
  });
  const { onClose, onOpenSession } = mount("", false, {
    sessions: [session("First"), session("Second")],
  });
  let resolve!: (value: boolean) => void;
  onOpenSession.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  fireEvent.click(
    screen.getByRole("option", { name: "Open conversation First" }),
  );
  const signal = onOpenSession.mock.calls[0]![1]!;
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "Second" },
  });
  expect(signal.aborted).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>("option", {
      name: "Open conversation Second",
    }).disabled,
  ).toBe(false);
  await act(async () => resolve(true));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("option", { name: "Open conversation Second" }),
  );
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
});

it("opens the exact native message and renders snippets as text", async () => {
  const search = vi
    .spyOn(WebClient.prototype, "searchTranscripts")
    .mockResolvedValue(response('<img src=x onerror="alert(1)"> needle'));
  const { onClose, onOpenMessage } = mount();
  const result = await screen.findByRole("option", {
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
  expect(document.activeElement).toBe(screen.getByRole("searchbox"));
  expect(screen.getByRole("option", { selected: true })).toBe(result);
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
  const { node, view } = mount("old");
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
  view.rerender(
    node(true, { initialQuery: "new", initialIncludeArchived: true }),
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
  const result = await screen.findByRole("option", {
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
    await screen.findByRole("option", {
      name: "Open message from assistant in UI notes",
    }),
  );
  const firstSignal = onOpenMessage.mock.calls[0]![1]!;
  expect(firstSignal.aborted).toBe(false);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "B" } });
  expect(firstSignal.aborted).toBe(true);
  await screen.findByText("B result");
  const second = screen.getByRole<HTMLButtonElement>("option", {
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
  const { onClose, onOpenMessage, node, view } = mount();
  let reject!: (reason: Error) => void;
  onOpenMessage.mockReturnValueOnce(
    new Promise((_resolve, rejectPromise) => {
      reject = rejectPromise;
    }),
  );
  fireEvent.click(
    await screen.findByRole("option", {
      name: "Open message from assistant in UI notes",
    }),
  );
  const signal = onOpenMessage.mock.calls[0]![1]!;
  view.rerender(node(true, { initialIncludeArchived: true }));
  expect(signal.aborted).toBe(true);
  await act(async () => reject(new Error("Old window failed")));
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>("option", {
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
      await screen.findByRole("option", {
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
