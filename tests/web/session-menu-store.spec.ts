// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import type { WebSnapshot } from "../../web/protocol/types.ts";
import { WebApiError, WebClient } from "../../web/ui/src/protocol/client.ts";
import { createWebStore } from "../../web/ui/src/store/web-store.ts";

const path = "/sessions/source.jsonl";
const id = "source";

function snapshot(sessionId = id, sessionPath = path): WebSnapshot {
  return {
    protocolVersion: 1,
    generatedAt: "2026-10-13T00:00:00Z",
    cursor: 1,
    preferences: { theme: "system" },
    currentSessionId: sessionId,
    currentSessionPath: sessionPath,
    workspaces: [{ path: "/project", name: "Project", current: true }],
    sessions: [
      {
        id: sessionId,
        path: sessionPath,
        cwd: "/project",
        name: sessionId,
        modified: "2026-10-13T00:00:00Z",
        created: "2026-10-13T00:00:00Z",
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
        messageCount: 1,
        firstMessage: "Hello",
      },
    ],
    selectedSession: {
      id: sessionId,
      path: sessionPath,
      cwd: "/project",
      entries: [],
      bytes: 0,
      truncation: {
        maxBytes: 2_000_000,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
        entriesOmitted: 0,
        truncated: false,
      },
    },
    models: [],
    runtime: { status: "idle", capabilities: {} },
    truncation: {
      bytes: 0,
      maxBytes: 4_000_000,
      modelsOmitted: 0,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
      truncated: false,
    },
  };
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

it("shows archive receipts only after native success and keeps each undo target through navigation", async () => {
  const client = new WebClient();
  vi.spyOn(client, "snapshot").mockResolvedValue(snapshot());
  const archive = vi
    .spyOn(client, "archiveSession")
    .mockRejectedValueOnce(new Error("write failed"));
  const store = createWebStore(client);
  store.setState({ snapshot: snapshot() });
  await store.getState().actions.archiveSession(path);
  expect(store.getState().archiveNotices).toEqual([]);
  archive.mockResolvedValue({ path, archived: true });
  await store.getState().actions.archiveSession(path);
  const receipt = store.getState().archiveNotices[0]!;
  expect(receipt).toMatchObject({ path, sessionId: id, title: id });
  store.setState({ selectedPath: "/other.jsonl" });
  await store.getState().actions.archiveSession(path);
  expect(store.getState().archiveNotices).toHaveLength(1);
  expect(store.getState().archiveNotices[0]!.key).not.toBe(receipt.key);
  vi.spyOn(client, "unarchiveSession").mockResolvedValue({
    path,
    archived: false,
  });
  await store.getState().actions.unarchiveSession(path);
  expect(store.getState().archiveNotices).toEqual([]);
});

it("forks a complete conversation without treating the last displayed message as the native branch tip", async () => {
  const client = new WebClient();
  const read = vi.spyOn(client, "snapshot").mockResolvedValue(snapshot());
  const fork = vi
    .spyOn(client, "forkSession")
    .mockImplementation(async (request) => {
      expect(request).toMatchObject({
        scope: "conversation",
        sessionId: id,
        sessionPath: path,
      });
      expect(request).not.toHaveProperty("entryId");
      expect(request).not.toHaveProperty("rerun");
      read.mockResolvedValue(snapshot("child", "/sessions/child.jsonl"));
      return {
        state: "forked",
        commandId: request.commandId,
        source: {
          sessionId: id,
          sessionPath: path,
          entryId: "native-metadata-not-rendered",
        },
        sessionId: "child",
        sessionPath: "/sessions/child.jsonl",
      };
    });
  const prompt = vi.spyOn(client, "prompt");
  const store = createWebStore(client);
  await store.getState().actions.refreshSnapshot();
  expect(await store.getState().actions.forkConversation(path, id)).toBe(true);
  expect(fork).toHaveBeenCalledTimes(1);
  expect(prompt).not.toHaveBeenCalled();
  expect(store.getState().selectedPath).toBe("/sessions/child.jsonl");
  expect(store.getState().sessionForkPending).toBe(false);
});

it("binds activation to the menu's exact identity and never forks a copied replacement", async () => {
  const client = new WebClient();
  vi.spyOn(client, "snapshot").mockResolvedValue(snapshot());
  const select = vi
    .spyOn(client, "selectSession")
    .mockRejectedValue(new WebApiError("changed", 409, "SESSION_CONFLICT"));
  const fork = vi.spyOn(client, "forkSession");
  const store = createWebStore(client);
  await store.getState().actions.refreshSnapshot();
  expect(await store.getState().actions.forkConversation(path, "old-id")).toBe(
    false,
  );
  expect(select).toHaveBeenCalledWith(path, "old-id");
  expect(fork).not.toHaveBeenCalled();
});

it("forks a running conversation into a worktree without cancelling or dispatching a turn", async () => {
  const client = new WebClient();
  const running = snapshot();
  running.runtime.status = "running";
  running.sessions[0]!.execution = { status: "running", pendingFollowUps: 1 };
  const read = vi.spyOn(client, "snapshot").mockResolvedValue(running);
  const fork = vi
    .spyOn(client, "forkSession")
    .mockImplementation(async (request) => {
      expect(request).toMatchObject({
        scope: "conversation",
        environment: "worktree",
        sessionId: id,
        sessionPath: path,
      });
      const child = snapshot(
        "worktree-child",
        "/sessions/worktree-child.jsonl",
      );
      child.selectedSession!.cwd = "/project/.git/pi-worktrees/child";
      child.sessions[0]!.cwd = child.selectedSession!.cwd;
      child.sessions[0]!.workspacePath = "/project";
      read.mockResolvedValue(child);
      return {
        state: "forked",
        commandId: request.commandId,
        source: {
          sessionId: id,
          sessionPath: path,
          entryId: "persisted-prefix",
        },
        sessionId: "worktree-child",
        sessionPath: "/sessions/worktree-child.jsonl",
        sourceStillRunning: true,
      };
    });
  const prompt = vi.spyOn(client, "prompt");
  const cancel = vi.spyOn(client, "cancelActiveTurn");
  const store = createWebStore(client);
  await store.getState().actions.refreshSnapshot();
  store.setState({ collapsed: new Set(["/project", "/other-project"]) });
  expect(
    await store.getState().actions.forkConversation(path, id, "worktree"),
  ).toBe(true);
  expect(fork).toHaveBeenCalledTimes(1);
  expect(cancel).not.toHaveBeenCalled();
  expect(prompt).not.toHaveBeenCalled();
  expect(store.getState().snapshot?.selectedSession?.cwd).toBe(
    "/project/.git/pi-worktrees/child",
  );
  expect([...store.getState().collapsed]).toEqual(["/other-project"]);
  expect(store.getState().sessionForkPending).toBe(false);
});

it("retries the same worktree creation command after delivery loss without changing environment", async () => {
  const client = new WebClient();
  vi.spyOn(client, "snapshot").mockResolvedValue(snapshot());
  const fork = vi
    .spyOn(client, "forkSession")
    .mockRejectedValue(new Error("response lost"));
  const store = createWebStore(client);
  await store.getState().actions.refreshSnapshot();
  expect(
    await store.getState().actions.forkConversation(path, id, "worktree"),
  ).toBe(false);
  expect(
    await store.getState().actions.forkConversation(path, id, "worktree"),
  ).toBe(false);
  expect(fork.mock.calls[1]![0]).toEqual(fork.mock.calls[0]![0]);
  expect(fork.mock.calls[1]![0]).toMatchObject({ environment: "worktree" });
});

it("cancels only the pending fork and waits for its terminal receipt instead of cancelling the source turn", async () => {
  const client = new WebClient();
  vi.spyOn(client, "snapshot").mockResolvedValue(snapshot());
  let finish!: (value: Awaited<ReturnType<WebClient["forkSession"]>>) => void;
  const fork = vi.spyOn(client, "forkSession").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const cancel = vi
    .spyOn(client, "cancelSessionFork")
    .mockResolvedValue({ state: "requested" });
  const cancelTurn = vi.spyOn(client, "cancelActiveTurn");
  const store = createWebStore(client);
  await store.getState().actions.refreshSnapshot();
  const operation = store
    .getState()
    .actions.forkConversation(path, id, "worktree");
  await vi.waitFor(() => expect(fork).toHaveBeenCalledTimes(1));
  const request = fork.mock.calls[0]![0];
  await store.getState().actions.cancelSessionFork();
  await store.getState().actions.cancelSessionFork();
  expect(cancel).toHaveBeenCalledExactlyOnceWith({
    commandId: request.commandId,
    sessionId: id,
    sessionPath: path,
  });
  expect(cancelTurn).not.toHaveBeenCalled();
  expect(store.getState().sessionForkPending).toBe(true);
  expect(store.getState().sessionForkCancellation).toBe("requested");
  expect(store.getState().selectedPath).toBe(path);
  finish({
    state: "cancelled",
    commandId: request.commandId,
    source: { sessionId: id, sessionPath: path, entryId: "frozen" },
  });
  expect(await operation).toBe(false);
  expect(store.getState().sessionForkPending).toBe(false);
  expect(store.getState().sessionForkCancellation).toBeNull();
  expect(store.getState().selectedPath).toBe(path);
});

it("retains the fork command identity after an uncertain delivery", async () => {
  const client = new WebClient();
  vi.spyOn(client, "snapshot").mockResolvedValue(snapshot());
  const fork = vi
    .spyOn(client, "forkSession")
    .mockRejectedValue(new Error("connection lost"));
  const store = createWebStore(client);
  await store.getState().actions.refreshSnapshot();
  expect(await store.getState().actions.forkConversation(path, id)).toBe(false);
  expect(await store.getState().actions.forkConversation(path, id)).toBe(false);
  expect(fork.mock.calls[1]![0]).toEqual(fork.mock.calls[0]![0]);
});

it("reactivates the saved child on a replay without creating another fork", async () => {
  const client = new WebClient();
  const read = vi.spyOn(client, "snapshot").mockResolvedValue(snapshot());
  const child = snapshot("child", "/sessions/child.jsonl");
  const fork = vi
    .spyOn(client, "forkSession")
    .mockImplementation(async (request) => {
      if (fork.mock.calls.length === 1) throw new Error("response lost");
      const inactiveChild = structuredClone(child);
      inactiveChild.currentSessionId = id;
      inactiveChild.currentSessionPath = path;
      inactiveChild.sessions[0]!.controller = "none";
      read.mockResolvedValue(inactiveChild);
      return {
        state: "forked",
        replayed: true,
        commandId: request.commandId,
        source: { sessionId: id, sessionPath: path, entryId: "native-tail" },
        sessionId: "child",
        sessionPath: "/sessions/child.jsonl",
      };
    });
  const select = vi
    .spyOn(client, "selectSession")
    .mockImplementation(async () => {
      read.mockResolvedValue(child);
      return { cancelled: false };
    });
  const store = createWebStore(client);
  await store.getState().actions.refreshSnapshot();
  expect(await store.getState().actions.forkConversation(path, id)).toBe(false);
  expect(await store.getState().actions.forkConversation(path, id)).toBe(true);
  expect(fork.mock.calls[0]).toEqual(fork.mock.calls[1]);
  expect(select).toHaveBeenCalledExactlyOnceWith(
    "/sessions/child.jsonl",
    "child",
  );
});

it("keeps a cancelled or uncertain deletion selected and retries the supplied command", async () => {
  const client = new WebClient();
  vi.spyOn(client, "snapshot").mockResolvedValue(snapshot());
  const remove = vi
    .spyOn(client, "deleteSession")
    .mockResolvedValueOnce({
      state: "cancelled",
      sessionId: id,
      sessionPath: path,
      commandId: "delete-1",
    })
    .mockResolvedValueOnce({
      state: "uncertain",
      sessionId: id,
      sessionPath: path,
      commandId: "delete-1",
    });
  const store = createWebStore(client);
  await store.getState().actions.refreshSnapshot();
  expect(
    await store.getState().actions.deleteSession(path, id, "delete-1"),
  ).toBe(false);
  expect(store.getState().selectedPath).toBe(path);
  expect(
    await store.getState().actions.deleteSession(path, id, "delete-1"),
  ).toBe(false);
  expect(store.getState().workspaceDraft).toBe(false);
  expect(remove.mock.calls[0]).toEqual(remove.mock.calls[1]);
});

it("clears the deleted reader and reports committed deletion even if metadata cleanup needs attention", async () => {
  const client = new WebClient();
  const read = vi.spyOn(client, "snapshot").mockResolvedValue(snapshot());
  vi.spyOn(client, "deleteSession").mockImplementation(async (request) => {
    const next = snapshot("empty", "/sessions/empty.jsonl");
    read.mockResolvedValue(next);
    return {
      ...request,
      state: "deleted",
      activeSessionChanged: true,
      metadataCleanupPending: true,
    };
  });
  const store = createWebStore(client);
  await store.getState().actions.refreshSnapshot();
  expect(
    await store.getState().actions.deleteSession(path, id, "delete-2"),
  ).toBe(true);
  expect(store.getState().selectedPath).not.toBe(path);
  expect(store.getState().workspaceDraft).toBe(true);
  expect(store.getState().notice).toContain("deleted");
});

it("does not clear another conversation when a deletion completes after navigation", async () => {
  const client = new WebClient();
  const read = vi.spyOn(client, "snapshot").mockResolvedValue(snapshot());
  let finish!: () => void;
  vi.spyOn(client, "deleteSession").mockImplementation(async (request) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { ...request, state: "deleted" };
  });
  vi.spyOn(client, "selectSession").mockResolvedValue({ cancelled: false });
  const store = createWebStore(client);
  await store.getState().actions.refreshSnapshot();
  const removing = store.getState().actions.deleteSession(path, id, "delete-3");
  read.mockResolvedValue(snapshot("other", "/sessions/other.jsonl"));
  await store.getState().actions.selectSession("/sessions/other.jsonl");
  finish();
  expect(await removing).toBe(true);
  expect(store.getState().selectedPath).toBe("/sessions/other.jsonl");
  expect(store.getState().workspaceDraft).toBe(false);
});

