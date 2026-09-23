import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WEB_COMMAND_INPUT } from "../../extensions/shared/web-command-feedback.ts";
import { WEB_TURN_CHANGES_ENTRY } from "../../web/protocol/turn-changes.ts";
import {
  jsonByteLength,
  WEB_MAX_ENTRIES,
  WEB_MAX_SELECTED_TRANSCRIPT_BYTES,
} from "../../web/protocol/types.ts";
import type { WebRuntimeController } from "../../web/runtime/types.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";

const agentDir = await mkdtemp(join(tmpdir(), "openpi-history-test-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { PiWebAdapter } = await import("../../web/adapter/pi-adapter.ts");
const { WebHost } = await import("../../web/host/web-host.ts");
after(() => rm(agentDir, { recursive: true, force: true }));
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function fixture(t: TestContext, persisted = false) {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-history-native-"));
  const directory = join(cwd, "sessions");
  await mkdir(directory);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const manager = persisted
    ? SessionManager.create(cwd, directory)
    : SessionManager.inMemory(cwd);
  const runtime: WebRuntimeController = {
    cwd,
    workspaceSelected: true,
    sessionDirectory: directory,
    sessionManager: manager,
    isIdle: () => true,
    getActiveTurn: () => undefined,
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    sendPrompt: async () => ({ pendingFollowUps: 0 }),
    newSession: async () => ({
      cancelled: true,
      sessionId: manager.getSessionId(),
    }),
    switchSession: async () => ({ cancelled: true }),
    listModels: () => [],
    searchModels: (query, limit) => projectWebModelSearch([], query, limit),
    setModel: async () => {
      throw new Error("unused");
    },
    subscribe: () => () => {},
    dispose: async () => {},
  };
  return { manager, runtime, adapter: new PiWebAdapter(runtime), directory };
}
function assistant(manager: SessionManager, text: string) {
  return manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    usage,
    timestamp: Date.now(),
  });
}

test("bounded native pages recover the user request omitted by a long single turn", async (t) => {
  const { manager, adapter } = await fixture(t);
  manager.appendMessage({
    role: "user",
    content: "Original user request",
    timestamp: 1,
  });
  for (let index = 0; index < 540; index++)
    assistant(manager, `Progress ${index}`);
  const latest = (await adapter.getSnapshot()).selectedSession!;
  assert.equal(latest.entries.length, WEB_MAX_ENTRIES);
  assert.equal(
    latest.entries.some((entry) => entry.message?.role === "user"),
    false,
  );
  let before = latest.history!.beforeEntryId;
  const all = [...latest.entries];
  while (before) {
    const result = await adapter.getSessionHistory(
      latest.id,
      latest.path,
      latest.history!.leafEntryId!,
      before,
    );
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.ok(result.session.entries.length <= WEB_MAX_ENTRIES);
    assert.ok(
      jsonByteLength({ session: result.session }) <=
        WEB_MAX_SELECTED_TRANSCRIPT_BYTES,
    );
    assert.equal(result.session.requestedBeforeEntryId, before);
    all.unshift(...result.session.entries);
    before = result.session.history!.beforeEntryId;
  }
  assert.deepEqual(
    all.map((entry) => entry.id),
    manager.getBranch().map((entry) => entry.id),
  );
  assert.equal(all[0]?.message?.content, "Original user request");
});

test("history pages follow user turns and retain every native entry", async (t) => {
  const { manager, adapter } = await fixture(t);
  for (let turn = 0; turn < 65; turn++) {
    manager.appendMessage({
      role: "user",
      content: `Request ${turn}`,
      timestamp: turn,
    });
    for (let step = 0; step < 4; step++)
      assistant(manager, `Response ${turn}.${step}`);
  }
  const latest = (await adapter.getSnapshot()).selectedSession!;
  const pages = [latest.entries];
  assert.equal(latest.entries[0]?.message?.role, "user");
  assert.equal(
    latest.entries.filter((entry) => entry.message?.role === "user").length,
    20,
  );
  let before = latest.history!.beforeEntryId;
  while (before) {
    const result = await adapter.getSessionHistory(
      latest.id,
      latest.path,
      latest.history!.leafEntryId!,
      before,
    );
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.session.entries[0]?.message?.role, "user");
    assert.ok(
      result.session.entries.filter((entry) => entry.message?.role === "user")
        .length <= 20,
    );
    pages.unshift(result.session.entries);
    assert.notEqual(result.session.history?.beforeEntryId, before);
    before = result.session.history!.beforeEntryId;
  }
  assert.deepEqual(
    pages.flat().map((entry) => entry.id),
    manager.getBranch().map((entry) => entry.id),
  );
});

