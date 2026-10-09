// @vitest-environment jsdom

import { Dialog } from "@astryxdesign/core/Dialog";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { createElement, Fragment, useState } from "react";
import { jsx } from "react/jsx-runtime";
import { I18nextProvider } from "react-i18next";
import { afterEach, expect, it, vi } from "vitest";
import {
  jsonByteLength,
  type WebHistoryAnchor,
  type WebSessionProjection,
  type WebSnapshot,
} from "../../web/protocol/types.ts";
import {
  type SessionReadingCache,
  sessionReadingScope,
} from "../../web/ui/src/features/transcript/session-reading-state.ts";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { useSessionHistory } from "../../web/ui/src/features/transcript/use-session-history.ts";
import { i18n } from "../../web/ui/src/i18n.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";
import type { LiveEntry } from "../../web/ui/src/store/web-store.ts";

type Navigation = WebHistoryAnchor & {
  revision: number;
  session: WebSessionProjection;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function session(
  from: number,
  through: number,
  leaf = through,
): WebSessionProjection {
  const entries = Array.from({ length: through - from + 1 }, (_, index) => ({
    type: "message" as const,
    id: `e${from + index}`,
    parentId: from + index ? `e${from + index - 1}` : null,
    timestamp: new Date(from + index).toISOString(),
    message: {
      role: from + index === 0 ? "user" : "assistant",
      content: `Message ${from + index}`,
    },
  }));
  return {
    id: "s",
    path: "/sessions/s.jsonl",
    cwd: "/workspace",
    entries,
    bytes: jsonByteLength(entries),
    truncation: {
      truncated: from > 0,
      entriesOmitted: from,
      messagesTruncated: 0,
      messagePartsOmitted: 0,
      maxBytes: 2 * 1024 * 1024,
    },
    history: {
      leafEntryId: `e${leaf}`,
      beforeEntryId: from > 0 ? `e${from}` : null,
    },
  };
}

function navigation(through = 3, revision = 1): Navigation {
  const window = session(0, through, 30);
  window.history = {
    ...window.history!,
    anchorEntryId: `e${through}`,
    anchorOnBranch: true,
  };
  return {
    sessionId: window.id,
    sessionPath: window.path,
    entryId: `e${through}`,
    revision,
    session: window,
  };
}

it("replaces a saved reading window with the exact bounded search window without loading unrelated pages", () => {
  const latest = session(29, 30);
  const cache: SessionReadingCache = new Map([
    [
      sessionReadingScope(latest),
      {
        window: {
          session: session(20, 21, 30),
          anchor: "e21",
          validatedLeaf: "e30",
        },
      },
    ],
  ]);
  const onRefresh = vi.fn(async () => true);
  const onAnchorChange = vi.fn();
  const read = vi.spyOn(WebClient.prototype, "sessionHistory");
  const target = navigation();
  const { result } = renderHook(() =>
    useSessionHistory(
      latest,
      { beforePrepend: vi.fn(), onRefresh, onAnchorChange },
      cache,
      target,
    ),
  );
  expect(result.current.session?.entries.map(({ id }) => id)).toEqual([
    "e0",
    "e1",
    "e2",
    "e3",
  ]);
  expect(result.current.engaged).toBe(true);
  expect(result.current.hasNewer).toBe(true);
  expect(result.current.verifying).toBe(false);
  expect(cache.get(sessionReadingScope(latest))?.window?.anchor).toBe("e3");
  expect(onAnchorChange).toHaveBeenLastCalledWith({
    sessionId: "s",
    sessionPath: latest.path,
    entryId: "e3",
  });
  expect(onRefresh).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it("rejects a copied-path or branch-invalid navigation window", () => {
  const latest = session(29, 30);
  const copied = navigation();
  copied.session.path = "/sessions/copy.jsonl";
  const { result, rerender } = renderHook(
    ({ target }) =>
      useSessionHistory(latest, { beforePrepend: vi.fn() }, undefined, target),
    { initialProps: { target: copied } },
  );
  expect(result.current.session).toBe(latest);
  expect(result.current.engaged).toBe(false);
  const rejected = navigation();
  rejected.session.history!.anchorOnBranch = false;
  rerender({ target: rejected });
  expect(result.current.session).toBe(latest);
  expect(result.current.engaged).toBe(false);
});

it("cancels an old page request when a new search navigation takes ownership of reading", async () => {
  const latest = session(29, 30);
  let finish!: (
    value: Awaited<ReturnType<WebClient["sessionHistory"]>>,
  ) => void;
  const read = vi
    .spyOn(WebClient.prototype, "sessionHistory")
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const { result, rerender } = renderHook(
    ({ target }: { target: Navigation | null }) =>
      useSessionHistory(latest, { beforePrepend: vi.fn() }, undefined, target),
    { initialProps: { target: null as Navigation | null } },
  );
  act(() => {
    void result.current.loadOlder();
  });
  expect(read).toHaveBeenCalledOnce();
  rerender({ target: navigation() });
  expect(read.mock.calls[0]![2].aborted).toBe(true);
  await act(async () =>
    finish({
      ...session(20, 28),
      anchorEntryId: "e30",
      requestedBeforeEntryId: "e29",
      history: {
        leafEntryId: "e30",
        beforeEntryId: "e20",
        anchorEntryId: "e30",
        anchorOnBranch: true,
      },
    }),
  );
  expect(result.current.session?.entries.at(-1)?.id).toBe("e3");
  expect(result.current.session?.entries[0]?.id).toBe("e0");
});

function snapshot(selected: WebSessionProjection): WebSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: "2026-09-30T00:00:00Z",
    cursor: 1,
    preferences: { theme: "system" },
    currentSessionId: selected.id,
    currentSessionPath: selected.path,
    selectedSession: selected,
    sessions: [],
    workspaces: [],
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
  };
}

function node(
  state: WebSnapshot,
  target: Navigation | null,
  cache: SessionReadingCache,
  liveMessages: LiveEntry[] = [],
  extra: Partial<Parameters<typeof Transcript>[0]> = {},
) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(Transcript, {
      snapshot: state,
      historyNavigation: target,
      readingCache: cache,
      liveMessages,
      liveRunning: false,
      livePhase: "idle",
      liveRetry: null,
      thinkingStarts: {},
      thinkingDurations: {},
      scrollToBottom: 0,
      onResend: async () => true,
      ...extra,
    }),
  );
}

