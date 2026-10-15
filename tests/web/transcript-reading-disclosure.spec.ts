// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import {
  type SessionReadingCache,
  sessionReadingScope,
} from "../../web/ui/src/features/transcript/session-reading-state.ts";
import { Transcript } from "../../web/ui/src/features/transcript/Transcript.tsx";
import { i18n } from "../../web/ui/src/i18n.ts";

const state: WebSnapshot = {
  protocolVersion: 1,
  generatedAt: "2026-10-09T00:00:00Z",
  cursor: 1,
  preferences: { theme: "light" },
  currentSessionId: "session",
  currentSessionPath: "/sessions/session.jsonl",
  sessions: [],
  workspaces: [],
  models: [],
  runtime: { status: "idle", capabilities: {} },
  selectedSession: {
    id: "session",
    path: "/sessions/session.jsonl",
    cwd: "/workspace",
    bytes: 1000,
    truncation: {
      truncated: false,
      entriesOmitted: 0,
      messagesTruncated: 0,
      messagePartsOmitted: 0,
      maxBytes: 2 * 1024 * 1024,
    },
    entries: [
      {
        type: "message",
        id: "prompt",
        timestamp: "2026-10-09T00:00:00Z",
        message: { role: "user", content: "Read two files" },
      },
      {
        type: "message",
        id: "phase",
        timestamp: "2026-10-09T00:00:01Z",
        message: {
          role: "assistant",
          content: "First phase is ready.",
          parts: [
            { type: "thinking", text: "Inspect the first file" },
            {
              type: "toolCall",
              id: "read-a",
              name: "read",
              arguments: '{"path":"a.ts"}',
            },
            { type: "text", text: "First phase is ready." },
            { type: "thinking", text: "Inspect the second file" },
            {
              type: "toolCall",
              id: "read-b",
              name: "read",
              arguments: '{"path":"b.ts"}',
            },
          ],
        },
      },
      {
        type: "message",
        id: "result-a",
        timestamp: "2026-10-09T00:00:02Z",
        message: {
          role: "toolResult",
          toolName: "read",
          toolCallId: "read-a",
          content: "Exact first result",
          isError: false,
        },
      },
      {
        type: "message",
        id: "result-b",
        timestamp: "2026-10-09T00:00:03Z",
        message: {
          role: "toolResult",
          toolName: "read",
          toolCallId: "read-b",
          content: "Exact second result",
          isError: false,
        },
      },
      {
        type: "message",
        id: "final",
        timestamp: "2026-10-09T00:00:04Z",
        message: {
          role: "assistant",
          content: "Both reads completed.",
          stopReason: "stop",
        },
      },
      {
        type: "custom",
        id: "timing",
        timestamp: "2026-10-09T00:00:04Z",
        turnTiming: {
          version: 1,
          sessionId: "session",
          commandId: "run",
          epoch: 1,
          promptEntryId: "prompt",
          resultEntryId: "final",
          startedAt: 0,
          finishedAt: 4000,
          elapsedMs: 4000,
          outcome: "completed",
        },
      },
    ],
  },
  truncation: {
    truncated: false,
    sessionsOmitted: 0,
    workspacesOmitted: 0,
    modelsOmitted: 0,
    maxBytes: 4 * 1024 * 1024,
    bytes: 1000,
  },
};

function view(cache: SessionReadingCache, value = state) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(Transcript, {
      snapshot: value,
      readingCache: cache,
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
}

function bookmark(key: string, pinned = false) {
  return new Map([
    [
      sessionReadingScope(state.selectedSession),
      {
        position: {
          key,
          entryId: "phase",
          offset: -30,
          scrollTop: 550,
          pinned,
        },
      },
    ],
  ]) satisfies SessionReadingCache;
}

const originalScroll = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTo",
);
const originalScrollTop = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTop",
);
beforeEach(() => {
  const positions = new WeakMap<HTMLElement, number>();
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return positions.get(this) ?? 0;
    },
    set(this: HTMLElement, top: number) {
      positions.set(
        this,
        Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight)),
      );
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = Math.max(
        0,
        Math.min(options.top ?? 0, this.scrollHeight - this.clientHeight),
      );
    },
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(360);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1800);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains("conversation"))
        return new DOMRect(0, 0, 800, 360);
      if (
        this.closest("[hidden]") ||
        this.parentElement?.closest("details:not([open])")
      )
        return new DOMRect();
      const conversation = this.closest<HTMLElement>(".conversation");
      const top = this.dataset.historyEntry?.startsWith("phase-thinking-3")
        ? 1000
        : 600;
      return new DOMRect(
        0,
        top - (conversation?.scrollTop ?? 0),
        800,
        this.classList.contains("process-sequence") ? 480 : 40,
      );
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalScroll)
    Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  if (originalScrollTop)
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollTop",
      originalScrollTop,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
});