test("a short page retains the native predecessor needed to reconcile a new prompt", async (t) => {
  const { manager, adapter } = await fixture(t);
  const predecessor = assistant(manager, "Earlier context");
  manager.appendMessage({ role: "user", content: "New prompt", timestamp: 1 });
  const latest = (await adapter.getSnapshot()).selectedSession!;
  assert.equal(latest.entries[0]?.id, predecessor);
  assert.equal(latest.truncation.entriesOmitted, 0);
});

test("a byte-bounded partial turn remains reachable behind a complete latest turn", async (t) => {
  const { manager, adapter } = await fixture(t);
  manager.appendMessage({
    role: "user",
    content: "Large earlier turn",
    timestamp: 1,
  });
  for (let step = 0; step < 240; step++)
    assistant(manager, `Evidence ${step}: ` + "content ".repeat(1200));
  manager.appendMessage({ role: "user", content: "Latest turn", timestamp: 2 });
  assistant(manager, "Latest answer");
  const latest = (await adapter.getSnapshot()).selectedSession!;
  assert.equal(latest.entries.at(-2)?.message?.content, "Latest turn");
  let before = latest.history!.beforeEntryId;
  const all = [...latest.entries];
  while (before) {
    const result = await adapter.getSessionHistory(
      latest.id,
      latest.path,
      latest.history!.leafEntryId!,
      before,
    );
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.ok(result.session.entries.length > 0);
    all.unshift(...result.session.entries);
    assert.notEqual(result.session.history?.beforeEntryId, before);
    before = result.session.history!.beforeEntryId;
  }
  assert.deepEqual(
    all.map((entry) => entry.id),
    manager.getBranch().map((entry) => entry.id),
  );
});

test("byte-bounded history remains pageable when fewer than 250 entries fill the snapshot", async (t) => {
  const { manager, adapter } = await fixture(t);
  manager.appendMessage({
    role: "user",
    content: "Before large results",
    timestamp: 1,
  });
  for (let index = 0; index < 140; index++)
    assistant(manager, `${index}:` + "evidence ".repeat(1200));
  const latest = (await adapter.getSnapshot()).selectedSession!;
  assert.ok(manager.getBranch().length < WEB_MAX_ENTRIES);
  assert.ok(latest.truncation.entriesOmitted > 0);
  const result = await adapter.getSessionHistory(
    latest.id,
    latest.path,
    latest.history!.leafEntryId!,
    latest.history!.beforeEntryId!,
  );
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.ok(
    jsonByteLength({ session: result.session }) <=
      WEB_MAX_SELECTED_TRANSCRIPT_BYTES,
  );
  assert.equal(
    result.session.entries[0]?.message?.content,
    "Before large results",
  );
  assert.equal(result.session.history?.beforeEntryId, null);
});

test("native ancestry accepts appended entries and rejects an existing entry on a different branch", async (t) => {
  const { manager, adapter } = await fixture(t);
  const root = manager.appendMessage({
    role: "user",
    content: "Shared root",
    timestamp: 1,
  });
  assistant(manager, "Old branch");
  const anchor = manager.getLeafId()!;
  const latest = (await adapter.getSnapshot()).selectedSession!;
  assistant(manager, "Appended entry");
  const appended = (
    await adapter.getSnapshot(latest.path, {
      sessionId: latest.id,
      entryId: anchor,
    })
  ).selectedSession!;
  assert.equal(appended.history?.anchorOnBranch, true);
  assert.equal(
    (await adapter.getSessionHistory(latest.id, latest.path, anchor, anchor))
      .status,
    "ok",
  );
  assert.equal(
    (
      await adapter.getSessionHistory(
        latest.id,
        latest.path,
        root,
        manager.getLeafId()!,
      )
    ).status,
    "changed",
  );
  manager.branch(root);
  assistant(manager, "New branch");
  assert.ok(
    manager.getEntry(anchor),
    "the old entry remains in the native tree",
  );
  const changed = (
    await adapter.getSnapshot(latest.path, {
      sessionId: latest.id,
      entryId: anchor,
    })
  ).selectedSession!;
  assert.equal(changed.history?.anchorOnBranch, false);
  assert.equal(
    (await adapter.getSessionHistory(latest.id, latest.path, anchor, anchor))
      .status,
    "changed",
  );
});

