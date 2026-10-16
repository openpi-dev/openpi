import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiWebAdapter } from "../../web/adapter/pi-adapter.ts";
import { readSessionFork } from "../../web/protocol/session-fork.ts";
import { WEB_SESSION_FORK } from "../../web/protocol/session-fork.ts";
import {
  readSessionTurnEvidence,
  WEB_TURN_TIMING_ENTRY,
} from "../../web/protocol/turn-timing.ts";
import { WEB_TRANSCRIPT_SEARCH_MAX_TOTAL_BYTES } from "../../web/search/transcript-search.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";
import type { WebRuntimeController } from "../../web/runtime/types.ts";

function runtimeFor(
  cwd: string,
  sessionDirectory: string,
  sessionManager: SessionManager,
): WebRuntimeController {
  return {
    cwd,
    workspaceSelected: true,
    sessionDirectory,
    sessionManager,
    isIdle: () => true,
    getActiveTurn: () => undefined,
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    sendPrompt: async () => ({ pendingFollowUps: 0 }),
    newSession: async () => ({
      cancelled: false,
      sessionId: sessionManager.getSessionId(),
    }),
    switchSession: async () => ({ cancelled: false }),
    listModels: () => [],
    searchModels: (query, limit) => projectWebModelSearch([], query, limit),
    setModel: async () => {
      throw new Error("Model is not available");
    },
    subscribe: () => () => {},
    dispose: async () => {},
  };
}

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function persistSession(
  manager: SessionManager,
  content: string,
  timestamp: number,
) {
  manager.appendMessage({ role: "user", content, timestamp });
  return manager.appendMessage({
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage: zeroUsage,
    stopReason: "stop",
    timestamp,
  });
}

