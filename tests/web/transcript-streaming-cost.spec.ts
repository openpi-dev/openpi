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
        new Map(),
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

  it("reuses one exact assistant row and keeps a truncated duplicate on the native id", () => {
    const aliased = buildEntries(
      snapshot([messageEntry("e1", complete)]),
      [{ key: "live-1", message: complete }],
      new Map(),
    );
    expect(aliased.entries.map((entry) => entry.key)).toEqual(["live-1"]);

    const truncated = {
      ...complete,
      truncation: { truncated: true as const },
    };
    const reconciled = buildEntries(
      snapshot([messageEntry("e1", truncated)]),
      [{ key: "live-1", message: truncated }],
      new Map(),
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
      new Map(),
    );
    expect(
      distinct.entries.map((entry) => [entry.key, entry.message.content]),
    ).toEqual([
      ["e1", "same"],
      ["live-1", "other"],
    ]);
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
        new Map(),
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
      buildEntries(state, [], new Map()).entries.map(
        (entry) => entry.message.content,
      ),
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
      buildEntries(state, [], new Map()).entries.map(
        (entry) => entry.message.content,
      ),
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
    const pending = buildEntries(snapshot(persisted), [optimistic], new Map());
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
      new Map(),
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