test("an oversized multi-part message keeps its native entry boundary instead of becoming an empty skipped page", async (t) => {
  const { manager, adapter } = await fixture(t);
  const user = manager.appendMessage({
    role: "user",
    content: "Original question",
    timestamp: 1,
  });
  const huge = manager.appendMessage({
    role: "assistant",
    content: Array.from({ length: 64 }, () => ({
      type: "text",
      text: "测试".repeat(6000),
    })),
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    usage,
    timestamp: 2,
  });
  const current = (await adapter.getSnapshot()).selectedSession!;
  assert.ok(current.entries.some((entry) => entry.id === huge));
  assert.ok(
    current.entries.find((entry) => entry.id === huge)?.message?.truncation
      ?.partsOmitted,
  );
  const tail = assistant(manager, "Later response");
  const result = await adapter.getSessionHistory(
    current.id,
    current.path,
    tail,
    tail,
  );
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.ok(
    result.session.entries.some((entry) => entry.id === huge),
    "the oversized entry itself remains reachable",
  );
  assert.ok(
    jsonByteLength({ session: result.session }) <=
      WEB_MAX_SELECTED_TRANSCRIPT_BYTES,
  );
  const ids = new Set(result.session.entries.map((entry) => entry.id));
  if (result.session.history?.beforeEntryId) {
    const previous = await adapter.getSessionHistory(
      current.id,
      current.path,
      tail,
      result.session.history.beforeEntryId,
    );
    assert.equal(previous.status, "ok");
    if (previous.status === "ok")
      for (const entry of previous.session.entries) ids.add(entry.id);
  }
  assert.ok(
    ids.has(user),
    "the question before the oversized response is also reachable",
  );
});

test("history reads keep copied Session files distinct even when embedded IDs match", async (t) => {
  const { manager, adapter, directory } = await fixture(t, true);
  const root = manager.appendMessage({
    role: "user",
    content: "Original",
    timestamp: 1,
  });
  const originalAnchor = assistant(manager, "Original branch response");
  const original = (await adapter.getSnapshot()).selectedSession!;
  const copyPath = join(directory, "copied.jsonl");
  await writeFile(copyPath, await readFile(manager.getSessionFile()!));
  const copy = SessionManager.open(copyPath);
  copy.branch(root);
  const copyAnchor = assistant(copy, "Copy branch response");
  assert.equal(copy.getSessionId(), manager.getSessionId());
  assert.equal(
    (
      await adapter.getSessionHistory(
        original.id,
        copyPath,
        originalAnchor,
        originalAnchor,
      )
    ).status,
    "changed",
  );
  const result = await adapter.getSessionHistory(
    original.id,
    copyPath,
    copyAnchor,
    copyAnchor,
  );
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.equal(result.session.path, copyPath);
  const copiedItem = await adapter.getSessionItem(
    original.id,
    copyPath,
    copyAnchor,
    0,
  );
  assert.equal(copiedItem.status, "ok");
  if (copiedItem.status === "ok")
    assert.equal(copiedItem.page.text, "Copy branch response");
  assert.equal(
    (await adapter.getSessionItem(original.id, original.path, copyAnchor, 0))
      .status,
    "changed",
  );
  const wrongIdentity = (
    await adapter.getSnapshot(original.path, {
      sessionId: "different",
      entryId: root,
    })
  ).selectedSession!;
  assert.equal(wrongIdentity.history?.anchorOnBranch, false);
});

test("native item pages recover truncated text and text beyond the preview part limit", async (t) => {
  const { manager, adapter } = await fixture(t);
  const body = `${"a".repeat(31_999)}\ud83d\ude00${"b".repeat(40_000)}`;
  const user = manager.appendMessage({
    role: "user",
    content: body,
    timestamp: 1,
  });
  const parts = Array.from({ length: 70 }, (_, index) => ({
    type: "text" as const,
    text: `Segment ${index}: ${"content".repeat(250)}`,
  }));
  const answer = manager.appendMessage({
    role: "assistant",
    content: parts,
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    usage,
    timestamp: 2,
  });
  const snapshot = (await adapter.getSnapshot()).selectedSession!;
  assert.equal(
    snapshot.entries.find((entry) => entry.id === user)?.message?.truncation
      ?.visibleText,
    true,
  );
  assert.equal(
    snapshot.entries.find((entry) => entry.id === answer)?.message?.truncation
      ?.visibleText,
    true,
  );

  for (const [entryId, expected] of [
    [user, body],
    [answer, parts.map((part) => part.text).join("\n")],
  ] as const) {
    let cursor = 0;
    let restored = "";
    while (true) {
      const result = await adapter.getSessionItem(
        snapshot.id,
        snapshot.path,
        entryId,
        cursor,
      );
      assert.equal(result.status, "ok");
      if (result.status !== "ok") break;
      assert.ok(result.page.text.length <= 32_000);
      restored += result.page.text;
      if (result.page.nextCursor === null) {
        assert.equal(result.page.totalChars, expected.length);
        break;
      }
      assert.ok(result.page.nextCursor > cursor);
      cursor = result.page.nextCursor;
    }
    assert.equal(restored, expected);
  }
  assert.equal(
    (
      await adapter.getSessionItem(
        snapshot.id,
        snapshot.path,
        user,
        body.length + 1,
      )
    ).status,
    "invalid_cursor",
  );
});

