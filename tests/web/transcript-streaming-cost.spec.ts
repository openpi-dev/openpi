// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import type { WebTurnTiming } from "../../web/protocol/turn-timing.ts";
import type { WebLiveMessage, WebSnapshot } from "../../web/protocol/types.ts";
import {
  buildEntries,
  groupConversationTurns,
  Transcript,
} from "../../web/ui/src/features/transcript/Transcript.tsx";
import { displayedThinkingDuration } from "../../web/ui/src/features/transcript/transcript-entries.ts";
import { i18n } from "../../web/ui/src/i18n.ts";
import type { LiveEntry } from "../../web/ui/src/store/web-store.ts";

afterEach(() => {
  cleanup();
});

const truncation = {
  bytes: 0,
  maxBytes: 1024,
  messagesTruncated: 0,
  messagePartsOmitted: 0,
  entriesOmitted: 0,
  modelsOmitted: 0,
  sessionsOmitted: 0,
  workspacesOmitted: 0,
  truncated: false,
};

function snapshot(
  entries: NonNullable<WebSnapshot["selectedSession"]>["entries"] = [],
): WebSnapshot {
  return {
    protocolVersion: 1,
    preferences: { theme: "system" },
    generatedAt: "2026-10-16T00:00:00Z",
    cursor: 1,
    currentSessionId: "s",
    currentSessionPath: "/s.jsonl",
    workspaces: [],
    sessions: [],
    models: [],
    truncation,
    runtime: { status: "idle", capabilities: {} },
    selectedSession: {
      id: "s",
      path: "/s.jsonl",
      cwd: "/",
      entries,
      bytes: 0,
      truncation,
    },
  };
}

function messageEntry(
  id: string,
  message: WebLiveMessage,
): NonNullable<WebSnapshot["selectedSession"]>["entries"][number] {
  return {
    id,
    type: "message",
    timestamp: "2026-10-16T00:00:00Z",
    message,
  };
}

function historicalStringifies(updates: number, count: number) {
  const entries = Array.from({ length: count }, (_, index) =>
    messageEntry(`e${index}`, {
      role: "assistant",
      timestamp: index,
      content: `HISTORICAL_PAYLOAD ${"x".repeat(200)}`,
      parts: [{ type: "text", text: `HISTORICAL_PAYLOAD ${index}` }],
    }),
  );
  const state = snapshot(entries);
  let historical = 0;
  const original = JSON.stringify;
  JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
    const text = original(value, ...(rest as []));
    if (text.includes("HISTORICAL_PAYLOAD")) historical++;
    return text;
  }) as typeof JSON.stringify;
  try {
    for (let update = 0; update < updates; update++) {
      buildEntries(
        state,
        [
          {
            key: "live-current",
            message: {
              role: "assistant",
              content: `LIVE_PAYLOAD ${update}`,
              timestamp: 9_000_000 + update,
            },
          },
        ],
        { nativeRowKeys: new Map(), ambiguousTimingIds: new Set() },
      );
    }
  } finally {
    JSON.stringify = original;
  }
  return historical;
}