it("uses the last included response as reading anchor while the requested prompt remains the focus target", () => {
  const latest = session(2, 4);
  const target = navigation(3);
  target.entryId = "e2";
  target.session.history!.anchorEntryId = "e2";
  target.session.history!.leafEntryId = "e4";
  const cache: SessionReadingCache = new Map();
  const onAnchorChange = vi.fn();
  const view = renderHook(
    ({ selected }) =>
      useSessionHistory(
        selected,
        { beforePrepend: vi.fn(), onAnchorChange },
        cache,
        target,
      ),
    { initialProps: { selected: latest } },
  );
  expect(onAnchorChange).toHaveBeenLastCalledWith({
    sessionId: "s",
    sessionPath: latest.path,
    entryId: "e3",
  });
  const appended = session(2, 5);
  appended.history!.anchorEntryId = "e3";
  appended.history!.anchorOnBranch = true;
  view.rerender({ selected: appended });
  const ids = view.result.current.session!.entries.map((entry) => entry.id);
  expect(ids).toEqual(["e0", "e1", "e2", "e3", "e4", "e5"]);
  expect(new Set(ids).size).toBe(ids.length);
});

it("cancels an unloaded reveal on a loaded click or hidden view and never hydrates unloaded scrubbing", async () => {
  vi.useFakeTimers();
  class PointerFixture extends MouseEvent {
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      Object.defineProperties(this, {
        pointerId: { value: init.pointerId },
        isPrimary: { value: init.isPrimary },
      });
    }
  }
  vi.stubGlobal("PointerEvent", PointerFixture);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("conversation")
        ? new DOMRect(0, 0, 1000, 500)
        : new DOMRect(80, 0, 840, 100);
    },
  );
  const selected = session(0, 7);
  selected.entries.forEach((entry, index) => {
    entry.message!.role = index % 2 ? "assistant" : "user";
  });
  vi.spyOn(WebClient.prototype, "sessionPromptHistory").mockResolvedValue({
    sessionId: "s",
    sessionPath: selected.path,
    anchorEntryId: "e7",
    requestedBeforeEntryId: null,
    entryIds: ["old", "e0", "e2", "e4", "e6"],
    nextBeforeEntryId: null,
  });
  let finish!: (result: boolean) => void;
  const navigate = vi.fn(
    (_anchor: WebHistoryAnchor, _signal?: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const cache: SessionReadingCache = new Map();
  const view = render(
    node(snapshot(selected), null, cache, [], {
      onNavigateToMessage: navigate,
    }),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  const old = view.container.querySelector<HTMLElement>(
    '[data-turn-entry="old"]',
  )!;
  const loaded = view.container.querySelector<HTMLElement>(
    '[data-turn-entry="e2"]',
  )!;
  fireEvent.click(old);
  expect(navigate).toHaveBeenCalledOnce();
  const firstSignal = navigate.mock.calls[0]![1]!;
  fireEvent.click(loaded);
  expect(firstSignal.aborted).toBe(true);
  expect(document.activeElement).toBe(
    view.container.querySelector('[data-history-entry="e2"]'),
  );
  await act(async () => finish(true));
  expect(navigate).toHaveBeenCalledOnce();
  const rail = view.container.querySelector<HTMLElement>(".turn-rail")!;
  [...rail.querySelectorAll<HTMLElement>(".turn-tick")].forEach(
    (button, index) => {
      vi.spyOn(button, "getBoundingClientRect").mockReturnValue(
        new DOMRect(952, index * 10, 36, 10),
      );
    },
  );
  fireEvent.pointerDown(old, {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientY: 60,
  });
  fireEvent.pointerMove(rail, { pointerId: 1, isPrimary: true, clientY: 5 });
  expect(navigate).toHaveBeenCalledOnce();
  fireEvent.pointerMove(rail, { pointerId: 1, isPrimary: true, clientY: 25 });
  expect(document.activeElement).toBe(
    view.container.querySelector('[data-history-entry="e2"]'),
  );
  fireEvent.pointerUp(rail, { pointerId: 1, isPrimary: true });
  fireEvent.click(old);
  expect(navigate).toHaveBeenCalledOnce(); // Suppress the drag's following click.
  fireEvent.click(old);
  expect(navigate).toHaveBeenCalledTimes(2);
  view.rerender(
    node(snapshot(selected), null, cache, [], {
      onNavigateToMessage: navigate,
      resultExposureEnabled: false,
    }),
  );
  expect(navigate.mock.calls[1]![1]!.aborted).toBe(true);
  await act(async () => finish(true));
  view.unmount();
  vi.unstubAllGlobals();
});

it("keeps the complete native index usable for keyboard reveal after the rail gutter narrows", async () => {
  vi.useFakeTimers();
  let gutter = 80;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains("conversation"))
        return new DOMRect(0, 0, 1000, 500);
      const id = this.dataset.historyEntry;
      const top = id ? (Number(id.slice(1)) - 4) * 100 + 16 : 16;
      return new DOMRect(80, top, 920 - gutter, 120);
    },
  );
  const latest = session(6, 7);
  latest.entries[0]!.message!.role = "user";
  const older = session(0, 5, 7);
  older.entries.forEach((entry, index) => {
    entry.message!.role = index % 2 ? "assistant" : "user";
  });
  older.history!.anchorEntryId = "e4";
  older.history!.anchorOnBranch = true;
  const target: Navigation = {
    sessionId: older.id,
    sessionPath: older.path,
    entryId: "e4",
    revision: 1,
    session: older,
  };
  const read = vi
    .spyOn(WebClient.prototype, "sessionPromptHistory")
    .mockResolvedValue({
      sessionId: latest.id,
      sessionPath: latest.path,
      anchorEntryId: "e7",
      requestedBeforeEntryId: null,
      entryIds: ["e0", "e2", "e4", "e6"],
      nextBeforeEntryId: null,
    });
  const navigate = vi.fn(
    async (_anchor: WebHistoryAnchor, _signal?: AbortSignal) => true,
  );
  try {
    const view = render(
      node(snapshot(latest), target, new Map(), [], {
        onNavigateToMessage: navigate,
      }),
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(
      view.container.querySelector('[data-turn-entry="e6"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector('[data-history-entry="e6"]'),
    ).toBeNull();
    gutter = 24;
    fireEvent.resize(window);
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(
      view.container.querySelector<HTMLElement>(".turn-rail")!.style.visibility,
    ).toBe("hidden");
    expect(
      view.container.querySelector('[data-turn-entry="e6"]'),
    ).not.toBeNull();
    const prompt = view.container.querySelector<HTMLElement>(
      '[data-history-entry="e4"]',
    )!;
    prompt.focus();
    fireEvent.keyDown(document, { key: "ArrowDown", altKey: true });
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      { sessionId: latest.id, sessionPath: latest.path, entryId: "e6" },
      expect.any(AbortSignal),
    );
    expect(read).toHaveBeenCalledOnce();
    view.rerender(
      node(snapshot(latest), target, new Map(), [], {
        onNavigateToMessage: navigate,
        resultExposureEnabled: false,
      }),
    );
    fireEvent.keyDown(document, { key: "ArrowDown", altKey: true });
    expect(navigate).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("does not report an obsolete rail failure after external search navigation has succeeded", async () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("conversation")
        ? new DOMRect(0, 0, 1000, 500)
        : new DOMRect(80, 0, 840, 100);
    },
  );
  const selected = session(0, 7);
  selected.entries.forEach((entry, index) => {
    entry.message!.role = index % 2 ? "assistant" : "user";
  });
  vi.spyOn(WebClient.prototype, "sessionPromptHistory").mockResolvedValue({
    sessionId: "s",
    sessionPath: selected.path,
    anchorEntryId: "e7",
    requestedBeforeEntryId: null,
    entryIds: ["old", "e0", "e2", "e4", "e6"],
    nextBeforeEntryId: null,
  });
  let finish!: (result: boolean) => void;
  const navigate = vi.fn(
    (_anchor: WebHistoryAnchor, _signal?: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const cache: SessionReadingCache = new Map();
  const view = render(
    node(snapshot(selected), null, cache, [], {
      onNavigateToMessage: navigate,
    }),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  fireEvent.click(view.container.querySelector('[data-turn-entry="old"]')!);
  const signal = navigate.mock.calls[0]![1]!;
  const target = navigation(3);
  target.session.history!.leafEntryId = "e7";
  view.rerender(
    node(snapshot(selected), target, cache, [], {
      onNavigateToMessage: navigate,
    }),
  );
  expect(signal.aborted).toBe(true);
  await act(async () => finish(false));
  expect(view.container.querySelector(".turn-navigation-error")).toBeNull();
  vi.useRealTimers();
});

it("navigates native setup landmarks inside the selected scrollport and returns focus to their body", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("conversation")
        ? new DOMRect(0, 0, 1000, 500)
        : new DOMRect(80, 0, 840, 100);
    },
  );
  const selected = session(0, 7);
  selected.entries[2]!.message = {
    role: "custom",
    customType: "openpi-setup-request",
    display: true,
    content: "Apply a dark theme",
    details: { command: "openpi-setup", request: "Apply a dark theme" },
  };
  selected.entries[4]!.message = { role: "user", content: "Later prompt" };
  selected.entries[6]!.message = { role: "user", content: "Fourth prompt" };
  const unrelated = document.createElement("article");
  unrelated.dataset.historyEntry = "e2";
  unrelated.tabIndex = -1;
  document.body.append(unrelated);
  const view = render(node(snapshot(selected), null, new Map()));
  const target = view.container.querySelector<HTMLElement>(
    '.conversation [data-history-entry="e2"]',
  )!;
  fireEvent.click(
    screen.getByRole("button", {
      name: i18n.t("conversationTurnPosition", { position: 2 }),
    }),
  );
  expect(document.activeElement).toBe(target);
  expect(document.activeElement).not.toBe(unrelated);
  expect(target.tabIndex).toBe(-1);
  unrelated.remove();
});