test("item hydration rejects entries outside the selected native branch", async (t) => {
  const { manager, adapter } = await fixture(t);
  const root = manager.appendMessage({
    role: "user",
    content: "Shared",
    timestamp: 1,
  });
  const discarded = assistant(manager, "Old branch");
  const session = (await adapter.getSnapshot()).selectedSession!;
  manager.branch(root);
  assistant(manager, "New branch");
  assert.equal(
    (await adapter.getSessionItem(session.id, session.path, discarded, 0))
      .status,
    "changed",
  );
  assert.equal(
    (await adapter.getSessionItem("different", session.path, root, 0)).status,
    "changed",
  );
  assert.equal(
    (await adapter.getSessionItem(session.id, session.path, root, 0)).status,
    "ok",
  );
});

test("item hydration includes visible native command input without exposing tool results", async (t) => {
  const { manager, adapter } = await fixture(t);
  const content = "/openpi-setup " + "model ".repeat(3_000);
  const command = manager.appendCustomEntry(WEB_COMMAND_INPUT, {
    text: content,
  });
  const tool = manager.appendMessage({
    role: "toolResult",
    toolCallId: "tool-1",
    toolName: "bash",
    content: [{ type: "text", text: "private tool output" }],
    isError: false,
    timestamp: 2,
  });
  const session = (await adapter.getSnapshot()).selectedSession!;
  const result = await adapter.getSessionItem(
    session.id,
    session.path,
    command,
    0,
  );
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.equal(result.page.text, content);
  assert.equal(
    (await adapter.getSessionItem(session.id, session.path, tool, 0)).status,
    "changed",
  );
});

test("snapshot fitting retains a real latest-entry cursor before dropping bounded catalog rows", async (t) => {
  const { manager, runtime, adapter, directory } = await fixture(t, true);
  manager.appendMessage({
    role: "user",
    content: "Question before the large response",
    timestamp: 1,
  });
  const huge = manager.appendMessage({
    role: "assistant",
    content: Array.from({ length: 64 }, () => ({
      type: "text",
      text: "测试".repeat(6000),
    })),
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    usage,
    timestamp: 2,
  });
  for (let index = 0; index < 500; index++) {
    const other = SessionManager.create(runtime.cwd, directory);
    other.appendMessage({
      role: "user",
      content: "问".repeat(500),
      timestamp: index,
    });
    assistant(other, "");
  }
  runtime.listModels = () =>
    Array.from({ length: 250 }, (_, index) => ({
      provider: "模".repeat(500),
      id: `${index}${"模".repeat(500)}`,
      name: "模".repeat(500),
      label: "模".repeat(500),
      current: index === 0,
    }));
  const snapshot = await adapter.getSnapshot();
  assert.ok(jsonByteLength(snapshot) <= 4 * 1024 * 1024);
  assert.ok(
    snapshot.selectedSession?.entries.some((entry) => entry.id === huge),
  );
  assert.ok(snapshot.selectedSession?.history?.beforeEntryId);
  assert.ok(
    snapshot.truncation.sessionsOmitted > 0 ||
      snapshot.truncation.modelsOmitted > 0,
  );
});

test("history HTTP reads require authentication and exact bounded native cursors", async (t) => {
  const { manager, runtime } = await fixture(t);
  manager.appendMessage({ role: "user", content: "Question", timestamp: 1 });
  const leaf = assistant(manager, "Answer");
  const host = new WebHost({ runtime, token: "ab".repeat(32) });
  await host.start();
  t.after(() => host.stop());
  const headers = { Authorization: `Bearer ${"ab".repeat(32)}` };
  const path = `current:${manager.getSessionId()}`;
  const query = new URLSearchParams({
    sessionId: manager.getSessionId(),
    path,
    anchorEntryId: leaf,
    beforeEntryId: leaf,
  });
  const address = `${host.origin}/api/session/history?${query}`;
  assert.equal((await fetch(address)).status, 401);
  assert.equal(
    (await fetch(`${address}&beforeEntryId=${leaf}`, { headers })).status,
    400,
  );
  const response = await fetch(address, { headers });
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).session.entries[0].message.content,
    "Question",
  );
  query.set("path", join(tmpdir(), "not-a-known-session.jsonl"));
  assert.equal(
    (await fetch(`${host.origin}/api/session/history?${query}`, { headers }))
      .status,
    404,
  );
  query.set("path", path);
  query.set("sessionId", "different-session");
  assert.equal(
    (await fetch(`${host.origin}/api/session/history?${query}`, { headers }))
      .status,
    409,
  );
});