it("rejects a mismatched delete receipt and prevents duplicate in-flight calls", async () => {
  const client = new WebClient();
  vi.spyOn(client, "snapshot").mockResolvedValue(snapshot());
  let finish!: () => void;
  const remove = vi
    .spyOn(client, "deleteSession")
    .mockImplementation(async (request) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { ...request, sessionId: "wrong", state: "deleted" };
    });
  const store = createWebStore(client);
  await store.getState().actions.refreshSnapshot();
  const pending = store.getState().actions.deleteSession(path, id, "delete-4");
  expect(
    await store.getState().actions.deleteSession(path, id, "delete-4"),
  ).toBe(false);
  finish();
  expect(await pending).toBe(false);
  expect(remove).toHaveBeenCalledTimes(1);
  expect(store.getState().selectedPath).toBe(path);
});

it("opens a local conversation link as an exact read without changing the controller", async () => {
  window.history.replaceState(
    null,
    "",
    `/?${new URLSearchParams({ sessionPath: path, sessionId: id })}`,
  );
  const client = new WebClient();
  const read = vi.spyOn(client, "snapshot").mockResolvedValue(snapshot());
  const select = vi.spyOn(client, "selectSession");
  const store = createWebStore(client);
  expect(await store.getState().actions.refreshSnapshot()).toBe(true);
  expect(read).toHaveBeenCalledWith(path, undefined, id);
  expect(select).not.toHaveBeenCalled();
  expect(store.getState().selectedPath).toBe(path);
});

