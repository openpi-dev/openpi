// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  jsonByteLength,
  type WebSessionHistoryPage,
  type WebSessionProjection,
} from "../../web/protocol/types.ts";
import { useSessionHistory } from "../../web/ui/src/features/transcript/use-session-history.ts";
import { WebClient } from "../../web/ui/src/protocol/client.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const entry = (index: number) => ({
  type: "message" as const,
  id: `e${index}`,
  parentId: index ? `e${index - 1}` : null,
  timestamp: new Date(index).toISOString(),
  message: {
    role: index % 10 === 0 ? "user" : "assistant",
    content: `Entry ${index}`,
  },
});
function session(
  from = 2,
  through = 3,
  overrides: Partial<WebSessionProjection> = {},
): WebSessionProjection {
  const entries = Array.from({ length: through - from + 1 }, (_, index) =>
    entry(from + index),
  );
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
      leafEntryId: `e${through}`,
      beforeEntryId: from > 0 ? `e${from}` : null,
    },
    ...overrides,
  };
}
function page(
  from = 0,
  through = 1,
  anchor = "e3",
  before = "e2",
): WebSessionHistoryPage {
  return {
    ...session(from, through),
    anchorEntryId: anchor,
    requestedBeforeEntryId: before,
    history: {
      leafEntryId: anchor,
      beforeEntryId: from > 0 ? `e${from}` : null,
      anchorEntryId: anchor,
      anchorOnBranch: true,
    },
  };
}
function setup(selected = session(), callbacks = {}) {
  const onAnchorChange = vi.fn();
  const beforePrepend = vi.fn();
  const onRefresh = vi.fn(async () => true);
  return {
    ...renderHook(
      ({ selected }) =>
        useSessionHistory(selected, {
          onAnchorChange,
          beforePrepend,
          onRefresh,
          ...callbacks,
        }),
      { initialProps: { selected } },
    ),
    onAnchorChange,
    beforePrepend,
    onRefresh,
  };
}

it("does not fetch or retain sliding snapshots until the reader asks for history", () => {
  const read = vi.spyOn(WebClient.prototype, "sessionHistory");
  const { result, rerender, onAnchorChange } = setup();
  for (let index = 10; index < 100; index++) {
    const selected = session(index, index + 1);
    rerender({ selected });
    expect(result.current.session).toBe(selected);
  }
  expect(result.current.engaged).toBe(false);
  expect(read).not.toHaveBeenCalled();
  expect(onAnchorChange).not.toHaveBeenCalled();
});

it("loads native older entries before the current page and reaches the start", async () => {
  const read = vi
    .spyOn(WebClient.prototype, "sessionHistory")
    .mockResolvedValue(page());
  const { result, beforePrepend, onAnchorChange } = setup();
  await act(() => result.current.loadOlder());
  expect(read).toHaveBeenCalledWith(
    { sessionId: "s", sessionPath: "/sessions/s.jsonl", entryId: "e3" },
    "e2",
    expect.any(AbortSignal),
  );
  expect(result.current.session?.entries.map(({ id }) => id)).toEqual([
    "e0",
    "e1",
    "e2",
    "e3",
  ]);
  expect(result.current.session?.entries[0]?.message?.role).toBe("user");
  expect(result.current.hasMore).toBe(false);
  expect(beforePrepend).toHaveBeenCalledOnce();
  expect(onAnchorChange).toHaveBeenLastCalledWith({
    sessionId: "s",
    sessionPath: "/sessions/s.jsonl",
    entryId: "e3",
  });
});

it("keeps an in-flight older page when a verified append arrives", async () => {
  let finish!: (page: WebSessionHistoryPage) => void;
  const read = vi
    .spyOn(WebClient.prototype, "sessionHistory")
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const { result, rerender } = setup();
  act(() => {
    void result.current.loadOlder();
  });
  const appended = session(3, 4, {
    history: {
      leafEntryId: "e4",
      beforeEntryId: "e3",
      anchorEntryId: "e3",
      anchorOnBranch: true,
    },
  });
  rerender({ selected: appended });
  expect(read.mock.calls[0]![2].aborted).toBe(false);
  await act(async () => finish(page()));
  expect(result.current.session?.entries.map(({ id }) => id)).toEqual([
    "e0",
    "e1",
    "e2",
    "e3",
    "e4",
  ]);
  expect(read).toHaveBeenCalledOnce();
});

it.each(["session-id", "copied-path"])(
  "discards a delayed older page after changing %s",
  async (change) => {
    let finish!: (page: WebSessionHistoryPage) => void;
    const read = vi
      .spyOn(WebClient.prototype, "sessionHistory")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const { result, rerender, beforePrepend } = setup();
    act(() => {
      void result.current.loadOlder();
    });
    const replacement = session(
      20,
      21,
      change === "session-id"
        ? { id: "other" }
        : { path: "/sessions/copy.jsonl" },
    );
    rerender({ selected: replacement });
    expect(read.mock.calls[0]![2].aborted).toBe(true);
    await act(async () => finish(page()));
    expect(result.current.session).toBe(replacement);
    expect(beforePrepend).not.toHaveBeenCalled();
  },
);