test("catalog metadata matches Pi and unchanged files are not read again", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openpi-catalog-identity-"));
  const directory = join(root, "sessions");
  t.after(() => rm(root, { recursive: true, force: true }));
  const named = SessionManager.create(root, directory);
  persistSession(named, "named first", 10);
  named.appendSessionInfo("Visible name");
  const plain = SessionManager.create(root, directory);
  persistSession(plain, "plain first", 20);
  const branched = SessionManager.create(root, directory);
  persistSession(branched, "kept", 30);
  const forkPoint = branched.getLeafId()!;
  persistSession(branched, "abandoned", 31);
  branched.branch(forkPoint);
  persistSession(branched, "replacement", 32);
  const oracle = await SessionManager.listAll(directory);
  const adapter = new PiWebAdapter(
    runtimeFor(root, directory, SessionManager.inMemory(root)),
  );
  const originalOpen = fsPromises.open;
  const opened: string[] = [];
  t.mock.method(
    fsPromises,
    "open",
    async (...args: Parameters<typeof originalOpen>) => {
      const path = String(args[0]);
      if (path.startsWith(directory) && path.endsWith(".jsonl"))
        opened.push(path);
      return originalOpen(...args);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const listed = await adapter.listSessions();
  const files = listed.filter((session) => session.path.endsWith(".jsonl"));
  const byPath = new Map(files.map((session) => [session.path, session]));
  assert.deepEqual(
    files.map((session) => session.id),
    oracle.map((session) => session.id),
  );
  for (const expected of oracle) {
    const actual = byPath.get(expected.path);
    assert.ok(actual);
    assert.equal(actual.messageCount, expected.messageCount);
    assert.equal(actual.name, expected.name);
    assert.equal(actual.firstMessage, expected.firstMessage.slice(0, 2_000));
    assert.equal(Date.parse(actual.modified), expected.modified.getTime());
    assert.equal(Date.parse(actual.created), expected.created.getTime());
  }
  const firstRead = [...opened];
  assert.equal(new Set(firstRead).size, oracle.length);
  const again = await adapter.listSessions();
  assert.deepEqual(
    again
      .filter((session) => session.path.endsWith(".jsonl"))
      .map((session) => session.id),
    files.map((session) => session.id),
  );
  assert.deepEqual(opened, firstRead);

  plain.appendMessage({ role: "user", content: "appended", timestamp: 40 });
  await adapter.listSessions();
  const appended = opened.slice(firstRead.length);
  assert.deepEqual(appended, [plain.getSessionFile()]);

  const from = named.getSessionFile()!;
  const to = join(directory, "renamed.jsonl");
  const beforeRename = opened.length;
  await rename(from, to);
  const renamed = await adapter.listSessions();
  assert.equal(
    renamed.some((session) => session.path === from),
    false,
  );
  assert.equal(
    renamed.find((session) => session.path === to)?.id,
    named.getSessionId(),
  );
  const renameReads = opened
    .slice(beforeRename)
    .filter((path) => path !== to && path !== from);
  assert.deepEqual(renameReads, []);

  const beforeDelete = opened.length;
  await rm(plain.getSessionFile()!);
  const remaining = await adapter.listSessions();
  assert.equal(
    remaining.some((session) => session.path === plain.getSessionFile()),
    false,
  );
  assert.deepEqual(opened.slice(beforeDelete), []);

  const replaced = branched.getSessionFile()!;
  const beforeReplace = opened.length;
  await writeFile(
    replaced,
    `${JSON.stringify({ type: "session", version: 3, id: "replaced-id", timestamp: "2026-10-15T00:00:00.000Z", cwd: root })}\n${JSON.stringify({ type: "message", id: "m", parentId: null, timestamp: "2026-10-15T00:00:00.000Z", message: { role: "user", content: "replaced body", timestamp: 50 } })}\n`,
  );
  const afterReplace = await adapter.listSessions();
  assert.equal(
    afterReplace.some((session) => session.id === branched.getSessionId()),
    false,
  );
  assert.equal(
    afterReplace.find((session) => session.path === replaced)?.firstMessage,
    "replaced body",
  );
  assert.deepEqual(opened.slice(beforeReplace), [replaced]);
});

test("non-current history keeps Pi's branch without a synchronous open or a second read", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openpi-history-read-"));
  const directory = join(root, "sessions");
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, directory);
  persistSession(manager, "kept", 1);
  const forkPoint = manager.getLeafId()!;
  const abandoned = manager.appendMessage({
    role: "user",
    content: "abandoned",
    timestamp: 2,
  });
  manager.branch(forkPoint);
  const replacement = persistSession(manager, "replacement", 3);
  const assistant = manager.getLeafId()!;
  manager.appendCustomEntry(WEB_TURN_TIMING_ENTRY, {
    version: 1,
    sessionId: manager.getSessionId(),
    commandId: "turn-1",
    epoch: 1,
    startedAt: 1,
    finishedAt: 3,
    elapsedMs: 2,
    outcome: "completed",
    unreadEligible: true,
    resultEntryId: assistant,
  });
  manager.appendCustomEntry(WEB_SESSION_FORK, {
    version: 1,
    sessionId: manager.getSessionId(),
    source: {
      sessionId: "source-session",
      sessionPath: join(root, "source.jsonl"),
      entryId: "source-entry",
    },
    environment: "local",
    cwd: root,
    workspacePath: join(root, "project"),
  });
  const path = manager.getSessionFile()!;
  const oracle = SessionManager.open(path, directory);
  const oracleBranch = oracle.getBranch();
  const oracleIds = oracleBranch.map((entry) => entry.id);
  const oracleFork = readSessionFork(
    oracleBranch,
    oracle.getSessionId(),
    oracle.getCwd(),
  );
  const oracleEvidence = readSessionTurnEvidence(
    oracleBranch,
    oracle.getSessionId(),
    false,
  );
  const adapter = new PiWebAdapter(
    runtimeFor(root, directory, SessionManager.inMemory(root)),
  );
  const originalOpen = SessionManager.open;
  const originalRead = fsPromises.readFile;
  let syncOpens = 0;
  let bodyReads = 0;
  SessionManager.open = ((...args: Parameters<typeof originalOpen>) => {
    syncOpens++;
    return originalOpen(...args);
  }) as typeof SessionManager.open;
  t.mock.method(
    fsPromises,
    "readFile",
    async (...args: Parameters<typeof originalRead>) => {
      if (args[0] === path) bodyReads++;
      return originalRead(...args);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    SessionManager.open = originalOpen;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const listed = await adapter.listSessions();
  const summary = listed.find((session) => session.path === path);
  assert.ok(summary);
  assert.equal(summary.workspacePath, oracleFork?.workspacePath);
  assert.equal(summary.unread, oracleEvidence.results.length > 0);
  const session = await adapter.getSession(path, [summary]);
  assert.ok(session);
  assert.equal(syncOpens, 0);
  assert.equal(bodyReads, 1);
  const projected = new Set(session.entries.map((entry) => entry.id));
  for (const id of projected) assert.ok(oracleIds.includes(id));
  assert.equal(projected.has(abandoned), false);
  assert.equal(projected.has(replacement), true);
  const anchor = session.entries[0]?.id;
  assert.ok(anchor);
  const page = await adapter.getSessionHistory(
    manager.getSessionId(),
    path,
    oracle.getLeafId()!,
    anchor,
  );
  assert.equal(page.status, "ok");
  assert.equal(bodyReads, 1);
  if (page.status === "ok") {
    for (const entry of page.session.entries)
      assert.ok(oracleIds.includes(entry.id));
  }
});

test("a long non-current history matches Pi's branch and yields before the request finishes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openpi-long-history-yield-"));
  const directory = join(root, "sessions");
  await mkdir(directory, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const messageCount = 10_000;
  const path = join(directory, "long-history.jsonl");
  const timestamp = "2026-10-15T00:00:00.000Z";
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "long-history",
      timestamp,
      cwd: root,
    }),
  ];
  for (let index = 0; index < messageCount; index++) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: `e-${index}`,
        parentId: index === 0 ? null : `e-${index - 1}`,
        timestamp,
        message: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text: "m" }],
          timestamp: 1_792_022_400_000,
        },
      }),
    );
  }
  await writeFile(path, `${lines.join("\n")}\n`);
  const oracle = SessionManager.open(path, directory);
  const oracleBranch = oracle.getBranch();
  const adapter = new PiWebAdapter(
    runtimeFor(root, directory, SessionManager.inMemory(root)),
  );
  const summary = (await adapter.listSessions()).find(
    (session) => session.path === path,
  );
  assert.ok(summary);
  assert.equal(summary.messageCount, messageCount);
  const originalRead = fsPromises.readFile;
  const originalSetTimeout = globalThis.setTimeout;
  let bodyReads = 0;
  let watchParseTurns = false;
  let parseTurns = 0;
  // Counts timer turns scheduled while the body is being parsed. A later
  // await, such as the identity stat, must not count: setImmediate would also
  // starve a caller timer between chunks.
  globalThis.setTimeout = function (
    this: unknown,
    ...args: Parameters<typeof setTimeout>
  ) {
    if (watchParseTurns && args[1] === 0) parseTurns++;
    return originalSetTimeout.apply(globalThis, args);
  } as typeof setTimeout;
  t.mock.method(
    fsPromises,
    "readFile",
    async (...args: Parameters<typeof originalRead>) => {
      const result = await originalRead(...args);
      if (args[0] === path) {
        bodyReads++;
        watchParseTurns = true;
      }
      return result;
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const session = await adapter.getSession(path, [summary]);
  watchParseTurns = false;
  assert.ok(parseTurns > 0);
  assert.equal(bodyReads, 1);
  assert.ok(session);
  assert.equal(session.history?.leafEntryId, oracle.getLeafId());
  assert.equal(
    session.truncation.entriesOmitted + session.entries.length,
    oracleBranch.length,
  );
  const earliest = await adapter.getSessionMessageWindow(
    summary.id,
    path,
    "e-0",
  );
  assert.equal(earliest.status, "ok");
  assert.equal(bodyReads, 1);
});