it("recovers an expired link to a blank draft instead of presenting another conversation as the linked one", async () => {
  window.history.replaceState(
    null,
    "",
    `/?${new URLSearchParams({ sessionPath: path, sessionId: "old" })}`,
  );
  const client = new WebClient();
  vi.spyOn(client, "snapshot")
    .mockRejectedValueOnce(new WebApiError("missing", 409, "SESSION_CONFLICT"))
    .mockResolvedValue(snapshot());
  const store = createWebStore(client);
  expect(await store.getState().actions.refreshSnapshot()).toBe(true);
  expect(store.getState().workspaceDraft).toBe(true);
  expect(store.getState().notice).toContain("linked");
});

it.each([true, false])(
  "settles each pending same-path caller against its own native identity and controlled state: %s",
  async (controlled) => {
    const client = new WebClient();
    const replacement = snapshot("replacement");
    if (!controlled) replacement.currentSessionId = "different-controller";
    vi.spyOn(client, "snapshot").mockResolvedValue(replacement);
    let finish!: (value: { cancelled: boolean }) => void;
    const select = vi.spyOn(client, "selectSession").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const store = createWebStore(client);
    store.setState({
      snapshot: snapshot("else", "/sessions/else.jsonl"),
      selectedPath: "/sessions/else.jsonl",
      workspaceDraft: false,
    });
    const correct = store.getState().actions.selectSession(path, "replacement");
    await vi.waitFor(() => expect(select).toHaveBeenCalledTimes(1));
    const same = store.getState().actions.selectSession(path, "replacement");
    const stale = store
      .getState()
      .actions.selectSession(path, "stale-native-id");
    finish({ cancelled: false });
    expect(await Promise.all([correct, same, stale])).toEqual([
      controlled,
      controlled,
      false,
    ]);
    expect(select).toHaveBeenCalledExactlyOnceWith(path, "replacement");
  },
);