it("does not splice a pending page into an unverified or forked snapshot", async () => {
  let finish!: (page: WebSessionHistoryPage) => void;
  const read = vi
    .spyOn(WebClient.prototype, "sessionHistory")
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const { result, rerender, beforePrepend } = setup(session(), {
    onRefresh: () => new Promise<boolean>(() => {}),
  });
  act(() => {
    void result.current.loadOlder();
  });
  rerender({ selected: session(20, 21) });
  await act(async () => finish(page()));
  expect(result.current.verifying).toBe(true);
  expect(result.current.session?.entries.map(({ id }) => id)).toEqual([
    "e2",
    "e3",
  ]);
  expect(beforePrepend).not.toHaveBeenCalled();
  const forked = session(20, 21, {
    history: {
      leafEntryId: "e21",
      beforeEntryId: "e20",
      anchorEntryId: "e3",
      anchorOnBranch: false,
    },
  });
  rerender({ selected: forked });
  expect(result.current.session).toBe(forked);
  expect(result.current.error).toBe("historyChanged");
  expect(read.mock.calls[0]![2].aborted).toBe(true);
});

it("keeps a load error visible and permits retry without discarding the current page", async () => {
  const read = vi
    .spyOn(WebClient.prototype, "sessionHistory")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(page());
  const { result } = setup();
  await act(() => result.current.loadOlder());
  expect(result.current.error).toBe("historyUnavailable");
  expect(result.current.session?.entries.map(({ id }) => id)).toEqual([
    "e2",
    "e3",
  ]);
  await act(() => result.current.loadOlder());
  expect(read).toHaveBeenCalledTimes(2);
  expect(result.current.error).toBeNull();
  expect(result.current.session?.entries[0]?.id).toBe("e0");
});

it("keeps only a bounded reading window and releases it on Jump to latest", async () => {
  const read = vi
    .spyOn(WebClient.prototype, "sessionHistory")
    .mockResolvedValueOnce(page(750, 999, "e1249", "e1000"))
    .mockResolvedValueOnce(page(500, 749, "e1249", "e750"))
    .mockResolvedValueOnce(page(250, 499, "e1249", "e500"))
    .mockResolvedValueOnce(page(0, 249, "e1249", "e250"));
  const latest = session(1000, 1249);
  const { result, onAnchorChange } = setup(latest);
  for (let index = 0; index < 4; index++)
    await act(() => result.current.loadOlder());
  expect(read).toHaveBeenCalledTimes(4);
  expect(result.current.session?.entries).toHaveLength(1000);
  expect(result.current.session?.entries[0]?.id).toBe("e0");
  expect(result.current.hasNewer).toBe(true);
  act(() => result.current.resetToLatest());
  expect(result.current.session).toBe(latest);
  expect(result.current.engaged).toBe(false);
  expect(onAnchorChange).toHaveBeenLastCalledWith(null);
});

it("keeps a verified older reading position when many new entries create a gap", async () => {
  vi.spyOn(WebClient.prototype, "sessionHistory").mockResolvedValue(page());
  const { result, rerender } = setup();
  await act(() => result.current.loadOlder());
  rerender({
    selected: session(100, 101, {
      history: {
        leafEntryId: "e101",
        beforeEntryId: "e100",
        anchorEntryId: "e3",
        anchorOnBranch: true,
      },
    }),
  });
  expect(result.current.session?.entries.map(({ id }) => id)).toEqual([
    "e0",
    "e1",
    "e2",
    "e3",
  ]);
  expect(result.current.hasNewer).toBe(true);
  expect(result.current.verifying).toBe(false);
});

it("bounds retained bytes even when each page has far fewer than 250 entries", async () => {
  const text = "文".repeat(12000);
  const large = (from: number, through: number) => {
    const value = session(from, through);
    value.entries = value.entries.map((entry) => ({
      ...entry,
      message: {
        role: "assistant",
        content: text,
        parts: [{ type: "text", text }],
      },
    }));
    value.bytes = jsonByteLength(value.entries);
    return value;
  };
  vi.spyOn(WebClient.prototype, "sessionHistory").mockImplementation(
    async (anchor, before) => {
      const end = Number(before.slice(1));
      const result = page(end - 25, end - 1, anchor.entryId, before);
      const content = large(end - 25, end - 1);
      return { ...result, entries: content.entries, bytes: content.bytes };
    },
  );
  const { result } = setup(large(125, 149));
  for (let index = 0; index < 5; index++)
    await act(() => result.current.loadOlder());
  expect(result.current.session?.entries[0]?.id).toBe("e0");
  expect(result.current.session!.entries.length).toBeLessThan(150);
  expect(jsonByteLength(result.current.session?.entries)).toBeLessThanOrEqual(
    8 * 1024 * 1024,
  );
  expect(result.current.hasNewer).toBe(true);
});