it("closes the turn preview when the same native IDs are displayed from another Session path", async () => {
  vi.useFakeTimers();
  try {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("conversation")
          ? new DOMRect(0, 0, 1000, 500)
          : new DOMRect(80, 0, 840, 100);
      },
    );
    const selected = session(0, 7);
    selected.entries[2]!.message = { role: "user", content: "Second prompt" };
    selected.entries[4]!.message = { role: "user", content: "Third prompt" };
    selected.entries[6]!.message = { role: "user", content: "Fourth prompt" };
    const cache: SessionReadingCache = new Map();
    const view = render(node(snapshot(selected), null, cache));
    const first = screen.getByRole("button", {
      name: i18n.t("conversationTurnPosition", { position: 1 }),
    });
    fireEvent.mouseEnter(first);
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(view.container.querySelector(".turn-preview")).toBeTruthy();
    view.rerender(
      node(
        snapshot({ ...selected, path: "/sessions/copy.jsonl" }),
        null,
        cache,
      ),
    );
    expect(view.container.querySelector(".turn-preview")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: i18n.t("conversationTurnPosition", { position: 1 }),
      }),
    ).not.toBe(first);
  } finally {
    vi.useRealTimers();
  }
});

it("scrolls to and focuses the matched message, stays there during append, and can revisit the same result", async () => {
  const latest = session(29, 30);
  const target = navigation();
  const cache: SessionReadingCache = new Map();
  const originalScroll = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollTo",
  );
  const scroll = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
    this.scrollTop = options.top ?? 0;
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: scroll,
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains("conversation"))
        return new DOMRect(0, 10, 300, 100);
      if (this.dataset.historyMessage === "e3")
        return new DOMRect(
          0,
          210 - this.closest<HTMLElement>(".conversation")!.scrollTop,
          300,
          50,
        );
      return new DOMRect();
    },
  );
  try {
    const view = render(node(snapshot(latest), target, cache));
    await act(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const viewport =
      view.container.querySelector<HTMLElement>(".conversation")!;
    const matched = view.container.querySelector<HTMLElement>(
      '[data-history-message="e3"]',
    )!;
    expect(viewport.scrollTop).toBe(176);
    expect(document.activeElement).toBe(matched);
    expect(matched.dataset.historyHighlighted).toBe("true");
    expect(
      screen.getByRole("button", { name: i18n.t("jumpToLatest") }),
    ).toBeTruthy();
    scroll.mockClear();
    view.rerender(node(snapshot(session(30, 31)), target, cache));
    expect(viewport.scrollTop).toBe(176);
    expect(scroll).not.toHaveBeenCalled();
    viewport.scrollTop = 20;
    fireEvent.scroll(viewport);
    view.rerender(
      node(snapshot(session(30, 31)), { ...target, revision: 2 }, cache),
    );
    await act(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(viewport.scrollTop).toBe(176);
    expect(scroll).toHaveBeenCalledOnce();
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("jumpToLatest") }),
    );
    expect(screen.getByText("Message 31")).toBeTruthy();
    expect(
      view.container.querySelector('[data-history-highlighted="true"]'),
    ).toBeNull();
  } finally {
    if (originalScroll)
      Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScroll);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  }
});