test("concurrent catalog reads share one scan", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openpi-catalog-share-"));
  const directory = join(root, "sessions");
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const id of ["a", "b", "c"]) {
    const manager = SessionManager.create(root, directory);
    persistSession(manager, id, 1);
  }
  const adapter = new PiWebAdapter(
    runtimeFor(root, directory, SessionManager.inMemory(root)),
  );
  const originalOpen = fsPromises.open;
  let opens = 0;
  let releaseHold: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  t.mock.method(
    fsPromises,
    "open",
    async (...args: Parameters<typeof originalOpen>) => {
      const path = String(args[0]);
      if (path.startsWith(directory) && path.endsWith(".jsonl")) {
        opens++;
        if (opens === 1) {
          entered();
          await hold;
        }
      }
      return originalOpen(...args);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    releaseHold();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const first = adapter.listSessions();
  await started;
  const second = adapter.listSessions();
  releaseHold();
  await Promise.all([first, second]);
  assert.equal(opens, 3);
});

test("search cancellation and byte budget include the catalog pre-scan", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openpi-search-budget-"));
  const directory = join(root, "sessions");
  await mkdir(directory, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const small = join(directory, "small");
  await mkdir(small, { recursive: true });
  for (let index = 0; index < 6; index++) {
    const manager = SessionManager.create(root, small);
    persistSession(manager, `needle ${index}`, index + 1);
  }
  const adapter = new PiWebAdapter(
    runtimeFor(root, small, SessionManager.inMemory(root)),
  );
  const controller = new AbortController();
  const originalOpen = fsPromises.open;
  let opens = 0;
  t.mock.method(
    fsPromises,
    "open",
    async (...args: Parameters<typeof originalOpen>) => {
      const path = String(args[0]);
      if (path.startsWith(small) && path.endsWith(".jsonl")) {
        opens++;
        if (opens === 1) controller.abort();
      }
      return originalOpen(...args);
    },
  );
  syncBuiltinESMExports();
  await assert.rejects(
    adapter.searchTranscripts("needle", { signal: controller.signal }),
    /abort/i,
  );
  assert.ok(opens < 6);
  t.mock.restoreAll();
  syncBuiltinESMExports();

  const bulky = join(directory, "bulky");
  await mkdir(bulky, { recursive: true });
  const fileBytes = 1024 * 1024;
  const fileCount =
    Math.floor(WEB_TRANSCRIPT_SEARCH_MAX_TOTAL_BYTES / fileBytes) + 2;
  await Promise.all(
    Array.from({ length: fileCount }, (_, index) =>
      writeFile(join(bulky, `${index}.jsonl`), Buffer.alloc(fileBytes, 120)),
    ),
  );
  let bulkyOpens = 0;
  t.mock.method(
    fsPromises,
    "open",
    async (...args: Parameters<typeof originalOpen>) => {
      const path = String(args[0]);
      if (path.startsWith(bulky) && path.endsWith(".jsonl")) bulkyOpens++;
      return originalOpen(...args);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const found = await new PiWebAdapter(
    runtimeFor(root, bulky, SessionManager.inMemory(root)),
  ).searchTranscripts("needle");
  assert.equal(found.partial, true);
  assert.ok(found.partialReasons.includes("byte-limit"));
  assert.ok(bulkyOpens < fileCount);
  assert.ok(bulkyOpens * fileBytes <= WEB_TRANSCRIPT_SEARCH_MAX_TOTAL_BYTES);
});