describe("persisted transcript signatures", () => {
  const complete = {
    role: "assistant" as const,
    timestamp: 5,
    content: "same",
    parts: [{ type: "text" as const, text: "same" }],
  };

  it("reconciles exact tool executions when snapshot bounds change their payload", () => {
    const tool = {
      type: "toolCall" as const,
      id: "build-1",
      name: "bash",
      arguments: '{"command":"build"}',
    };
    const assistant: WebLiveMessage = {
      role: "assistant",
      timestamp: 5,
      content: "",
      parts: [{ type: "thinking", text: "Inspecting the build" }, tool],
      stopReason: "toolUse",
    };
    const result: WebLiveMessage = {
      role: "toolResult",
      toolName: "bash",
      toolCallId: tool.id,
      content: "Build output".repeat(100),
      isError: false,
    };
    const entries = [
      messageEntry("a1", {
        ...assistant,
        parts: [tool],
        truncation: { truncated: true },
      }),
      messageEntry("r1", {
        ...result,
        content: "Build output…",
        truncation: { truncated: true, text: true },
      }),
    ];
    const reconciled = buildEntries(
      snapshot(entries),
      [
        { key: "live-assistant", message: assistant },
        { key: "live-result", message: result },
        { key: "replayed-assistant", message: assistant },
        { key: "replayed-result", message: result },
      ],
      { nativeRowKeys: new Map(), ambiguousTimingIds: new Set() },
    );
    expect(reconciled.entries.map((entry) => entry.entryId)).toEqual([
      "a1",
      "r1",
    ]);
    // Running the same command again is a separate execution, even when the
    // provider reuses its timestamp. Never deduplicate command text.
    const repeated = buildEntries(
      snapshot(entries),
      [
        {
          key: "next",
          message: { ...assistant, parts: [{ ...tool, id: "build-2" }] },
        },
      ],
      { nativeRowKeys: new Map(), ambiguousTimingIds: new Set() },
    );
    expect(repeated.entries).toHaveLength(3);
  });

  it("reuses one exact assistant row and keeps a truncated duplicate on the native id", () => {
    const aliased = buildEntries(
      snapshot([messageEntry("e1", complete)]),
      [{ key: "live-1", message: complete }],
      { nativeRowKeys: new Map(), ambiguousTimingIds: new Set() },
    );
    expect(aliased.entries.map((entry) => entry.key)).toEqual(["live-1"]);

    const truncated = {
      ...complete,
      truncation: { truncated: true as const },
    };
    const reconciled = buildEntries(
      snapshot([messageEntry("e1", truncated)]),
      [{ key: "live-1", message: truncated }],
      { nativeRowKeys: new Map(), ambiguousTimingIds: new Set() },
    );
    expect(reconciled.entries.map((entry) => entry.key)).toEqual(["e1"]);

    const distinct = buildEntries(
      snapshot([messageEntry("e1", complete)]),
      [
        {
          key: "live-1",
          message: {
            ...complete,
            content: "other",
            parts: [{ type: "text", text: "other" }],
          },
        },
      ],
      { nativeRowKeys: new Map(), ambiguousTimingIds: new Set() },
    );
    expect(
      distinct.entries.map((entry) => [entry.key, entry.message.content]),
    ).toEqual([
      ["e1", "same"],
      ["live-1", "other"],
    ]);
  });

  it("aliases reversed live disclosures without changing native history order", () => {
    const first: WebLiveMessage = {
      role: "assistant",
      timestamp: 1,
      content: "First answer",
    };
    const second: WebLiveMessage = {
      role: "assistant",
      timestamp: 2,
      content: "Second answer",
    };
    const { entries } = buildEntries(
      snapshot([
        messageEntry("native-first", first),
        messageEntry("native-second", second),
      ]),
      [
        { key: "live-second", message: second },
        { key: "live-first", message: first },
      ],
      { nativeRowKeys: new Map(), ambiguousTimingIds: new Set() },
    );
    expect(entries.map((entry) => [entry.entryId, entry.key])).toEqual([
      ["native-first", "live-first"],
      ["native-second", "live-second"],
    ]);
  });

  it.each(["distinct", "identical"])(
    "does not borrow timestamp-only thinking duration across %s native payloads",
    (payloads) => {
      const previous: WebLiveMessage = {
        role: "assistant",
        timestamp: 42,
        content: "Previous answer",
        parts: [{ type: "thinking", text: "Previous reasoning" }],
      };
      const current: WebLiveMessage =
        payloads === "identical"
          ? previous
          : {
              ...previous,
              content: "Current answer",
              parts: [{ type: "thinking", text: "Current reasoning" }],
            };
      const state = snapshot([
        messageEntry("previous", previous),
        messageEntry("current", current),
      ]);
      const keys = {
        nativeRowKeys: new Map<string, string>(),
        ambiguousTimingIds: new Set<string>(),
      };
      const durations = {
        "message-assistant-42": 5_000,
        "live-current": 5_000,
      };
      const projected = buildEntries(
        state,
        [{ key: "live-current", message: current }],
        keys,
      );
      const retained = buildEntries(state, [], keys);
      for (const { entries } of [projected, retained]) {
        expect(
          entries.map((entry) => ({
            id: entry.entryId,
            duration: displayedThinkingDuration(entry, durations),
          })),
        ).toEqual([
          { id: "previous", duration: undefined },
          {
            id: "current",
            duration: payloads === "distinct" ? 5_000 : undefined,
          },
        ]);
        expect(
          displayedThinkingDuration(entries[0]!, {
            ...durations,
            previous: 1_000,
          }),
        ).toBe(1_000);
      }
    },
  );

  it.each([false, true])(
    "does not overwrite native timing from indistinguishable live messages (known alias: %s)",
    (knownAlias) => {
      const message: WebLiveMessage = {
        role: "assistant",
        timestamp: 42,
        content: "Same answer",
        parts: [{ type: "thinking", text: "Same reasoning" }],
      };
      const state = snapshot([messageEntry("native-old", message)]);
      const oldLive = { key: "live-old", message };
      const keys = {
        nativeRowKeys: new Map<string, string>(),
        ambiguousTimingIds: new Set<string>(),
      };
      if (knownAlias) buildEntries(state, [oldLive], keys);
      const { entries } = buildEntries(
        state,
        [oldLive, { key: "live-current", message }],
        keys,
      );
      const native = entries.find((entry) => entry.entryId === "native-old")!;
      expect(
        displayedThinkingDuration(native, {
          "live-old": 1_000,
          "live-current": 5_000,
          "message-assistant-42": 5_000,
        }),
      ).toBe(knownAlias ? 1_000 : undefined);
      const refreshed = snapshot([messageEntry("native-old", { ...message })]);
      for (const liveMessages of [[], [{ key: "live-current", message }]]) {
        const retained = buildEntries(refreshed, liveMessages, keys)
          .entries[0]!;
        expect(
          displayedThinkingDuration(retained, {
            "live-old": 1_000,
            "live-current": 5_000,
            "message-assistant-42": 5_000,
          }),
        ).toBe(knownAlias ? 1_000 : undefined);
      }
    },
  );

  it("keeps an established native alias when only a later indistinguishable live message remains", () => {
    const message: WebLiveMessage = {
      role: "assistant",
      timestamp: 42,
      content: "Same answer",
      parts: [{ type: "thinking", text: "Same reasoning" }],
    };
    const state = snapshot([messageEntry("native-old", message)]);
    const keys = {
      nativeRowKeys: new Map<string, string>(),
      ambiguousTimingIds: new Set<string>(),
    };
    buildEntries(state, [{ key: "live-old", message }], keys);
    const { entries } = buildEntries(
      state,
      [{ key: "live-current", message }],
      keys,
    );
    expect(
      displayedThinkingDuration(entries[0]!, {
        "live-old": 1_000,
        "live-current": 5_000,
        "message-assistant-42": 5_000,
      }),
    ).toBe(1_000);
  });

  it("prunes presentation ownership when a native row leaves the reading window", () => {
    const message: WebLiveMessage = {
      role: "assistant",
      timestamp: 42,
      content: "Same answer",
    };
    const state = snapshot([messageEntry("native-old", message)]);
    const presentation = {
      nativeRowKeys: new Map<string, string>(),
      ambiguousTimingIds: new Set<string>(),
    };
    buildEntries(state, [{ key: "live-old", message }], presentation);
    buildEntries(state, [{ key: "live-current", message }], presentation);
    expect(presentation.nativeRowKeys.get("native-old")).toBe("live-old");
    expect(presentation.ambiguousTimingIds.has("native-old")).toBe(true);
    buildEntries(snapshot(), [], presentation);
    expect(presentation.nativeRowKeys.size).toBe(0);
    expect(presentation.ambiguousTimingIds.size).toBe(0);
    const { entries } = buildEntries(state, [], presentation);
    expect(
      displayedThinkingDuration(entries[0]!, { "message-assistant-42": 5_000 }),
    ).toBe(5_000);
  });

  it("does not lend a new live duration to a different same-timestamp native message before persistence", () => {
    const previous: WebLiveMessage = {
      role: "assistant",
      timestamp: 42,
      content: "Previous answer",
      parts: [{ type: "thinking", text: "Previous reasoning" }],
    };
    const current: WebLiveMessage = {
      ...previous,
      content: "Current answer",
      parts: [{ type: "thinking", text: "Current reasoning" }],
    };
    const { entries } = buildEntries(
      snapshot([messageEntry("previous", previous)]),
      [{ key: "live-current", message: current }],
      { nativeRowKeys: new Map(), ambiguousTimingIds: new Set() },
    );
    const durations = {
      "message-assistant-42": 5_000,
      "live-current": 5_000,
    };
    expect(
      entries.map((entry) => displayedThinkingDuration(entry, durations)),
    ).toEqual([undefined, 5_000]);
  });

  it("collapses one timestamp-free live copy of a timestamped native prompt", () => {
    const content = "New user request while reading old history";
    const history = [
      messageEntry("before", {
        role: "assistant",
        content: "Previous answer",
        timestamp: 100,
      }),
      messageEntry("native-request", {
        role: "user",
        content,
        timestamp: 200,
        parts: [{ type: "text", text: content }],
      }),
    ];
    const optimistic: LiveEntry = {
      key: "optimistic-new-command",
      message: { role: "user", content },
      optimistic: {
        sessionId: "s",
        sessionPath: "/s.jsonl",
        commandId: "new-command",
        afterEntryId: "before",
        admitted: true,
      },
    };
    const shown = (copies: number) =>
      buildEntries(
        snapshot(history),
        [
          optimistic,
          ...Array.from({ length: copies }, (_, index) => ({
            key: `legacy-user-${index}`,
            message: { role: "user" as const, content },
          })),
        ],
        { nativeRowKeys: new Map(), ambiguousTimingIds: new Set() },
      );
    const once = shown(1);
    expect(
      once.entries
        .filter((entry) => entry.message.role === "user")
        .map((entry) => entry.entryId ?? entry.key),
    ).toEqual(["native-request"]);
    expect(once.projectedPrompts).toEqual([
      { key: "optimistic-new-command", entryId: "native-request" },
    ]);
    const twice = shown(2);
    expect(
      twice.entries
        .filter((entry) => entry.message.role === "user")
        .map((entry) => entry.entryId ?? entry.key),
    ).toEqual(["native-request", "legacy-user-1"]);
  });

  it("shows a message appended to the same history array", () => {
    const entries = [
      messageEntry("user", {
        role: "user",
        content: "One original request",
        timestamp: 1,
      }),
    ];
    const state = snapshot(entries);
    expect(
      buildEntries(state, [], {
        nativeRowKeys: new Map(),
        ambiguousTimingIds: new Set(),
      }).entries.map((entry) => entry.message.content),
    ).toEqual(["One original request"]);
    entries.push(
      messageEntry("recovered", {
        role: "assistant",
        content: "Recovered answer",
        timestamp: 2,
        stopReason: "stop",
      }),
    );
    expect(
      buildEntries(state, [], {
        nativeRowKeys: new Map(),
        ambiguousTimingIds: new Set(),
      }).entries.map((entry) => entry.message.content),
    ).toEqual(["One original request", "Recovered answer"]);
  });

  it("moves an optimistic prompt onto the later native message with the same text", () => {
    const optimistic: LiveEntry = {
      key: "optimistic-c1",
      message: { role: "user", content: "next" },
      optimistic: {
        sessionId: "s",
        sessionPath: "/s.jsonl",
        commandId: "c1",
        afterEntryId: "a1",
        admitted: true,
      },
    };
    const persisted = [
      messageEntry("u1", { role: "user", content: "hello" }),
      messageEntry("a1", { role: "assistant", content: "ok", timestamp: 2 }),
    ];
    const pending = buildEntries(snapshot(persisted), [optimistic], {
      nativeRowKeys: new Map(),
      ambiguousTimingIds: new Set(),
    });
    const pendingNext = pending.entries.find(
      (entry) => entry.message.content === "next",
    );
    expect(pendingNext?.key).toBe("optimistic-c1");
    expect(pendingNext?.entryId).toBeUndefined();
    expect(
      pending.entries.filter((entry) => entry.message.role === "user"),
    ).toHaveLength(2);

    const acknowledged = buildEntries(
      snapshot([
        ...persisted,
        messageEntry("u2", { role: "user", content: "next" }),
      ]),
      [optimistic],
      { nativeRowKeys: new Map(), ambiguousTimingIds: new Set() },
    );
    const nativeNext = acknowledged.entries.find(
      (entry) => entry.message.content === "next",
    );
    expect(nativeNext?.key).toBe("optimistic-c1");
    expect(nativeNext?.entryId).toBe("u2");
    expect(
      acknowledged.entries.filter((entry) => entry.message.role === "user"),
    ).toHaveLength(2);
  });

  it("does not serialize unchanged history again on later live updates", () => {
    expect(historicalStringifies(20, 250)).toBe(historicalStringifies(1, 250));
    expect(historicalStringifies(20, 1000)).toBe(
      historicalStringifies(1, 1000),
    );
  });
});