it.each(["phase-thinking-0-body", "phase-thinking-3-body"])(
  "reveals only the bookmarked process %s after a view remount, preserving its offset and native receipts",
  async (key) => {
    const cache = bookmark(key);
    const original = JSON.stringify(state.selectedSession!.entries);
    const mounted = render(view(new Map()));
    mounted.unmount();
    const returned = render(view(cache));
    await act(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const groups = Array.from(
      returned.container.querySelectorAll<HTMLDetailsElement>(
        ".process-sequence:not(.single-process)",
      ),
    );
    const target = groups.find(
      (group) => group.dataset.historyEntry === key.replace(/-body$/, ""),
    )!;
    expect(target).toBeTruthy();
    expect(target.open).toBe(true);
    expect(target.closest<HTMLElement>(".turn-response-body")?.hidden).toBe(
      false,
    );
    expect(
      returned.container
        .querySelector(".turn-duration-toggle")
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      groups.filter((group) => group !== target).every((group) => !group.open),
    ).toBe(true);
    expect(target.getBoundingClientRect().top).toBe(-30);
    expect(
      returned.container.querySelectorAll(".tool-evidence-card[open]"),
    ).toHaveLength(0);
    expect(returned.container.textContent).toContain("Exact first result");
    expect(returned.container.textContent).toContain("Exact second result");
    expect(JSON.stringify(state.selectedSession!.entries)).toBe(original);
  },
);

it("retains a pending native reading bookmark when a snapshot arrives before deferred disclosure measurement", () => {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  const cache = bookmark("phase-thinking-0-body");
  const returned = render(view(cache));
  returned.rerender(view(cache, { ...state, cursor: 2 }));
  act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(0);
  });
  const target = returned.container.querySelector<HTMLDetailsElement>(
    '[data-history-entry="phase-thinking-0"]',
  )!;
  expect(target.open).toBe(true);
  expect(target.closest<HTMLElement>(".turn-response-body")?.hidden).toBe(
    false,
  );
  expect(target.getBoundingClientRect().top).toBe(-30);
});