it.each([
  "/sessions/合法 #?.jsonl",
  "C:/Sessions/合法 #?.jsonl",
  String.raw`C:\Sessions\合法 #?.jsonl`,
  String.raw`\\server\share\Sessions\合法 #?.jsonl`,
  "//server/share/Sessions/合法 #?.jsonl",
])(
  "admits an exact platform-independent absolute session link without rewriting %s",
  async (sessionPath) => {
    window.history.replaceState(
      null,
      "",
      `/?${new URLSearchParams({ sessionPath, sessionId: id })}`,
    );
    const client = new WebClient();
    const read = vi
      .spyOn(client, "snapshot")
      .mockResolvedValue(snapshot(id, sessionPath));
    const select = vi.spyOn(client, "selectSession");
    const store = createWebStore(client);
    expect(await store.getState().actions.refreshSnapshot()).toBe(true);
    expect(read).toHaveBeenCalledWith(sessionPath, undefined, id);
    expect(store.getState().selectedPath).toBe(sessionPath);
    expect(store.getState().workspaceDraft).toBe(false);
    expect(select).not.toHaveBeenCalled();
  },
);

it.each([
  "sessions/relative.jsonl",
  "C:relative.jsonl",
  String.raw`\root-relative.jsonl`,
  String.raw`\\server`,
  "//server",
  "https://example.invalid/session.jsonl",
  "/sessions/bad\n.jsonl",
])(
  "rejects a relative, ambiguous or control-bearing session link %s",
  (sessionPath) => {
    window.history.replaceState(
      null,
      "",
      `/?${new URLSearchParams({ sessionPath, sessionId: id })}`,
    );
    const store = createWebStore();
    expect(store.getState().selectedPath).toBeNull();
    expect(store.getState().workspaceDraft).toBe(true);
    expect(store.getState().notice).toContain("linked");
  },
);

it.each([
  `sessionPath=${encodeURIComponent(path)}&sessionPath=${encodeURIComponent(path)}&sessionId=${id}`,
  `sessionPath=${encodeURIComponent(path)}&sessionId=${id}&sessionId=${id}`,
  new URLSearchParams({
    sessionPath: "/" + "a".repeat(4096),
    sessionId: id,
  }).toString(),
  new URLSearchParams({
    sessionPath: path,
    sessionId: "a".repeat(129),
  }).toString(),
  new URLSearchParams({
    sessionPath: path,
    sessionId: "bad\nidentity",
  }).toString(),
  new URLSearchParams({
    sessionPath: String.raw`\\?\C:\Sessions\child.jsonl`,
    sessionId: id,
  }).toString(),
])("keeps bounds, control and duplicate admission fail closed: %s", (query) => {
  window.history.replaceState(null, "", `/?${query}`);
  const store = createWebStore();
  expect(store.getState().selectedPath).toBeNull();
  expect(store.getState().workspaceDraft).toBe(true);
  expect(store.getState().notice).toContain("linked");
});
