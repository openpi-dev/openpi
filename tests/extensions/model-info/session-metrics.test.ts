import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { createSessionMetricsTracker } from "../../../extensions/model-info/session-metrics.ts";

const timestamp = "2026-08-27T00:00:00.000Z";

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
    ...overrides,
  };
}

function message(
  id: string,
  parentId: string | null,
  role: "user" | "assistant" | "toolResult",
  messageUsage?: Usage,
): SessionEntry {
  if (role === "assistant") {
    return {
      type: "message",
      id,
      parentId,
      timestamp,
      message: {
        role,
        content: [],
        api: "openai-responses",
        provider: "openai",
        model: "test",
        usage: messageUsage ?? usage(),
        stopReason: "stop",
        timestamp: 0,
      },
    };
  }

  if (role === "toolResult") {
    return {
      type: "message",
      id,
      parentId,
      timestamp,
      message: {
        role,
        toolCallId: `${id}-call`,
        toolName: "test",
        content: [],
        isError: false,
        timestamp: 0,
        ...(messageUsage ? { usage: messageUsage } : {}),
      },
    };
  }

  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role, content: [], timestamp: 0 },
  };
}

function compaction(
  id: string,
  parentId: string | null,
  entryUsage?: Usage,
): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp,
    summary: "summary",
    firstKeptEntryId: "kept",
    tokensBefore: 0,
    ...(entryUsage ? { usage: entryUsage } : {}),
  };
}

function branchSummary(
  id: string,
  parentId: string | null,
  entryUsage?: Usage,
): SessionEntry {
  return {
    type: "branch_summary",
    id,
    parentId,
    timestamp,
    fromId: "from",
    summary: "summary",
    ...(entryUsage ? { usage: entryUsage } : {}),
  };
}

function entryUsage(entry: SessionEntry) {
  if (entry.type === "message") {
    return entry.message.role === "assistant" ||
      entry.message.role === "toolResult"
      ? entry.message.usage
      : undefined;
  }
  return entry.type === "compaction" || entry.type === "branch_summary"
    ? entry.usage
    : undefined;
}

class InstrumentedSessionManager {
  readonly entries = new Map<string, SessionEntry>();
  readonly visits = new Map<string, number>();
  sessionId = "session-a";
  leafId: string | null = null;

  constructor(entries: SessionEntry[]) {
    for (const entry of entries) this.entries.set(entry.id, entry);
  }

  getSessionId() {
    return this.sessionId;
  }

  getLeafId() {
    return this.leafId;
  }

  getEntry(id: string) {
    this.visits.set(id, (this.visits.get(id) ?? 0) + 1);
    return this.entries.get(id);
  }

  setLeaf(id: string | null) {
    this.leafId = id;
  }

  append(entry: SessionEntry) {
    this.entries.set(entry.id, entry);
    this.leafId = entry.id;
  }

  visitCount() {
    return [...this.visits.values()].reduce((total, count) => total + count, 0);
  }
}

function fullActiveBranchMetrics(manager: InstrumentedSessionManager) {
  const entries: SessionEntry[] = [];
  let currentId = manager.leafId;
  while (currentId) {
    const entry = manager.entries.get(currentId);
    if (!entry) break;
    entries.push(entry);
    currentId = entry.parentId;
  }

  let cost = 0;
  let cacheRead = 0;
  let promptTokens = 0;
  for (const entry of entries.reverse()) {
    const currentUsage = entryUsage(entry);
    if (!currentUsage) continue;
    cost += currentUsage.cost.total;
    cacheRead += currentUsage.cacheRead;
    promptTokens +=
      currentUsage.input + currentUsage.cacheRead + currentUsage.cacheWrite;
  }
  return {
    cost,
    cachePercent: promptTokens > 0 ? (cacheRead / promptTokens) * 100 : null,
  };
}

test("matches a full scan of the active branch", () => {
  const manager = new InstrumentedSessionManager([
    message("user", null, "user"),
    message(
      "assistant",
      "user",
      "assistant",
      usage({
        input: 100,
        cacheRead: 50,
        cacheWrite: 25,
        cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      }),
    ),
    message(
      "tool",
      "assistant",
      "toolResult",
      usage({
        input: 10,
        cacheRead: 5,
        cacheWrite: 0,
        cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
      }),
    ),
  ]);
  manager.setLeaf("tool");

  assert.deepEqual(
    createSessionMetricsTracker().sync(manager),
    fullActiveBranchMetrics(manager),
  );
});

test("returns null cache percentage for zero and missing usage", () => {
  const manager = new InstrumentedSessionManager([
    message("user", null, "user"),
    message("assistant", "user", "assistant", usage()),
    message("tool", "assistant", "toolResult"),
    compaction("compaction", "tool"),
    branchSummary("summary", "compaction"),
  ]);
  manager.setLeaf("summary");

  assert.deepEqual(createSessionMetricsTracker().sync(manager), {
    cost: 0,
    cachePercent: null,
  });
});

