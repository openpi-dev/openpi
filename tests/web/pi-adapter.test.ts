import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fsPromises from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  PiWebAdapter,
  WEB_SESSION_MARKDOWN_MAX_BYTES,
} from "../../web/adapter/pi-adapter.ts";
import { WebHost } from "../../web/host/web-host.ts";
import { WEB_TURN_TIMING_ENTRY } from "../../web/protocol/turn-timing.ts";
import { WEB_SESSION_FORK } from "../../web/protocol/session-fork.ts";
import {
  WEB_MAX_SELECTED_TRANSCRIPT_BYTES,
  WEB_MAX_SESSIONS,
  WEB_MAX_SNAPSHOT_BYTES,
  WEB_MAX_WORKSPACES,
} from "../../web/protocol/types.ts";
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
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

test("worktree forks stay in the original sidebar project while file authority and native cwd remain isolated after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openpi-worktree-projection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const worktree = join(project, ".git", "pi-worktrees", "fork");
  const cwd = join(worktree, "src");
  const sessions = join(root, "sessions");
  await mkdir(cwd, { recursive: true });
  const source = SessionManager.create(project, sessions);
  persistSession(source, "Source", 1);
  const sourcePath = source.getSessionFile()!;
  const sourceId = source.getSessionId();
  const sourceLeaf = source.getLeafId()!;
  const child = SessionManager.open(sourcePath, sessions, cwd);
  child.createBranchedSession(sourceLeaf);
  child.appendCustomEntry(WEB_SESSION_FORK, {
    version: 1,
    sessionId: child.getSessionId(),
    source: {
      sessionId: sourceId,
      sessionPath: sourcePath,
      entryId: sourceLeaf,
    },
    environment: "worktree",
    cwd,
    workspacePath: project,
    worktree: { path: worktree, baseSha: "a".repeat(40), sourceRoot: project },
  });
  const runtime = runtimeFor(cwd, sessions, child);
  for (let restart = 0; restart < 2; restart++) {
    const adapter = new PiWebAdapter(runtime);
    const data = await adapter.getSnapshot(child.getSessionFile());
    assert.deepEqual(
      data.workspaces.map((item) => item.path),
      [project],
    );
    assert.equal(data.workspaces[0]!.current, true);
    assert.equal(data.selectedSession?.cwd, cwd);
    const projected = data.sessions.find(
      (item) => item.id === child.getSessionId(),
    );
    assert.equal(projected?.workspacePath, project);
    assert.equal(projected?.worktree?.path, worktree);
    assert.equal(await adapter.requireWorkspace(cwd), cwd);
    assert.equal(
      (await adapter.requireSession(child.getSessionFile()!)).cwd,
      cwd,
    );
    await assert.rejects(
      adapter.requireWorkspace(join(root, "unrelated")),
      /not available/u,
    );
  }
});