it.each(["pinned", "another-session"])(
  "keeps completed disclosures folded for a %s bookmark",
  async (kind) => {
    const cache =
      kind === "pinned"
        ? bookmark("phase-thinking-0", true)
        : new Map([
            [
              sessionReadingScope({ id: "copy", path: "/sessions/copy.jsonl" }),
              {
                position: {
                  key: "phase-thinking-0",
                  entryId: "phase",
                  offset: -30,
                  scrollTop: 550,
                  pinned: false,
                },
              },
            ],
          ]);
    const returned = render(view(cache));
    await act(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    expect(
      returned.container.querySelector<HTMLElement>(".turn-response-body")
        ?.hidden,
    ).toBe(true);
    expect(
      returned.container.querySelectorAll(".process-sequence[open]"),
    ).toHaveLength(0);
    expect(
      returned.container.querySelector<HTMLElement>(".conversation")?.scrollTop,
    ).toBe(1440);
  },
);

it("restores a bookmarked collapsed summary without opening its process contents", async () => {
  const returned = render(view(bookmark("phase-thinking-0")));
  await act(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  const target = returned.container.querySelector<HTMLDetailsElement>(
    '[data-history-entry="phase-thinking-0"]',
  )!;
  expect(target.open).toBe(false);
  expect(target.closest<HTMLElement>(".turn-response-body")?.hidden).toBe(
    false,
  );
  expect(target.getBoundingClientRect().top).toBe(-30);
});

it.each(["result-a", "result-a-body"])(
  "distinguishes an orphan native result's summary from its visible child bookmark %s",
  async (key) => {
    const orphan = structuredClone(state);
    orphan.selectedSession!.entries.splice(1, 1);
    const returned = render(view(bookmark(key), orphan));
    await act(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    const group = returned.container.querySelector<HTMLDetailsElement>(
      '.process-sequence[data-history-entry="result-a"]',
    )!;
    expect(group.open).toBe(key.endsWith("-body"));
    const target = returned.container.querySelector<HTMLElement>(
      `[data-history-entry="${key}"]`,
    )!;
    expect(target.getBoundingClientRect().top).toBe(-30);
    expect(group.closest<HTMLElement>(".turn-response-body")?.hidden).toBe(
      false,
    );
  },
);

it.each(["settled", "running"])(
  "captures the first visible native receipt through the bounded %s group and restores both reading offsets on remount",
  async (mode) => {
    const batch = structuredClone(state);
    const phase = batch.selectedSession!.entries[1]!;
    phase.message!.parts = Array.from({ length: 12 }, (_, index) => ({
      type: "toolCall" as const,
      id: `read-${index}`,
      name: "read",
      arguments: JSON.stringify({ path: `${index}.ts` }),
    }));
    batch.selectedSession!.entries.splice(
      2,
      2,
      ...Array.from({ length: 12 }, (_, index) => ({
        type: "message" as const,
        id: `receipt-${index}`,
        timestamp: "2026-10-09T00:00:03Z",
        message: {
          role: "toolResult" as const,
          toolName: "read",
          toolCallId: `read-${index}`,
          content: `Exact result ${index}`,
          isError: false,
        },
      })),
    );
    if (mode === "running") {
      batch.runtime.status = "running";
      phase.message!.content = "";
      batch.selectedSession!.entries = batch.selectedSession!.entries.filter(
        (entry) => entry.id !== "final" && entry.id !== "timing",
      );
      const current = {
        type: "toolCall",
        id: "read-next",
        name: "read",
        arguments: '{"path":"next.ts"}',
      } as const;
      phase.message!.parts.push(current);
      batch.runtime.liveTools = [{ call: current, state: "running" }];
    }
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains("conversation"))
          return new DOMRect(0, 0, 800, 360);
        const conversation = this.closest<HTMLElement>(".conversation");
        const inner = this.closest<HTMLElement>(".process-sequence-scroll");
        const groupTop = 600 - (conversation?.scrollTop ?? 0);
        if (this.classList.contains("process-sequence-scroll"))
          return new DOMRect(0, groupTop + 20, 800, 192);
        if (this.dataset.historyResult?.startsWith("receipt-")) {
          const index = Number(this.dataset.historyResult.slice(8));
          return new DOMRect(
            0,
            groupTop + 20 + index * 48 - (inner?.scrollTop ?? 0),
            800,
            40,
          );
        }
        if (this.classList.contains("process-sequence"))
          return new DOMRect(0, groupTop, 800, 240);
        // Hidden native bodies can still report bounds; visibility must use their
        // disclosure ancestors rather than trusting height alone.
        return new DOMRect(0, -550, 800, 40);
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("process-sequence-scroll") ? 192 : 360;
      },
    );
    const originalIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value(this: HTMLElement) {
        const inner = this.closest<HTMLElement>(".process-sequence-scroll");
        if (!inner) return;
        const target = this.getBoundingClientRect();
        const clip = inner.getBoundingClientRect();
        if (target.top < clip.top) inner.scrollTop += target.top - clip.top;
        else if (target.bottom > clip.bottom)
          inner.scrollTop += target.bottom - clip.bottom;
      },
    });
    const style = document.createElement("style");
    style.textContent = ".process-sequence-scroll { overflow-y: auto; }";
    document.head.append(style);
    try {
      const cache: SessionReadingCache = new Map();
      const mounted = render(view(cache, batch));
      const elapsed = mounted.container.querySelector(".turn-duration-toggle");
      if (elapsed) fireEvent.click(elapsed);
      const group =
        mounted.container.querySelector<HTMLDetailsElement>(
          ".process-sequence",
        )!;
      group.open = true;
      fireEvent(group, new Event("toggle"));
      const conversation =
        mounted.container.querySelector<HTMLElement>(".conversation")!;
      const inner = group.querySelector<HTMLElement>(
        ".process-sequence-scroll",
      )!;
      inner.style.overflowY = "auto";
      conversation.scrollTop = 550;
      inner.scrollTop = 200;
      fireEvent.scroll(inner);
      fireEvent.wheel(conversation, { deltaY: -1 });
      fireEvent.scroll(conversation);
      mounted.unmount();
      const saved = cache.get(sessionReadingScope(batch.selectedSession))!
        .position!;
      expect(saved.key).toBe("receipt-4");
      expect(saved.entryId).toBe("receipt-4");
      expect(saved.offset).toBe(62);
      expect(saved.scrollTop).toBe(550);
      const returned = render(view(cache, batch));
      const returnedInner = returned.container.querySelector<HTMLElement>(
        ".process-sequence-scroll",
      )!;
      returnedInner.style.overflowY = "auto";
      await act(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
      const target = returned.container.querySelector<HTMLElement>(
        '[data-history-result="receipt-4"]',
      )!;
      expect(target.getBoundingClientRect().top).toBe(62);
      expect(returnedInner.scrollTop).toBe(200);
      expect(
        returned.container.querySelector<HTMLElement>(".conversation")
          ?.scrollTop,
      ).toBe(550);
      expect(
        target.closest<HTMLDetailsElement>(".process-sequence")?.open,
      ).toBe(true);
      expect(
        returned.container.querySelectorAll(".tool-evidence-card[open]"),
      ).toHaveLength(0);
      if (mode === "running") {
        expect(
          target.closest<HTMLDetailsElement>(".process-sequence")?.dataset
            .running,
        ).toBe("true");
        const appended = structuredClone(batch);
        appended.cursor++;
        const next = {
          type: "toolCall",
          id: "read-appended",
          name: "read",
          arguments: '{"path":"appended.ts"}',
        } as const;
        appended.selectedSession!.entries[1]!.message!.parts!.push(next);
        appended.runtime.liveTools!.push({ call: next, state: "running" });
        // A native scroll event can arrive after the next stream snapshot. The
        // restored physical reading position must already own following.
        returned.rerender(view(cache, appended));
        expect(returnedInner.scrollTop).toBe(200);
        expect(target.getBoundingClientRect().top).toBe(62);
      }
    } finally {
      style.remove();
      if (originalIntoView)
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollIntoView",
          originalIntoView,
        );
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  },
);