function timing(promptEntryId: string): WebTurnTiming {
  return {
    version: 1,
    sessionId: "s",
    commandId: "c",
    epoch: 1,
    startedAt: 0,
    finishedAt: 1,
    elapsedMs: 1,
    outcome: "completed",
    promptEntryId,
  };
}

function turnIds(
  rows: Parameters<typeof groupConversationTurns>[0],
  running = false,
  timedTurn?: Parameters<typeof groupConversationTurns>[3],
) {
  return groupConversationTurns(
    rows,
    running,
    undefined,
    timedTurn,
  ).turns.flatMap((turn) => turn.rows.map(() => turn.id));
}

describe("conversation turn attribution", () => {
  it("attaches a timing row to its first prompt without crossing a barrier or a queued prompt", () => {
    const rows = [
      {
        key: "p1",
        turn: 1,
        kind: "prompt" as const,
        promptEntryId: "p1",
        content: null,
      },
      { key: "a1", turn: 1, kind: "response" as const, content: null },
      {
        key: "t1",
        turn: 9,
        kind: "custom" as const,
        timing: timing("p1"),
        content: null,
      },
      {
        key: "queued",
        turn: 7,
        kind: "prompt" as const,
        promptEntryId: "queued",
        pendingPrompt: true,
        content: null,
      },
    ];
    expect(turnIds(rows)).toEqual([1, 1, 1, 7]);

    const blocked = [
      {
        key: "p1",
        turn: 1,
        kind: "prompt" as const,
        promptEntryId: "p1",
        content: null,
      },
      {
        key: "fork",
        turn: 1,
        kind: "custom" as const,
        forkSnapshotBoundary: true as const,
        content: null,
      },
      {
        key: "t1",
        turn: 4,
        kind: "custom" as const,
        timing: timing("p1"),
        content: null,
      },
    ];
    expect(turnIds(blocked)).toEqual([1, 1, 4]);

    const firstPrompt = [
      {
        key: "p1",
        turn: 1,
        kind: "prompt" as const,
        promptEntryId: "p1",
        content: null,
      },
      {
        key: "p1-again",
        turn: 2,
        kind: "prompt" as const,
        promptEntryId: "p1",
        content: null,
      },
      {
        key: "t1",
        turn: 3,
        kind: "custom" as const,
        timing: timing("p1"),
        content: null,
      },
    ];
    expect(turnIds(firstPrompt)).toEqual([1, 1, 1]);
  });

  it("reads each row a bounded number of times as the turn count grows", () => {
    const measure = (turns: number) => {
      const rows = Array.from({ length: turns }, (_, index) => [
        {
          key: `p${index}`,
          turn: index + 1,
          kind: "prompt" as const,
          promptEntryId: `p${index}`,
          content: null,
        },
        {
          key: `a${index}`,
          turn: index + 1,
          kind: "response" as const,
          content: null,
        },
        {
          key: `t${index}`,
          turn: index + 1,
          kind: "custom" as const,
          timing: timing(`p${index}`),
          content: null,
        },
      ]).flat();
      let reads = 0;
      const counted = new Proxy(rows, {
        get(target, prop, receiver) {
          if (typeof prop === "string" && /^\d+$/u.test(prop)) reads++;
          return Reflect.get(target, prop, receiver);
        },
      });
      const ids = turnIds(counted);
      expect(ids).toEqual(rows.map((row) => row.turn));
      return { reads, rows: rows.length };
    };
    const small = measure(50);
    const large = measure(400);
    expect(small.reads / small.rows).toBeLessThan(12);
    expect(large.reads / large.rows).toBeLessThan(12);
    expect(large.reads).toBeLessThan(small.reads * 16);
  });
});