it("reveals the exact native receipt inside a bounded process group and preserves the reader on append", async () => {
  const methods = new Map(
    ["scrollTo", "scrollIntoView"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, name),
    ]),
  );
  const scroll = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
    this.scrollTop = Math.max(
      0,
      Math.min(options.top ?? 0, this.scrollHeight - this.clientHeight),
    );
  });
  const reveal = vi.fn(function (this: HTMLElement) {
    const inner = this.closest<HTMLElement>(".process-sequence-scroll");
    if (!inner) return;
    const item = this.getBoundingClientRect();
    const bounds = inner.getBoundingClientRect();
    if (item.top < bounds.top) inner.scrollTop += item.top - bounds.top;
    else if (item.bottom > bounds.bottom)
      inner.scrollTop += item.bottom - bounds.bottom;
  });
  Object.defineProperties(HTMLElement.prototype, {
    scrollTo: { configurable: true, value: scroll },
    scrollIntoView: { configurable: true, value: reveal },
  });
  try {
    const selected = session(0, 0);
    const tools = Array.from({ length: 12 }, (_, index) => ({
      type: "toolCall" as const,
      id: `tool-${index}`,
      name: "read",
      arguments: JSON.stringify({ path: `/workspace/file-${index}.ts` }),
    }));
    selected.entries.push({
      id: "assistant",
      parentId: "e0",
      type: "message",
      timestamp: "2026-09-30T00:00:01Z",
      message: { role: "assistant", content: "", parts: tools },
    });
    selected.entries.push(
      ...tools.map((tool, index) => ({
        id: `receipt-${index}`,
        parentId: index ? `receipt-${index - 1}` : "assistant",
        type: "message" as const,
        timestamp: "2026-09-30T00:00:02Z",
        message: {
          role: "toolResult",
          toolCallId: tool.id,
          toolName: tool.name,
          content: `Exact receipt ${index}`,
          isError: false,
        },
      })),
    );
    selected.history = { leafEntryId: "receipt-11", beforeEntryId: null };
    const cache: SessionReadingCache = new Map();
    const view = render(node(snapshot(selected), null, cache));
    const viewport =
      view.container.querySelector<HTMLElement>(".conversation")!;
    const inner = view.container.querySelector<HTMLElement>(
      ".process-sequence-scroll",
    )!;
    const sequence = inner.closest<HTMLDetailsElement>(".process-sequence")!;
    let innerTop = 0;
    Object.defineProperties(viewport, {
      scrollHeight: { get: () => 2200 },
      clientHeight: { get: () => 600 },
    });
    Object.defineProperties(inner, {
      scrollHeight: { get: () => 900 },
      clientHeight: { get: () => 360 },
      scrollTop: {
        get: () => innerTop,
        set: (top: number) => {
          innerTop = Math.max(0, Math.min(top, 540));
        },
      },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this === viewport) return new DOMRect(0, 0, 1000, 600);
        if (this === inner)
          return new DOMRect(0, 600 - viewport.scrollTop, 800, 360);
        if (this.dataset.historyResult) {
          const index = Number(this.dataset.historyResult.slice(8));
          return new DOMRect(
            0,
            600 - viewport.scrollTop + index * 64 - innerTop,
            800,
            40,
          );
        }
        return new DOMRect();
      },
    );
    const target: Navigation = {
      sessionId: selected.id,
      sessionPath: selected.path,
      entryId: "receipt-9",
      revision: 1,
      session: {
        ...selected,
        history: {
          ...selected.history,
          anchorEntryId: "receipt-9",
          anchorOnBranch: true,
        },
      },
    };
    view.rerender(node(snapshot(selected), target, cache));
    await act(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const matched = view.container.querySelector<HTMLElement>(
      '[data-history-result="receipt-9"]',
    )!;
    expect(sequence.open).toBe(true);
    expect(matched.textContent).toContain("Exact receipt 9");
    expect(
      matched.querySelector(".tool-evidence-card")?.getAttribute("data-state"),
    ).toBe("returned");
    expect(inner.scrollTop).toBeGreaterThan(0);
    expect(matched.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      inner.getBoundingClientRect().top,
    );
    expect(matched.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      inner.getBoundingClientRect().bottom,
    );
    expect(matched.getBoundingClientRect().top).toBe(24);
    expect(document.activeElement).toBe(matched);
    expect(matched.dataset.historyHighlighted).toBe("true");
    inner.scrollTop = 180;
    fireEvent.scroll(inner);
    viewport.scrollTop = 700;
    fireEvent.scroll(viewport);
    scroll.mockClear();
    reveal.mockClear();
    const appended = {
      ...selected,
      entries: [
        ...selected.entries,
        {
          id: "after",
          parentId: "receipt-11",
          type: "message" as const,
          timestamp: "2026-09-30T00:00:03Z",
          message: { role: "assistant", content: "Appended native response" },
        },
      ],
      history: {
        ...selected.history,
        leafEntryId: "after",
        anchorEntryId: "receipt-11",
        anchorOnBranch: true,
      },
    };
    view.rerender(node(snapshot(appended), target, cache));
    expect(screen.getByText("Appended native response")).toBeTruthy();
    expect(inner.scrollTop).toBe(180);
    expect(viewport.scrollTop).toBe(700);
    expect(scroll).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  } finally {
    for (const [name, descriptor] of methods) {
      if (descriptor)
        Object.defineProperty(HTMLElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLElement.prototype, name);
    }
  }
});