function persistSession(
  manager: SessionManager,
  content: string,
  timestamp: number,
) {
  manager.appendMessage({ role: "user", content, timestamp });
  manager.appendMessage({
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

test("archived worktree forks filter by their original project and retain native cwd after restart", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "openpi-archive-worktree-project-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const worktree = join(project, ".git", "pi-worktrees", "archive-fork");
  const cwd = join(worktree, "src");
  const directory = join(root, "sessions");
  await mkdir(cwd, { recursive: true });
  const source = SessionManager.create(project, directory);
  persistSession(source, "Source", 1);
  const sourcePath = source.getSessionFile()!;
  const sourceLeaf = source.getLeafId()!;
  const child = SessionManager.open(sourcePath, directory, cwd);
  child.createBranchedSession(sourceLeaf);
  child.appendCustomEntry(WEB_SESSION_FORK, {
    version: 1,
    sessionId: child.getSessionId(),
    source: {
      sessionId: source.getSessionId(),
      sessionPath: sourcePath,
      entryId: sourceLeaf,
    },
    environment: "worktree",
    cwd,
    workspacePath: project,
    worktree: { path: worktree, baseSha: "a".repeat(40), sourceRoot: project },
  });
  persistSession(child, "Archived fork", 2);
  const childPath = child.getSessionFile()!;
  const runtime = runtimeFor(root, directory, SessionManager.inMemory(root));
  await new PiWebAdapter(runtime).archiveSession(childPath);

  for (let restart = 0; restart < 2; restart++) {
    const adapter = new PiWebAdapter(runtime);
    const page = await adapter.listArchivedSessions({ cwd: project, limit: 1 });
    assert.equal(page.status, "ok");
    if (page.status !== "ok") return;
    assert.equal(page.sessions.length, 1);
    assert.equal(page.sessions[0]!.path, childPath);
    assert.equal(page.sessions[0]!.workspacePath, project);
    assert.equal(page.sessions[0]!.cwd, cwd);
    assert.equal(page.sessions[0]!.worktree?.path, worktree);
    const byNativeDirectory = await adapter.listArchivedSessions({ cwd });
    assert.equal(byNativeDirectory.status, "ok");
    if (byNativeDirectory.status !== "ok") return;
    assert.deepEqual(byNativeDirectory.sessions, []);
    assert.equal((await adapter.requireSession(childPath)).cwd, cwd);
    assert.ok(
      (await adapter.getSnapshot()).workspaces.some(
        (item) => item.path === project,
      ),
    );
  }
});

test("content search uses Pi's visible catalog and locates older messages in a bounded native window", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-search-window-"));
  const directory = join(root, "sessions");
  try {
    const manager = SessionManager.create(root, directory);
    persistSession(manager, "older BODY-NEEDLE", 1);
    const promptId = manager
      .getBranch()
      .find(
        (entry) => entry.type === "message" && entry.message.role === "user",
      )!.id;
    manager.appendSessionInfo("Searchable title");
    for (let index = 0; index < 340; index++)
      persistSession(manager, `later turn ${index}`, index + 2);
    const path = manager.getSessionFile()!;
    const runtime = runtimeFor(root, directory, manager);
    const adapter = new PiWebAdapter(runtime);
    const recent = await adapter.getSession(path);
    assert.ok(!recent!.entries.some((entry) => entry.id === promptId));
    const found = await adapter.searchTranscripts("BODY-NEEDLE");
    assert.equal(found.matches.length, 1);
    assert.equal(found.matches[0]!.sessionName, "Searchable title");
    assert.equal(found.matches[0]!.messageId, promptId);
    const window = await adapter.getSessionMessageWindow(
      manager.getSessionId(),
      path,
      promptId,
    );
    assert.equal(window.status, "ok");
    if (window.status === "ok") {
      assert.equal(window.session.history!.anchorOnBranch, true);
      assert.ok(window.session.entries.some((entry) => entry.id === promptId));
      assert.ok(
        Buffer.byteLength(JSON.stringify({ session: window.session })) <=
          WEB_MAX_SELECTED_TRANSCRIPT_BYTES,
      );
    }
    assert.equal(
      (await adapter.getSessionMessageWindow("copied-id", path, promptId))
        .status,
      "changed",
    );
    assert.equal(
      (
        await adapter.getSessionMessageWindow(
          manager.getSessionId(),
          path,
          "missing",
        )
      ).status,
      "changed",
    );
    await adapter.archiveSession(path);
    assert.equal(
      (await adapter.searchTranscripts("BODY-NEEDLE")).matches.length,
      0,
    );
    assert.equal(
      (
        await adapter.searchTranscripts("BODY-NEEDLE", {
          includeArchived: true,
        })
      ).matches.length,
      1,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      adapter.searchTranscripts("BODY-NEEDLE", { signal: controller.signal }),
      /abort/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pins preserve identity and manual order across reload, archive and workspace changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-pins-"));
  const sessionDirectory = join(root, "sessions");
  try {
    const first = SessionManager.create(root, sessionDirectory);
    persistSession(first, "first", 1);
    const second = SessionManager.create(root, sessionDirectory);
    persistSession(second, "second", 2);
    const runtime = runtimeFor(root, sessionDirectory, second);
    const adapter = new PiWebAdapter(runtime);
    const a = { path: first.getSessionFile()!, id: first.getSessionId() };
    const b = { path: second.getSessionFile()!, id: second.getSessionId() };
    const ordered = async (source: PiWebAdapter) =>
      (await source.listSessions())
        .filter(
          (session) => session.pinOrder !== undefined && !session.archived,
        )
        .sort((a, b) => a.pinOrder! - b.pinOrder!)
        .map((session) => session.path);
    await Promise.all([
      adapter.setSessionPin(a.path, a.id, true),
      adapter.setSessionPin(b.path, b.id, true),
    ]);
    assert.deepEqual(await ordered(adapter), [a.path, b.path]);
    await adapter.setSessionPin(b.path, b.id, true, a);
    await adapter.setSessionPin(b.path, b.id, true); // Retry does not move an existing pin.
    assert.deepEqual(await ordered(new PiWebAdapter(runtime)), [
      b.path,
      a.path,
    ]);
    await adapter.archiveSession(b.path);
    assert.deepEqual(await ordered(adapter), [a.path]);
    await adapter.unarchiveSession(b.path);
    assert.deepEqual(await ordered(adapter), [b.path, a.path]);
    await adapter.renameWorkspace(root, "Renamed");
    assert.deepEqual(await ordered(new PiWebAdapter(runtime)), [
      b.path,
      a.path,
    ]);
    await assert.rejects(
      adapter.setSessionPin(a.path, "stale-id", false),
      /identity changed/,
    );
    await assert.rejects(
      adapter.setSessionPin(a.path, a.id, true, {
        path: b.path,
        id: "stale-id",
      }),
      /order changed/,
    );
    const copyPath = join(sessionDirectory, "copied.jsonl");
    await writeFile(copyPath, await readFile(a.path));
    assert.equal(
      (await adapter.listSessions()).find(
        (session) => session.path === copyPath,
      )?.pinOrder,
      undefined,
    );
    await adapter.setSessionPin(a.path, a.id, false);
    assert.deepEqual(await ordered(new PiWebAdapter(runtime)), [b.path]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pin writes fail closed and retain the previous persisted order", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-pin-failure-"));
  const sessionDirectory = join(root, "sessions");
  try {
    const manager = SessionManager.create(root, sessionDirectory);
    persistSession(manager, "first", 1);
    const adapter = new PiWebAdapter(
      runtimeFor(root, sessionDirectory, manager),
    );
    const path = manager.getSessionFile()!;
    await adapter.setSessionPin(path, manager.getSessionId(), true);
    const metadata = join(sessionDirectory, "workspace-state.json");
    const prior = await readFile(metadata, "utf8");
    await rm(metadata);
    await mkdir(metadata);
    await assert.rejects(
      adapter.setSessionPin(path, manager.getSessionId(), false),
    );
    assert.equal(
      (await adapter.listSessions()).find((session) => session.path === path)
        ?.pinOrder,
      0,
    );
    await rm(metadata, { recursive: true });
    await writeFile(metadata, prior);
    await adapter.setSessionPin(path, manager.getSessionId(), false);
    assert.equal(
      (await adapter.listSessions()).find((session) => session.path === path)
        ?.pinOrder,
      undefined,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session projection uses the selected file when IDs are duplicated", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-session-identity-"));
  const sessionDirectory = join(root, "sessions");
  try {
    const current = SessionManager.create(root, sessionDirectory);
    persistSession(current, "original conversation", 1);
    const currentPath = current.getSessionFile()!;
    const copyPath = join(sessionDirectory, "copied-session.jsonl");
    await writeFile(copyPath, await readFile(currentPath));
    const copy = SessionManager.open(copyPath, sessionDirectory);
    persistSession(copy, "copied conversation only", 2);
    await utimes(copyPath, new Date(), new Date(Date.now() + 10_000));
    const adapter = new PiWebAdapter(
      runtimeFor(root, sessionDirectory, current),
    );

    const snapshot = await adapter.getSnapshot(copyPath);
    assert.equal(snapshot.selectedSession?.path, copyPath);
    assert.equal(
      snapshot.sessions.find((item) => item.path === copyPath)?.controller,
      "none",
    );
    assert.match(
      JSON.stringify(snapshot.selectedSession?.entries),
      /copied conversation only/,
    );
    assert.doesNotMatch(
      JSON.stringify((await adapter.getSession(currentPath))?.entries),
      /copied conversation only/,
    );
    assert.equal(
      (await adapter.getSnapshot()).selectedSession?.path,
      currentPath,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session summaries include only known execution facts for an exact Session identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-session-status-"));
  const sessionDirectory = join(root, "sessions");
  try {
    const current = SessionManager.create(root, sessionDirectory);
    persistSession(current, "current conversation", 1);
    const currentPath = current.getSessionFile()!;
    const copiedPath = join(sessionDirectory, "copied-session.jsonl");
    await writeFile(copiedPath, await readFile(currentPath));
    const unknown = SessionManager.create(root, sessionDirectory);
    persistSession(unknown, "unloaded conversation", 2);
    const runtime = runtimeFor(root, sessionDirectory, current);
    runtime.getSessionExecution = (sessionId, sessionPath) => {
      if (sessionId === current.getSessionId()) {
        return {
          sessionId,
          sessionPath: currentPath,
          status: "running",
          pendingFollowUps: 2,
          queuedMessages: ["private queued content"],
          liveTools: [],
          liveToolsOmitted: 0,
        };
      }
      return {
        sessionId,
        sessionPath,
        status: "unknown",
        liveTools: [],
        liveToolsOmitted: 0,
      };
    };
    const adapter = new PiWebAdapter(runtime);
    const sessions = await adapter.listSessions();
    assert.deepEqual(
      sessions.find((session) => session.path === currentPath)?.execution,
      {
        status: "running",
        pendingFollowUps: 2,
      },
    );
    assert.equal(
      sessions.find((session) => session.path === copiedPath)?.execution,
      undefined,
    );
    assert.equal(
      sessions.find((session) => session.path === unknown.getSessionFile())
        ?.execution,
      undefined,
    );
    assert.doesNotMatch(JSON.stringify(sessions), /private queued content/);

    runtime.getSessionExecution = (sessionId, sessionPath) => ({
      sessionId: "mismatched-id",
      sessionPath,
      status: "running",
      pendingFollowUps: 3,
      liveTools: [],
      liveToolsOmitted: 0,
    });
    assert.equal(
      (await adapter.listSessions()).some((session) => session.execution),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renaming a copied session does not rename the active session with the same ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-session-rename-"));
  const sessionDirectory = join(root, "sessions");
  try {
    const current = SessionManager.create(root, sessionDirectory);
    persistSession(current, "original conversation", 1);
    current.appendSessionInfo("active name");
    const currentPath = current.getSessionFile()!;
    const originalBytes = await readFile(currentPath);
    const copyPath = join(sessionDirectory, "copied-session.jsonl");
    await writeFile(copyPath, originalBytes);
    const adapter = new PiWebAdapter(
      runtimeFor(root, sessionDirectory, current),
    );

    await adapter.renameSession(copyPath, "copy name");
    assert.equal(
      SessionManager.open(copyPath, sessionDirectory).getSessionName(),
      "copy name",
    );
    assert.equal(current.getSessionName(), "active name");
    assert.deepEqual(await readFile(currentPath), originalBytes);
    await adapter.renameSession(currentPath, "new active name");
    assert.equal(current.getSessionName(), "new active name");
    assert.equal(
      SessionManager.open(copyPath, sessionDirectory).getSessionName(),
      "copy name",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conversation Markdown exports the complete current native branch rather than the bounded transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-conversation-markdown-"));
  try {
    const manager = SessionManager.inMemory(root);
    manager.appendSessionInfo("Complete conversation");
    const first = manager.appendMessage({
      role: "user",
      content: "first-visible",
      timestamp: 1,
    });
    manager.appendMessage({
      role: "user",
      content: "abandoned-branch-secret",
      timestamp: 2,
    });
    manager.branch(first);
    const sections = [
      "# Complete conversation\n",
      "\n## User\n\nfirst-visible\n",
    ];
    for (let index = 0; index < 60; index++) {
      const content = `part-${index}:${"界".repeat(20_000)}`;
      manager.appendMessage({ role: "user", content, timestamp: index + 3 });
      sections.push(`\n## User\n\n${content}\n`);
    }
    manager.appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private-reasoning" },
        {
          type: "toolCall",
          id: "private-call",
          name: "read",
          arguments: { path: "private-tool-arguments" },
        },
        { type: "text", text: "**last-visible-answer**" },
      ],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: 100,
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "private-call",
      toolName: "read",
      content: [{ type: "text", text: "private-tool-output" }],
      isError: false,
      timestamp: 101,
    });
    manager.appendCustomEntry("private-metadata", {
      secret: "private-custom-entry",
    });
    manager.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "image-caption" },
        { type: "image", data: "private-base64-bytes", mimeType: "image/png" },
      ],
      timestamp: 102,
    });
    sections.push(
      "\n## Assistant\n\n**last-visible-answer**\n",
      "\n## User\n\nimage-caption\n\n[Image]\n",
    );
    const adapter = new PiWebAdapter(
      runtimeFor(root, join(root, "sessions"), manager),
    );
    const nativeBefore = JSON.stringify(manager.getEntries());
    const snapshot = await adapter.getSnapshot();
    assert.equal(snapshot.selectedSession?.truncation.truncated, true);
    assert.ok(snapshot.selectedSession!.truncation.entriesOmitted > 0);
    const exported = await adapter.sessionMarkdown(
      `current:${manager.getSessionId()}`,
      manager.getSessionId(),
    );
    assert.equal(exported.markdown, sections.join(""));
    assert.doesNotMatch(exported.markdown, /abandoned-branch-secret|private-/u);
    assert.equal(JSON.stringify(manager.getEntries()), nativeBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conversation Markdown requires the exact native file even when another Session shares its id", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "openpi-conversation-markdown-identity-"),
  );
  try {
    const directory = join(root, "sessions");
    const current = SessionManager.create(root, directory);
    persistSession(current, "shared-history", 1);
    const path = current.getSessionFile()!;
    const copyPath = join(directory, "copy.jsonl");
    await writeFile(copyPath, await readFile(path));
    persistSession(current, "active-only-history", 2);
    const runtime = runtimeFor(root, directory, current);
    const reads: string[][] = [];
    runtime.getSessionManagerForRead = (id, requestedPath) => {
      reads.push([id, requestedPath]);
      return requestedPath === path ? current : undefined;
    };
    const adapter = new PiWebAdapter(runtime);
    assert.match(
      (await adapter.sessionMarkdown(path, current.getSessionId())).markdown,
      /active-only-history/u,
    );
    const copied = await adapter.sessionMarkdown(
      copyPath,
      current.getSessionId(),
    );
    assert.match(copied.markdown, /shared-history/u);
    assert.doesNotMatch(copied.markdown, /active-only-history/u);
    assert.deepEqual(
      new Set(reads.map((identity) => JSON.stringify(identity))),
      new Set(
        [
          [current.getSessionId(), path],
          [current.getSessionId(), copyPath],
        ].map((identity) => JSON.stringify(identity)),
      ),
    );
    await assert.rejects(adapter.sessionMarkdown(path, "different-id"), {
      code: "SESSION_CONFLICT",
      statusCode: 409,
    });
    runtime.getSessionManagerForRead = () => current;
    await assert.rejects(
      adapter.sessionMarkdown(copyPath, current.getSessionId()),
      { code: "SESSION_CONFLICT", statusCode: 409 },
    );
    await assert.rejects(
      adapter.sessionMarkdown(
        join(directory, "missing.jsonl"),
        current.getSessionId(),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conversation Markdown accepts its exact JSON byte limit and rejects oversized exports without truncation", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "openpi-conversation-markdown-limit-"),
  );
  try {
    const manager = SessionManager.inMemory(root);
    manager.appendSessionInfo("Byte boundary");
    const prefix = "# Byte boundary\n\n## User\n\n";
    const suffix = "\n";
    const overhead = Buffer.byteLength(
      JSON.stringify({ markdown: prefix + suffix }),
    );
    const content = "x".repeat(WEB_SESSION_MARKDOWN_MAX_BYTES - overhead);
    manager.appendMessage({ role: "user", content, timestamp: 1 });
    const adapter = new PiWebAdapter(
      runtimeFor(root, join(root, "sessions"), manager),
    );
    const path = `current:${manager.getSessionId()}`;
    const exported = await adapter.sessionMarkdown(
      path,
      manager.getSessionId(),
    );
    assert.equal(
      Buffer.byteLength(JSON.stringify(exported)),
      WEB_SESSION_MARKDOWN_MAX_BYTES,
    );
    assert.equal(exported.markdown, prefix + content + suffix);
    manager.appendMessage({ role: "user", content: "extra", timestamp: 2 });
    await assert.rejects(
      adapter.sessionMarkdown(path, manager.getSessionId()),
      { code: "SESSION_MARKDOWN_TOO_LARGE", statusCode: 413 },
    );

    const escaped = SessionManager.inMemory(root);
    escaped.appendSessionInfo("Escaped bytes");
    escaped.appendMessage({
      role: "user",
      content: "\\".repeat(Math.ceil(WEB_SESSION_MARKDOWN_MAX_BYTES / 2)),
      timestamp: 1,
    });
    const escapedAdapter = new PiWebAdapter(
      runtimeFor(root, join(root, "sessions"), escaped),
    );
    await assert.rejects(
      escapedAdapter.sessionMarkdown(
        `current:${escaped.getSessionId()}`,
        escaped.getSessionId(),
      ),
      { code: "SESSION_MARKDOWN_TOO_LARGE", statusCode: 413 },
    );
    assert.equal(
      escaped.getBranch().filter((entry) => entry.type === "message").length,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deleted Session metadata cleanup preserves copied identities and survives restart and retry", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "openpi-conversation-delete-metadata-"),
  );
  try {
    const directory = join(root, "sessions");
    const project = join(root, "removed-project");
    const current = SessionManager.create(root, directory);
    persistSession(current, "current", 1);
    const deleted = SessionManager.create(project, directory);
    persistSession(deleted, "deleted", 2);
    const identity = {
      path: deleted.getSessionFile()!,
      id: deleted.getSessionId(),
    };
    const copied = { path: join(directory, "copy.jsonl"), id: identity.id };
    await writeFile(copied.path, await readFile(identity.path));
    const runtime = runtimeFor(root, directory, current);
    let adapter = new PiWebAdapter(runtime);
    await adapter.setSidebarPin({ kind: "workspace", path: root }, true);
    for (const item of [identity, copied]) {
      await adapter.setSessionPin(item.path, item.id, true);
      await adapter.setSessionRead(
        item.path,
        item.id,
        false,
        (await adapter.requireSession(item.path)).readRevision!,
      );
      await adapter.archiveSession(item.path);
    }
    await adapter.setSessionOrder(identity.path, identity.id, copied);
    await adapter.removeWorkspace(project);
    const file = join(directory, "workspace-state.json");
    const before = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(
      before.ungroupedSessions.sort(),
      [identity.path, copied.path].sort(),
    );
    await rm(identity.path);
    await adapter.forgetDeletedSession(identity.path, identity.id);
    adapter = new PiWebAdapter(runtime);
    const remaining = await adapter.requireSession(copied.path);
    assert.equal(remaining.unread, true);
    assert.equal(remaining.archived, true);
    assert.equal(remaining.ungrouped, true);
    assert.notEqual(remaining.pinOrder, undefined);
    const after = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(
      after.sidebarPins,
      before.sidebarPins.filter(
        (pin: { path: string }) => pin.path !== identity.path,
      ),
    );
    assert.deepEqual(
      after.sessionOrder,
      before.sessionOrder.filter(
        (session: { path: string }) => session.path !== identity.path,
      ),
    );
    assert.deepEqual(
      after.sessionReadStates,
      before.sessionReadStates.filter(
        (session: { path: string }) => session.path !== identity.path,
      ),
    );
    assert.deepEqual(after.ungroupedSessions, [copied.path]);
    assert.deepEqual(
      JSON.parse(
        await readFile(join(directory, "archived-sessions.json"), "utf8"),
      ),
      [copied.path],
    );
    await adapter.forgetDeletedSession(identity.path, identity.id);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), after);
    assert.equal((await adapter.requireSession(copied.path)).unread, true);
    assert.equal(
      (await adapter.getSnapshot()).workspaces.find(
        (workspace) => workspace.path === root,
      )?.pinOrder,
      0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selecting a copied session calls the runtime despite a shared session ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-select-identity-"));
  const sessionDirectory = join(root, "sessions");
  const current = SessionManager.create(root, sessionDirectory);
  persistSession(current, "original conversation", 1);
  const currentPath = current.getSessionFile()!;
  const copyPath = join(sessionDirectory, "copied-session.jsonl");
  await writeFile(copyPath, await readFile(currentPath));
  const runtime = runtimeFor(root, sessionDirectory, current);
  const switched: string[] = [];
  runtime.switchSession = async (path) => {
    switched.push(path);
    return { cancelled: false };
  };
  const host = new WebHost({ runtime });
  try {
    await host.start();
    const url = new URL(host.url);
    const token = new URLSearchParams(url.hash.slice(1)).get("token");
    for (const path of [currentPath, copyPath]) {
      const response = await fetch(`${url.origin}/api/sessions/select`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path }),
      });
      assert.equal(response.status, 200);
      await response.json();
    }
    assert.deepEqual(switched, [copyPath]);
  } finally {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot pins current and selected sessions while bounding the projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-adapter-"));
  const sessionDirectory = join(root, "sessions");
  try {
    const current = SessionManager.inMemory(root);
    current.appendMessage({ role: "user", content: "current", timestamp: 1 });
    const selectedCwd = join(root, "selected-workspace");
    await mkdir(selectedCwd);
    const selected = SessionManager.create(selectedCwd, sessionDirectory);
    persistSession(selected, "selected", 2);
    const adapter = new PiWebAdapter(
      runtimeFor(root, sessionDirectory, current),
    );
    const pinnedSession = SessionManager.create(root, sessionDirectory);
    persistSession(pinnedSession, "pinned outside the recent window", 2);
    await adapter.setSessionPin(
      pinnedSession.getSessionFile()!,
      pinnedSession.getSessionId(),
      true,
    );
    for (let index = 0; index < WEB_MAX_SESSIONS + 3; index++) {
      const manager = SessionManager.create(root, sessionDirectory);
      persistSession(manager, `session-${index}`, index + 3);
    }

    const selectedPath = selected.getSessionFile();
    assert.ok(selectedPath);
    const snapshot = await adapter.getSnapshot(selectedPath);
    assert.equal(
      snapshot.sessions.find(
        (session) => session.path === pinnedSession.getSessionFile(),
      )?.pinOrder,
      0,
    );

    assert.equal(snapshot.sessions.length, WEB_MAX_SESSIONS);
    assert.ok(
      snapshot.sessions.some(
        (session) => session.id === current.getSessionId(),
      ),
    );
    const currentSummary = snapshot.sessions.find(
      (session) => session.id === current.getSessionId(),
    );
    assert.deepEqual(
      {
        source: currentSummary?.source,
        origin: currentSummary?.origin,
        controller: currentSummary?.controller,
        readOnly: currentSummary?.readOnly,
      },
      {
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
      },
    );
    assert.ok(
      snapshot.sessions.some((session) => session.path === selectedPath),
    );
    const selectedSummary = snapshot.sessions.find(
      (session) => session.path === selectedPath,
    );
    assert.equal(selectedSummary?.source, "web-session");
    assert.equal(selectedSummary?.origin, "web");
    assert.equal(selectedSummary?.controller, "none");
    assert.equal(selectedSummary?.readOnly, false);
    assert.equal(snapshot.selectedSession?.path, selectedPath);
    assert.equal(
      (
        await new PiWebAdapter(
          runtimeFor(root, sessionDirectory, current),
        ).requireSession(selectedPath)
      ).cwd,
      selectedCwd,
    );
    assert.equal(snapshot.truncation.sessionsOmitted, 6);
    assert.equal(snapshot.truncation.truncated, true);
    assert.ok(snapshot.truncation.bytes <= WEB_MAX_SNAPSHOT_BYTES);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manual sidebar order selects older files before the page bound while retaining current, selected and pinned Sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-sidebar-manual-page-"));
  const directory = join(root, "sessions");
  try {
    const otherProject = join(root, "other-project");
    await mkdir(otherProject);
    const current = SessionManager.inMemory(root);
    const moved = SessionManager.create(otherProject, directory);
    persistSession(moved, "older manually ordered conversation", 1);
    const movedPath = moved.getSessionFile()!;
    const selected = SessionManager.create(otherProject, directory);
    persistSession(selected, "older selected conversation", 2);
    const selectedPath = selected.getSessionFile()!;
    const pinned = SessionManager.create(root, directory);
    persistSession(pinned, "older pinned conversation", 3);
    const pinnedPath = pinned.getSessionFile()!;
    const runtime = runtimeFor(root, directory, current);
    const adapter = new PiWebAdapter(runtime);
    await adapter.setSessionPin(pinnedPath, pinned.getSessionId(), true);
    let newest = moved;
    for (let index = 0; index < WEB_MAX_SESSIONS + 2; index++) {
      newest = SessionManager.create(root, directory);
      persistSession(newest, `recent-${index}`, index + 100);
    }
    const newestPath = newest.getSessionFile()!;
    await adapter.setSessionOrder(movedPath, moved.getSessionId(), {
      path: newestPath,
      id: newest.getSessionId(),
    });

    // Project groups and Recents filter the same persisted global order.
    const manual = await new PiWebAdapter(runtime).getSnapshot(
      selectedPath,
      undefined,
      "manual",
    );
    const updated = await adapter.getSnapshot(
      selectedPath,
      undefined,
      "updated",
    );
    for (const page of [manual, updated]) {
      assert.equal(page.sessions.length, WEB_MAX_SESSIONS);
      assert.ok(
        page.sessions.some((session) => session.id === current.getSessionId()),
      );
      assert.ok(page.sessions.some((session) => session.path === selectedPath));
      assert.equal(
        page.sessions.find((session) => session.path === pinnedPath)?.pinOrder,
        0,
      );
      assert.equal(page.truncation.sessionsOmitted, 6);
    }
    const row = manual.sessions.find((session) => session.path === movedPath);
    assert.ok(row);
    assert.equal(row.cwd, otherProject);
    assert.equal(row.pinOrder, undefined);
    assert.ok(
      row.order! <
        manual.sessions.find((session) => session.path === newestPath)!.order!,
    );
    assert.ok(
      manual.sessions.indexOf(row) <
        manual.sessions.findIndex((session) => session.path === newestPath),
    );
    assert.equal(
      updated.sessions.some((session) => session.path === movedPath),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archived history does not consume the active page and keeps its project and independent cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-sidebar-archive-scope-"));
  const directory = join(root, "sessions");
  try {
    const archiveProject = join(root, "archived-project");
    await mkdir(archiveProject);
    const current = SessionManager.create(root, directory);
    persistSession(current, "current conversation", 1);
    const other = SessionManager.create(root, directory);
    persistSession(other, "older active conversation", 2);
    const otherPath = other.getSessionFile()!;
    const archivePaths = [];
    for (let index = 0; index < WEB_MAX_SESSIONS + 2; index++) {
      const manager = SessionManager.create(archiveProject, directory);
      persistSession(manager, `archive-${index}`, index + 100);
      archivePaths.push(manager.getSessionFile()!);
    }
    await writeFile(
      join(directory, "archived-sessions.json"),
      JSON.stringify(archivePaths),
    );
    const adapter = new PiWebAdapter(runtimeFor(root, directory, current));
    const active = await adapter.getSnapshot();
    assert.deepEqual(
      new Set(active.sessions.map((session) => session.path)),
      new Set([current.getSessionFile(), otherPath]),
    );
    assert.equal(active.truncation.sessionsOmitted, 0);
    assert.equal(active.truncation.truncated, false);
    assert.ok(
      active.workspaces.some((workspace) => workspace.path === archiveProject),
    );
    await adapter.renameWorkspace(archiveProject, "Archived project");

    const first = await adapter.listArchivedSessions({ limit: 25 });
    assert.equal(first.status, "ok");
    if (first.status !== "ok") return;
    assert.equal(first.sessions.length, 25);
    assert.equal(first.truncation.matchesOmitted, WEB_MAX_SESSIONS + 2 - 25);
    const second = await adapter.listArchivedSessions({
      limit: 25,
      cursor: first.nextCursor,
    });
    assert.equal(second.status, "ok");
    if (second.status !== "ok") return;
    assert.equal(
      new Set(
        [...first.sessions, ...second.sessions].map((session) => session.path),
      ).size,
      50,
    );

    const selectedPath = archivePaths[0]!;
    const selected = await adapter.getSnapshot(selectedPath);
    assert.equal(selected.selectedSession?.path, selectedPath);
    assert.equal(
      selected.sessions.find((session) => session.path === selectedPath)
        ?.archived,
      true,
    );
    assert.equal(selected.sessions.length, 3);
    assert.equal(selected.truncation.sessionsOmitted, 0);
    assert.equal((await adapter.requireSession(selectedPath)).archived, true);
    await adapter.unarchiveSession(selectedPath);
    assert.equal((await adapter.getSnapshot()).sessions.length, 3);
    // Removing another archive does not invalidate an unchanged cursor anchor.
    const replay = await adapter.listArchivedSessions({
      limit: 25,
      cursor: first.nextCursor,
    });
    assert.equal(replay.status, "ok");
    if (replay.status === "ok")
      assert.deepEqual(replay.sessions, second.sessions);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovers default Pi sessions as bounded read-only projections", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-terminal-history-"));
  const sessionDirectory = join(root, "web-sessions");
  const agentDirectory = join(root, "pi-agent");
  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  try {
    await mkdir(sessionDirectory, { recursive: true });
    const current = SessionManager.inMemory(root);
    const terminal = SessionManager.create(root);
    persistSession(terminal, "terminal history", 2);
    const terminalPath = terminal.getSessionFile();
    assert.ok(terminalPath);
    const unrelatedWorkspace = join(root, "unrelated-workspace");
    await mkdir(unrelatedWorkspace);
    const unrelated = SessionManager.create(unrelatedWorkspace);
    persistSession(unrelated, "unrelated first message", 3);
    unrelated.appendMessage({
      role: "user",
      content: "unrelated-only-token",
      timestamp: 4,
    });
    const unrelatedPath = unrelated.getSessionFile();
    assert.ok(unrelatedPath);
    const fileBefore = await readFile(terminalPath);
    const originalOpen = fsPromises.open;
    const openedPaths: string[] = [];
    t.mock.method(
      fsPromises,
      "open",
      (...args: Parameters<typeof originalOpen>) => {
        openedPaths.push(String(args[0]));
        assert.notEqual(String(args[0]), unrelatedPath);
        return originalOpen(...args);
      },
    );
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const adapter = new PiWebAdapter(
      runtimeFor(root, sessionDirectory, current),
    );
    const listAll = SessionManager.listAll;
    SessionManager.listAll = async () => {
      throw new Error("unrelated Session discovery must not be used");
    };
    try {
      const listed = await adapter.listReadOnlyTerminalSessions({ limit: 1 });
      assert.equal(listed.total, 1);
      assert.equal("allMessagesText" in listed.sessions[0]!, false);
      assert.deepEqual(listed.sessions[0], {
        id: terminal.getSessionId(),
        path: terminalPath,
        cwd: root,
        modified: listed.sessions[0]?.modified,
        created: listed.sessions[0]?.created,
        messageCount: 2,
        metadataPartial: false,
        firstMessage: "terminal history",
        source: "pi-default",
        origin: "terminal",
        readOnly: true,
      });
      const inspected = await adapter.getReadOnlyTerminalSession(terminalPath);
      assert.equal(inspected.readOnly, true);
      assert.equal(inspected.source, "pi-default");
      assert.equal(inspected.preview.messages.length, 2);
      assert.equal("allMessagesText" in inspected, false);
      assert.ok(openedPaths.includes(terminalPath));
      assert.equal(
        (
          await adapter.listReadOnlyTerminalSessions({
            query: "unrelated-only-token",
          })
        ).total,
        0,
      );
      await assert.rejects(
        adapter.getReadOnlyTerminalSession(unrelatedPath),
        (error: unknown) =>
          error instanceof Error &&
          (error as { code?: string }).code === "SESSION_NOT_FOUND",
      );
      const cancelled = AbortSignal.abort();
      const opensBefore = openedPaths.length;
      await assert.rejects(
        adapter.getReadOnlyTerminalSession(terminalPath, { signal: cancelled }),
        { name: "AbortError" },
      );
      await assert.rejects(
        adapter.listReadOnlyTerminalSessions({ signal: cancelled }),
        { name: "AbortError" },
      );
      assert.equal(openedPaths.length, opensBefore);

      const controller = new AbortController();
      let targetOpens = 0;
      t.mock.method(
        fsPromises,
        "open",
        async (...args: Parameters<typeof originalOpen>) => {
          const handle = await originalOpen(...args);
          if (String(args[0]) === terminalPath && ++targetOpens === 2) {
            const read = handle.read.bind(handle);
            t.mock.method(
              handle,
              "read",
              async (...readArgs: Parameters<typeof read>) => {
                const result = await read(...readArgs);
                controller.abort();
                return result;
              },
            );
          }
          return handle;
        },
      );
      syncBuiltinESMExports();
      await assert.rejects(
        adapter.getReadOnlyTerminalSession(terminalPath, {
          signal: controller.signal,
        }),
        { name: "AbortError" },
      );
      assert.equal(
        targetOpens,
        2,
        "cancellation occurs during the preview, after metadata admission",
      );
    } finally {
      SessionManager.listAll = listAll;
    }
    assert.equal((await SessionManager.listAll(sessionDirectory)).length, 0);
    assert.deepEqual(await readFile(terminalPath), fileBefore);
    assert.equal(
      (await adapter.listSessions()).some(
        (session) => session.path === terminalPath,
      ),
      false,
    );
    assert.equal(
      (await adapter.getSnapshot()).currentSessionId,
      current.getSessionId(),
    );
    const hidden = new PiWebAdapter(
      runtimeFor(root, sessionDirectory, current),
    );
    await hidden.removeWorkspace(root);
    const unboundRuntime = {
      ...runtimeFor(root, sessionDirectory, current),
      workspaceSelected: false,
    };
    const unbound = new PiWebAdapter(unboundRuntime);
    const originalReaddir = fsPromises.readdir;
    t.mock.method(
      fsPromises,
      "readdir",
      (...args: Parameters<typeof originalReaddir>) => {
        assert.ok(
          !String(args[0]).startsWith(agentDirectory),
          "unavailable workspace must not walk the default store",
        );
        return originalReaddir(...args);
      },
    );
    syncBuiltinESMExports();
    await assert.rejects(hidden.listReadOnlyTerminalSessions());
    await assert.rejects(unbound.listReadOnlyTerminalSessions());

    const firstKept = terminal.appendMessage({
      role: "user",
      content: "kept after compaction",
      timestamp: 5,
    });
    terminal.appendCompaction("summary before kept window", firstKept, 100);
    const compacted = await adapter.getReadOnlyTerminalSession(terminalPath);
    assert.ok(
      JSON.stringify(compacted.preview.messages).includes(
        "kept after compaction",
      ),
    );
    assert.ok(
      !JSON.stringify(compacted.preview.messages).includes("terminal history"),
    );
    assert.ok(compacted.preview.messages.length <= 80);
    assert.ok(compacted.preview.retainedBytes <= 1024 * 1024);
    await assert.rejects(
      readFile(join(sessionDirectory, "archived-sessions.json")),
      { code: "ENOENT" },
    );
    terminal.appendMessage({
      role: "user",
      content: "x".repeat(300 * 1024),
      timestamp: 8,
    });
    terminal.appendSessionInfo("late metadata name");
    const partial = await adapter.listReadOnlyTerminalSessions();
    assert.equal(partial.partial, true);
    assert.equal(partial.sessions[0]?.metadataPartial, true);
    assert.equal(
      (await adapter.getReadOnlyTerminalSession(terminalPath)).metadataPartial,
      true,
    );
    const unmatched = await adapter.listReadOnlyTerminalSessions({
      query: "late metadata name",
    });
    assert.equal(unmatched.sessions.length, 0);
    assert.equal(
      unmatched.partial,
      true,
      "an absent match in a prefix is not a complete search",
    );
    const directory = terminalPath.slice(
      0,
      Math.max(terminalPath.lastIndexOf("/"), terminalPath.lastIndexOf("\\")),
    );
    for (let i = 0; i <= WEB_MAX_SESSIONS; i++)
      await writeFile(join(directory, `unrelated-${i}.txt`), "");
    const capped = await adapter.listReadOnlyTerminalSessions();
    assert.equal(
      capped.partial,
      true,
      "directory traversal stops at the discovery bound",
    );
  } finally {
    if (previousAgentDirectory === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("project order stays stable across manual moves, Session selection, rename and restart, including same-name projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-project-order-"));
  const sessionDirectory = join(root, "sessions");
  try {
    const projects = ["alpha", "one/shared", "two/shared", "zeta"].map((path) =>
      join(root, path),
    );
    const sessions = projects.map((cwd, index) => {
      const session = SessionManager.create(cwd, sessionDirectory);
      persistSession(session, `Project conversation ${index}`, index);
      return session;
    });
    let manager = sessions[0]!;
    const runtime: WebRuntimeController = {
      ...runtimeFor(projects[0]!, sessionDirectory, manager),
      get cwd() {
        return manager.getCwd();
      },
      get sessionManager() {
        return manager;
      },
      switchSession: async (path) => {
        manager = SessionManager.open(path, sessionDirectory);
        return { cancelled: false };
      },
    };
    const adapter = new PiWebAdapter(runtime);
    const initialOrder = (await adapter.getSnapshot()).workspaces.map(
      (workspace) => workspace.path,
    );
    assert.deepEqual([...initialOrder].sort(), [...projects].sort());
    for (const session of [sessions[0]!, ...[...sessions].reverse()]) {
      await runtime.switchSession(session.getSessionFile()!);
      for (const source of [adapter, new PiWebAdapter(runtime)]) {
        const snapshot = await source.getSnapshot(session.getSessionFile()!);
        assert.deepEqual(
          snapshot.workspaces.map((workspace) => workspace.path),
          initialOrder,
          "selection must not promote the current project or reorder equal names",
        );
        assert.equal(snapshot.selectedSession?.path, session.getSessionFile());
        assert.deepEqual(
          snapshot.workspaces
            .filter((workspace) => workspace.current)
            .map((workspace) => workspace.path),
          [session.getCwd()],
          "current-project metadata still follows runtime selection",
        );
      }
    }
    await adapter.setWorkspaceOrder(projects[2]!, projects[0]!);
    await adapter.setWorkspaceOrder(projects[0]!, null);
    const movedOrder = [projects[2]!, projects[1]!, projects[3]!, projects[0]!];
    const metadata = join(sessionDirectory, "workspace-state.json");
    assert.deepEqual(
      JSON.parse(await readFile(metadata, "utf8")).workspaceOrder,
      movedOrder,
    );
    await adapter.renameWorkspace(projects[2]!, "ZZZ renamed project");
    for (const session of sessions) {
      await runtime.switchSession(session.getSessionFile()!);
      for (const source of [adapter, new PiWebAdapter(runtime)]) {
        const snapshot = await source.getSnapshot(session.getSessionFile()!);
        assert.deepEqual(
          snapshot.workspaces.map((workspace) => workspace.path),
          movedOrder,
          "the user's manual project order survives selection and renaming",
        );
        assert.equal(snapshot.selectedSession?.path, session.getSessionFile());
      }
    }
    const discoveredPath = join(root, "000-new-project");
    const discovered = SessionManager.create(discoveredPath, sessionDirectory);
    persistSession(discovered, "A newly discovered project", 10);
    for (const source of [adapter, new PiWebAdapter(runtime)]) {
      assert.deepEqual(
        (await source.getSnapshot()).workspaces.map(
          (workspace) => workspace.path,
        ),
        [...movedOrder, discoveredPath],
        "a newly discovered project follows saved positions even if its name sorts first",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project order preserves hidden and unprojected positions and rejects stale anchors", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-project-order-bounds-"));
  const directory = join(root, "sessions");
  try {
    await mkdir(directory);
    const projects = Array.from(
      { length: WEB_MAX_WORKSPACES + 10 },
      (_, index) => join(root, `project-${String(index).padStart(3, "0")}`),
    );
    const hidden = projects[5]!;
    const unloaded = join(root, "temporarily-unloaded-project");
    const originalOrder = [...projects, unloaded, root];
    const metadata = join(directory, "workspace-state.json");
    await writeFile(
      metadata,
      JSON.stringify({
        version: 1,
        hiddenWorkspaces: [hidden],
        ungroupedSessions: [],
        workspaceNames: {},
        importedWorkspaces: projects,
        workspaceOrder: originalOrder,
      }),
    );
    const runtime = runtimeFor(root, directory, SessionManager.inMemory(root));
    const adapter = new PiWebAdapter(runtime);
    const before = await adapter.getSnapshot();
    assert.equal(before.workspaces.length, WEB_MAX_WORKSPACES);
    assert.ok(
      !before.workspaces.some(
        (workspace) => workspace.path === projects.at(-1),
      ),
    );
    await adapter.setWorkspaceOrder(projects.at(-1)!, projects[0]!);
    const expected = [
      projects.at(-1)!,
      ...originalOrder.filter((path) => path !== projects.at(-1)),
    ];
    assert.deepEqual(
      JSON.parse(await readFile(metadata, "utf8")).workspaceOrder,
      expected,
    );
    const moved = await new PiWebAdapter(runtime).getSnapshot();
    assert.deepEqual(
      moved.workspaces.map((workspace) => workspace.path),
      expected
        .filter((path) => path !== hidden && path !== unloaded)
        .slice(0, WEB_MAX_WORKSPACES),
    );
    assert.ok(moved.truncation.workspacesOmitted > 0);

    await adapter.setSidebarPin(
      { kind: "workspace", path: projects[1]! },
      true,
    );
    const saved = await readFile(metadata, "utf8");
    for (const anchor of [
      hidden,
      unloaded,
      projects[1]!,
      join(root, "missing"),
    ]) {
      await assert.rejects(adapter.setWorkspaceOrder(projects[0]!, anchor), {
        code: "WORKSPACE_ORDER_CHANGED",
        statusCode: 409,
      });
    }
    await assert.rejects(adapter.setWorkspaceOrder(hidden, projects[0]!), {
      code: "WORKSPACE_ORDER_CHANGED",
      statusCode: 409,
    });
    assert.equal(await readFile(metadata, "utf8"), saved);
    const removedAnchor = projects[2]!;
    const remove = adapter.removeWorkspace(removedAnchor);
    const staleDrop = adapter.setWorkspaceOrder(projects[0]!, removedAnchor);
    const result = await Promise.allSettled([remove, staleDrop]);
    assert.equal(result[0]!.status, "fulfilled");
    assert.equal(result[1]!.status, "rejected");
    if (result[1]!.status === "rejected") {
      assert.equal(result[1]!.reason.code, "WORKSPACE_ORDER_CHANGED");
    }
    assert.deepEqual(
      JSON.parse(await readFile(metadata, "utf8")).workspaceOrder,
      expected.filter((path) => path !== removedAnchor),
      "a queued drop revalidates its anchor after an earlier removal commits",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project order and unpin commit together, remain invisible while pending, and recover from a failed save", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-project-order-atomic-"));
  const directory = join(root, "sessions");
  let releaseWrite = () => {};
  try {
    const projects = ["alpha", "beta", "gamma"].map((name) => join(root, name));
    const managers = projects.map((cwd, index) => {
      const manager = SessionManager.create(cwd, directory);
      persistSession(manager, `Project ${index}`, index);
      return manager;
    });
    const manager = managers[0]!;
    const runtime = runtimeFor(projects[0]!, directory, manager);
    const adapter = new PiWebAdapter(runtime);
    await adapter.setWorkspaceOrder(projects[0]!, projects[1]!);
    await adapter.setSessionPin(
      manager.getSessionFile()!,
      manager.getSessionId(),
      true,
    );
    await adapter.setSidebarPin(
      { kind: "workspace", path: projects[2]! },
      true,
    );
    const metadata = join(directory, "workspace-state.json");
    const before = await readFile(metadata, "utf8");
    const beforeRows = (await adapter.getSnapshot()).workspaces;
    const internal = adapter as unknown as {
      writeAtomically: (filePath: string, content: string) => Promise<void>;
    };
    const writeAtomically = internal.writeAtomically.bind(adapter);
    let markStarted = () => {};
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    const released = new Promise<void>((resolveReleased) => {
      releaseWrite = resolveReleased;
    });
    internal.writeAtomically = async () => {
      markStarted();
      await released;
      throw new Error("disk full");
    };
    const failed = assert.rejects(
      adapter.setWorkspaceOrder(projects[2]!, projects[0]!),
      /disk full/u,
    );
    await started;
    assert.deepEqual((await adapter.getSnapshot()).workspaces, beforeRows);
    assert.equal(await readFile(metadata, "utf8"), before);
    releaseWrite();
    await failed;
    assert.deepEqual((await adapter.getSnapshot()).workspaces, beforeRows);
    assert.equal(await readFile(metadata, "utf8"), before);

    internal.writeAtomically = writeAtomically;
    await adapter.setWorkspaceOrder(projects[2]!, projects[0]!);
    const snapshot = await new PiWebAdapter(runtime).getSnapshot();
    assert.deepEqual(
      snapshot.workspaces.map((workspace) => workspace.path),
      [projects[2], projects[0], projects[1]],
    );
    assert.ok(
      snapshot.workspaces.every(
        (workspace) => workspace.pinOrder === undefined,
      ),
    );
    assert.equal(
      snapshot.sessions.find(
        (session) => session.path === manager.getSessionFile(),
      )?.pinOrder,
      0,
    );
    const saved = JSON.parse(await readFile(metadata, "utf8"));
    assert.deepEqual(saved.workspaceOrder, [
      projects[2],
      projects[0],
      projects[1],
    ]);
    assert.deepEqual(saved.sidebarPins, [
      {
        kind: "session",
        path: manager.getSessionFile(),
        id: manager.getSessionId(),
      },
    ]);
  } finally {
    releaseWrite();
    await rm(root, { recursive: true, force: true });
  }
});

test("project order metadata limits fail without truncating previously saved positions", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-project-order-limit-"));
  const directory = join(root, "sessions");
  try {
    await mkdir(directory);
    const metadata = join(directory, "workspace-state.json");
    const original = JSON.stringify({
      version: 1,
      hiddenWorkspaces: [],
      ungroupedSessions: [],
      workspaceNames: {},
      workspaceOrder: Array.from({ length: 5_000 }, (_, index) =>
        join(root, `unloaded-${index}`),
      ),
    });
    await writeFile(metadata, original);
    const adapter = new PiWebAdapter(
      runtimeFor(root, directory, SessionManager.inMemory(root)),
    );
    await assert.rejects(
      adapter.setWorkspaceOrder(root, null),
      /metadata limit/u,
    );
    assert.equal(await readFile(metadata, "utf8"), original);
    assert.deepEqual(
      (await adapter.getSnapshot()).workspaces.map(
        (workspace) => workspace.path,
      ),
      [root],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unbound Web runtime never projects its bootstrap cwd as a workspace or Session", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-unbound-"));
  const bootstrap = join(root, ".bootstrap-workspace");
  const imported = join(root, "chosen-workspace");
  const sessionDirectory = join(root, "sessions");
  try {
    await Promise.all([
      mkdir(bootstrap, { recursive: true }),
      mkdir(imported, { recursive: true }),
      mkdir(sessionDirectory, { recursive: true }),
    ]);
    const current = SessionManager.inMemory(bootstrap);
    const runtime = Object.assign(
      runtimeFor(bootstrap, sessionDirectory, current),
      { workspaceSelected: false as const },
    );
    const adapter = new PiWebAdapter(runtime);

    const initial = await adapter.getSnapshot();
    assert.deepEqual(initial.workspaces, []);
    assert.deepEqual(initial.sessions, []);
    assert.equal(initial.currentSessionId, undefined);
    assert.equal(initial.selectedSession, undefined);

    await adapter.importWorkspace(imported);
    const afterImport = await adapter.getSnapshot();
    const canonicalImported = await realpath(imported);
    const canonicalBootstrap = await realpath(bootstrap);
    assert.deepEqual(
      afterImport.workspaces.map((workspace) => workspace.path),
      [canonicalImported],
    );
    assert.equal(
      afterImport.workspaces.some(
        (workspace) => workspace.path === canonicalBootstrap,
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selected transcript is byte bounded with explicit omission evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-transcript-"));
  const sessionDirectory = join(root, "sessions");
  try {
    const current = SessionManager.inMemory(root);
    for (let index = 0; index < 300; index++) {
      current.appendMessage({
        role: "user",
        content: `${index}:${"x".repeat(20_000)}`,
        timestamp: index,
      });
    }
    const runtime: WebRuntimeController = {
      ...runtimeFor(root, sessionDirectory, current),
      listModels: () =>
        Array.from({ length: 1_000 }, (_, index) => ({
          provider: "p".repeat(1_000),
          id: `model-${index}`,
          name: "n".repeat(1_000),
          label: "l".repeat(1_000),
          current: index === 999,
        })),
    };
    const adapter = new PiWebAdapter(runtime);
    const snapshot = await adapter.getSnapshot();

    assert.ok(snapshot.selectedSession);
    assert.ok(snapshot.selectedSession.bytes <= 2 * 1024 * 1024);
    assert.ok(snapshot.selectedSession.truncation.entriesOmitted > 0);
    assert.equal(snapshot.selectedSession.truncation.truncated, true);
    assert.equal(snapshot.models.length, 250);
    assert.ok(snapshot.models.some((model) => model.current));
    assert.equal(snapshot.truncation.modelsOmitted, 750);
    assert.ok(snapshot.truncation.bytes <= WEB_MAX_SNAPSHOT_BYTES);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("first archive mutation preserves previously persisted archive metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-archive-"));
  const sessionDirectory = join(root, "sessions");
  try {
    await mkdir(sessionDirectory, { recursive: true });
    const existing = join(sessionDirectory, "existing.jsonl");
    await writeFile(
      join(sessionDirectory, "archived-sessions.json"),
      `${JSON.stringify([existing])}\n`,
    );
    const current = SessionManager.inMemory(root);
    const adapter = new PiWebAdapter(
      runtimeFor(root, sessionDirectory, current),
    );
    const currentPath = `current:${current.getSessionId()}`;

    await adapter.archiveSession(currentPath);

    const persisted = JSON.parse(
      await readFile(join(sessionDirectory, "archived-sessions.json"), "utf8"),
    ) as string[];
    assert.deepEqual(
      new Set(persisted),
      new Set([existing, resolve(currentPath)]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive ordering and exact project filtering precede pagination and bind cursor scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-archive-scope-"));
  const directory = join(root, "sessions");
  const alpha = join(root, "alpha");
  const beta = join(root, "alpha-other");
  try {
    const paths: string[] = [];
    for (const [index, cwd, created, modified] of [
      [0, alpha, "2020-01-01", "2024-01-03"],
      [1, beta, "2020-01-04", "2024-01-04"],
      [2, alpha, "2020-01-03", "2024-01-01"],
      [3, alpha, "2020-01-02", "2024-01-02"],
    ] as const) {
      const manager = SessionManager.create(cwd, directory);
      persistSession(manager, `retained ${index}`, index + 1);
      const path = manager.getSessionFile()!;
      const entries = (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      for (const entry of entries) {
        entry.timestamp = `${entry.type === "session" ? created : modified}T00:00:00.000Z`;
        if (entry.type === "message")
          entry.message.timestamp = Date.parse(entry.timestamp);
      }
      await writeFile(
        path,
        `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      );
      paths.push(path);
    }
    const adapter = new PiWebAdapter(
      runtimeFor(root, directory, SessionManager.inMemory(root)),
    );
    for (const path of paths) await adapter.archiveSession(path);
    const updated = await adapter.listArchivedSessions({
      cwd: alpha,
      limit: 1,
    });
    assert.equal(updated.status, "ok");
    if (updated.status !== "ok") return;
    assert.deepEqual(
      updated.sessions.map((session) => session.path),
      [paths[0]],
    );
    assert.ok(updated.nextCursor);
    const updatedNext = await adapter.listArchivedSessions({
      cwd: alpha,
      sort: "updated",
      cursor: updated.nextCursor,
      limit: 1,
    });
    assert.equal(updatedNext.status, "ok");
    if (updatedNext.status !== "ok") return;
    assert.deepEqual(
      updatedNext.sessions.map((session) => session.path),
      [paths[3]],
    );
    const created = await adapter.listArchivedSessions({
      cwd: alpha,
      sort: "created",
      limit: 1,
    });
    assert.equal(created.status, "ok");
    if (created.status !== "ok") return;
    assert.deepEqual(
      created.sessions.map((session) => session.path),
      [paths[2]],
    );
    assert.equal(created.truncation.matchesOmitted, 2);
    assert.ok(created.nextCursor);
    const createdNext = await adapter.listArchivedSessions({
      cwd: alpha,
      sort: "created",
      cursor: created.nextCursor,
      limit: 1,
    });
    assert.equal(createdNext.status, "ok");
    if (createdNext.status !== "ok") return;
    assert.deepEqual(
      createdNext.sessions.map((session) => session.path),
      [paths[3]],
    );
    for (const options of [
      { cwd: alpha, sort: "updated" as const },
      { cwd: beta, sort: "created" as const },
      { query: "changed", cwd: alpha, sort: "created" as const },
    ])
      assert.deepEqual(
        await adapter.listArchivedSessions({
          ...options,
          cursor: created.nextCursor,
        }),
        { status: "stale_cursor" },
      );

    const legacyCursor = Buffer.from(
      JSON.stringify({
        version: 1,
        sessionPath: paths[1],
        queryHash: createHash("sha256").update("").digest("hex"),
      }),
    ).toString("base64url");
    const legacy = await adapter.listArchivedSessions({
      cursor: legacyCursor,
      limit: 1,
    });
    assert.equal(legacy.status, "ok");
    if (legacy.status !== "ok") return;
    assert.deepEqual(
      legacy.sessions.map((session) => session.path),
      [paths[0]],
    );
    assert.deepEqual(
      await adapter.listArchivedSessions({ cursor: legacyCursor, cwd: alpha }),
      { status: "stale_cursor" },
    );
    assert.deepEqual(
      await adapter.listArchivedSessions({
        cursor: legacyCursor,
        sort: "created",
      }),
      { status: "stale_cursor" },
    );
    for (const cwd of [
      "",
      "relative",
      `${root}/\ninvalid`,
      `/${"x".repeat(4096)}`,
    ]) {
      assert.deepEqual(await adapter.listArchivedSessions({ cwd }), {
        status: "invalid",
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace projection retains an archive-only project beyond the bounded Session rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-archive-project-"));
  const directory = join(root, "sessions");
  const archivedProject = join(root, "archive-only");
  try {
    const manager = SessionManager.create(archivedProject, directory);
    persistSession(manager, "old archive", 1);
    const path = manager.getSessionFile()!;
    const current = SessionManager.inMemory(root);
    const adapter = new PiWebAdapter(runtimeFor(root, directory, current));
    await adapter.archiveSession(path);
    for (let index = 0; index < WEB_MAX_SESSIONS; index++) {
      const recent = SessionManager.create(root, directory);
      persistSession(recent, `recent ${index}`, index + 2);
    }
    const snapshot = await adapter.getSnapshot();
    assert.equal(
      snapshot.sessions.some((session) => session.path === path),
      false,
    );
    assert.ok(
      snapshot.workspaces.some(
        (workspace) => workspace.path === archivedProject,
      ),
    );
    assert.equal(
      await adapter.requireWorkspace(archivedProject),
      archivedProject,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archived Session listing is queryable, cursor-bounded, and stale-safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-archived-list-"));
  const sessionDirectory = join(root, "sessions");
  try {
    const current = SessionManager.inMemory(root);
    const alphaOne = SessionManager.create(root, sessionDirectory);
    persistSession(alphaOne, "alpha first", 1);
    alphaOne.appendSessionInfo("Alpha One");
    const alphaTwo = SessionManager.create(root, sessionDirectory);
    persistSession(alphaTwo, "alpha second", 2);
    alphaTwo.appendSessionInfo("Alpha Two");
    const beta = SessionManager.create(root, sessionDirectory);
    persistSession(beta, "beta only", 3);
    beta.appendSessionInfo("Beta");
    const paths = [
      alphaOne.getSessionFile(),
      alphaTwo.getSessionFile(),
      beta.getSessionFile(),
    ];
    assert.ok(paths.every((path) => path !== undefined));

    const adapter = new PiWebAdapter(
      runtimeFor(root, sessionDirectory, current),
    );
    for (const path of paths) await adapter.archiveSession(path!);

    const first = await adapter.listArchivedSessions({
      query: "ALPHA",
      limit: 1,
    });
    assert.equal(first.status, "ok");
    if (first.status !== "ok") return;
    assert.equal(first.sessions.length, 1);
    assert.equal(first.sessions[0]?.archived, true);
    assert.ok(first.nextCursor);
    assert.equal(first.truncation.matchesOmitted, 1);

    const second = await adapter.listArchivedSessions({
      query: "alpha",
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.equal(second.status, "ok");
    if (second.status !== "ok") return;
    assert.equal(second.sessions.length, 1);
    assert.equal(second.nextCursor, undefined);
    assert.deepEqual(
      new Set([...first.sessions, ...second.sessions].map((item) => item.id)),
      new Set([alphaOne.getSessionId(), alphaTwo.getSessionId()]),
    );

    assert.deepEqual(
      await adapter.listArchivedSessions({
        cursor: first.nextCursor,
        query: "different-query",
      }),
      { status: "stale_cursor" },
    );
    assert.deepEqual(
      await adapter.listArchivedSessions({ cursor: "not-a-valid-cursor" }),
      { status: "invalid" },
    );
    assert.deepEqual(await adapter.listArchivedSessions({ limit: 51 }), {
      status: "invalid",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive scan continuations reach old matches after an empty bounded window in global sort order", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-archive-scan-next-"));
  const project = join(root, "old-project");
  try {
    const active = Array.from({ length: 5_000 }, (_, index) => ({
      id: `active-${index}`,
      path: join(root, `active-${index}.jsonl`),
      cwd: root,
      created: new Date(100_000 - index),
      modified: new Date(100_000 - index),
      messageCount: 1,
      firstMessage: "active fixture",
      allMessagesText: "active fixture",
    }));
    const older = [
      {
        ...active[0]!,
        id: "older-a",
        path: join(root, "older-a.jsonl"),
        cwd: project,
        created: new Date(200),
        modified: new Date(300),
        firstMessage: "old needle A",
      },
      {
        ...active[0]!,
        id: "older-b",
        path: join(root, "older-b.jsonl"),
        cwd: project,
        created: new Date(300),
        modified: new Date(200),
        firstMessage: "old needle B",
      },
    ];
    const listing = t.mock.method(SessionManager, "listAll", async () => [
      ...active,
      ...older,
    ]);
    await writeFile(
      join(root, "archived-sessions.json"),
      JSON.stringify(older.map((session) => session.path)),
    );
    const adapter = new PiWebAdapter(
      runtimeFor(root, root, SessionManager.inMemory(root)),
    );
    for (const options of [
      { sort: "updated" as const },
      { sort: "created" as const },
      { query: "old needle", sort: "updated" as const },
      { cwd: project, sort: "created" as const },
    ]) {
      const first = await adapter.listArchivedSessions({
        ...options,
        limit: 1,
      });
      assert.equal(first.status, "ok");
      if (first.status !== "ok") return;
      assert.deepEqual(first.sessions, []);
      assert.equal(first.truncation.recordsUnscanned, 2);
      assert.ok(
        first.nextCursor,
        "an empty scan window must still expose continuation",
      );
      const next = await adapter.listArchivedSessions({
        ...options,
        limit: 1,
        cursor: first.nextCursor,
      });
      assert.equal(next.status, "ok");
      if (next.status !== "ok") return;
      assert.ok(next.nextCursor);
      const last = await adapter.listArchivedSessions({
        ...options,
        limit: 1,
        cursor: next.nextCursor,
      });
      assert.equal(last.status, "ok");
      if (last.status !== "ok") return;
      assert.deepEqual(
        [...next.sessions, ...last.sessions].map((session) => session.id),
        options.sort === "created"
          ? ["older-b", "older-a"]
          : ["older-a", "older-b"],
      );
      assert.equal(last.nextCursor, undefined);
      assert.equal(last.truncation.recordsUnscanned, 0);
    }
    listing.mock.mockImplementation(async () => [
      ...active,
      { ...older[0]!, created: new Date(200_000) },
      older[1]!,
    ]);
    const globallyNewest = await adapter.listArchivedSessions({
      sort: "created",
      limit: 1,
    });
    assert.equal(globallyNewest.status, "ok");
    if (globallyNewest.status !== "ok") return;
    assert.deepEqual(
      globallyNewest.sessions.map((session) => session.id),
      ["older-a"],
      "created ordering must happen before the bounded scan window",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive cursors produced for long valid Session paths remain bounded and replayable", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-archive-long-path-"));
  const directory = join(root, "a".repeat(140), "b".repeat(140));
  try {
    const paths: string[] = [];
    for (let index = 0; index < 2; index++) {
      const manager = SessionManager.create(root, directory);
      persistSession(manager, `long path archive ${index}`, index + 1);
      paths.push(manager.getSessionFile()!);
    }
    await writeFile(
      join(directory, "archived-sessions.json"),
      JSON.stringify(paths),
    );
    const adapter = new PiWebAdapter(
      runtimeFor(root, directory, SessionManager.inMemory(root)),
    );
    const first = await adapter.listArchivedSessions({ limit: 1 });
    assert.equal(first.status, "ok");
    if (first.status !== "ok") return;
    assert.ok(first.sessions[0]!.path.length > 320);
    assert.ok(first.nextCursor);
    assert.ok(
      first.nextCursor.length <= 512,
      "an emitted cursor must fit its input bound",
    );
    const second = await adapter.listArchivedSessions({
      limit: 1,
      cursor: first.nextCursor,
    });
    assert.equal(second.status, "ok");
    if (second.status !== "ok") return;
    assert.deepEqual(
      new Set(
        [...first.sessions, ...second.sessions].map((session) => session.path),
      ),
      new Set(paths),
    );
    assert.equal(second.nextCursor, undefined);
    assert.deepEqual(
      await adapter.listArchivedSessions({
        cursor: `${first.nextCursor}${"x".repeat(513)}`,
      }),
      { status: "invalid" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archived listing rejects pre-cancelled admission and forwards in-progress cancellation to Pi", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-archive-cancel-"));
  const controller = new AbortController();
  const reason = new Error("archive query cancelled");
  let admit: () => void = () => {};
  const admitted = new Promise<void>((resolve) => {
    admit = resolve;
  });
  let receivedSignal: AbortSignal | undefined;
  const listing = t.mock.method(
    SessionManager,
    "listAll",
    async (
      ...[_directory, _progress, signal]: Parameters<
        typeof SessionManager.listAll
      >
    ) => {
      receivedSignal = signal;
      admit();
      signal?.throwIfAborted();
      if (!signal) throw new Error("Pi catalog requires the query signal");
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  );
  try {
    const adapter = new PiWebAdapter(
      runtimeFor(root, root, SessionManager.inMemory(root)),
    );
    const preCancelled = AbortSignal.abort(reason);
    await assert.rejects(
      adapter.listArchivedSessions({}, preCancelled),
      (error) => error === reason,
    );
    assert.equal(listing.mock.callCount(), 0);
    const outcome = adapter.listArchivedSessions({}, controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    await admitted;
    assert.equal(listing.mock.callCount(), 1);
    assert.equal(receivedSignal, controller.signal);
    controller.abort(reason);
    assert.equal(await outcome, reason);
  } finally {
    controller.abort(reason);
    await rm(root, { recursive: true, force: true });
  }
});

test("failed archive metadata initialization can retry after repair in the same adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-archive-repair-"));
  const file = join(root, "archived-sessions.json");
  try {
    await writeFile(file, "{invalid archive metadata\n");
    const adapter = new PiWebAdapter(
      runtimeFor(root, root, SessionManager.inMemory(root)),
    );
    const failures = await Promise.allSettled([
      adapter.listArchivedSessions(),
      adapter.listArchivedSessions(),
    ]);
    assert.ok(failures.every((result) => result.status === "rejected"));
    assert.equal(await readFile(file, "utf8"), "{invalid archive metadata\n");
    await writeFile(file, "[]\n");
    const retried = await adapter.listArchivedSessions();
    assert.equal(retried.status, "ok");
    if (retried.status !== "ok") return;
    assert.deepEqual(retried.sessions, []);
    assert.equal(await readFile(file, "utf8"), "[]\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed workspace metadata initialization retries without leaking partially validated sidebar state", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-workspace-repair-"));
  const file = join(root, "workspace-state.json");
  try {
    const manager = SessionManager.create(root, root);
    persistSession(manager, "metadata recovery fixture", 1);
    const path = manager.getSessionFile()!;
    const identity = { path, id: manager.getSessionId() };
    const rejectedProject = join(root, "rejected-project");
    for (const pins of [
      { sessionPins: [identity] },
      {
        sidebarPins: [
          { kind: "workspace", path: rejectedProject },
          { kind: "session", ...identity },
        ],
      },
    ]) {
      const corrupt = JSON.stringify({
        version: 1,
        ...pins,
        importedWorkspaces: [rejectedProject],
        sessionOrder: [identity],
        workspaceOrder: [rejectedProject, root],
        sessionReadStates: [{ ...identity, read: false, revision: "rejected" }],
        hiddenWorkspaces: "invalid shape",
        ungroupedSessions: [],
        workspaceNames: {},
      });
      await writeFile(file, corrupt);
      const adapter = new PiWebAdapter(runtimeFor(root, root, manager));
      const failures = await Promise.allSettled([
        adapter.listArchivedSessions(),
        adapter.listArchivedSessions(),
      ]);
      assert.ok(failures.every((result) => result.status === "rejected"));
      assert.equal(await readFile(file, "utf8"), corrupt);
      const repaired = `${JSON.stringify({
        version: 1,
        hiddenWorkspaces: [],
        ungroupedSessions: [],
        workspaceNames: {},
      })}\n`;
      await writeFile(file, repaired);
      const retried = await adapter.listArchivedSessions();
      assert.equal(retried.status, "ok");
      const snapshot = await adapter.getSnapshot();
      const session = snapshot.sessions.find((item) => item.path === path)!;
      assert.equal(session.pinOrder, undefined, "rejected pins must not leak");
      assert.equal(session.order, undefined, "rejected order must not leak");
      assert.equal(
        session.unread,
        false,
        "rejected reading state must not leak",
      );
      assert.deepEqual(
        snapshot.workspaces.map((workspace) => workspace.path),
        [root],
        "rejected imported projects must not leak",
      );
      assert.equal(await readFile(file, "utf8"), repaired);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archived cursors bind duplicate IDs to their file and stay replayable", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-archived-cursor-"));
  const sessionDirectory = join(root, "sessions");
  try {
    const current = SessionManager.inMemory(root);
    const first = SessionManager.create(root, sessionDirectory);
    persistSession(first, "中".repeat(160), 1);
    const firstPath = first.getSessionFile();
    assert.ok(firstPath);
    const duplicatePath = join(sessionDirectory, "duplicate.jsonl");
    await writeFile(duplicatePath, await readFile(firstPath));
    const second = SessionManager.create(root, sessionDirectory);
    persistSession(second, "ﬃ".repeat(50), 2);
    const secondPath = second.getSessionFile();
    assert.ok(secondPath);
    const normalizedSecond = SessionManager.create(root, sessionDirectory);
    persistSession(normalizedSecond, "ﬃ".repeat(50), 3);
    const normalizedSecondPath = normalizedSecond.getSessionFile();
    assert.ok(normalizedSecondPath);
    const adapter = new PiWebAdapter(
      runtimeFor(root, sessionDirectory, current),
    );
    for (const path of [
      firstPath,
      duplicatePath,
      secondPath,
      normalizedSecondPath,
    ]) {
      await adapter.archiveSession(path);
    }

    const chinese = await adapter.listArchivedSessions({
      query: "中".repeat(160),
      limit: 1,
    });
    assert.equal(chinese.status, "ok");
    if (chinese.status !== "ok") return;
    assert.ok(chinese.nextCursor);
    assert.ok(chinese.nextCursor.length <= 512);
    const chineseReplay = await adapter.listArchivedSessions({
      query: "中".repeat(160),
      limit: 1,
      cursor: chinese.nextCursor,
    });
    assert.equal(chineseReplay.status, "ok");

    const normalized = await adapter.listArchivedSessions({
      query: "ﬃ".repeat(50),
      limit: 1,
    });
    assert.equal(normalized.status, "ok");
    if (normalized.status !== "ok") return;
    assert.ok(normalized.nextCursor);
    assert.ok(normalized.nextCursor.length <= 512);
    const normalizedReplay = await adapter.listArchivedSessions({
      query: "ﬃ".repeat(50),
      limit: 1,
      cursor: normalized.nextCursor,
    });
    assert.equal(normalizedReplay.status, "ok");

    const duplicateFirst = await adapter.listArchivedSessions({
      query: "中",
      limit: 1,
    });
    assert.equal(duplicateFirst.status, "ok");
    if (duplicateFirst.status !== "ok") return;
    const duplicateSeen = new Set(
      duplicateFirst.sessions.map((item) => item.path),
    );
    let cursor = duplicateFirst.nextCursor;
    while (cursor) {
      const page = await adapter.listArchivedSessions({
        query: "中",
        limit: 1,
        cursor,
      });
      assert.equal(page.status, "ok");
      if (page.status !== "ok") break;
      for (const session of page.sessions) duplicateSeen.add(session.path);
      cursor = page.nextCursor;
    }
    assert.deepEqual(duplicateSeen, new Set([firstPath, duplicatePath]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt package metadata fails closed without overwriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-corrupt-state-"));
  const imported = await mkdtemp(join(tmpdir(), "openpi-web-corrupt-import-"));
  const sessionDirectory = join(root, "sessions");
  try {
    await mkdir(sessionDirectory, { recursive: true });
    const workspaceFile = join(sessionDirectory, "workspace-state.json");
    const archiveFile = join(sessionDirectory, "archived-sessions.json");
    await writeFile(workspaceFile, "{not-json\n");
    await writeFile(archiveFile, '{"not":"an array"}\n');
    const current = SessionManager.inMemory(root);

    await assert.rejects(
      new PiWebAdapter(
        runtimeFor(root, sessionDirectory, current),
      ).importWorkspace(imported),
      /JSON|position|property/u,
    );
    assert.equal(await readFile(workspaceFile, "utf8"), "{not-json\n");

    await assert.rejects(
      new PiWebAdapter(
        runtimeFor(root, sessionDirectory, current),
      ).archiveSession(`current:${current.getSessionId()}`),
      /Archive metadata/u,
    );
    assert.equal(await readFile(archiveFile, "utf8"), '{"not":"an array"}\n');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(imported, { recursive: true, force: true });
  }
});

test("workspace mutation rolls back its in-memory state when persistence fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-state-rollback-"));
  const imported = await mkdtemp(join(tmpdir(), "openpi-web-import-rollback-"));
  const sessionDirectory = join(root, "sessions");
  try {
    await mkdir(sessionDirectory, { recursive: true });
    const current = SessionManager.inMemory(root);
    const adapter = new PiWebAdapter(
      runtimeFor(root, sessionDirectory, current),
    );
    (
      adapter as unknown as {
        writeAtomically: () => Promise<void>;
      }
    ).writeAtomically = async () => {
      throw new Error("disk full");
    };

    await assert.rejects(adapter.importWorkspace(imported), /disk full/u);
    const snapshot = await adapter.getSnapshot();
    assert.equal(
      snapshot.workspaces.some((workspace) => workspace.path === imported),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(imported, { recursive: true, force: true });
  }
});

test("workspace transactions roll back a failed mutation before the next mutation persists", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-state-transaction-"));
  const sessionDirectory = join(root, "sessions");
  try {
    await mkdir(sessionDirectory, { recursive: true });
    const current = SessionManager.inMemory(root);
    const adapter = new PiWebAdapter(
      runtimeFor(root, sessionDirectory, current),
    );
    const internal = adapter as unknown as {
      writeAtomically: (filePath: string, content: string) => Promise<void>;
    };
    const writeAtomically = internal.writeAtomically.bind(adapter);
    let attempts = 0;
    internal.writeAtomically = async (filePath, content) => {
      attempts++;
      if (attempts === 1) throw new Error("first write fails");
      await writeAtomically(filePath, content);
    };

    const first = adapter.renameWorkspace(root, "First");
    const second = adapter.renameWorkspace(root, "Second");
    const [firstResult, secondResult] = await Promise.allSettled([
      first,
      second,
    ]);

    assert.equal(firstResult.status, "rejected");
    assert.equal(secondResult.status, "fulfilled");
    assert.equal(attempts, 2);
    const persisted = JSON.parse(
      await readFile(join(sessionDirectory, "workspace-state.json"), "utf8"),
    ) as { workspaceNames: Record<string, string> };
    assert.equal(persisted.workspaceNames[resolve(root)], "Second");
    assert.equal(
      (await adapter.getSnapshot()).workspaces.find(
        (workspace) => workspace.path === resolve(root),
      )?.name,
      "Second",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive transactions roll back a failed mutation before the next mutation persists", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-archive-transaction-"));
  const sessionDirectory = join(root, "sessions");
  try {
    await mkdir(sessionDirectory, { recursive: true });
    const current = SessionManager.inMemory(root);
    const adapter = new PiWebAdapter(
      runtimeFor(root, sessionDirectory, current),
    );
    const internal = adapter as unknown as {
      writeAtomically: (filePath: string, content: string) => Promise<void>;
    };
    const writeAtomically = internal.writeAtomically.bind(adapter);
    let attempts = 0;
    internal.writeAtomically = async (filePath, content) => {
      attempts++;
      if (attempts === 1) throw new Error("first write fails");
      await writeAtomically(filePath, content);
    };
    const currentPath = `current:${current.getSessionId()}`;

    const first = adapter.archiveSession(currentPath);
    const second = adapter.archiveSession(currentPath);
    const [firstResult, secondResult] = await Promise.allSettled([
      first,
      second,
    ]);

    assert.equal(firstResult.status, "rejected");
    assert.equal(secondResult.status, "fulfilled");
    assert.equal(attempts, 2);
    const persisted = JSON.parse(
      await readFile(join(sessionDirectory, "archived-sessions.json"), "utf8"),
    ) as string[];
    assert.deepEqual(persisted, [resolve(currentPath)]);
    assert.equal(
      (await adapter.getSnapshot()).sessions.find(
        (session) => session.id === current.getSessionId(),
      )?.archived,
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace reads see only committed state while an atomic write is pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-state-visibility-"));
  const sessionDirectory = join(root, "sessions");
  try {
    await mkdir(sessionDirectory, { recursive: true });
    const current = SessionManager.inMemory(root);
    const adapter = new PiWebAdapter(
      runtimeFor(root, sessionDirectory, current),
    );
    await adapter.renameWorkspace(root, "Old");
    const internal = adapter as unknown as {
      writeAtomically: (filePath: string, content: string) => Promise<void>;
    };
    const writeAtomically = internal.writeAtomically.bind(adapter);
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    let releaseWrite: () => void = () => {};
    const released = new Promise<void>((resolveReleased) => {
      releaseWrite = resolveReleased;
    });
    internal.writeAtomically = async (filePath, content) => {
      markStarted();
      await released;
      await writeAtomically(filePath, content);
    };

    const pending = adapter.renameWorkspace(root, "New");
    await started;

    const during = await adapter.getSnapshot();
    assert.equal(
      during.workspaces.find((workspace) => workspace.path === resolve(root))
        ?.name,
      "Old",
    );
    const persistedDuring = JSON.parse(
      await readFile(join(sessionDirectory, "workspace-state.json"), "utf8"),
    ) as { workspaceNames: Record<string, string> };
    assert.equal(persistedDuring.workspaceNames[resolve(root)], "Old");

    releaseWrite();
    await pending;

    assert.equal(
      (await adapter.getSnapshot()).workspaces.find(
        (workspace) => workspace.path === resolve(root),
      )?.name,
      "New",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive reads see only committed state while an atomic write is pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-archive-visibility-"));
  const sessionDirectory = join(root, "sessions");
  try {
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "archived-sessions.json"), "[]\n");
    const current = SessionManager.inMemory(root);
    const adapter = new PiWebAdapter(
      runtimeFor(root, sessionDirectory, current),
    );
    const internal = adapter as unknown as {
      writeAtomically: (filePath: string, content: string) => Promise<void>;
    };
    const writeAtomically = internal.writeAtomically.bind(adapter);
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    let releaseWrite: () => void = () => {};
    const released = new Promise<void>((resolveReleased) => {
      releaseWrite = resolveReleased;
    });
    internal.writeAtomically = async (filePath, content) => {
      markStarted();
      await released;
      await writeAtomically(filePath, content);
    };
    const currentPath = `current:${current.getSessionId()}`;

    const pending = adapter.archiveSession(currentPath);
    await started;

    assert.equal(
      (await adapter.getSnapshot()).sessions.find(
        (session) => session.id === current.getSessionId(),
      )?.archived,
      undefined,
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(sessionDirectory, "archived-sessions.json"),
          "utf8",
        ),
      ),
      [],
    );

    releaseWrite();
    await pending;

    assert.equal(
      (await adapter.getSnapshot()).sessions.find(
        (session) => session.id === current.getSessionId(),
      )?.archived,
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initialize restores the initial workspace exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-initialize-"));
  const sessionDirectory = join(root, "sessions");
  try {
    await mkdir(sessionDirectory, { recursive: true });
    const workspaceFile = join(sessionDirectory, "workspace-state.json");
    await writeFile(
      workspaceFile,
      `${JSON.stringify({
        version: 1,
        hiddenWorkspaces: [resolve(root)],
        ungroupedSessions: [],
        workspaceNames: {},
      })}\n`,
    );
    const current = SessionManager.inMemory(root);
    const adapter = new PiWebAdapter(
      runtimeFor(root, sessionDirectory, current),
    );
    const internal = adapter as unknown as {
      writeAtomically: (filePath: string, content: string) => Promise<void>;
    };
    const writeAtomically = internal.writeAtomically.bind(adapter);
    let writes = 0;
    internal.writeAtomically = async (filePath, content) => {
      writes++;
      await writeAtomically(filePath, content);
    };

    await adapter.initialize();
    await adapter.initialize();

    assert.equal(writes, 1);
    assert.ok(
      (await adapter.getSnapshot()).workspaces.some(
        (workspace) => workspace.path === resolve(root),
      ),
    );
    const persisted = JSON.parse(await readFile(workspaceFile, "utf8")) as {
      hiddenWorkspaces: string[];
    };
    assert.deepEqual(persisted.hiddenWorkspaces, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("getSnapshot does not restore or persist workspace metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-read-only-snapshot-"));
  const sessionDirectory = join(root, "sessions");
  try {
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      join(sessionDirectory, "workspace-state.json"),
      `${JSON.stringify({
        version: 1,
        hiddenWorkspaces: [resolve(root)],
        ungroupedSessions: [],
        workspaceNames: {},
      })}\n`,
    );
    const current = SessionManager.inMemory(root);
    const adapter = new PiWebAdapter(
      runtimeFor(root, sessionDirectory, current),
    );
    let writes = 0;
    (
      adapter as unknown as {
        writeAtomically: () => Promise<void>;
      }
    ).writeAtomically = async () => {
      writes++;
      throw new Error("GET attempted to persist metadata");
    };

    const snapshot = await adapter.getSnapshot();

    assert.equal(writes, 0);
    assert.equal(
      snapshot.workspaces.some((workspace) => workspace.path === resolve(root)),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initialize fails closed without exposing or retrying uncommitted state", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-initialize-failure-"));
  const sessionDirectory = join(root, "sessions");
  try {
    await mkdir(sessionDirectory, { recursive: true });
    const workspaceFile = join(sessionDirectory, "workspace-state.json");
    const original = `${JSON.stringify({
      version: 1,
      hiddenWorkspaces: [resolve(root)],
      ungroupedSessions: [],
      workspaceNames: {},
    })}\n`;
    await writeFile(workspaceFile, original);
    const current = SessionManager.inMemory(root);
    const adapter = new PiWebAdapter(
      runtimeFor(root, sessionDirectory, current),
    );
    let writes = 0;
    (
      adapter as unknown as {
        writeAtomically: () => Promise<void>;
      }
    ).writeAtomically = async () => {
      writes++;
      throw new Error("disk full");
    };

    await assert.rejects(adapter.initialize(), /disk full/u);
    await assert.rejects(adapter.initialize(), /disk full/u);

    assert.equal(writes, 1);
    assert.equal(await readFile(workspaceFile, "utf8"), original);
    assert.equal(
      (await adapter.getSnapshot()).workspaces.some(
        (workspace) => workspace.path === resolve(root),
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Session provenance targets the current file even when a copied file retains its id", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-provenance-"));
  try {
    const directory = join(root, "sessions");
    const manager = SessionManager.create(root, directory);
    persistSession(manager, "original", 1);
    const original = manager.getSessionFile();
    assert.ok(original);
    const copy = join(directory, "copied.jsonl");
    await writeFile(copy, await readFile(original));
    const adapter = new PiWebAdapter(runtimeFor(root, directory, manager));
    const { sessions } = await adapter.listSessionProjection();
    assert.equal(sessions.find((s) => s.path === copy)?.controller, "none");
    assert.deepEqual(
      sessions.filter((s) => s.controller === "web").map((s) => s.path),
      [original],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unarchive is idempotent across restart and preserves canonical Session data", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-unarchive-"));
  const sessionDirectory = join(root, "sessions");
  try {
    const manager = SessionManager.create(root, sessionDirectory);
    persistSession(manager, "keep original history", 1);
    const path = manager.getSessionFile();
    assert.ok(path);
    const original = await readFile(path, "utf8");
    const runtime = runtimeFor(root, sessionDirectory, manager);
    const adapter = new PiWebAdapter(runtime);
    await adapter.archiveSession(path);
    assert.equal((await adapter.requireSession(path)).archived, true);
    await Promise.all([
      adapter.unarchiveSession(path),
      adapter.unarchiveSession(path),
    ]);
    const restored = await new PiWebAdapter(runtime).requireSession(path);
    assert.equal(restored.archived, undefined);
    assert.equal(restored.cwd, root);
    assert.equal(await readFile(path, "utf8"), original);
    const metadata = await readFile(
      join(sessionDirectory, "archived-sessions.json"),
      "utf8",
    );
    await assert.rejects(adapter.unarchiveSession(join(root, "missing.jsonl")));
    assert.equal(
      await readFile(join(sessionDirectory, "archived-sessions.json"), "utf8"),
      metadata,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot projects a bounded thinking state without a revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-thinking-bounds-"));
  const sessionDirectory = join(root, "sessions");
  try {
    const current = SessionManager.inMemory(root);
    const runtime: WebRuntimeController = {
      ...runtimeFor(root, sessionDirectory, current),
      getThinkingState: () => ({
        level: "l".repeat(900),
        available: Array.from(
          { length: 20 },
          (_, index) => `level-${index}-${"a".repeat(600)}`,
        ),
        supported: true,
      }),
    };
    const snapshot = await new PiWebAdapter(runtime).getSnapshot();

    assert.ok(snapshot.thinking);
    assert.equal(snapshot.thinking.level.length, 500);
    assert.equal(snapshot.thinking.available.length, 16);
    assert.ok(
      snapshot.thinking.available.every((level) => level.length <= 500),
    );
    assert.equal(snapshot.thinking.supported, true);
    assert.equal("revision" in snapshot.thinking, false);
    assert.ok(snapshot.truncation.bytes <= WEB_MAX_SNAPSHOT_BYTES);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a throwing or absent thinking getter is omitted without failing the snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-thinking-fail-open-"));
  const sessionDirectory = join(root, "sessions");
  try {
    const current = SessionManager.inMemory(root);
    const throwing: WebRuntimeController = {
      ...runtimeFor(root, sessionDirectory, current),
      getThinkingState: () => {
        throw new Error("thinking state exploded");
      },
    };
    const thrown = await new PiWebAdapter(throwing).getSnapshot();
    assert.equal(thrown.thinking, undefined);

    const absent = await new PiWebAdapter(
      runtimeFor(root, sessionDirectory, current),
    ).getSnapshot();
    assert.equal(absent.thinking, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mixed sidebar pins migrate legacy conversation order and preserve empty projects across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-sidebar-mixed-pins-"));
  const directory = join(root, "sessions");
  try {
    const manager = SessionManager.create(root, directory);
    persistSession(manager, "pinned conversation", 1);
    const identity = {
      path: manager.getSessionFile()!,
      id: manager.getSessionId(),
    };
    const metadata = join(directory, "workspace-state.json");
    await writeFile(
      metadata,
      JSON.stringify({
        version: 1,
        hiddenWorkspaces: [],
        ungroupedSessions: [],
        workspaceNames: {},
        sessionPins: [identity],
      }),
    );
    const runtime = runtimeFor(root, directory, manager);
    const adapter = new PiWebAdapter(runtime);
    assert.equal((await adapter.listSessions())[0]!.pinOrder, 0);
    await mkdir(join(root, "empty-project"));
    const project = await adapter.importWorkspace(join(root, "empty-project"));
    await adapter.setSidebarPin({ kind: "workspace", path: project }, true, {
      kind: "session",
      ...identity,
    });
    let restored = new PiWebAdapter(runtime);
    let snapshot = await restored.getSnapshot();
    assert.equal(
      snapshot.workspaces.find((workspace) => workspace.path === project)
        ?.pinOrder,
      0,
    );
    assert.equal(
      snapshot.sessions.find((session) => session.path === identity.path)
        ?.pinOrder,
      1,
    );
    assert.equal(
      snapshot.sessions.some((session) => session.cwd === project),
      false,
    );
    await restored.setSidebarPin({ kind: "session", ...identity }, true, {
      kind: "workspace",
      path: project,
    });
    restored = new PiWebAdapter(runtime);
    snapshot = await restored.getSnapshot();
    assert.equal(snapshot.sessions[0]!.pinOrder, 0);
    assert.equal(
      snapshot.workspaces.find((workspace) => workspace.path === project)
        ?.pinOrder,
      1,
    );
    const saved = JSON.parse(await readFile(metadata, "utf8"));
    assert.deepEqual(saved.sidebarPins, [
      { kind: "session", ...identity },
      { kind: "workspace", path: project },
    ]);
    assert.equal("sessionPins" in saved, false);
    assert.ok(saved.importedWorkspaces.includes(project));
    await assert.rejects(
      restored.setSidebarPin({ kind: "session", ...identity }, true, {
        kind: "workspace",
        path: join(root, "missing"),
      }),
      /order changed/,
    );
    await restored.removeWorkspace(project);
    assert.equal(
      (await new PiWebAdapter(runtime).getSnapshot()).workspaces.some(
        (workspace) => workspace.path === project,
      ),
      false,
    );
    assert.equal((await restored.listSessions())[0]!.pinOrder, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Session order and manual unread markers bind copied IDs to their exact files and survive restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-sidebar-order-read-"));
  const directory = join(root, "sessions");
  try {
    const manager = SessionManager.create(root, directory);
    persistSession(manager, "original", 1);
    const original = {
      path: manager.getSessionFile()!,
      id: manager.getSessionId(),
    };
    const copied = { path: join(directory, "copy.jsonl"), id: original.id };
    await writeFile(copied.path, await readFile(original.path));
    const nativeBefore = await readFile(original.path, "utf8");
    const runtime = runtimeFor(root, directory, manager);
    let adapter = new PiWebAdapter(runtime);
    await adapter.setSessionOrder(original.path, original.id, copied);
    await adapter.setSessionRead(
      original.path,
      original.id,
      false,
      (await adapter.requireSession(original.path)).readRevision!,
    );
    adapter = new PiWebAdapter(runtime);
    let sessions = await adapter.listSessions();
    assert.ok(
      sessions.find((session) => session.path === original.path)!.order! <
        sessions.find((session) => session.path === copied.path)!.order!,
    );
    assert.equal(
      sessions.find((session) => session.path === original.path)!.unread,
      true,
    );
    assert.equal(
      sessions.find((session) => session.path === copied.path)!.unread,
      false,
    );
    assert.equal(
      sessions.find((session) => session.path === original.path)!.execution,
      undefined,
    );
    await adapter.setSessionOrder(copied.path, copied.id, original);
    await adapter.setSessionRead(
      original.path,
      original.id,
      true,
      (await adapter.requireSession(original.path)).readRevision!,
    );
    sessions = await new PiWebAdapter(runtime).listSessions();
    assert.ok(
      sessions.find((session) => session.path === copied.path)!.order! <
        sessions.find((session) => session.path === original.path)!.order!,
    );
    assert.equal(
      sessions.find((session) => session.path === original.path)!.unread,
      false,
    );
    await assert.rejects(
      adapter.setSessionRead(
        original.path,
        "foreign-id",
        false,
        (await adapter.requireSession(original.path)).readRevision!,
      ),
      /identity changed/,
    );
    await assert.rejects(
      adapter.setSessionOrder(original.path, original.id, {
        ...copied,
        id: "foreign-id",
      }),
      /anchor changed/,
    );
    assert.equal(await readFile(original.path, "utf8"), nativeBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy history stays read without migration writes, while explicit marks and published results survive restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openpi-sidebar-read-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "sessions");
  const manager = SessionManager.create(root, directory);
  const finish = (
    commandId: string,
    finishedAt: number,
    unreadEligible = false,
  ) => {
    persistSession(manager, commandId, finishedAt);
    manager.appendCustomEntry(WEB_TURN_TIMING_ENTRY, {
      version: 1,
      sessionId: manager.getSessionId(),
      commandId,
      epoch: 1,
      startedAt: finishedAt - 1,
      finishedAt,
      elapsedMs: 1,
      outcome: "completed",
      ...(unreadEligible ? { unreadEligible: true } : {}),
      resultEntryId: manager.getLeafId(),
    });
  };
  finish("before-upgrade", 100);
  const path = manager.getSessionFile()!;
  const id = manager.getSessionId();
  const explicit = SessionManager.create(root, directory);
  persistSession(explicit, "Manually unread", 1);
  const metadata = join(directory, "workspace-state.json");
  await writeFile(
    metadata,
    JSON.stringify({
      version: 1,
      hiddenWorkspaces: [],
      ungroupedSessions: [],
      workspaceNames: {},
      sessionReadStates: [
        {
          path: explicit.getSessionFile(),
          id: explicit.getSessionId(),
          read: false,
          revision: "manual",
        },
      ],
    }),
  );
  const sourceBytes = await readFile(path);
  const metadataBytes = await readFile(metadata);
  const runtime = runtimeFor(root, directory, manager);
  let adapter = new PiWebAdapter(runtime);
  const before = (await adapter.requireSession(path)).readRevision!;
  await adapter.initialize();
  assert.equal((await adapter.requireSession(path)).unread, false);
  assert.equal(
    (await adapter.requireSession(explicit.getSessionFile()!)).unread,
    true,
  );
  assert.deepEqual(await readFile(path), sourceBytes);
  assert.deepEqual(await readFile(metadata), metadataBytes);
  assert.equal(
    (await adapter.requireSession(path)).execution?.lastTurn?.commandId,
    "before-upgrade",
  );

  // Native branch order remains authoritative even if the wall clock moves back.
  finish("after-upgrade", 50, true);
  const unread = await adapter.requireSession(path);
  assert.equal(unread.unread, true);
  await assert.rejects(adapter.setSessionRead(path, id, true, before), {
    code: "SESSION_READ_STATE_CHANGED",
  });
  assert.equal(
    unread.firstUnread?.type === "turn" && unread.firstUnread.commandId,
    "after-upgrade",
  );
  const saved = await readFile(metadata, "utf8");
  adapter = new PiWebAdapter(runtime);
  await adapter.initialize();
  assert.deepEqual(await adapter.requireSession(path), unread);
  assert.equal(await readFile(metadata, "utf8"), saved);
  await adapter.setSessionRead(path, id, true, unread.readRevision!);
  assert.equal((await adapter.requireSession(path)).unread, false);
});

test("legacy or unpersisted execution projections cannot seed unread state or create metadata on discovery", async (t) => {
  const root = await mkdtemp(
    join(tmpdir(), "openpi-sidebar-read-migration-failure-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "sessions");
  const manager = SessionManager.create(root, directory);
  persistSession(manager, "Historical result", 1);
  manager.appendCustomEntry(WEB_TURN_TIMING_ENTRY, {
    version: 1,
    sessionId: manager.getSessionId(),
    commandId: "legacy",
    epoch: 1,
    startedAt: 1,
    finishedAt: 2,
    elapsedMs: 1,
    outcome: "completed",
    resultEntryId: manager.getLeafId(),
  });
  const runtime = runtimeFor(root, directory, manager);
  runtime.getSessionExecution = (sessionId, sessionPath) => ({
    sessionId,
    sessionPath,
    status: "idle",
    liveTools: [],
    liveToolsOmitted: 0,
    lastTurn: { commandId: "unpersisted", finishedAt: 3, outcome: "completed" },
  });
  const adapter = new PiWebAdapter(runtime);
  const path = manager.getSessionFile()!;
  const metadata = join(directory, "workspace-state.json");
  await adapter.initialize();
  assert.equal((await adapter.requireSession(path)).unread, false);
  assert.equal(
    (await adapter.requireSession(path)).execution?.lastTurn?.commandId,
    "unpersisted",
  );
  await assert.rejects(readFile(metadata), { code: "ENOENT" });
});

test("native last-turn evidence survives restart without inventing idle, and stale read receipts cannot clear a new result", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-sidebar-native-read-"));
  const directory = join(root, "sessions");
  try {
    const manager = SessionManager.create(root, directory);
    const current = SessionManager.create(root, directory);
    persistSession(current, "different active Session", 1);
    const finish = (
      commandId: string,
      finishedAt: number,
      outcome = "completed",
      sessionId = manager.getSessionId(),
      unreadEligible = true,
    ) => {
      persistSession(manager, commandId, finishedAt);
      manager.appendCustomEntry(WEB_TURN_TIMING_ENTRY, {
        version: 1,
        ...(unreadEligible ? { unreadEligible: true } : {}),
        sessionId,
        commandId,
        epoch: 1,
        startedAt: finishedAt - 1,
        finishedAt,
        elapsedMs: 1,
        outcome,
        resultEntryId: manager.getLeafId(),
      });
    };
    finish("first", 100);
    const identity = {
      path: manager.getSessionFile()!,
      id: manager.getSessionId(),
    };
    const runtime = runtimeFor(root, directory, current);
    let adapter = new PiWebAdapter(runtime);
    const summary = async () =>
      (await adapter.listSessions()).find(
        (session) => session.path === identity.path,
      )!;
    const first = (await summary()).execution?.lastTurn;
    const firstRevision = (await summary()).readRevision!;
    assert.ok(first?.resultEntryId);
    assert.equal((await summary()).execution?.status, "unknown");
    assert.equal((await summary()).unread, true);
    await adapter.setSessionRead(
      identity.path,
      identity.id,
      true,
      firstRevision,
    );
    adapter = new PiWebAdapter(runtime);
    assert.equal((await summary()).unread, false);
    // An existing exact read receipt preserves older unmarked results after it.
    finish("second", 200, "completed", manager.getSessionId(), false);
    assert.equal((await summary()).unread, true);
    await assert.rejects(
      adapter.setSessionRead(identity.path, identity.id, true, firstRevision),
      { code: "SESSION_READ_STATE_CHANGED" },
    );
    await assert.rejects(
      adapter.setSessionRead(identity.path, identity.id, true, ""),
      { code: "SESSION_READ_STATE_CHANGED" },
    );
    assert.equal((await summary()).unread, true);
    await adapter.setSessionRead(
      identity.path,
      identity.id,
      true,
      (await summary()).readRevision!,
    );
    assert.equal((await summary()).unread, false);
    finish("cancelled", 300, "cancelled");
    assert.equal((await summary()).unread, false);
    finish("failed", 400, "failed");
    assert.equal((await summary()).unread, true);
    const failedPosition = (await summary()).firstUnread;
    finish("uncertain", 500, "uncertain");
    assert.equal((await summary()).unread, true);
    assert.deepEqual((await summary()).firstUnread, failedPosition);
    finish("foreign", 600, "completed", "foreign-session");
    assert.equal((await summary()).execution, undefined);
    assert.equal((await summary()).unread, true);
    assert.deepEqual((await summary()).firstUnread, failedPosition);
    assert.equal(
      (await new PiWebAdapter(runtime).listSessions()).find(
        (session) => session.path === identity.path,
      )!.execution,
      undefined,
    );
    await adapter.setSessionRead(
      identity.path,
      identity.id,
      true,
      (await summary()).readRevision!,
    );
    assert.equal((await summary()).unread, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the first unread native result survives running, cancellation and later results, while revisions guard every new eligible result", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-sidebar-unread-position-"));
  const directory = join(root, "sessions");
  try {
    const manager = SessionManager.create(root, directory);
    const finish = (
      commandId: string,
      finishedAt: number,
      outcome: "completed" | "failed" | "cancelled" | "uncertain" = "completed",
    ) => {
      persistSession(manager, commandId, finishedAt);
      manager.appendCustomEntry(WEB_TURN_TIMING_ENTRY, {
        version: 1,
        unreadEligible: true,
        sessionId: manager.getSessionId(),
        commandId,
        epoch: 1,
        startedAt: 0,
        finishedAt,
        elapsedMs: 1,
        outcome,
        resultEntryId: manager.getLeafId(),
      });
      return manager.getLeafId()!;
    };
    const firstLeaf = finish("first", 500);
    const path = manager.getSessionFile()!;
    const id = manager.getSessionId();
    const runtime = runtimeFor(root, directory, manager);
    let status: "running" | "idle" = "idle";
    runtime.getSessionExecution = (sessionId, sessionPath) => ({
      sessionId,
      sessionPath,
      status,
      liveTools: [],
      liveToolsOmitted: 0,
    });
    let adapter = new PiWebAdapter(runtime);
    const summary = () => adapter.requireSession(path);
    const first = await summary();
    assert.equal(first.firstUnread?.type, "turn");
    assert.equal(
      first.firstUnread?.type === "turn" && first.firstUnread.commandId,
      "first",
    );
    status = "running";
    assert.equal((await summary()).execution?.status, "running");
    assert.deepEqual((await summary()).firstUnread, first.firstUnread);
    assert.equal((await summary()).readRevision, first.readRevision);
    status = "idle";
    finish("cancelled", 600, "cancelled");
    finish("uncertain", 700, "uncertain");
    assert.deepEqual((await summary()).firstUnread, first.firstUnread);
    assert.equal((await summary()).readRevision, first.readRevision);
    // Native sequence remains authoritative when the system clock moves back.
    const secondLeaf = finish("second", 100);
    const second = await summary();
    assert.deepEqual(second.firstUnread, first.firstUnread);
    assert.notEqual(second.readRevision, first.readRevision);
    for (const read of [true, false])
      await assert.rejects(
        adapter.setSessionRead(path, id, read, first.readRevision!),
        { code: "SESSION_READ_STATE_CHANGED" },
      );
    await adapter.setSessionRead(path, id, true, second.readRevision!);
    assert.equal((await summary()).unread, false);
    // Replayed native receipts are not a second unread result.
    const timing = manager.getLeafEntry();
    assert.ok(timing?.type === "custom");
    manager.appendCustomEntry(WEB_TURN_TIMING_ENTRY, timing.data);
    assert.equal((await summary()).unread, false);
    const readRevision = (await summary()).readRevision;
    assert.equal((await summary()).firstUnread, undefined);
    adapter = new PiWebAdapter(runtime);
    assert.equal((await summary()).readRevision, readRevision);
    assert.equal((await summary()).unread, false);

    const failedLeaf = finish("failed", 50, "failed");
    const failed = await summary();
    assert.equal(
      failed.firstUnread?.type === "turn" && failed.firstUnread.commandId,
      "failed",
    );
    finish("third", 40);
    assert.deepEqual((await summary()).firstUnread, failed.firstUnread);
    assert.notEqual((await summary()).readRevision, failed.readRevision);
    // A native rewind drops an unread result that is no longer on the branch.
    manager.branch(secondLeaf);
    assert.equal((await summary()).firstUnread, undefined);
    manager.branch(failedLeaf);
    assert.deepEqual((await summary()).firstUnread, failed.firstUnread);
    await adapter.setSessionRead(
      path,
      id,
      true,
      (await summary()).readRevision!,
    );
    manager.branch(firstLeaf);
    assert.equal((await summary()).firstUnread, undefined);
    finish("new-branch", 10);
    const branched = (await summary()).firstUnread;
    assert.equal(branched?.type === "turn" && branched.commandId, "new-branch");
    await adapter.setSessionRead(
      path,
      id,
      false,
      (await summary()).readRevision!,
    );
    assert.deepEqual((await summary()).firstUnread, { type: "sessionStart" });
    manager.branch(firstLeaf);
    assert.deepEqual((await summary()).firstUnread, { type: "sessionStart" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reading revisions protect both edits from another window, bind exact files and survive restart without snapshot writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-sidebar-read-revisions-"));
  const directory = join(root, "sessions");
  try {
    const manager = SessionManager.create(root, directory);
    persistSession(manager, "original", 1);
    const path = manager.getSessionFile()!;
    const id = manager.getSessionId();
    const copy = join(directory, "same-id-copy.jsonl");
    await writeFile(copy, await readFile(path));
    const runtime = runtimeFor(root, directory, manager);
    let adapter = new PiWebAdapter(runtime);
    const summary = () => adapter.requireSession(path);
    const initial = await summary();
    assert.equal(initial.unread, false);
    assert.equal((await summary()).readRevision, initial.readRevision);
    const metadata = join(directory, "workspace-state.json");
    await assert.rejects(readFile(metadata), { code: "ENOENT" });
    await assert.rejects(
      adapter.setSessionRead(copy, id, false, initial.readRevision!),
      { code: "SESSION_READ_STATE_CHANGED" },
    );

    await adapter.setSessionRead(path, id, false, initial.readRevision!);
    const marked = await summary();
    assert.equal(marked.unread, true);
    assert.notEqual(marked.readRevision, initial.readRevision);
    for (const read of [true, false])
      await assert.rejects(
        adapter.setSessionRead(path, id, read, initial.readRevision!),
        { code: "SESSION_READ_STATE_CHANGED" },
      );

    await adapter.setSessionRead(path, id, false, marked.readRevision!);
    const markedAgain = await summary();
    assert.notEqual(markedAgain.readRevision, marked.readRevision);
    await assert.rejects(
      adapter.setSessionRead(path, id, true, marked.readRevision!),
      { code: "SESSION_READ_STATE_CHANGED" },
    );
    const persisted = await readFile(metadata, "utf8");
    adapter = new PiWebAdapter(runtime);
    assert.deepEqual(await summary(), markedAgain);
    assert.equal(await readFile(metadata, "utf8"), persisted);

    await adapter.setSessionRead(path, id, true, markedAgain.readRevision!);
    const acknowledged = await summary();
    assert.equal(acknowledged.unread, false);
    assert.notEqual(acknowledged.readRevision, markedAgain.readRevision);
    await assert.rejects(
      adapter.setSessionRead(path, id, false, markedAgain.readRevision!),
      { code: "SESSION_READ_STATE_CHANGED" },
    );

    // The previous metadata format had no edit nonce. It stays readable, and
    // the first explicit edit upgrades that record without a snapshot write.
    const legacy = JSON.parse(await readFile(metadata, "utf8"));
    delete legacy.sessionReadStates[0].revision;
    const legacyText = JSON.stringify(legacy);
    await writeFile(metadata, legacyText);
    adapter = new PiWebAdapter(runtime);
    const migrated = await summary();
    assert.equal(migrated.unread, false);
    assert.equal(await readFile(metadata, "utf8"), legacyText);
    await adapter.setSessionRead(path, id, false, migrated.readRevision!);
    assert.equal(
      typeof JSON.parse(await readFile(metadata, "utf8")).sessionReadStates[0]
        .revision,
      "string",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a native fork does not turn inherited timing into a new unread result", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-sidebar-fork-read-"));
  const directory = join(root, "sessions");
  try {
    const manager = SessionManager.create(root, directory);
    persistSession(manager, "source answer", 1);
    manager.appendCustomEntry(WEB_TURN_TIMING_ENTRY, {
      version: 1,
      sessionId: manager.getSessionId(),
      commandId: "source-turn",
      unreadEligible: true,
      epoch: 1,
      startedAt: 0,
      finishedAt: 1,
      elapsedMs: 1,
      outcome: "completed",
      resultEntryId: manager.getLeafId(),
    });
    const fork = SessionManager.forkFrom(
      manager.getSessionFile()!,
      root,
      directory,
    );
    const adapter = new PiWebAdapter(runtimeFor(root, directory, fork));
    const source = await adapter.requireSession(manager.getSessionFile()!);
    const copied = await adapter.requireSession(fork.getSessionFile()!);
    assert.notEqual(copied.id, source.id);
    assert.equal(source.unread, true);
    assert.equal(copied.unread, false);
    assert.equal(copied.execution?.lastTurn, undefined);
    assert.notEqual(copied.readRevision, source.readRevision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sidebar metadata failures retain committed pins, order and reading state and allow a later retry", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "openpi-sidebar-metadata-failure-"),
  );
  const directory = join(root, "sessions");
  try {
    const manager = SessionManager.create(root, directory);
    persistSession(manager, "first", 1);
    const second = SessionManager.create(root, directory);
    persistSession(second, "second", 2);
    const identity = {
      path: manager.getSessionFile()!,
      id: manager.getSessionId(),
    };
    const other = { path: second.getSessionFile()!, id: second.getSessionId() };
    const adapter = new PiWebAdapter(runtimeFor(root, directory, manager));
    await adapter.setSidebarPin({ kind: "workspace", path: root }, true);
    await adapter.setSessionRead(
      identity.path,
      identity.id,
      false,
      (await adapter.requireSession(identity.path)).readRevision!,
    );
    await adapter.setSessionOrder(identity.path, identity.id, other);
    const metadata = join(directory, "workspace-state.json");
    const before = await readFile(metadata, "utf8");
    const sessions = await adapter.listSessions();
    await rm(metadata);
    await mkdir(metadata);
    await assert.rejects(
      adapter.setSidebarPin({ kind: "workspace", path: root }, false),
    );
    await assert.rejects(
      adapter.setSessionRead(
        identity.path,
        identity.id,
        true,
        (await adapter.requireSession(identity.path)).readRevision!,
      ),
    );
    await assert.rejects(
      adapter.setSessionOrder(other.path, other.id, identity),
    );
    assert.deepEqual(await adapter.listSessions(), sessions);
    assert.equal(
      (await adapter.getSnapshot()).workspaces.find(
        (workspace) => workspace.path === root,
      )?.pinOrder,
      0,
    );
    await rm(metadata, { recursive: true });
    await writeFile(metadata, before);
    await adapter.setSessionRead(
      identity.path,
      identity.id,
      true,
      (await adapter.requireSession(identity.path)).readRevision!,
    );
    assert.equal(
      (await adapter.listSessions()).find(
        (session) => session.path === identity.path,
      )!.unread,
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an acknowledgement already writing cannot clear a turn that finishes during its atomic save", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-sidebar-read-race-"));
  const directory = join(root, "sessions");
  try {
    const manager = SessionManager.create(root, directory);
    persistSession(manager, "first", 1);
    const path = manager.getSessionFile()!;
    const id = manager.getSessionId();
    const runtime = runtimeFor(root, directory, manager);
    let turn = {
      commandId: "first",
      finishedAt: 100,
      outcome: "completed" as const,
    };
    const publish = () =>
      manager.appendCustomEntry(WEB_TURN_TIMING_ENTRY, {
        version: 1,
        unreadEligible: true,
        sessionId: id,
        epoch: 1,
        startedAt: turn.finishedAt - 1,
        elapsedMs: 1,
        ...turn,
      });
    publish();
    runtime.getSessionExecution = (sessionId, sessionPath) => ({
      sessionId,
      sessionPath,
      status: "idle",
      lastTurn: turn,
      liveTools: [],
      liveToolsOmitted: 0,
    });
    const adapter = new PiWebAdapter(runtime);
    await adapter.setSessionRead(
      path,
      id,
      false,
      (await adapter.requireSession(path)).readRevision!,
    );
    const internal = adapter as unknown as {
      writeAtomically: (filePath: string, content: string) => Promise<void>;
    };
    const writeAtomically = internal.writeAtomically.bind(adapter);
    let started = () => {};
    const writing = new Promise<void>((resolveStarted) => {
      started = resolveStarted;
    });
    let release = () => {};
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    internal.writeAtomically = async (filePath, content) => {
      started();
      await gate;
      await writeAtomically(filePath, content);
    };
    const pending = adapter.setSessionRead(
      path,
      id,
      true,
      (await adapter.requireSession(path)).readRevision!,
    );
    await writing;
    turn = { ...turn, commandId: "second", finishedAt: 200 };
    publish();
    assert.equal((await adapter.listSessions())[0]!.unread, true);
    release();
    await pending;
    assert.equal(
      (await new PiWebAdapter(runtime).listSessions())[0]!.unread,
      true,
    );
    assert.equal(
      JSON.parse(
        await readFile(join(directory, "workspace-state.json"), "utf8"),
      ).sessionReadStates[0].lastReadTurn.commandId,
      "first",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid sidebar metadata remains untouched and blocks later sidebar writes", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "openpi-sidebar-invalid-metadata-"),
  );
  const directory = join(root, "sessions");
  try {
    const manager = SessionManager.create(root, directory);
    persistSession(manager, "first", 1);
    const identity = {
      path: manager.getSessionFile()!,
      id: manager.getSessionId(),
    };
    const metadata = join(directory, "workspace-state.json");
    for (const invalid of [
      { sidebarPins: [{ kind: "workspace", path: 10 }] },
      { sessionOrder: [{ id: identity.id }] },
      {
        sessionReadStates: [
          {
            ...identity,
            read: true,
            lastReadTurn: { commandId: "turn", finishedAt: -1 },
          },
        ],
      },
      { importedWorkspaces: [true] },
      { workspaceOrder: [true] },
      { workspaceOrder: ["relative/project"] },
      { workspaceOrder: [root, root] },
      { workspaceOrder: [`${root}/nested/../project`, join(root, "project")] },
      { workspaceOrder: [`${root}/invalid\nproject`] },
      {
        workspaceOrder: Array.from({ length: 5_001 }, (_, index) =>
          join(root, `project-${index}`),
        ),
      },
    ]) {
      const original = JSON.stringify({
        version: 1,
        hiddenWorkspaces: [],
        ungroupedSessions: [],
        workspaceNames: {},
        ...invalid,
      });
      await writeFile(metadata, original);
      const adapter = new PiWebAdapter(runtimeFor(root, directory, manager));
      await assert.rejects(
        adapter.setSessionRead(identity.path, identity.id, false, "observed"),
        /invalid shape/,
      );
      assert.equal(await readFile(metadata, "utf8"), original);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