test("does not revisit entries for a repeated sync of the same leaf", () => {
  const manager = new InstrumentedSessionManager([
    message("user", null, "user"),
    message("assistant", "user", "assistant", usage({ input: 10 })),
  ]);
  manager.setLeaf("assistant");
  const tracker = createSessionMetricsTracker();

  tracker.sync(manager);
  const visitsAfterFirstSync = manager.visitCount();

  tracker.sync(manager);

  assert.equal(manager.visitCount(), visitsAfterFirstSync);
});

test("visits each appended suffix entry once without revisiting cached ancestors", () => {
  const manager = new InstrumentedSessionManager([
    message("user", null, "user"),
    message("assistant", "user", "assistant", usage({ input: 10 })),
  ]);
  manager.setLeaf("assistant");
  const tracker = createSessionMetricsTracker();
  tracker.sync(manager);
  const cachedAncestorVisits = {
    user: manager.visits.get("user"),
    assistant: manager.visits.get("assistant"),
  };

  manager.append(
    message("tool", "assistant", "toolResult", usage({ input: 5 })),
  );
  manager.append(message("next", "tool", "assistant", usage({ input: 3 })));
  tracker.sync(manager);

  assert.equal(manager.visits.get("tool"), 1);
  assert.equal(manager.visits.get("next"), 1);
  assert.equal(manager.visits.get("user"), cachedAncestorVisits.user);
  assert.equal(manager.visits.get("assistant"), cachedAncestorVisits.assistant);
});

test("returns cached totals when switching to a cached ancestor", () => {
  const manager = new InstrumentedSessionManager([
    message("user", null, "user"),
    message("assistant", "user", "assistant", usage({ input: 10 })),
    message("tool", "assistant", "toolResult", usage({ input: 5 })),
  ]);
  manager.setLeaf("tool");
  const tracker = createSessionMetricsTracker();
  tracker.sync(manager);
  const visitsAfterInitialSync = manager.visitCount();

  manager.setLeaf("assistant");

  assert.deepEqual(tracker.sync(manager), fullActiveBranchMetrics(manager));
  assert.equal(manager.visitCount(), visitsAfterInitialSync);
});

test("visits an unseen sibling once without revisiting its cached ancestors", () => {
  const manager = new InstrumentedSessionManager([
    message("user", null, "user"),
    message("assistant", "user", "assistant", usage({ input: 10 })),
    message("tool", "assistant", "toolResult", usage({ input: 5 })),
    message("sibling", "assistant", "assistant", usage({ input: 7 })),
  ]);
  manager.setLeaf("tool");
  const tracker = createSessionMetricsTracker();
  tracker.sync(manager);
  const cachedAncestorVisits = {
    user: manager.visits.get("user"),
    assistant: manager.visits.get("assistant"),
  };

  manager.setLeaf("sibling");

  assert.deepEqual(tracker.sync(manager), fullActiveBranchMetrics(manager));
  assert.equal(manager.visits.get("sibling"), 1);
  assert.equal(manager.visits.get("user"), cachedAncestorVisits.user);
  assert.equal(manager.visits.get("assistant"), cachedAncestorVisits.assistant);
});

test("counts compaction and branch-summary usage", () => {
  const manager = new InstrumentedSessionManager([
    compaction(
      "compaction",
      null,
      usage({
        input: 20,
        cacheRead: 30,
        cacheWrite: 10,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
      }),
    ),
    branchSummary(
      "summary",
      "compaction",
      usage({
        input: 40,
        cacheRead: 20,
        cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 3 },
      }),
    ),
  ]);
  manager.setLeaf("summary");

  assert.deepEqual(createSessionMetricsTracker().sync(manager), {
    cost: 5,
    cachePercent: (50 / 120) * 100,
  });
});

test("recomputes all metrics after an explicit reset", () => {
  const manager = new InstrumentedSessionManager([
    message("user", null, "user"),
    message("assistant", "user", "assistant", usage({ input: 10 })),
  ]);
  manager.setLeaf("assistant");
  const tracker = createSessionMetricsTracker();
  tracker.sync(manager);
  const visitsAfterFirstSync = manager.visitCount();

  tracker.reset();

  assert.deepEqual(tracker.sync(manager), fullActiveBranchMetrics(manager));
  assert.equal(manager.visitCount(), visitsAfterFirstSync + 2);
});

test("resets automatically when a new session reuses entry ids", () => {
  const manager = new InstrumentedSessionManager([
    message(
      "entry",
      null,
      "assistant",
      usage({
        input: 10,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
      }),
    ),
  ]);
  manager.setLeaf("entry");
  const tracker = createSessionMetricsTracker();
  assert.deepEqual(tracker.sync(manager), { cost: 1, cachePercent: 0 });

  manager.sessionId = "session-b";
  manager.entries.set(
    "entry",
    message(
      "entry",
      null,
      "assistant",
      usage({
        input: 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 9 },
      }),
    ),
  );

  assert.deepEqual(tracker.sync(manager), { cost: 9, cachePercent: 0 });
  assert.equal(manager.visits.get("entry"), 2);
});