it("retains timing conflicts through snapshot refresh but resets them for the same Session id at a different path", () => {
  const previous: WebLiveMessage = {
    role: "assistant",
    timestamp: 42,
    content: "Previous answer",
    parts: [{ type: "thinking", text: "Previous reasoning" }],
  };
  const current: WebLiveMessage = {
    ...previous,
    content: "Current answer",
    parts: [{ type: "thinking", text: "Current reasoning" }],
  };
  const state = snapshot([messageEntry("native-old", previous)]);
  const node = (value: WebSnapshot, liveMessages: LiveEntry[] = []) =>
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Transcript, {
        snapshot: value,
        liveMessages,
        liveRunning: false,
        livePhase: "idle",
        liveRetry: null,
        thinkingStarts: {},
        thinkingDurations: {
          "message-assistant-42": 5_000,
          "live-current": 5_000,
        },
        scrollToBottom: 0,
      }),
    );
  const view = render(node(state, [{ key: "live-current", message: current }]));
  const firstLabel = () =>
    view.container
      .querySelector(".thinking-line summary")
      ?.getAttribute("aria-label");
  expect(firstLabel()).not.toContain("5s");
  const refreshed = snapshot([messageEntry("native-old", { ...previous })]);
  view.rerender(node(refreshed));
  expect(firstLabel()).not.toContain("5s");
  view.rerender(
    node({
      ...refreshed,
      selectedSession: { ...refreshed.selectedSession!, path: "/copied.jsonl" },
    }),
  );
  expect(firstLabel()).toContain("5s");
});