it("keeps a smooth loaded-turn jump unpinned through its first frames without unpinning layout clamps, and follows again on a downward return", async () => {
  const originalScroll = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollTo",
  );
  const scroll = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
    if (options.behavior !== "smooth")
      this.scrollTop = Math.min(
        options.top ?? 0,
        this.scrollHeight - this.clientHeight,
      );
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: scroll,
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1530);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(627);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("conversation")
        ? new DOMRect(0, 0, 1000, 627)
        : new DOMRect(80, -160, 840, 100);
    },
  );
  try {
    const selected = session(0, 7);
    selected.entries.forEach((entry, index) => {
      entry.message!.role = index % 2 ? "assistant" : "user";
    });
    vi.spyOn(WebClient.prototype, "sessionPromptHistory").mockResolvedValue({
      sessionId: selected.id,
      sessionPath: selected.path,
      anchorEntryId: "e7",
      requestedBeforeEntryId: null,
      entryIds: ["e0", "e2", "e4", "e6"],
      nextBeforeEntryId: null,
    });
    const cache: SessionReadingCache = new Map();
    const view = render(node(snapshot(selected), null, cache));
    await act(async () => {});
    const viewport =
      view.container.querySelector<HTMLElement>(".conversation")!;
    expect(viewport.scrollTop).toBe(903);
    // A layout clamp while following should preserve automatic following.
    viewport.scrollTop = 900;
    fireEvent.scroll(viewport);
    view.rerender(node(snapshot(selected), null, cache));
    expect(viewport.scrollTop).toBe(903);
    expect(
      screen.queryByRole("button", { name: i18n.t("jumpToLatest") }),
    ).toBeNull();
    fireEvent.click(
      view.container.querySelector<HTMLElement>('[data-turn-entry="e2"]')!,
    );
    expect(scroll).toHaveBeenLastCalledWith({ top: 727, behavior: "smooth" });
    // A smooth jump can emit an unchanged first frame, then move within 48px.
    fireEvent.scroll(viewport);
    viewport.scrollTop = 900;
    fireEvent.scroll(viewport);
    expect(
      screen.getByRole("button", { name: i18n.t("jumpToLatest") }),
    ).toBeTruthy();
    scroll.mockClear();
    view.rerender(node(snapshot(selected), null, cache));
    expect(viewport.scrollTop).toBe(900);
    expect(scroll).not.toHaveBeenCalled();
    viewport.scrollTop = 903;
    fireEvent.scroll(viewport);
    view.rerender(node(snapshot(selected), null, cache));
    expect(scroll).toHaveBeenCalledWith({ top: 1530, behavior: "instant" });
    expect(
      screen.queryByRole("button", { name: i18n.t("jumpToLatest") }),
    ).toBeNull();
  } finally {
    if (originalScroll)
      Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScroll);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  }
});

it.each(["wheel", "ArrowUp", "PageUp", "Home", "Shift+Space"])(
  "pauses streamed bottom following on %s before scroll delivery and resumes on a downward return",
  async (input) => {
    const originalScroll = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollTo",
    );
    const scroll = vi.fn(function (
      this: HTMLElement,
      options: ScrollToOptions,
    ) {
      this.scrollTop = Math.min(
        options.top ?? 0,
        this.scrollHeight - this.clientHeight,
      );
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scroll,
    });
    let height = 1530;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      () => height,
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(627);
    try {
      const selected = session(0, 1);
      const state = snapshot(selected);
      state.runtime.status = "running";
      const cache: SessionReadingCache = new Map();
      const stream = (content: string) =>
        node(
          state,
          null,
          cache,
          [{ key: "stream", message: { role: "assistant", content } }],
          { liveRunning: true, livePhase: "running" },
        );
      const view = render(stream("First streamed text"));
      const viewport =
        view.container.querySelector<HTMLElement>(".conversation")!;
      expect(viewport.scrollTop).toBe(903);
      scroll.mockClear();
      if (input === "wheel") fireEvent.wheel(viewport, { deltaY: -3 });
      else
        fireEvent.keyDown(viewport, {
          key: input === "Shift+Space" ? " " : input,
          shiftKey: input === "Shift+Space",
        });
      // Streaming can render between the input and the browser's scroll event.
      view.rerender(stream("Second streamed text"));
      expect(screen.getByText("Second streamed text")).toBeTruthy();
      expect(viewport.scrollTop).toBe(903);
      expect(scroll).not.toHaveBeenCalled();
      viewport.scrollTop = 900;
      fireEvent.scroll(viewport);
      expect(
        screen.getByRole("button", { name: i18n.t("jumpToLatest") }),
      ).toBeTruthy();
      height = 1550;
      view.rerender(stream("Third streamed text"));
      expect(viewport.scrollTop).toBe(900);
      expect(scroll).not.toHaveBeenCalled();
      // Unchanged near-bottom frames must not undo the reader's pause.
      fireEvent.scroll(viewport);
      view.rerender(stream("Fourth streamed text"));
      expect(screen.getByText("Fourth streamed text")).toBeTruthy();
      expect(viewport.scrollTop).toBe(900);
      expect(scroll).not.toHaveBeenCalled();
      viewport.scrollTop = height - viewport.clientHeight;
      fireEvent.scroll(viewport);
      expect(
        screen.queryByRole("button", { name: i18n.t("jumpToLatest") }),
      ).toBeNull();
      height = 1600;
      view.rerender(stream("Fifth streamed text"));
      expect(viewport.scrollTop).toBe(973);
      expect(scroll).toHaveBeenCalledWith({ top: 1600, behavior: "instant" });
    } finally {
      if (originalScroll)
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollTo",
          originalScroll,
        );
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    }
  },
);

it("returns keyboard focus to the conversation when the latest button disappears", () => {
  const view = render(node(snapshot(session(0, 3)), null, new Map()));
  const viewport = view.container.querySelector<HTMLElement>(".conversation")!;
  Object.defineProperties(viewport, {
    clientHeight: { get: () => 360 },
    scrollHeight: { get: () => 900 },
  });
  viewport.scrollTo = vi.fn();
  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  const jump = screen.getByRole("button", { name: i18n.t("jumpToLatest") });
  jump.focus();
  expect(document.activeElement).toBe(jump);
  const focus = vi.spyOn(viewport, "focus");
  fireEvent.click(jump);
  expect(
    screen.queryByRole("button", { name: i18n.t("jumpToLatest") }),
  ).toBeNull();
  expect(document.activeElement).toBe(viewport);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(viewport.scrollTo).toHaveBeenCalledWith({
    top: 900,
    behavior: "smooth",
  });
});