test("item HTTP reads are explicit, authenticated, and bounded", async (t) => {
  const { manager, runtime } = await fixture(t);
  const text = "A".repeat(90_000);
  const entryId = manager.appendMessage({
    role: "user",
    content: text,
    timestamp: 1,
  });
  const host = new WebHost({ runtime, token: "cd".repeat(32) });
  await host.start();
  t.after(() => host.stop());
  const headers = { Authorization: `Bearer ${"cd".repeat(32)}` };
  const query = new URLSearchParams({
    sessionId: manager.getSessionId(),
    sessionPath: `current:${manager.getSessionId()}`,
    entryId,
    cursor: "0",
  });
  const address = `${host.origin}/api/session/item?${query}`;
  assert.equal((await fetch(address)).status, 401);
  assert.equal(
    (await fetch(`${address}&entryId=${entryId}`, { headers })).status,
    400,
  );
  const response = await fetch(address, { headers });
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.text, text.slice(0, 32_000));
  assert.equal(page.nextCursor, 32_000);
  query.set("cursor", "9999999999");
  assert.equal(
    (await fetch(`${host.origin}/api/session/item?${query}`, { headers }))
      .status,
    400,
  );
  query.set("cursor", "0");
  query.set("sessionId", "different");
  assert.equal(
    (await fetch(`${host.origin}/api/session/item?${query}`, { headers }))
      .status,
    409,
  );
});

test("turn review reads the persisted prompt-bound diff, not the current workspace", async (t) => {
  const { manager, runtime, adapter } = await fixture(t);
  const promptEntryId = manager.appendMessage({
    role: "user",
    content: "Edit the file",
    timestamp: 1,
  });
  assistant(manager, "Done");
  const sessionId = manager.getSessionId();
  const path = `current:${sessionId}`;
  const diff =
    "diff --git a/example.txt b/example.txt\n@@ -1 +1 @@\n-old\n+new\n";
  manager.appendCustomEntry(WEB_TURN_CHANGES_ENTRY, {
    version: 1,
    sessionId,
    promptEntryId,
    state: "complete",
    fileCount: 1,
    files: [
      {
        path: "example.txt",
        status: "modified",
        additions: 1,
        deletions: 1,
        diff,
        diffTruncated: false,
      },
    ],
    additions: 1,
    deletions: 1,
  });
  const result = await adapter.getTurnChanges(sessionId, path, promptEntryId);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.changes.files[0]?.diff, diff);
  assert.deepEqual(
    await adapter.getTurnChanges(sessionId, path, promptEntryId, "other.txt"),
    { ok: false, reason: "not_found" },
  );

  const host = new WebHost({ runtime, token: "ef".repeat(32) });
  await host.start();
  t.after(() => host.stop());
  const headers = { Authorization: `Bearer ${"ef".repeat(32)}` };
  const query = new URLSearchParams({
    sessionId,
    sessionPath: path,
    promptEntryId,
  });
  const address = `${host.origin}/api/turn-changes?${query}`;
  assert.equal((await fetch(address)).status, 401);
  assert.equal(
    (await fetch(`${address}&promptEntryId=${promptEntryId}`, { headers }))
      .status,
    400,
  );
  assert.equal(
    (await (await fetch(address, { headers })).json()).changes.files[0].diff,
    diff,
  );

  manager.appendMessage({
    role: "user",
    content: "A later turn",
    timestamp: 2,
  });
  manager.appendCustomEntry(WEB_TURN_CHANGES_ENTRY, {
    version: 1,
    sessionId,
    promptEntryId,
    state: "complete",
    fileCount: 1,
    files: [
      {
        path: "wrong.txt",
        status: "added",
        additions: 1,
        deletions: 0,
        diff: "wrong",
        diffTruncated: false,
      },
    ],
    additions: 1,
    deletions: 0,
  });
  assert.equal(
    (await adapter.getTurnChanges(sessionId, path, promptEntryId)).ok,
    true,
  );
  manager.branch(promptEntryId);
  assert.deepEqual(
    await adapter.getTurnChanges(sessionId, path, promptEntryId),
    { ok: false, reason: "not_found" },
  );
});