it("shows a persisted reasoning duration from the message identity after the live key is gone", () => {
  const state = snapshot([
    messageEntry("e1", {
      role: "assistant",
      timestamp: 1_700_000_000_000,
      content: "",
      stopReason: "stop",
      parts: [{ type: "thinking", text: "Inspect the source" }],
    }),
  ]);
  const view = render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Transcript, {
        snapshot: state,
        liveMessages: [],
        liveRunning: false,
        livePhase: "idle",
        liveRetry: null,
        thinkingStarts: {},
        thinkingDurations: { "message-assistant-1700000000000": 5_000 },
        scrollToBottom: 0,
        onResend: async () => true,
      }),
    ),
  );
  expect(
    view.container
      .querySelector(".thinking-line summary")
      ?.getAttribute("aria-label"),
  ).toContain("5s");
  view.rerender(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(Transcript, {
        snapshot: state,
        liveMessages: [],
        liveRunning: false,
        livePhase: "idle",
        liveRetry: null,
        thinkingStarts: {},
        thinkingDurations: { e1: 5_000 },
        scrollToBottom: 0,
        onResend: async () => true,
      }),
    ),
  );
  expect(
    view.container
      .querySelector(".thinking-line summary")
      ?.getAttribute("aria-label"),
  ).toContain("5s");
});