it.each(
  ["conversation", "process"].flatMap((owner) =>
    ["summary", "button"].flatMap((control) =>
      ["ArrowUp", "PageUp", "Home", "Shift+Space"].map((key) => ({
        owner,
        control,
        key,
      })),
    ),
  ),
)(
  "preserves $owner keyboard ownership for $key on a focused $control before scroll delivery",
  ({ owner, control, key }) => {
    const calls = ["first", "second"].map((id) => ({
      type: "toolCall" as const,
      id,
      name: "bash",
      arguments: '{"command":"printf test"}',
    }));
    const selected = session(0, 1);
    selected.entries[1]!.message!.content = "";
    selected.entries[1]!.message!.parts = calls;
    const cache: SessionReadingCache = new Map();
    const stream = (content: string) => {
      const state = snapshot(selected);
      state.preferences.bashToolDisplay = "full";
      state.runtime.status = "running";
      state.runtime.liveTools = calls.map((call, index) => ({
        call,
        state: index === 0 ? "returned" : "running",
        result: {
          role: "toolResult",
          toolName: call.name,
          toolCallId: call.id,
          content: index === 0 ? "Completed first command" : content,
          isError: false,
        },
      }));
      return node(state, null, cache, [], {
        liveRunning: true,
        livePhase: "running",
      });
    };
    const view = render(stream("First native output"));
    const scroller = view.container.querySelector<HTMLElement>(
      ".process-sequence-scroll",
    )!;
    scroller.style.overflowY = "auto";
    scroller.style.overscrollBehaviorY = "contain";
    const viewport =
      view.container.querySelector<HTMLElement>(".conversation")!;
    const element = owner === "process" ? scroller : viewport;
    let top = 0;
    let height = 900;
    const setTop = vi.fn((value: number) => {
      top = Math.max(0, Math.min(value, height - 360));
    });
    Object.defineProperties(element, {
      clientHeight: { get: () => 360 },
      scrollHeight: { get: () => height },
      scrollTop: { get: () => top, set: setTop },
    });
    if (owner === "conversation")
      element.scrollTo = vi.fn((options: ScrollToOptions) => {
        element.scrollTop = options.top ?? 0;
      });
    view.rerender(stream("Second native output"));
    expect(element.scrollTop).toBe(540);
    const target = view.container.querySelector<HTMLElement>(
      owner === "process"
        ? control === "summary"
          ? ".tool-evidence-card > summary"
          : ".evidence-shell button"
        : control === "summary"
          ? ".process-sequence > summary"
          : ".message-row.user .message-actions button",
    )!;
    expect(target).toBeTruthy();
    target.focus();
    expect(document.activeElement).toBe(target);
    setTop.mockClear();
    fireEvent.keyDown(target, {
      key: key === "Shift+Space" ? " " : key,
      shiftKey: key === "Shift+Space",
    });
    view.rerender(stream("Third native output"));
    expect(view.container.textContent).toContain("Third native output");
    if (key === "Shift+Space") {
      expect(setTop).toHaveBeenCalledWith(height);
      expect(element.scrollTop).toBe(540);
      return;
    }
    expect(setTop).not.toHaveBeenCalled();
    element.scrollTop = 533;
    fireEvent.scroll(element);
    setTop.mockClear();
    height = 920;
    view.rerender(stream("Fourth native output"));
    expect(element.scrollTop).toBe(533);
    expect(setTop).not.toHaveBeenCalled();
    element.scrollTop = height - element.clientHeight;
    fireEvent.scroll(element);
    height = 1000;
    view.rerender(stream("Fifth native output"));
    expect(element.scrollTop).toBe(640);
  },
);

it("preserves an upward reader through a prepended bottom clamp and resumes after a downward return", async () => {
  const originalScroll = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollTo",
  );
  const scroll = vi.fn(function (this: HTMLElement, options: ScrollToOptions) {
    this.scrollTop = Math.min(
      options.top ?? 0,
      this.scrollHeight - this.clientHeight,
    );
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: scroll,
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
  vi.spyOn(WebClient.prototype, "sessionHistory").mockImplementation(
    async (anchor, before) => {
      const older = session(0, 1, 3);
      return {
        ...older,
        anchorEntryId: anchor.entryId,
        requestedBeforeEntryId: before,
        history: {
          ...older.history!,
          anchorEntryId: anchor.entryId,
          anchorOnBranch: true,
        },
      };
    },
  );
  try {
    const selected = session(2, 3);
    const cache: SessionReadingCache = new Map();
    const view = render(node(snapshot(selected), null, cache));
    const viewport =
      view.container.querySelector<HTMLElement>(".conversation")!;
    await act(async () => {});
    expect(viewport.scrollTop).toBe(300);
    await act(async () => fireEvent.wheel(viewport, { deltaY: -1 }));
    expect(screen.getByText("Message 0")).toBeTruthy();
    expect(viewport.scrollTop).toBe(300);
    fireEvent.scroll(viewport);
    scroll.mockClear();
    view.rerender(node(snapshot(selected), null, cache));
    expect(scroll).not.toHaveBeenCalled();
    expect(viewport.scrollTop).toBe(300);
    expect(
      screen.getByRole("button", { name: i18n.t("jumpToLatest") }),
    ).toBeTruthy();
    viewport.scrollTop = 299;
    fireEvent.scroll(viewport);
    viewport.scrollTop = 300;
    fireEvent.scroll(viewport);
    view.rerender(node(snapshot(selected), null, cache));
    expect(scroll).toHaveBeenCalledWith({ top: 800, behavior: "instant" });
    expect(
      screen.queryByRole("button", { name: i18n.t("jumpToLatest") }),
    ).toBeNull();
  } finally {
    if (originalScroll)
      Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScroll);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  }
});

it("loads the single prefetched page on upward scrolling and keeps the next page outside the DOM", async () => {
  const read = vi
    .spyOn(WebClient.prototype, "sessionHistory")
    .mockImplementation(async (anchor, before) => {
      const end = Number(before.slice(1));
      const older = session(end - 2, end - 1, 7);
      return {
        ...older,
        anchorEntryId: anchor.entryId,
        requestedBeforeEntryId: before,
        history: {
          ...older.history!,
          anchorEntryId: anchor.entryId,
          anchorOnBranch: true,
        },
      };
    });
  const view = render(node(snapshot(session(6, 7)), null, new Map()));
  const viewport = view.container.querySelector<HTMLElement>(".conversation")!;
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(viewport, "clientHeight", {
    configurable: true,
    value: 300,
  });
  await act(async () => {});
  expect(read).toHaveBeenCalledOnce();
  expect(screen.queryByText("Message 4")).toBeNull();
  expect(
    screen.queryByRole("button", { name: i18n.t("jumpToLatest") }),
  ).toBeNull();
  viewport.scrollTop = 700;
  fireEvent.scroll(viewport);
  viewport.scrollTop = 200;
  await act(async () => fireEvent.scroll(viewport));
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls.map(([, before]) => before)).toEqual(["e6", "e4"]);
  expect(screen.getByText("Message 4")).toBeTruthy();
  expect(screen.queryByText("Message 2")).toBeNull();
  expect(
    screen.getByRole("button", { name: i18n.t("jumpToLatest") }),
  ).toBeTruthy();
});

