import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiWebAdapter } from "../../web/adapter/pi-adapter.ts";
import {
  WEB_MAX_SESSIONS,
  WEB_MAX_SNAPSHOT_BYTES,
} from "../../web/protocol/types.ts";
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
    sendPrompt: async () => {},
    newSession: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    listModels: () => [],
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
    for (let index = 0; index < WEB_MAX_SESSIONS + 3; index++) {
      const manager = SessionManager.create(root, sessionDirectory);
      persistSession(manager, `session-${index}`, index + 3);
    }

    const selectedPath = selected.getSessionFile();
    assert.ok(selectedPath);
    const snapshot = await new PiWebAdapter(
      runtimeFor(root, sessionDirectory, current),
    ).getSnapshot(selectedPath);

    assert.equal(snapshot.sessions.length, WEB_MAX_SESSIONS);
    assert.ok(
      snapshot.sessions.some(
        (session) => session.id === current.getSessionId(),
      ),
    );
    assert.ok(
      snapshot.sessions.some((session) => session.path === selectedPath),
    );
    assert.equal(snapshot.selectedSession?.path, selectedPath);
    assert.equal(
      (
        await new PiWebAdapter(
          runtimeFor(root, sessionDirectory, current),
        ).requireSession(selectedPath)
      ).cwd,
      selectedCwd,
    );
    assert.equal(snapshot.truncation.sessionsOmitted, 5);
    assert.equal(snapshot.truncation.truncated, true);
    assert.ok(snapshot.truncation.bytes <= WEB_MAX_SNAPSHOT_BYTES);
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