it("prepends distinct native turns in order even when every provider timestamp is identical", async () => {
  const simultaneous = (value: WebSessionProjection) => ({
    ...value,
    entries: value.entries.map((entry, index) => ({
      ...entry,
      message: {
        ...entry.message!,
        role: index % 2 ? "assistant" : "user",
        timestamp: 42,
      },
    })),
  });
  const read = vi
    .spyOn(WebClient.prototype, "sessionHistory")
    .mockImplementation(async (anchor, before) => {
      const end = Number(before.slice(1));
      const older = simultaneous(session(end - 4, end - 1, 11));
      return {
        ...older,
        anchorEntryId: anchor.entryId,
        requestedBeforeEntryId: before,
        history: {
          ...older.history!,
          anchorEntryId: anchor.entryId,
          anchorOnBranch: true,
        },
      };
    });
  const view = render(
    node(snapshot(simultaneous(session(8, 11))), null, new Map()),
  );
  const viewport = view.container.querySelector<HTMLElement>(".conversation")!;
  const ids = () =>
    [...viewport.querySelectorAll<HTMLElement>(".message-row")].map(
      (row) => row.dataset.historyMessage ?? row.dataset.historyEntry,
    );
  const latestQuestion = viewport.querySelector('[data-history-entry="e8"]');
  await act(async () => {});
  expect(ids()).toEqual(["e8", "e9", "e10", "e11"]);
  await act(async () => fireEvent.wheel(viewport, { deltaY: -100 }));
  expect(ids()).toEqual(
    Array.from({ length: 8 }, (_, index) => `e${index + 4}`),
  );
  expect(viewport.querySelector('[data-history-entry="e8"]')).toBe(
    latestQuestion,
  );
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => fireEvent.wheel(viewport, { deltaY: -100 }));
  expect(ids()).toEqual(Array.from({ length: 12 }, (_, index) => `e${index}`));
  expect(viewport.querySelector('[data-history-entry="e8"]')).toBe(
    latestQuestion,
  );
  expect(read).toHaveBeenCalledTimes(2);
});

it.each(["thinking", "tool"])(
  "retains a manually opened live %s disclosure when its exact native message arrives",
  (kind) => {
    const initial = session(0, 0);
    const live: LiveEntry = {
      key: "stream-1",
      message: {
        role: "assistant",
        timestamp: 42,
        content: "Native answer",
        parts: [
          kind === "thinking"
            ? { type: "thinking", text: "Visible thinking summary" }
            : {
                type: "toolCall",
                id: "read-call",
                name: "read",
                arguments: '{"path":"src.ts"}',
              },
          { type: "text", text: "Native answer" },
        ],
      },
    };
    const cache: SessionReadingCache = new Map();
    const view = render(node(snapshot(initial), null, cache, [live]));
    const selector =
      kind === "thinking" ? ".thinking-line" : ".tool-evidence-card";
    const disclosure =
      view.container.querySelector<HTMLDetailsElement>(selector)!;
    disclosure.open = true;
    const persisted = session(0, 1);
    persisted.entries[1]!.message = live.message;
    view.rerender(node(snapshot(persisted), null, cache, [live]));
    expect(view.container.querySelector(selector)).toBe(disclosure);
    expect(disclosure.open).toBe(true);
    if (kind === "thinking")
      expect(
        disclosure.closest<HTMLElement>("[data-history-message]")?.dataset
          .historyEntry,
      ).toBe("e1-thinking-0-body");
    view.rerender(node(snapshot(persisted), null, cache));
    expect(view.container.querySelector(selector)).toBe(disclosure);
    expect(disclosure.open).toBe(true);
    const copied = { ...persisted, path: "/sessions/copy.jsonl" };
    view.rerender(node(snapshot(copied), null, cache));
    expect(view.container.querySelector(selector)).not.toBe(disclosure);
    expect(
      view.container.querySelector<HTMLDetailsElement>(selector)!.open,
    ).toBe(false);
  },
);

it("does not alias an ambiguous pair of native disclosures to one equal live payload", () => {
  const initial = session(0, 0);
  const live: LiveEntry = {
    key: "stream-1",
    message: {
      role: "assistant",
      timestamp: 42,
      content: "Same reply",
      parts: [{ type: "thinking", text: "Same summary" }],
    },
  };
  const cache: SessionReadingCache = new Map();
  const view = render(node(snapshot(initial), null, cache, [live]));
  const previous =
    view.container.querySelector<HTMLDetailsElement>(".thinking-line")!;
  previous.open = true;
  const persisted = session(0, 2);
  for (const entry of persisted.entries.slice(1)) entry.message = live.message;
  view.rerender(node(snapshot(persisted), null, cache, [live]));
  const disclosures = [
    ...view.container.querySelectorAll<HTMLDetailsElement>(".thinking-line"),
  ];
  expect(disclosures).toHaveLength(2);
  expect(disclosures).not.toContain(previous);
  expect(disclosures.every((item) => !item.open)).toBe(true);
});

it("keeps a distinct live payload visible when only its timestamp matches a native message", () => {
  const persisted = session(0, 1);
  persisted.entries[1]!.message!.timestamp = 42;
  const live: LiveEntry = {
    key: "stream-1",
    message: {
      role: "assistant",
      timestamp: 42,
      content: "Another live reply",
    },
  };
  const view = render(node(snapshot(persisted), null, new Map(), [live]));
  expect(screen.getByText("Message 1")).toBeTruthy();
  expect(screen.getByText("Another live reply")).toBeTruthy();
  expect(
    view.container.querySelectorAll(".message-row.assistant.response"),
  ).toHaveLength(2);
});

it("offers explicit retry after an automatic load fails without retrying on every wheel gesture", async () => {
  const read = vi
    .spyOn(WebClient.prototype, "sessionHistory")
    .mockRejectedValueOnce(new Error("preload offline"))
    .mockRejectedValueOnce(new Error("reader offline"))
    .mockResolvedValueOnce({
      ...session(0, 1, 3),
      anchorEntryId: "e3",
      requestedBeforeEntryId: "e2",
      history: {
        leafEntryId: "e3",
        beforeEntryId: null,
        anchorEntryId: "e3",
        anchorOnBranch: true,
      },
    });
  const view = render(node(snapshot(session(2, 3)), null, new Map()));
  const viewport = view.container.querySelector<HTMLElement>(".conversation")!;
  await act(async () => {});
  await act(async () => fireEvent.wheel(viewport, { deltaY: -100 }));
  expect(read).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("alert").textContent).toBe(
    i18n.t("historyUnavailable"),
  );
  for (let index = 0; index < 5; index++)
    fireEvent.wheel(viewport, { deltaY: -100 });
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () =>
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("retryAdmissionCheck") }),
    ),
  );
  expect(read).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Message 0")).toBeTruthy();
});

it("lets nested scrolling and message controls keep their upward input", async () => {
  const read = vi
    .spyOn(WebClient.prototype, "sessionHistory")
    .mockResolvedValue({
      ...session(0, 1, 3),
      anchorEntryId: "e3",
      requestedBeforeEntryId: "e2",
      history: {
        leafEntryId: "e3",
        beforeEntryId: null,
        anchorEntryId: "e3",
        anchorOnBranch: true,
      },
    });
  const view = render(node(snapshot(session(2, 3)), null, new Map()));
  const viewport = view.container.querySelector<HTMLElement>(".conversation")!;
  await act(async () => {});
  const nested = document.createElement("div");
  nested.style.overflowY = "auto";
  nested.scrollTop = 30;
  const input = document.createElement("input");
  nested.append(input);
  viewport.append(nested);
  fireEvent.wheel(nested, { deltaY: -100 });
  fireEvent.keyDown(input, { key: "Home", ctrlKey: true });
  expect(screen.queryByText("Message 0")).toBeNull();
  expect(read).toHaveBeenCalledOnce();
  nested.scrollTop = 0;
  await act(async () => fireEvent.wheel(nested, { deltaY: -100 }));
  expect(screen.getByText("Message 0")).toBeTruthy();
  expect(read).toHaveBeenCalledOnce();
  nested.remove();
});

it("pages from keyboard reading without a normal load button and announces a pending read", async () => {
  let finish!: (page: Awaited<ReturnType<WebClient["sessionHistory"]>>) => void;
  const read = vi
    .spyOn(WebClient.prototype, "sessionHistory")
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const view = render(node(snapshot(session(2, 3)), null, new Map()));
  const viewport = view.container.querySelector<HTMLElement>(".conversation")!;
  expect(viewport.tabIndex).toBe(0);
  viewport.focus();
  expect(document.activeElement).toBe(viewport);
  expect(
    view.container.querySelector(".conversation-history button"),
  ).toBeNull();
  fireEvent.keyDown(viewport, { key: "PageUp" });
  expect(read).toHaveBeenCalledOnce();
  expect(screen.getByRole("status").textContent).toBe(i18n.t("historyLoading"));
  expect(
    view.container.querySelector(".conversation-history button"),
  ).toBeNull();
  await act(async () =>
    finish({
      ...session(0, 1, 3),
      anchorEntryId: "e3",
      requestedBeforeEntryId: "e2",
      history: {
        leafEntryId: "e3",
        beforeEntryId: null,
        anchorEntryId: "e3",
        anchorOnBranch: true,
      },
    }),
  );
  expect(screen.getByText("Message 0")).toBeTruthy();
  expect(screen.queryByRole("status")).toBeNull();
});

it("matches native message identities as data without interpolating them into a selector", async () => {
  const target = navigation();
  const special = 'e3"][data-unrelated="true';
  target.entryId = special;
  target.session.entries.at(-1)!.id = special;
  target.session.history!.anchorEntryId = special;
  const cache: SessionReadingCache = new Map();
  const { container } = render(node(snapshot(session(29, 30)), target, cache));
  await act(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  const matched = [
    ...container.querySelectorAll<HTMLElement>("[data-history-message]"),
  ].find((item) => item.dataset.historyMessage === special)!;
  expect(matched).toBeTruthy();
  expect(document.activeElement).toBe(matched);
  expect(matched.dataset.historyHighlighted).toBe("true");
});

it("cancels deferred focus when another result takes ownership or the transcript unmounts", () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((frame) => {
    frames.delete(frame);
  });
  const cache: SessionReadingCache = new Map();
  const state = snapshot(session(29, 30));
  const view = render(node(state, navigation(), cache));
  const firstFrame = [...frames.keys()].at(-1)!;
  expect(frames.size).toBe(1);
  view.rerender(node(state, navigation(2, 2), cache));
  expect(frames.has(firstFrame)).toBe(false);
  expect(frames.size).toBe(1);
  act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  });
  const matched = view.container.querySelector<HTMLElement>(
    '[data-history-message="e2"]',
  )!;
  expect(document.activeElement).toBe(matched);
  expect(matched.dataset.historyHighlighted).toBe("true");
  view.rerender(node(state, navigation(3, 3), cache));
  expect(frames.size).toBe(1);
  view.unmount();
  expect(frames.size).toBe(0);
});

it("focuses the matched message after the search dialog restores focus to its opener", async () => {
  const methods = new Map(
    ["showModal", "close"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
    ]),
  );
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
      this.dispatchEvent(new Event("close"));
    },
  });
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  const focus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    const modal = document.querySelector("dialog[open]");
    if (modal && !modal.contains(this)) return;
    focus.call(this, options);
  });
  const cache: SessionReadingCache = new Map();
  function SearchNavigation() {
    const [open, setOpen] = useState(false);
    const [target, setTarget] = useState<Navigation | null>(null);
    return createElement(
      Fragment,
      null,
      createElement(
        "button",
        { type: "button", onClick: () => setOpen(true) },
        "Search history",
      ),
      jsx(Dialog, {
        isOpen: open,
        onOpenChange: setOpen,
        "aria-label": "Search messages",
        children: createElement(
          Fragment,
          null,
          createElement(
            "button",
            {
              type: "button",
              onClick: () => {
                setTarget(navigation());
              },
            },
            "Open older message",
          ),
          createElement(
            "button",
            { type: "button", onClick: () => setOpen(false) },
            "Close search",
          ),
        ),
      }),
      node(snapshot(session(29, 30)), target, cache),
    );
  }
  try {
    const { container } = render(createElement(SearchNavigation));
    const opener = screen.getByRole("button", { name: "Search history" });
    opener.focus();
    fireEvent.click(opener);
    const result = screen.getByRole("button", { name: "Open older message" });
    result.focus();
    fireEvent.click(result);
    await act(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(container.querySelector("dialog")!.open).toBe(true);
    expect(container.querySelector('[data-history-message="e3"]')).toBeTruthy();
    expect(document.activeElement).toBe(result);
    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    await act(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const matched = container.querySelector<HTMLElement>(
      '[data-history-message="e3"]',
    )!;
    expect(container.querySelector("dialog")!.open).toBe(false);
    expect(document.activeElement).toBe(matched);
    expect(matched.dataset.historyHighlighted).toBe("true");
  } finally {
    cleanup();
    for (const [name, descriptor] of methods) {
      if (descriptor)
        Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
      else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
    }
  }
});
