// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WebCommandDiscoveryResult,
  WebEvent,
  WebModelSearchResult,
  WebModelSummary,
  WebSnapshot,
  WebThinkingState,
} from "../../web/protocol/types.ts";
import {
  type CommandReceipt,
  type SessionCreationResult,
  type SessionMutationResult,
  WebApiError,
  WebClient,
  type WorkspaceSelectionResult,
} from "../../web/ui/src/protocol/client.ts";
import {
  consumeEventStream,
  EventResyncRequired,
  type EventStreamOptions,
} from "../../web/ui/src/protocol/event-stream.ts";
import { createWebStore } from "../../web/ui/src/store/web-store.ts";

const snapshotTruncation = {
  bytes: 0,
  maxBytes: 4 * 1024 * 1024,
  modelsOmitted: 0,
  sessionsOmitted: 0,
  workspacesOmitted: 0,
  truncated: false,
};

const transcriptTruncation = {
  maxBytes: 2 * 1024 * 1024,
  messagesTruncated: 0,
  messagePartsOmitted: 0,
  entriesOmitted: 0,
  truncated: false,
};

function snapshot(name = "Current"): WebSnapshot {
  return {
    protocolVersion: 1,
    preferences: { theme: "system" },
    generatedAt: "2026-09-03T00:00:00Z",
    cursor: 4,
    currentSessionId: "session-1",
    workspaces: [{ path: "/tmp/ws", name: "Workspace", current: true }],
    sessions: [
      {
        id: "session-1",
        path: "/tmp/ws/session.jsonl",
        cwd: "/tmp/ws",
        name,
        modified: "2026-09-03T00:00:00Z",
        created: "2026-09-03T00:00:00Z",
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
        messageCount: 1,
        firstMessage: "Hello",
      },
    ],
    selectedSession: {
      id: "session-1",
      path: "/tmp/ws/session.jsonl",
      cwd: "/tmp/ws",
      entries: [],
      bytes: 2,
      truncation: transcriptTruncation,
    },
    models: [
      {
        provider: "test",
        id: "model",
        name: "model",
        label: "Test model",
        current: true,
      },
    ],
    runtime: { status: "idle", capabilities: {} },
    truncation: snapshotTruncation,
  };
}

function activeSnapshot(
  id: string,
  path: string,
  options: { cursor?: number; name?: string; workspace?: string } = {},
) {
  const workspace = options.workspace ?? "/tmp/ws";
  const next = snapshot(options.name ?? id);
  next.cursor = options.cursor ?? next.cursor;
  next.currentSessionId = id;
  next.workspaces = [{ path: workspace, name: "Workspace", current: true }];
  next.sessions = [
    {
      id,
      path,
      cwd: workspace,
      name: options.name ?? id,
      modified: "2026-09-03T00:00:00Z",
      created: "2026-09-03T00:00:00Z",
      source: "web-session",
      origin: "web",
      controller: "web",
      readOnly: false,
      messageCount: 1,
      firstMessage: "Hello",
    },
  ];
  next.selectedSession = {
    id,
    path,
    cwd: workspace,
    entries: [],
    bytes: 2,
    truncation: transcriptTruncation,
  };
  return next;
}

function unboundSnapshot(workspaces: WebSnapshot["workspaces"] = []) {
  const next = snapshot();
  delete next.currentSessionId;
  delete next.selectedSession;
  next.workspaces = workspaces;
  next.sessions = [];
  return next;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

it("Plan changes wait for canonical confirmation, prevent duplicate clicks and do not submit a prompt", async () => {
  const client = new FakeClient();
  const before = snapshot();
  before.runtime.plan = "inactive";
  before.runtime.planRevision = null;
  client.snapshots.push(Promise.resolve(before));
  const request = deferred<{ sessionId: string }>();
  const change = vi
    .spyOn(client, "setPlanMode")
    .mockReturnValue(request.promise);
  const prompt = vi.spyOn(client, "prompt");
  const store = createWebStore(client);
  await store.getState().actions.refreshSnapshot();
  const pending = store.getState().actions.selectPlanMode(true);
  expect(store.getState().snapshot?.runtime.plan).toBe("inactive");
  expect(store.getState().planSelectionPending).toBe(true);
  await store.getState().actions.selectPlanMode(true);
  expect(await store.getState().actions.sendPrompt("wait")).toBe(false);
  expect(change).toHaveBeenCalledExactlyOnceWith(
    "session-1",
    "/tmp/ws/session.jsonl",
    true,
    null,
  );
  const after = snapshot();
  after.cursor++;
  after.runtime.plan = "planning";
  after.runtime.planRevision = "plan-1";
  client.snapshots.push(Promise.resolve(after));
  request.resolve({ sessionId: "session-1" });
  await pending;
  expect(store.getState().snapshot?.runtime.plan).toBe("planning");
  expect(store.getState().planSelectionPending).toBe(false);
  expect(store.getState().liveMessages).toEqual([]);
  expect(prompt).not.toHaveBeenCalled();
});

it("does not change Plan mode from a copied Session observer", async () => {
  const client = new FakeClient();
  const change = vi.spyOn(client, "setPlanMode");
  const current = snapshot();
  current.currentSessionPath = current.selectedSession!.path;
  current.runtime.planRevision = null;
  current.selectedSession!.path = "/tmp/ws/copied-session.jsonl";
  current.sessions.push({
    ...current.sessions[0]!,
    path: current.selectedSession!.path,
    controller: "none",
  });
  const store = createWebStore(client);
  store.setState({
    snapshot: current,
    selectedPath: current.selectedSession!.path,
    workspaceDraft: false,
  });
  await store.getState().actions.selectPlanMode(true);
  expect(change).not.toHaveBeenCalled();
  expect(store.getState().planSelectionPending).toBe(false);
});

it("keeps a newer Plan write pending when an older receipt arrives after retaking the same view", async () => {
  const client = new FakeClient();
  const initial = snapshot();
  initial.currentSessionPath = initial.selectedSession!.path;
  initial.runtime.plan = "inactive";
  initial.runtime.planRevision = null;
  client.snapshots.push(Promise.resolve(initial));
  const first = deferred<{ sessionId: string }>();
  const second = deferred<{ sessionId: string }>();
  const change = vi
    .spyOn(client, "setPlanMode")
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const store = createWebStore(client);
  await store.getState().actions.refreshSnapshot();
  const oldWrite = store.getState().actions.selectPlanMode(true);
  const observer = structuredClone(initial);
  observer.currentSessionId = "other";
  observer.currentSessionPath = "/tmp/ws/other.jsonl";
  observer.sessions[0]!.controller = "none";
  observer.sessions.push({
    ...initial.sessions[0]!,
    id: "other",
    path: observer.currentSessionPath,
  });
  client.snapshots.push(Promise.resolve(observer));
  await store.getState().actions.refreshSnapshot();
  expect(store.getState().planSelectionPending).toBe(false);
  const activated = structuredClone(initial);
  activated.runtime.plan = "planning";
  activated.runtime.planRevision = "first-plan";
  client.snapshots.push(Promise.resolve(activated));
  await store.getState().actions.selectSession(initial.selectedSession!.path);
  const newWrite = store.getState().actions.selectPlanMode(false);
  expect(change).toHaveBeenCalledTimes(2);
  expect(store.getState().planSelectionPending).toBe(true);
  first.resolve({ sessionId: "session-1" });
  await oldWrite;
  expect(store.getState().planSelectionPending).toBe(true);
  const confirmed = structuredClone(initial);
  confirmed.runtime.planRevision = "second-plan";
  client.snapshots.push(Promise.resolve(confirmed));
  second.resolve({ sessionId: "session-1" });
  await newWrite;
  expect(store.getState().planSelectionPending).toBe(false);
  expect(store.getState().snapshot?.runtime.plan).toBe("inactive");
});

class FakeClient extends WebClient {
  snapshots: Array<Promise<WebSnapshot>> = [];
  snapshotPaths: Array<string | null | undefined> = [];
  workspaceResult: Promise<WorkspaceSelectionResult> = Promise.resolve({
    cancelled: true,
  });
  creationResult:
    | ((commandId: string) => Promise<SessionCreationResult>)
    | null = null;
  selectionResults: Array<Promise<SessionMutationResult>> = [];
  modelResult: Promise<WebModelSummary> = Promise.resolve({
    provider: "test",
    id: "model",
    label: "Test model",
    name: "model",
    current: true,
  });
  modelSearchResults: Array<Promise<WebModelSearchResult>> = [];
  modelSearchQueries: Array<{
    query: string;
    sessionId?: string;
  }> = [];
  promptResult: Promise<CommandReceipt> = Promise.resolve({
    id: "prompt-1",
    accepted: true,
  });
  thinkingResult: Promise<WebThinkingState & { sessionId: string }> =
    Promise.resolve({
      sessionId: "session-1",
      level: "medium",
      available: ["off", "minimal", "low", "medium", "high"],
      supported: true,
      revision: 1,
    });
  setThinkingResults: Array<Promise<WebThinkingState & { sessionId: string }>> =
    [];
  commandResults: Array<Promise<WebCommandDiscoveryResult>> = [];
  commandRequests: Array<{ sessionId: string; signal?: AbortSignal }> = [];
  creations: Array<{ commandId: string; workspacePath: string }> = [];
  selections: string[] = [];
  modelSelections: Array<{
    provider: string;
    modelId: string;
    sessionId: string;
  }> = [];
  prompts: Array<{ sessionId: string; content: string }> = [];
  thinkingRequests: string[] = [];
  thinkings: Array<{ sessionId: string; level: string }> = [];

  override snapshot(path?: string | null) {
    this.snapshotPaths.push(path);
    const next = this.snapshots.shift();
    if (!next) throw new Error("No fake snapshot queued");
    return next;
  }

  override chooseWorkspace() {
    return this.workspaceResult;
  }

  override createSession(workspacePath: string, commandId: string) {
    this.creations.push({ commandId, workspacePath });
    return (
      this.creationResult?.(commandId) ??
      Promise.resolve({
        cancelled: false,
        commandId,
        sessionId: "session-1",
      })
    );
  }

  override selectSession(path: string) {
    this.selections.push(path);
    return this.selectionResults.shift() ?? Promise.resolve({});
  }

  override selectModel(
    provider: string,
    modelId: string,
    sessionId: string,
    _sessionPath: string,
  ) {
    this.modelSelections.push({ provider, modelId, sessionId });
    return this.modelResult;
  }

  override searchModels(
    query: string,
    sessionId?: string,
    _signal?: AbortSignal,
  ) {
    this.modelSearchQueries.push({ query, sessionId });
    return (
      this.modelSearchResults.shift() ??
      Promise.resolve({
        models: [],
        totalAvailable: 0,
        totalMatches: 0,
        truncation: {
          truncated: false,
          matchesOmitted: 0,
          maxResults: 50,
          maxBytes: 64 * 1024,
          bytes: 0,
        },
      })
    );
  }

  override prompt(
    sessionId: string,
    content: string,
    _commandId: string,
    _sessionPath: string,
    _retry = false,
  ) {
    this.prompts.push({ sessionId, content });
    return this.promptResult;
  }

  override thinking(sessionId: string, _signal: AbortSignal) {
    this.thinkingRequests.push(sessionId);
    return this.thinkingResult;
  }

  override setThinkingLevel(
    sessionId: string,
    level: string,
    _sessionPath: string,
  ) {
    this.thinkings.push({ sessionId, level });
    const queued = this.setThinkingResults.shift();
    if (queued) return queued;
    return Promise.resolve({
      sessionId,
      level,
      available: ["off", "minimal", "low", "medium", "high"],
      supported: true,
      revision: 1_000 + this.thinkings.length,
    });
  }
  override commands(sessionId: string, signal?: AbortSignal) {
    this.commandRequests.push({ sessionId, signal });
    const next = this.commandResults.shift();
    if (!next) throw new Error("No fake command discovery queued");
    return next;
  }
}

function commandDiscovery(name = "review"): WebCommandDiscoveryResult {
  return {
    commands: [
      {
        name,
        source: "prompt",
        availability: "available",
        argumentHint: "[arguments]",
      },
    ],
    totalAvailable: 1,
    truncation: {
      truncated: false,
      commandsOmitted: 0,
      maxCommands: 250,
      maxBytes: 64 * 1024,
      bytes: 200,
    },
  };
}

function runtimeEvent(
  sequence: number,
  type: string,
  detail?: Record<string, unknown>,
): WebEvent {
  return {
    protocolVersion: 1,
    sequence,
    type,
    timestamp: "2026-09-03T00:00:00Z",
    ...(detail ? { detail } : {}),
  };
}

function eventStreamHarness() {
  let active: EventStreamOptions | null = null;
  const consumeEvents = vi.fn((options: EventStreamOptions) => {
    active = options;
    options.onConnected();
    return new Promise<void>((resolve) => {
      if (options.signal.aborted) {
        resolve();
        return;
      }
      options.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  return {
    consumeEvents,
    emit(event: WebEvent) {
      if (!active) throw new Error("Event stream is not connected");
      active.onEvent(event);
    },
  };
}

afterEach(() => {
  window.sessionStorage.clear();
  window.localStorage?.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sidebar Session navigation", () => {
  it("keeps a successful restore receipt when selection changes during its canonical refresh", async () => {
    const client = new FakeClient();
    const current = snapshot();
    const target = activeSnapshot("B", "/tmp/ws/b.jsonl");
    const refresh = deferred<WebSnapshot>();
    client.snapshots.push(refresh.promise, Promise.resolve(target));
    vi.spyOn(client, "unarchiveSession").mockResolvedValue({
      path: "/tmp/ws/archived.jsonl",
      archived: false,
    });
    const store = createWebStore(client);
    store.setState({
      snapshot: current,
      selectedPath: current.selectedSession!.path,
    });
    const restoring = store
      .getState()
      .actions.unarchiveSession("/tmp/ws/archived.jsonl");
    await vi.waitFor(() =>
      expect(client.snapshotPaths).toEqual([current.selectedSession!.path]),
    );
    await store.getState().actions.selectSession(target.selectedSession!.path);
    refresh.resolve(current);
    expect(await restoring).toBe(true);
    expect(store.getState().selectedPath).toBe(target.selectedSession!.path);
    expect(store.getState().snapshot).toBe(target);
    expect(store.getState().notice).toBeNull();
  });

  it("does not reset live state or issue a selection for the confirmed current file", async () => {
    const client = new FakeClient();
    const current = snapshot();
    current.currentSessionPath = current.selectedSession!.path;
    client.snapshots.push(Promise.resolve(current));
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    store.setState({
      liveMessages: [
        {
          key: "stream",
          message: { role: "assistant", content: "Partial reply" },
        },
      ],
      activeTurn: {
        sessionId: "session-1",
        sessionPath: current.currentSessionPath,
        commandId: "active",
        epoch: 1,
      },
      liveRunning: true,
      livePhase: "running",
      planSelectionPending: true,
      modelSelectionPending: true,
      turnCancellationPending: true,
      mobileSidebarOpen: true,
    });
    const before = store.getState();
    await store.getState().actions.selectSession(current.selectedSession!.path);
    expect(client.selections).toEqual([]);
    expect(client.snapshotPaths).toHaveLength(1);
    expect(store.getState().liveMessages).toBe(before.liveMessages);
    expect(store.getState().activeTurn).toBe(before.activeTurn);
    expect(store.getState()).toMatchObject({
      liveRunning: true,
      livePhase: "running",
      planSelectionPending: true,
      modelSelectionPending: true,
      turnCancellationPending: true,
      sessionSwitching: false,
      mobileSidebarOpen: false,
    });
  });

  it("deduplicates an in-flight selection of the same target", async () => {
    const client = new FakeClient();
    const target = activeSnapshot("B", "/tmp/ws/b.jsonl");
    client.snapshots.push(Promise.resolve(snapshot()), Promise.resolve(target));
    const receipt = deferred<SessionMutationResult>();
    client.selectionResults.push(receipt.promise);
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    const first = store
      .getState()
      .actions.selectSession(target.selectedSession!.path);
    await vi.waitFor(() => expect(client.selections).toHaveLength(1));
    const second = store
      .getState()
      .actions.selectSession(target.selectedSession!.path);
    expect(store.getState().sessionSwitching).toBe(true);
    receipt.resolve({});
    await Promise.all([first, second]);
    expect(client.selections).toEqual([target.selectedSession!.path]);
    expect(client.snapshotPaths).toHaveLength(2);
    expect(store.getState().selectedPath).toBe(target.selectedSession!.path);
    expect(store.getState().sessionSwitching).toBe(false);
  });

  it.each([false, true])(
    "still activates the same viewed observer path (copied id: %s)",
    async (copiedId) => {
      const client = new FakeClient();
      const controller = activeSnapshot(
        "controller",
        "/tmp/ws/controller.jsonl",
      );
      const viewed = activeSnapshot(
        copiedId ? "controller" : "reader",
        "/tmp/ws/reader.jsonl",
      );
      const background = {
        ...controller,
        currentSessionPath: controller.selectedSession!.path,
        selectedSession: viewed.selectedSession,
        sessions: [
          ...controller.sessions,
          { ...viewed.sessions[0]!, controller: "none" as const },
        ],
      };
      client.snapshots.push(
        Promise.resolve(background),
        Promise.resolve(viewed),
      );
      const store = createWebStore(client);
      store.setState({ selectedPath: viewed.selectedSession!.path });
      await store.getState().actions.refreshSnapshot();
      await store
        .getState()
        .actions.selectSession(viewed.selectedSession!.path);
      expect(client.selections).toEqual([viewed.selectedSession!.path]);
      expect(store.getState().snapshot?.currentSessionId).toBe(
        viewed.currentSessionId,
      );
    },
  );

  it.each([false, true])(
    "keeps a valid reader when removing a workspace (reader workspace: %s)",
    async (readerWorkspace) => {
      const client = new FakeClient();
      const controller = activeSnapshot("controller", "/tmp/control/c.jsonl", {
        workspace: "/tmp/control",
      });
      const reader = activeSnapshot("reader", "/tmp/read/r.jsonl", {
        workspace: "/tmp/read",
      });
      const removed = readerWorkspace ? "/tmp/read" : "/tmp/unrelated";
      const background = {
        ...controller,
        currentSessionPath: controller.selectedSession!.path,
        selectedSession: reader.selectedSession,
        sessions: [
          ...controller.sessions,
          { ...reader.sessions[0]!, controller: "none" as const },
        ],
        workspaces: [
          ...controller.workspaces,
          ...reader.workspaces,
          { path: "/tmp/unrelated", name: "Unrelated", current: false },
        ],
      };
      vi.spyOn(client, "removeWorkspace").mockResolvedValue({
        path: removed,
        removed: true,
      });
      client.snapshots.push(
        Promise.resolve({
          ...background,
          workspaces: background.workspaces.filter(
            (item) => item.path !== removed,
          ),
          sessions: background.sessions.map((item) =>
            item.cwd === removed ? { ...item, ungrouped: true } : item,
          ),
        }),
      );
      const store = createWebStore(client);
      store.setState({
        snapshot: background,
        selectedPath: reader.selectedSession!.path,
        selectedWorkspace: "/tmp/read",
      });
      await store.getState().actions.removeWorkspace(removed);
      expect(client.snapshotPaths).toEqual([reader.selectedSession!.path]);
      expect(store.getState().selectedPath).toBe(reader.selectedSession!.path);
    },
  );

  it("does not overwrite a newer selection when workspace removal settles late", async () => {
    const client = new FakeClient();
    const target = activeSnapshot("B", "/tmp/ws/b.jsonl");
    const removal = deferred<{ path: string; removed: true }>();
    vi.spyOn(client, "removeWorkspace").mockReturnValue(removal.promise);
    const store = createWebStore(client);
    store.setState({
      snapshot: snapshot(),
      selectedPath: snapshot().selectedSession!.path,
      selectedWorkspace: "/tmp/ws",
    });
    const removing = store.getState().actions.removeWorkspace("/tmp/unrelated");
    client.snapshots.push(Promise.resolve(target), Promise.resolve(target));
    await store.getState().actions.selectSession(target.selectedSession!.path);
    removal.resolve({ path: "/tmp/unrelated", removed: true });
    await removing;
    expect(client.snapshotPaths).toEqual([
      target.selectedSession!.path,
      target.selectedSession!.path,
    ]);
    expect(store.getState().selectedPath).toBe(target.selectedSession!.path);
  });

  it.each([false, true])(
    "keeps the exact controlled Session sendable after hiding its workspace (other workspace: %s)",
    async (hasOtherWorkspace) => {
      const client = new FakeClient();
      const before = snapshot();
      const after = {
        ...before,
        workspaces: hasOtherWorkspace
          ? [{ path: "/tmp/other", name: "Other", current: true }]
          : [],
        sessions: before.sessions.map((session) => ({
          ...session,
          ungrouped: true,
        })),
      };
      client.snapshots.push(Promise.resolve(before), Promise.resolve(after));
      vi.spyOn(client, "removeWorkspace").mockResolvedValue({
        path: "/tmp/ws",
        removed: true,
      });
      const prompt = vi.spyOn(client, "prompt");
      const store = createWebStore(client);
      await store.getState().actions.refreshSnapshot();

      await store.getState().actions.removeWorkspace("/tmp/ws");

      expect(store.getState().selectedWorkspace).toBe("/tmp/ws");
      expect(store.getState().selectedPath).toBe("/tmp/ws/session.jsonl");
      expect(store.getState().workspaceDraft).toBe(false);
      expect(await store.getState().actions.sendPrompt("continue here")).toBe(
        true,
      );
      expect(prompt).toHaveBeenCalledExactlyOnceWith(
        "session-1",
        "continue here",
        expect.any(String),
        "/tmp/ws/session.jsonl",
        false,
        [],
      );
      expect(client.creations).toEqual([]);
      expect(client.selections).toEqual([]);
      store.getState().actions.stop();
    },
  );
});

describe("native prompt resolution provenance", () => {
  it.each(["workspace", "create", "select", "foreign"] as const)(
    "does not treat %s navigation as acceptance and preserves prior native evidence",
    async (navigation) => {
      const client = new FakeClient();
      const initial = snapshot();
      const target = activeSnapshot("B", "/tmp/ws/b.jsonl");
      initial.sessions.push({ ...target.sessions[0]!, controller: "none" });
      client.snapshots.push(Promise.resolve(target));
      client.creationResult = async (commandId) => ({
        cancelled: false,
        commandId,
        sessionId: "B",
        sessionPath: target.selectedSession!.path,
      });
      const stream = eventStreamHarness();
      const store = createWebStore(client, {
        consumeEvents: stream.consumeEvents,
      });
      const images = [
        { data: "AA==", mimeType: "image/png" as const, name: "draft.png" },
      ];
      const evidence = {
        sessionId: "session-1",
        sessionPath: initial.selectedSession!.path,
        commandId: "previous-native",
        content: "Accepted earlier",
        images,
      };
      store.setState({
        snapshot: initial,
        selectedPath:
          navigation === "foreign" ? null : initial.selectedSession!.path,
        selectedWorkspace: "/tmp/ws",
        cursor: 4,
        promptAdmissionResolution: evidence,
        promptAdmissionRecovery: {
          sessionId: "session-1",
          sessionPath: initial.selectedSession!.path,
          commandId: "unknown",
          content: "Still uncertain",
          optimisticKey: "optimistic-unknown",
          images,
          phase: "verification-failed",
        },
      });
      try {
        if (navigation === "workspace")
          store.getState().actions.setWorkspace("/tmp/new");
        if (navigation === "create")
          await store.getState().actions.createSession("/tmp/ws");
        if (navigation === "select")
          await store
            .getState()
            .actions.selectSession(target.selectedSession!.path);
        if (navigation === "foreign") {
          store.getState().actions.start();
          await vi.waitFor(() =>
            expect(stream.consumeEvents).toHaveBeenCalledOnce(),
          );
          stream.emit(
            runtimeEvent(5, "session_switched", {
              sessionId: "B",
              sessionPath: target.selectedSession!.path,
            }),
          );
          await vi.waitFor(() =>
            expect(store.getState().sessionSwitching).toBe(false),
          );
        }
        expect(store.getState().promptAdmissionRecovery).toBeNull();
        expect(store.getState().promptAdmissionResolution).toBe(evidence);
        expect(store.getState().promptAdmissionResolution?.images).toBe(images);
      } finally {
        store.getState().actions.stop();
      }
    },
  );

  it("projects exact identity and the original images only after matching native evidence", async () => {
    const stream = eventStreamHarness();
    const store = createWebStore(new FakeClient(), {
      consumeEvents: stream.consumeEvents,
    });
    const initial = snapshot();
    const images = [{ data: "AA==", mimeType: "image/png" as const }];
    const recovery = {
      sessionId: "session-1",
      sessionPath: initial.selectedSession!.path,
      commandId: "unknown",
      content: "Original draft",
      optimisticKey: "optimistic-unknown",
      images,
      phase: "verification-failed" as const,
    };
    store.setState({
      snapshot: initial,
      selectedPath: initial.selectedSession!.path,
      cursor: 4,
      promptAdmissionRecovery: recovery,
    });
    store.getState().actions.start();
    try {
      await vi.waitFor(() =>
        expect(stream.consumeEvents).toHaveBeenCalledOnce(),
      );
      stream.emit(
        runtimeEvent(5, "prompt_accepted", {
          sessionId: recovery.sessionId,
          sessionPath: "/tmp/copied.jsonl",
          commandId: recovery.commandId,
        }),
      );
      expect(store.getState().promptAdmissionResolution).toBeNull();
      stream.emit(
        runtimeEvent(6, "prompt_accepted", {
          sessionId: recovery.sessionId,
          sessionPath: recovery.sessionPath,
          commandId: recovery.commandId,
        }),
      );
      expect(store.getState().promptAdmissionResolution).toEqual({
        sessionId: recovery.sessionId,
        sessionPath: recovery.sessionPath,
        commandId: recovery.commandId,
        content: recovery.content,
        images,
      });
      expect(store.getState().promptAdmissionResolution?.images).toBe(images);
    } finally {
      store.getState().actions.stop();
    }
  });
});

describe("OpenPI Web store", () => {
  it("retains a valid requested background view without moving the input controller", async () => {
    const client = new FakeClient();
    const current = activeSnapshot("controller", "/tmp/ws/controller.jsonl");
    const viewed = activeSnapshot("viewed", "/tmp/ws/viewed.jsonl");
    const background = {
      ...current,
      sessions: [
        ...current.sessions,
        { ...viewed.sessions[0]!, controller: "none" as const },
      ],
      selectedSession: viewed.selectedSession,
      selectedExecution: {
        sessionId: "viewed",
        sessionPath: "/tmp/ws/viewed.jsonl",
        status: "running" as const,
        pendingFollowUps: 2,
        liveTools: [],
        liveToolsOmitted: 0,
      },
    };
    client.snapshots.push(
      Promise.resolve(background),
      Promise.resolve(current),
    );
    const store = createWebStore(client);
    store.setState({
      snapshot: viewed,
      selectedPath: "/tmp/ws/viewed.jsonl",
      liveMessages: [
        {
          key: "optimistic-read-view",
          message: { role: "user", content: "Queued in viewed Session" },
          optimistic: {
            sessionId: "viewed",
            sessionPath: "/tmp/ws/viewed.jsonl",
            commandId: "read-view",
            afterEntryId: null,
            admitted: true,
          },
        },
        {
          key: "old-controller-live",
          message: { role: "assistant", content: "Old live fragment" },
        },
      ],
    });
    expect(await store.getState().actions.refreshSnapshot()).toBe(true);
    expect(client.snapshotPaths).toEqual(["/tmp/ws/viewed.jsonl"]);
    expect(store.getState().selectedPath).toBe("/tmp/ws/viewed.jsonl");
    expect(store.getState().snapshot?.currentSessionId).toBe("controller");
    expect(store.getState().snapshot?.selectedExecution?.pendingFollowUps).toBe(
      2,
    );
    expect(store.getState().liveMessages.map((entry) => entry.key)).toEqual([
      "optimistic-read-view",
    ]);
    expect(
      await store.getState().actions.sendPrompt("must stay read only"),
    ).toBe(false);
    expect(client.prompts).toEqual([]);
    store.getState().actions.stop();
  });

  it("keeps both scoped pending submissions when one same-text native message arrives", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const stream = eventStreamHarness();
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    store.getState().actions.start();
    try {
      await vi.waitFor(() =>
        expect(stream.consumeEvents).toHaveBeenCalledOnce(),
      );
      await store.getState().actions.sendPrompt("继续");
      await store.getState().actions.sendPrompt("继续");
      stream.emit(
        runtimeEvent(10, "message_start", {
          sessionId: "session-1",
          messageKey: "native-user",
          message: { role: "user", content: "继续" },
        }),
      );
      const pending = store
        .getState()
        .liveMessages.filter((entry) => entry.optimistic);
      expect(pending).toHaveLength(2);
      expect(pending[0]?.optimistic).toMatchObject({
        sessionId: "session-1",
        sessionPath: "/tmp/ws/session.jsonl",
      });
      for (let index = 0; index < 12; index++)
        stream.emit(
          runtimeEvent(11 + index, "message_start", {
            sessionId: "session-1",
            messageKey: `live-${index}`,
            message: { role: "assistant", content: `Step ${index}` },
          }),
        );
      expect(
        store.getState().liveMessages.filter((entry) => entry.optimistic),
      ).toHaveLength(2);
      expect(
        store.getState().liveMessages.filter((entry) => !entry.optimistic)
          .length,
      ).toBeLessThanOrEqual(8);
    } finally {
      store.getState().actions.stop();
    }
  });

  it("keeps its requested view and scoped pending message when another client changes the controller", async () => {
    const client = new FakeClient();
    const viewed = snapshot();
    const controller = activeSnapshot(
      "controller",
      "/tmp/ws/controller.jsonl",
      { cursor: 20 },
    );
    const background = {
      ...controller,
      sessions: [
        ...controller.sessions,
        { ...viewed.sessions[0]!, controller: "none" as const },
      ],
      selectedSession: viewed.selectedSession,
    };
    client.snapshots.push(
      Promise.resolve(viewed),
      Promise.resolve(background),
      Promise.resolve(controller),
    );
    const stream = eventStreamHarness();
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    store.getState().actions.start();
    try {
      await vi.waitFor(() =>
        expect(stream.consumeEvents).toHaveBeenCalledOnce(),
      );
      await store.getState().actions.sendPrompt("My pending message");
      stream.emit(
        runtimeEvent(10, "session_switched", {
          sessionId: "controller",
          sessionPath: "/tmp/ws/controller.jsonl",
        }),
      );
      await vi.waitFor(() =>
        expect(store.getState().sessionSwitching).toBe(false),
      );
      expect(store.getState().selectedPath).toBe("/tmp/ws/session.jsonl");
      expect(store.getState().snapshot?.currentSessionId).toBe("controller");
      expect(
        store.getState().liveMessages.filter((entry) => entry.optimistic),
      ).toHaveLength(1);
      stream.emit(
        runtimeEvent(21, "message_update", {
          sessionId: "controller",
          messageKey: "foreign",
          message: { role: "assistant", content: "Foreign controller content" },
        }),
      );
      expect(
        store
          .getState()
          .liveMessages.some(
            (entry) => entry.message.content === "Foreign controller content",
          ),
      ).toBe(false);
      expect(
        await store
          .getState()
          .actions.sendPrompt("Not authorized in this view"),
      ).toBe(false);
      expect(client.prompts).toHaveLength(1);
    } finally {
      store.getState().actions.stop();
    }
  });

  it.each([true, false])(
    "only clears own pending when selection changes the viewed file (same view: %s)",
    async (sameView) => {
      const client = new FakeClient();
      const viewed = activeSnapshot("A", "/tmp/ws/a.jsonl");
      const controller = activeSnapshot("B", "/tmp/ws/b.jsonl");
      const background = {
        ...controller,
        sessions: [
          ...controller.sessions,
          { ...viewed.sessions[0]!, controller: "none" as const },
        ],
        selectedSession: viewed.selectedSession,
      };
      const target = sameView ? viewed : controller;
      client.snapshots.push(Promise.resolve(target));
      const stream = eventStreamHarness();
      const store = createWebStore(client, {
        consumeEvents: stream.consumeEvents,
      });
      store.setState({
        snapshot: background,
        cursor: 4,
        selectedPath: "/tmp/ws/a.jsonl",
        selectedWorkspace: "/tmp/ws",
        liveMessages: [
          {
            key: "optimistic-a",
            message: { role: "user", content: "Queued A" },
            optimistic: {
              sessionId: "A",
              sessionPath: "/tmp/ws/a.jsonl",
              commandId: "a",
              afterEntryId: null,
              admitted: true,
            },
          },
        ],
      });
      vi.spyOn(client, "selectSession").mockImplementation(async (path) => {
        if (sameView)
          stream.emit(
            runtimeEvent(5, "session_switched", {
              sessionId: "A",
              sessionPath: path,
            }),
          );
        return {};
      });
      store.getState().actions.start();
      try {
        await vi.waitFor(() =>
          expect(stream.consumeEvents).toHaveBeenCalledOnce(),
        );
        await store
          .getState()
          .actions.selectSession(target.selectedSession!.path);
        expect(store.getState().selectedPath).toBe(
          target.selectedSession!.path,
        );
        expect(store.getState().snapshot?.currentSessionId).toBe(
          target.currentSessionId,
        );
        expect(
          store.getState().liveMessages.filter((entry) => entry.optimistic),
        ).toHaveLength(sameView ? 1 : 0);
      } finally {
        store.getState().actions.stop();
      }
    },
  );

  it("discovers commands once for the active Session and caches the result", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    client.commandResults.push(Promise.resolve(commandDiscovery()));
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();

    await store.getState().actions.discoverCommands();
    await store.getState().actions.discoverCommands();

    expect(client.commandRequests).toHaveLength(1);
    expect(client.commandRequests[0]?.sessionId).toBe("session-1");
    expect(store.getState().commandDiscovery).toMatchObject({
      sessionId: "session-1",
      status: "ready",
      commands: [{ name: "review" }],
      commandsOmitted: 0,
    });
  });

  it("retries command discovery after an error", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    client.commandResults.push(
      Promise.reject(new Error("discovery failed")),
      Promise.resolve(commandDiscovery("retry-success")),
    );
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();

    await store.getState().actions.discoverCommands();
    expect(store.getState().commandDiscovery).toMatchObject({
      status: "error",
      error: "discovery failed",
    });
    await store.getState().actions.discoverCommands();
    expect(store.getState().commandDiscovery).toMatchObject({
      status: "ready",
      commands: [{ name: "retry-success" }],
    });
    expect(client.commandRequests).toHaveLength(2);
  });

  it("cancels and ignores command discovery when the workspace changes", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const pending = deferred<WebCommandDiscoveryResult>();
    client.commandResults.push(pending.promise);
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();

    const discovery = store.getState().actions.discoverCommands();
    store.getState().actions.setWorkspace("/tmp/other");
    expect(client.commandRequests[0]?.signal?.aborted).toBe(true);
    pending.resolve(commandDiscovery("stale"));
    await discovery;

    expect(store.getState().commandDiscovery).toEqual({
      sessionId: null,
      status: "idle",
      commands: [],
      totalAvailable: 0,
      commandsOmitted: 0,
      error: null,
    });
  });

  it("does not discover commands for a draft workspace", async () => {
    const client = new FakeClient();
    const store = createWebStore(client);
    store.setState({
      snapshot: unboundSnapshot([
        { path: "/tmp/draft", name: "Draft", current: false },
      ]),
      selectedWorkspace: "/tmp/draft",
      workspaceDraft: true,
    });

    await store.getState().actions.discoverCommands();

    expect(client.commandRequests).toHaveLength(0);
    expect(store.getState().commandDiscovery.status).toBe("idle");
  });

  it("prevents an older snapshot response from overwriting newer state", async () => {
    const client = new FakeClient();
    const older = deferred<WebSnapshot>();
    const newer = deferred<WebSnapshot>();
    client.snapshots.push(older.promise, newer.promise);
    const store = createWebStore(client);

    const first = store.getState().actions.refreshSnapshot();
    const second = store.getState().actions.refreshSnapshot();
    newer.resolve(snapshot("Newer"));
    expect(await second).toBe(true);
    older.resolve(snapshot("Older"));
    expect(await first).toBe(false);
    expect(store.getState().snapshot?.sessions[0]?.name).toBe("Newer");
  });

  it("ignores an older snapshot failure after a newer response succeeds", async () => {
    const client = new FakeClient();
    const older = deferred<WebSnapshot>();
    const newer = deferred<WebSnapshot>();
    client.snapshots.push(older.promise, newer.promise);
    const store = createWebStore(client);

    const first = store.getState().actions.refreshSnapshot();
    const second = store.getState().actions.refreshSnapshot();
    newer.resolve(snapshot("Newer"));
    expect(await second).toBe(true);
    older.reject(new Error("late snapshot failure"));
    expect(await first).toBe(false);

    expect(store.getState().snapshot?.sessions[0]?.name).toBe("Newer");
    expect(store.getState().notice).toBeNull();
    expect(store.getState().connection).not.toBe("unavailable");
  });

  it("keeps only the newest model search result when responses settle out of order", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const oldResult = deferred<WebModelSearchResult>();
    const newResult = deferred<WebModelSearchResult>();
    client.modelSearchResults.push(oldResult.promise, newResult.promise);
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();

    const oldSearch = store.getState().actions.searchModels("old");
    await vi.waitFor(() => expect(client.modelSearchQueries).toHaveLength(1));
    const newSearch = store.getState().actions.searchModels("new");
    await vi.waitFor(() => expect(client.modelSearchQueries).toHaveLength(2));

    newResult.resolve({
      models: [
        {
          provider: "test",
          id: "new-model",
          name: "New model",
          label: "New model",
          current: false,
        },
      ],
      totalAvailable: 2,
      totalMatches: 1,
      truncation: {
        truncated: false,
        matchesOmitted: 0,
        maxResults: 50,
        maxBytes: 64 * 1024,
        bytes: 100,
      },
    });
    await newSearch;

    oldResult.resolve({
      models: [
        {
          provider: "test",
          id: "old-model",
          name: "Old model",
          label: "Old model",
          current: false,
        },
      ],
      totalAvailable: 2,
      totalMatches: 1,
      truncation: {
        truncated: false,
        matchesOmitted: 0,
        maxResults: 50,
        maxBytes: 64 * 1024,
        bytes: 100,
      },
    });
    await oldSearch;

    expect(store.getState().modelSearch.query).toBe("new");
    expect(store.getState().modelSearch.models[0]?.id).toBe("new-model");
  });

  it("clears a model search and rejects its late result after a workspace change", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const result = deferred<WebModelSearchResult>();
    client.modelSearchResults.push(result.promise);
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();

    const searching = store.getState().actions.searchModels("remote");
    await vi.waitFor(() => expect(client.modelSearchQueries).toHaveLength(1));
    store.getState().actions.setWorkspace("/tmp/other");
    result.resolve({
      models: [
        {
          provider: "test",
          id: "late-model",
          name: "Late model",
          label: "Late model",
          current: false,
        },
      ],
      totalAvailable: 1,
      totalMatches: 1,
      truncation: {
        truncated: false,
        matchesOmitted: 0,
        maxResults: 50,
        maxBytes: 64 * 1024,
        bytes: 100,
      },
    });
    await searching;

    expect(store.getState().selectedWorkspace).toBe("/tmp/other");
    expect(store.getState().modelSearch).toEqual({
      query: "",
      status: "idle",
      models: [],
      totalMatches: 0,
      matchesOmitted: 0,
      error: null,
    });
  });

  it("clears model search results when the model catalog changes in the same Session", async () => {
    const client = new FakeClient();
    const refreshed = snapshot();
    refreshed.generatedAt = "2026-09-03T00:00:01Z";
    refreshed.models = [{ ...refreshed.models[0]!, label: "Changed model" }];
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(refreshed),
    );
    client.modelSearchResults.push(
      Promise.resolve({
        models: [
          {
            provider: "test",
            id: "search-only-model",
            name: "Search only model",
            label: "Search only model",
            current: false,
          },
        ],
        totalAvailable: 251,
        totalMatches: 1,
        truncation: {
          truncated: false,
          matchesOmitted: 0,
          maxResults: 50,
          maxBytes: 64 * 1024,
          bytes: 200,
        },
      }),
    );
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    await store.getState().actions.searchModels("search-only");
    expect(store.getState().modelSearch.status).toBe("ready");

    expect(await store.getState().actions.refreshSnapshot()).toBe(true);

    expect(store.getState().snapshot?.currentSessionId).toBe("session-1");
    expect(store.getState().modelSearch).toEqual({
      query: "",
      status: "idle",
      models: [],
      totalMatches: 0,
      matchesOmitted: 0,
      error: null,
    });
  });

  it("rejects a model search result from an older same-Session model catalog", async () => {
    const client = new FakeClient();
    const refreshed = snapshot();
    refreshed.generatedAt = "2026-09-03T00:00:01Z";
    refreshed.models = [{ ...refreshed.models[0]!, label: "Changed model" }];
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(refreshed),
    );
    const result = deferred<WebModelSearchResult>();
    client.modelSearchResults.push(result.promise);
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();

    const searching = store.getState().actions.searchModels("search-only");
    await vi.waitFor(() => expect(client.modelSearchQueries).toHaveLength(1));
    expect(await store.getState().actions.refreshSnapshot()).toBe(true);
    result.resolve({
      models: [
        {
          provider: "test",
          id: "stale-model",
          name: "Stale model",
          label: "Stale model",
          current: false,
        },
      ],
      totalAvailable: 251,
      totalMatches: 1,
      truncation: {
        truncated: false,
        matchesOmitted: 0,
        maxResults: 50,
        maxBytes: 64 * 1024,
        bytes: 200,
      },
    });
    await searching;

    expect(store.getState().modelSearch.status).toBe("idle");
    expect(store.getState().modelSearch.models).toEqual([]);
  });

  it.each(["loading", "ready"] as const)(
    "invalidates a %s model search on settings changes outside the bounded catalog",
    async (status) => {
      const client = new FakeClient();
      const current = snapshot();
      current.truncation = {
        ...current.truncation,
        modelsOmitted: 1,
        truncated: true,
      };
      client.snapshots.push(Promise.resolve(current));
      const result = deferred<WebModelSearchResult>();
      const found: WebModelSearchResult = {
        models: [
          {
            provider: "test",
            id: "hidden-model",
            name: "Old hidden name",
            label: "Old hidden name",
            current: false,
          },
        ],
        totalAvailable: 2,
        totalMatches: 1,
        truncation: {
          truncated: false,
          matchesOmitted: 0,
          maxResults: 50,
          maxBytes: 64 * 1024,
          bytes: 200,
        },
      };
      client.modelSearchResults.push(result.promise);
      const search = vi.spyOn(client, "searchModels");
      const stream = eventStreamHarness();
      const store = createWebStore(client, {
        consumeEvents: stream.consumeEvents,
      });
      store.getState().actions.start();
      try {
        await vi.waitFor(() =>
          expect(stream.consumeEvents).toHaveBeenCalledOnce(),
        );
        const searching = store.getState().actions.searchModels("hidden");
        await vi.waitFor(() => expect(search).toHaveBeenCalledOnce());
        if (status === "ready") {
          result.resolve(found);
          await searching;
        }
        expect(store.getState().modelSearch.status).toBe(status);

        stream.emit(runtimeEvent(5, "settings_changed"));
        expect(store.getState().modelSearch.status).toBe("idle");
        if (status === "loading")
          expect(search.mock.calls[0]?.[2]?.aborted).toBe(true);

        const refreshed = {
          ...current,
          cursor: 5,
          generatedAt: "2026-09-03T00:00:01Z",
        };
        client.snapshots.push(Promise.resolve(refreshed));
        expect(await store.getState().actions.refreshSnapshot()).toBe(true);
        expect(store.getState().snapshot?.models).toEqual(current.models);
        expect(store.getState().snapshot?.truncation.modelsOmitted).toBe(1);
        if (status === "loading") {
          result.resolve(found);
          await searching;
        }
        expect(store.getState().modelSearch.query).toBe("");
        expect(store.getState().modelSearch.status).toBe("idle");
        expect(store.getState().modelSearch.models).toEqual([]);
      } finally {
        result.resolve(found);
        store.getState().actions.stop();
      }
    },
  );

  it("keeps an available transcript as a read-only view when a different Session controls input", async () => {
    const client = new FakeClient();
    const stale = activeSnapshot("session-2", "/tmp/ws/current.jsonl");
    stale.sessions.unshift({
      ...stale.sessions[0]!,
      id: "session-1",
      path: "/tmp/ws/browsed.jsonl",
      controller: "none",
    });
    stale.selectedSession = {
      ...stale.selectedSession!,
      id: "session-1",
      path: "/tmp/ws/browsed.jsonl",
    };
    const canonical = activeSnapshot("session-2", "/tmp/ws/current.jsonl", {
      cursor: 6,
    });
    client.snapshots.push(Promise.resolve(stale), Promise.resolve(canonical));
    const store = createWebStore(client);
    store.setState({ selectedPath: "/tmp/ws/browsed.jsonl" });

    expect(
      await store.getState().actions.refreshSnapshot({ resetCursor: true }),
    ).toBe(true);

    expect(client.snapshotPaths).toEqual(["/tmp/ws/browsed.jsonl"]);
    expect(store.getState().selectedPath).toBe("/tmp/ws/browsed.jsonl");
    expect(store.getState().snapshot?.selectedSession?.id).toBe("session-1");
    expect(store.getState().snapshot?.currentSessionId).toBe("session-2");
    expect(
      await store.getState().actions.sendPrompt("do not switch control"),
    ).toBe(false);
    expect(client.prompts).toEqual([]);
  });

  it("clears a vanished selected path and retries the canonical snapshot once", async () => {
    const client = new FakeClient();
    const missing = activeSnapshot("session-2", "/tmp/ws/current.jsonl");
    delete missing.selectedSession;
    const canonical = activeSnapshot("session-2", "/tmp/ws/current.jsonl", {
      cursor: 7,
    });
    client.snapshots.push(Promise.resolve(missing), Promise.resolve(canonical));
    const store = createWebStore(client);
    store.setState({ selectedPath: "/tmp/ws/vanished.jsonl" });

    expect(
      await store.getState().actions.refreshSnapshot({ resetCursor: true }),
    ).toBe(true);

    expect(client.snapshotPaths).toEqual(["/tmp/ws/vanished.jsonl", null]);
    expect(store.getState().selectedPath).toBe("/tmp/ws/current.jsonl");
  });

  it("keeps the controlled file selected across refreshes with a newer same-ID copy", async () => {
    const client = new FakeClient();
    const canonical = snapshot();
    const copyPath = "/tmp/ws/copy.jsonl";
    canonical.sessions.unshift({
      ...canonical.sessions[0]!,
      path: copyPath,
      modified: "2026-09-04T00:00:00Z",
      controller: "none",
    });
    const copied = {
      ...canonical,
      selectedSession: { ...canonical.selectedSession!, path: copyPath },
    };
    const readSnapshot = vi
      .spyOn(client, "snapshot")
      .mockImplementation(async (path) =>
        path === copyPath ? copied : canonical,
      );
    const store = createWebStore(client);

    expect(await store.getState().actions.refreshSnapshot()).toBe(true);
    expect(await store.getState().actions.refreshSnapshot()).toBe(true);

    expect(readSnapshot.mock.calls).toEqual([
      [null],
      [canonical.selectedSession!.path],
    ]);
    expect(store.getState().selectedPath).toBe(canonical.selectedSession!.path);
    expect(store.getState().snapshot?.selectedSession?.path).toBe(
      canonical.selectedSession!.path,
    );
    expect(
      await store.getState().actions.sendPrompt("stay on the active file"),
    ).toBe(true);
    expect(client.prompts).toEqual([
      { sessionId: "session-1", content: "stay on the active file" },
    ]);
    store.getState().actions.stop();
  });

  it("sends all three mutation bodies with each confirmed same-ID file path", async () => {
    const client = new FakeClient();
    const paths = ["/tmp/ws/session.jsonl", "/tmp/ws/copy.jsonl"];
    let current = withThinking(activeSnapshot("same-id", paths[0]!));
    vi.spyOn(client, "snapshot").mockImplementation(async () => current);
    vi.spyOn(client, "selectModel").mockImplementation((...args) =>
      WebClient.prototype.selectModel.call(client, ...args),
    );
    vi.spyOn(client, "setThinkingLevel").mockImplementation((...args) =>
      WebClient.prototype.setThinkingLevel.call(client, ...args),
    );
    vi.spyOn(client, "prompt").mockImplementation((...args) =>
      WebClient.prototype.prompt.call(client, ...args),
    );
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      const body = JSON.parse(String(options.body));
      const result =
        url === "/api/model"
          ? current.models[0]
          : url === "/api/thinking"
            ? {
                ...current.thinking,
                sessionId: "same-id",
                level: body.level,
                revision: 2,
              }
            : { id: body.commandId, accepted: true };
      return new Response(JSON.stringify(result));
    });
    vi.stubGlobal("fetch", fetcher);
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();

    for (const path of paths) {
      if (path !== paths[0]) {
        current = withThinking(activeSnapshot("same-id", path));
        await store.getState().actions.selectSession(path);
      }
      await store.getState().actions.selectModel("test/model");
      store.getState().actions.selectThinking("high");
      await vi.waitFor(() =>
        expect(store.getState().thinkingPendingLevel).toBeNull(),
      );
      expect(await store.getState().actions.sendPrompt("hello")).toBe(true);
    }

    expect(
      fetcher.mock.calls.map(([url, options]) => ({
        url,
        body: JSON.parse(String(options.body)),
      })),
    ).toEqual(
      paths.flatMap((sessionPath) => [
        {
          url: "/api/model",
          body: {
            provider: "test",
            modelId: "model",
            sessionId: "same-id",
            sessionPath,
          },
        },
        {
          url: "/api/thinking",
          body: { sessionId: "same-id", sessionPath, level: "high" },
        },
        {
          url: "/api/prompt",
          body: {
            sessionId: "same-id",
            sessionPath,
            content: "hello",
            commandId: expect.any(String),
            controllerId: expect.any(String),
            retry: false,
            images: [],
          },
        },
      ]),
    );
    store.getState().actions.stop();
  });

  it("does not lend an uncertain prompt command to a same-ID copy after refresh", async () => {
    const client = new FakeClient();
    let current = snapshot();
    vi.spyOn(client, "snapshot").mockImplementation(async () => current);
    vi.spyOn(client, "prompt").mockImplementation((...args) =>
      WebClient.prototype.prompt.call(client, ...args),
    );
    const fetcher = vi
      .fn<(url: string, options: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("lost receipt"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "new", accepted: true })),
      );
    vi.stubGlobal("fetch", fetcher);
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    expect(await store.getState().actions.sendPrompt("once")).toBe(false);

    current = activeSnapshot("session-1", "/tmp/ws/copy.jsonl");
    expect(await store.getState().actions.refreshSnapshot()).toBe(true);
    expect(await store.getState().actions.sendPrompt("once")).toBe(true);

    const [first, second] = fetcher.mock.calls.map(([, options]) =>
      JSON.parse(String(options.body)),
    );
    expect(first).toMatchObject({
      sessionId: "session-1",
      sessionPath: "/tmp/ws/session.jsonl",
      retry: false,
    });
    expect(second).toMatchObject({
      sessionId: "session-1",
      sessionPath: "/tmp/ws/copy.jsonl",
      retry: false,
    });
    expect(second.commandId).not.toBe(first.commandId);
    store.getState().actions.stop();
  });

  it("allows a same-ID copied transcript to be read without granting the original's input control", async () => {
    const client = new FakeClient();
    const copied = snapshot();
    const copyPath = "/tmp/ws/copy.jsonl";
    copied.sessions.unshift({
      ...copied.sessions[0]!,
      path: copyPath,
      controller: "none",
    });
    copied.selectedSession = { ...copied.selectedSession!, path: copyPath };
    client.snapshots.push(Promise.resolve(copied), Promise.resolve(copied));
    const store = createWebStore(client);
    store.setState({ selectedPath: copyPath });

    expect(await store.getState().actions.refreshSnapshot()).toBe(true);

    expect(client.snapshotPaths).toEqual([copyPath]);
    expect(store.getState().selectedPath).toBe(copyPath);
    expect(store.getState().snapshot?.selectedSession?.path).toBe(copyPath);
    expect(
      await store.getState().actions.sendPrompt("do not send to the original"),
    ).toBe(false);
    expect(client.prompts).toEqual([]);
    const cancel = vi
      .spyOn(client, "cancelActiveTurn")
      .mockResolvedValue({ state: "accepted" });
    store.setState({
      activeTurn: {
        sessionId: "session-1",
        sessionPath: "/tmp/ws/session.jsonl",
        commandId: "original-turn",
        epoch: 1,
      },
    });
    await store.getState().actions.cancelActiveTurn();
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each(["network failure", "invalid canonical projection"])(
    "blocks stale Session operations after a same-ID switch with %s",
    async (failure) => {
      vi.useFakeTimers();
      const client = new FakeClient();
      const original = snapshot();
      original.thinking = {
        level: "medium",
        available: ["medium", "high"],
        supported: true,
        revision: 1,
      };
      client.snapshots.push(Promise.resolve(original));
      const store = createWebStore(client);
      await store.getState().actions.refreshSnapshot();
      const copyPath = "/tmp/ws/copy.jsonl";
      const copied = activeSnapshot("session-1", copyPath);
      copied.thinking = original.thinking;
      if (failure === "network failure") {
        client.snapshots.push(
          Promise.reject(new Error("snapshot unavailable")),
        );
      } else {
        const invalid = {
          ...copied,
          selectedSession: original.selectedSession,
        };
        client.snapshots.push(
          Promise.resolve(invalid),
          Promise.resolve(invalid),
        );
      }

      await store.getState().actions.selectSession(copyPath);

      expect(client.selections).toEqual([copyPath]);
      expect(store.getState().sessionSwitching).toBe(false);
      expect(store.getState().selectedPath).toBeNull();
      expect(store.getState().snapshot?.selectedSession?.path).toBe(
        original.selectedSession!.path,
      );
      await store.getState().actions.selectModel("test/model");
      store.getState().actions.selectThinking("high");
      await Promise.resolve();
      await store.getState().actions.discoverCommands();
      const sent = await store.getState().actions.sendPrompt("/review");
      expect({
        sent,
        prompts: client.prompts,
        modelSelections: client.modelSelections,
        thinkings: client.thinkings,
        commandRequests: client.commandRequests,
      }).toEqual({
        sent: false,
        prompts: [],
        modelSelections: [],
        thinkings: [],
        commandRequests: [],
      });

      client.snapshots.push(Promise.resolve(copied));
      expect(await store.getState().actions.refreshSnapshot()).toBe(true);
      expect(store.getState().selectedPath).toBe(copyPath);
      expect(await store.getState().actions.sendPrompt("confirmed copy")).toBe(
        true,
      );
      expect(client.prompts).toEqual([
        { sessionId: "session-1", content: "confirmed copy" },
      ]);
      store.getState().actions.stop();
    },
  );

  it.each([
    [
      "cursor gap",
      'id: 6\ndata: {"protocolVersion":1,"sequence":6,"type":"runtime_changed","timestamp":"2026-09-03T00:00:00Z"}\n\n',
    ],
    [
      "state invalidation",
      'id: 5\ndata: {"protocolVersion":1,"sequence":5,"type":"state_invalidated","timestamp":"2026-09-03T00:00:00Z"}\n\n',
    ],
  ])("requires a snapshot resync after an SSE %s", async (_name, record) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(record, {
          headers: { "Content-Type": "text/event-stream" },
          status: 200,
        }),
      ),
    );
    const onEvent = vi.fn();

    await expect(
      consumeEventStream({
        client: new WebClient(),
        cursor: 4,
        onConnected: vi.fn(),
        onEvent,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(EventResyncRequired);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("recovers a fresh snapshot when the event stream requires resync", async () => {
    const client = new FakeClient();
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(
        activeSnapshot("session-1", "/tmp/ws/session.jsonl", { cursor: 9 }),
      ),
    );
    let streamCalls = 0;
    const consumeEvents = vi.fn((options: EventStreamOptions) => {
      options.onConnected();
      streamCalls++;
      if (streamCalls === 1) {
        return Promise.reject(new EventResyncRequired("cursor gap"));
      }
      return new Promise<void>((resolve) => {
        options.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    });
    const store = createWebStore(client, { consumeEvents });
    await store.getState().actions.refreshSnapshot();

    store.getState().actions.start();
    await vi.waitFor(() => expect(client.snapshotPaths).toHaveLength(2));

    expect(store.getState().cursor).toBe(9);
    expect(store.getState().snapshot?.cursor).toBe(9);
    expect(store.getState().connection).toBe("reconnecting");
    store.getState().actions.stop();
  });

  it("preserves a business notice when the event stream reconnects", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    let connected: (() => void) | undefined;
    const consumeEvents = vi.fn((options: EventStreamOptions) => {
      connected = options.onConnected;
      return new Promise<void>((resolve) => {
        options.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    });
    const store = createWebStore(client, { consumeEvents });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();
    await vi.waitFor(() => expect(connected).toBeDefined());
    store.setState({ notice: "The created Session is no longer active." });
    connected?.();
    expect(store.getState().connection).toBe("connected");
    expect(store.getState().notice).toContain("no longer active");
    store.getState().actions.stop();
  });

  it("projects prompt admission optimistically and settles on the receipt", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const admission = deferred<{ id: string; accepted: boolean }>();
    client.promptResult = admission.promise;
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();

    const sending = store.getState().actions.sendPrompt("  inspect this  ");
    expect(store.getState().promptAdmissionPending).toBe(true);
    expect(store.getState().liveMessages[0]?.message.content).toBe(
      "inspect this",
    );
    admission.resolve({ id: "prompt-2", accepted: true });
    expect(await sending).toBe(true);
    expect(client.prompts).toEqual([
      { sessionId: "session-1", content: "inspect this" },
    ]);
    expect(store.getState().promptAdmissionPending).toBe(false);
    expect(store.getState().livePhase).toBe("preparing");
    store.getState().actions.stop();
  });

  it("marks only the exact HTTP-accepted prompt as admitted for display", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const receipt = deferred<CommandReceipt>();
    const prompt = vi.spyOn(client, "prompt").mockReturnValue(receipt.promise);
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();

    const sending = store.getState().actions.sendPrompt("pending");
    expect(store.getState().liveMessages[0]?.optimistic?.admitted).toBe(false);
    receipt.resolve({ id: prompt.mock.calls[0]![2], accepted: true });
    expect(await sending).toBe(true);
    expect(store.getState().liveMessages[0]?.optimistic?.admitted).toBe(true);
    store.getState().actions.stop();
  });

  it.each(["unknown", "lost", "wrong-command", "not-accepted"])(
    "does not mark %s prompt admission as accepted for display",
    async (result) => {
      const client = new FakeClient();
      vi.spyOn(client, "snapshot").mockResolvedValue(snapshot());
      vi.spyOn(client, "prompt").mockImplementation(async (_id, _text, id) => {
        if (result === "unknown")
          throw new WebApiError("unknown", 409, "COMMAND_ADMISSION_UNKNOWN");
        if (result === "lost") throw new TypeError("lost receipt");
        return {
          id: result === "wrong-command" ? "other" : id,
          accepted: result !== "not-accepted",
        };
      });
      const store = createWebStore(client);
      await store.getState().actions.refreshSnapshot();
      await store.getState().actions.sendPrompt("pending");
      expect(store.getState().liveMessages[0]?.optimistic?.admitted).toBe(
        false,
      );
      store.getState().actions.stop();
    },
  );

  it("marks only the matching scoped prompt accepted by an event", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const receipt = deferred<CommandReceipt>();
    const prompt = vi.spyOn(client, "prompt").mockReturnValue(receipt.promise);
    const stream = eventStreamHarness();
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();
    const sending = store.getState().actions.sendPrompt("pending");
    const commandId = prompt.mock.calls[0]![2];
    const selected = store.getState().snapshot!;
    store.setState({
      snapshot: {
        ...selected,
        currentSessionId: "controller-other",
        currentSessionPath: "/tmp/ws/other.jsonl",
      },
    });
    stream.emit(
      runtimeEvent(5, "prompt_accepted", {
        commandId,
        sessionId: "session-1",
        sessionPath: "/tmp/ws/copy.jsonl",
      }),
    );
    stream.emit(
      runtimeEvent(6, "prompt_accepted", {
        commandId: "another-command",
        sessionId: "session-1",
        sessionPath: "/tmp/ws/session.jsonl",
      }),
    );
    expect(store.getState().liveMessages[0]?.optimistic?.admitted).toBe(false);
    stream.emit(
      runtimeEvent(7, "prompt_accepted", {
        commandId,
        sessionId: "session-1",
        sessionPath: "/tmp/ws/session.jsonl",
      }),
    );
    expect(store.getState().liveMessages[0]?.optimistic?.admitted).toBe(true);
    expect(store.getState().snapshot?.currentSessionId).toBe(
      "controller-other",
    );
    expect(store.getState().liveRunning).toBe(false);
    receipt.resolve({ id: commandId, accepted: true });
    await sending;
    store.getState().actions.stop();
  });

  it("remembers only valid admitted prompt projections and releases their preview data", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const receipt = deferred<CommandReceipt>();
    const prompt = vi.spyOn(client, "prompt").mockReturnValue(receipt.promise);
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    const sending = store
      .getState()
      .actions.sendPrompt("image", [
        { mimeType: "image/png", data: "cHJldmlldw==" },
      ]);
    const original = store.getState().liveMessages[0]!;
    const native = {
      id: "native-user",
      parentId: null,
      type: "message" as const,
      timestamp: original.timestamp!,
      message: original.message,
    };
    const current = store.getState().snapshot!;
    store.setState({
      snapshot: {
        ...current,
        selectedSession: { ...current.selectedSession!, entries: [native] },
      },
    });
    const remember = store.getState().actions.rememberPromptProjection;
    const pair = [{ key: original.key, entryId: native.id }];
    remember("session-1", "/tmp/ws/session.jsonl", pair);
    expect(store.getState().liveMessages[0]).toBe(original);
    receipt.resolve({ id: prompt.mock.calls[0]![2], accepted: true });
    await sending;
    const accepted = store.getState().liveMessages[0]!;
    expect(accepted.message.parts?.[0]).toHaveProperty("previewUrl");
    remember("wrong-id", "/tmp/ws/session.jsonl", pair);
    remember("session-1", "/tmp/ws/copy.jsonl", pair);
    remember("session-1", "/tmp/ws/session.jsonl", [
      { key: original.key, entryId: "missing" },
    ]);
    expect(store.getState().liveMessages[0]).toBe(accepted);
    remember("session-1", "/tmp/ws/session.jsonl", pair);
    expect(store.getState().liveMessages[0]).toEqual({
      ...accepted,
      optimistic: { ...accepted.optimistic, projectedEntryId: native.id },
      message: { role: "user", content: "" },
    });
    const projected = store.getState().liveMessages[0]!;
    remember("session-1", "/tmp/ws/session.jsonl", pair);
    expect(store.getState().liveMessages[0]).toBe(projected);
    const nextPending = {
      ...accepted,
      key: "next-pending",
      optimistic: { ...accepted.optimistic!, commandId: "next-command" },
    };
    store.setState({ liveMessages: [projected, nextPending] });
    remember("session-1", "/tmp/ws/session.jsonl", [
      { key: nextPending.key, entryId: native.id },
    ]);
    expect(store.getState().liveMessages[1]).toBe(nextPending);
    const newerSnapshot = store.getState().snapshot!;
    store.setState({
      snapshot: {
        ...newerSnapshot,
        selectedSession: {
          ...newerSnapshot.selectedSession!,
          entries: [{ ...native, id: "newer-native-user" }],
        },
      },
    });
    remember("session-1", "/tmp/ws/session.jsonl", [
      { key: projected.key, entryId: "newer-native-user" },
    ]);
    expect(store.getState().liveMessages[0]).toBe(projected);
    remember("session-1", "/tmp/ws/session.jsonl", [
      { key: nextPending.key, entryId: native.id },
    ]);
    expect(store.getState().liveMessages[1]).toBe(nextPending);
    store.getState().actions.stop();
  });

  it("ignores prompt state events owned by another active Session", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const stream = eventStreamHarness();
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();

    stream.emit(
      runtimeEvent(5, "prompt_failed", {
        error: "wrong session",
        sessionId: "session-other",
      }),
    );

    expect(store.getState().notice).toBeNull();
    expect(store.getState().liveRunning).toBe(false);
    store.getState().actions.stop();
  });

  it("settles a prompt even when no agent turn starts", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const stream = eventStreamHarness();
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();

    stream.emit(
      runtimeEvent(5, "prompt_accepted", {
        commandId: "prompt-1",
        sessionId: "session-1",
      }),
    );
    expect(store.getState().liveRunning).toBe(true);
    expect(store.getState().livePhase).toBe("preparing");

    stream.emit(
      runtimeEvent(6, "prompt_settled", {
        commandId: "prompt-1",
        sessionId: "session-1",
      }),
    );
    expect(store.getState().liveRunning).toBe(false);
    expect(store.getState().livePhase).toBe("idle");

    stream.emit(
      runtimeEvent(7, "prompt_settled", {
        commandId: "prompt-2",
        sessionId: "session-1",
      }),
    );
    stream.emit(
      runtimeEvent(8, "prompt_accepted", {
        commandId: "prompt-2",
        sessionId: "session-1",
      }),
    );
    expect(store.getState().liveRunning).toBe(false);
    expect(store.getState().livePhase).toBe("idle");
    store.getState().actions.stop();
  });

  it("keeps a running turn running when a follow-up prompt is accepted", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const stream = eventStreamHarness();
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();

    stream.emit(
      runtimeEvent(5, "agent_start", {
        sessionId: "session-1",
      }),
    );
    expect(store.getState().liveRunning).toBe(true);
    expect(store.getState().livePhase).toBe("running");

    stream.emit(
      runtimeEvent(6, "prompt_accepted", {
        commandId: "prompt-follow-up",
        sessionId: "session-1",
      }),
    );
    expect(store.getState().liveRunning).toBe(true);
    expect(store.getState().livePhase).toBe("running");
    store.getState().actions.stop();
  });

  it("keeps a running turn running when a follow-up HTTP receipt arrives", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const stream = eventStreamHarness();
    const admission = deferred<CommandReceipt>();
    client.promptResult = admission.promise;
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();

    stream.emit(
      runtimeEvent(5, "agent_start", {
        sessionId: "session-1",
      }),
    );
    const sending = store.getState().actions.sendPrompt("queued follow-up");
    admission.resolve({ id: "prompt-follow-up", accepted: true });
    expect(await sending).toBe(true);
    expect(store.getState().liveRunning).toBe(true);
    expect(store.getState().livePhase).toBe("running");
    store.getState().actions.stop();
  });

  it("idles a settled HTTP receipt without restarting the live turn", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const stream = eventStreamHarness();
    const admission = deferred<CommandReceipt>();
    client.promptResult = admission.promise;
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();

    stream.emit(
      runtimeEvent(5, "prompt_settled", {
        commandId: "prompt-already-done",
        sessionId: "session-1",
      }),
    );
    const sending = store.getState().actions.sendPrompt("already settled");
    admission.resolve({ id: "prompt-already-done", accepted: true });
    expect(await sending).toBe(true);
    expect(store.getState().liveRunning).toBe(false);
    expect(store.getState().livePhase).toBe("idle");
    store.getState().actions.stop();
  });

  it("ignores prompt_accepted owned by another Session while the current turn is running", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const stream = eventStreamHarness();
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();

    stream.emit(
      runtimeEvent(5, "agent_start", {
        sessionId: "session-1",
      }),
    );
    stream.emit(
      runtimeEvent(6, "prompt_accepted", {
        commandId: "prompt-other",
        sessionId: "session-other",
      }),
    );
    expect(store.getState().liveRunning).toBe(true);
    expect(store.getState().livePhase).toBe("running");
    store.getState().actions.stop();
  });

  it("refreshes Session metadata events emitted by another browser tab", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(snapshot("Renamed elsewhere")),
    );
    const stream = eventStreamHarness();
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();

    stream.emit(
      runtimeEvent(5, "session_renamed", {
        sessionId: "session-1",
        sessionPath: "/tmp/ws/session.jsonl",
      }),
    );
    await vi.advanceTimersByTimeAsync(160);

    expect(store.getState().snapshot?.sessions[0]?.name).toBe(
      "Renamed elsewhere",
    );
    store.getState().actions.stop();
  });

  it("recovers the canonical Session when an external activation no longer lists the previously viewed file", async () => {
    const client = new FakeClient();
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(
        activeSnapshot("session-2", "/tmp/ws/external.jsonl", { cursor: 5 }),
      ),
      Promise.resolve(
        activeSnapshot("session-2", "/tmp/ws/external.jsonl", { cursor: 5 }),
      ),
    );
    const stream = eventStreamHarness();
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();

    stream.emit(
      runtimeEvent(5, "session_switched", {
        sessionId: "session-2",
        sessionPath: "/tmp/ws/external.jsonl",
      }),
    );
    await vi.waitFor(() =>
      expect(store.getState().snapshot?.currentSessionId).toBe("session-2"),
    );

    expect(store.getState().selectedPath).toBe("/tmp/ws/external.jsonl");
    expect(store.getState().snapshot?.currentSessionId).toBe("session-2");
    store.getState().actions.stop();
  });

  it("keeps the newest Session selection when an older request settles late", async () => {
    const client = new FakeClient();
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(activeSnapshot("session-2", "/tmp/ws/b.jsonl")),
    );
    const first = deferred<SessionMutationResult>();
    const second = deferred<SessionMutationResult>();
    client.selectionResults.push(first.promise, second.promise);
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();

    const selectingA = store
      .getState()
      .actions.selectSession("/tmp/ws/a.jsonl");
    await vi.waitFor(() =>
      expect(client.selections).toEqual(["/tmp/ws/a.jsonl"]),
    );
    const selectingB = store
      .getState()
      .actions.selectSession("/tmp/ws/b.jsonl");
    first.reject(new Error("late A failure"));
    await selectingA;
    await vi.waitFor(() =>
      expect(client.selections).toEqual(["/tmp/ws/a.jsonl", "/tmp/ws/b.jsonl"]),
    );
    second.resolve({});
    await selectingB;

    expect(store.getState().selectedPath).toBe("/tmp/ws/b.jsonl");
    expect(store.getState().sessionSwitching).toBe(false);
    expect(store.getState().notice).toBeNull();
  });

  it("ignores an old prompt admission after switching Sessions", async () => {
    const client = new FakeClient();
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(activeSnapshot("session-2", "/tmp/ws/b.jsonl")),
    );
    const prompt = deferred<CommandReceipt>();
    client.promptResult = prompt.promise;
    client.selectionResults.push(Promise.resolve({}));
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();

    const sending = store.getState().actions.sendPrompt("message for A");
    await store.getState().actions.selectSession("/tmp/ws/b.jsonl");
    prompt.resolve({ id: "prompt-a", accepted: true });

    expect(await sending).toBe(false);
    expect(store.getState().selectedPath).toBe("/tmp/ws/b.jsonl");
    expect(store.getState().liveMessages).toEqual([]);
    expect(store.getState().liveRunning).toBe(false);
    expect(store.getState().promptAdmissionPending).toBe(false);
  });

  it("does not let a stale receipt downgrade a newer Session epoch that is already running", async () => {
    const client = new FakeClient();
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(activeSnapshot("session-2", "/tmp/ws/b.jsonl")),
    );
    const prompt = deferred<CommandReceipt>();
    client.promptResult = prompt.promise;
    client.selectionResults.push(Promise.resolve({}));
    const stream = eventStreamHarness();
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();

    const sending = store.getState().actions.sendPrompt("message for A");
    await store.getState().actions.selectSession("/tmp/ws/b.jsonl");
    stream.emit(
      runtimeEvent(5, "agent_start", {
        sessionId: "session-2",
      }),
    );
    expect(store.getState().liveRunning).toBe(true);
    expect(store.getState().livePhase).toBe("running");
    prompt.resolve({ id: "prompt-a", accepted: true });

    expect(await sending).toBe(false);
    expect(store.getState().selectedPath).toBe("/tmp/ws/b.jsonl");
    expect(store.getState().liveRunning).toBe(true);
    expect(store.getState().livePhase).toBe("running");
    expect(store.getState().promptAdmissionPending).toBe(false);
    store.getState().actions.stop();
  });

  it("orders Session creation before a newer selection intent", async () => {
    const client = new FakeClient();
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(activeSnapshot("session-2", "/tmp/ws/b.jsonl")),
    );
    const creation = deferred<SessionCreationResult>();
    client.creationResult = () => creation.promise;
    client.selectionResults.push(Promise.resolve({}));
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();

    const creating = store.getState().actions.createSession("/tmp/ws");
    await vi.waitFor(() => expect(client.creations).toHaveLength(1));
    const selecting = store.getState().actions.selectSession("/tmp/ws/b.jsonl");
    creation.resolve({
      cancelled: false,
      commandId: client.creations[0]!.commandId,
      sessionId: "session-1",
    });
    await Promise.all([creating, selecting]);

    expect(client.selections).toEqual(["/tmp/ws/b.jsonl"]);
    expect(store.getState().selectedPath).toBe("/tmp/ws/b.jsonl");
    expect(store.getState().sessionSwitching).toBe(false);
  });

  it("correlates its own Session activation events around the HTTP receipt", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(
        activeSnapshot("session-2", "/tmp/ws/created.jsonl", { cursor: 5 }),
      ),
    );
    const creation = deferred<SessionCreationResult>();
    client.creationResult = () => creation.promise;
    const stream = eventStreamHarness();
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();

    const creating = store.getState().actions.createSession("/tmp/ws");
    await vi.waitFor(() => expect(client.creations).toHaveLength(1));
    const commandId = client.creations[0]!.commandId;
    stream.emit(
      runtimeEvent(5, "session_switched", {
        commandId,
        sessionId: "session-2",
        sessionPath: "/tmp/ws/created.jsonl",
      }),
    );
    creation.resolve({
      cancelled: false,
      commandId,
      sessionId: "session-2",
      sessionPath: "/tmp/ws/created.jsonl",
    });
    await creating;

    const prompt = deferred<CommandReceipt>();
    client.promptResult = prompt.promise;
    const sending = store.getState().actions.sendPrompt("follow up");
    expect(store.getState().promptAdmissionPending).toBe(true);
    stream.emit(
      runtimeEvent(6, "session_created", {
        commandId,
        sessionId: "session-2",
        sessionPath: "/tmp/ws/created.jsonl",
      }),
    );

    expect(store.getState().selectedPath).toBe("/tmp/ws/created.jsonl");
    expect(store.getState().promptAdmissionPending).toBe(true);
    prompt.resolve({ id: "prompt-2", accepted: true });
    expect(await sending).toBe(true);
    store.getState().actions.stop();
  });

  it("correlates creation events by Session identity before persistence", async () => {
    const client = new FakeClient();
    client.snapshots.push(
      Promise.resolve(unboundSnapshot()),
      Promise.resolve(activeSnapshot("session-new", "current:session-new")),
    );
    const creation = deferred<SessionCreationResult>();
    client.creationResult = () => creation.promise;
    const stream = eventStreamHarness();
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();

    const creating = store.getState().actions.createSession("/tmp/ws");
    await vi.waitFor(() => expect(client.creations).toHaveLength(1));
    const commandId = client.creations[0]!.commandId;
    stream.emit(
      runtimeEvent(5, "session_switched", {
        commandId,
        sessionId: "session-new",
      }),
    );
    stream.emit(
      runtimeEvent(6, "session_created", {
        commandId,
        sessionId: "session-new",
      }),
    );
    creation.resolve({
      cancelled: false,
      commandId,
      sessionId: "session-new",
    });

    expect(await creating).toMatchObject({ sessionId: "session-new" });
    expect(store.getState().selectedPath).toBe("current:session-new");
    expect(store.getState().notice).toBeNull();
    store.getState().actions.stop();
  });

  it("lets an external activation supersede queued Session creation", async () => {
    const client = new FakeClient();
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(
        activeSnapshot("session-2", "/tmp/ws/external.jsonl", { cursor: 5 }),
      ),
    );
    const stream = eventStreamHarness();
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();

    const creating = store.getState().actions.createSession("/tmp/ws");
    stream.emit(
      runtimeEvent(5, "session_switched", {
        sessionId: "session-2",
        sessionPath: "/tmp/ws/external.jsonl",
      }),
    );
    await creating;
    await vi.waitFor(() =>
      expect(store.getState().sessionSwitching).toBe(false),
    );

    expect(client.creations).toEqual([]);
    expect(store.getState().selectedPath).toBe("/tmp/ws/external.jsonl");
    store.getState().actions.stop();
  });

  it("scopes model selection results to the originating Session", async () => {
    const client = new FakeClient();
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(activeSnapshot("session-2", "/tmp/ws/b.jsonl")),
    );
    const model = deferred<WebModelSummary>();
    client.modelResult = model.promise;
    client.selectionResults.push(Promise.resolve({}));
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();

    const selectingModel = store
      .getState()
      .actions.selectModel("test/new-model");
    await vi.waitFor(() => expect(client.modelSelections).toHaveLength(1));
    await store.getState().actions.selectSession("/tmp/ws/b.jsonl");
    model.reject(new Error("late model response"));
    await selectingModel;

    expect(client.modelSelections).toEqual([
      {
        provider: "test",
        modelId: "new-model",
        sessionId: "session-1",
      },
    ]);
    expect(store.getState().selectedPath).toBe("/tmp/ws/b.jsonl");
    expect(store.getState().notice).toBeNull();
  });

  it("preserves a chosen workspace through first Session creation and prompt", async () => {
    const client = new FakeClient();
    const workspace = "/tmp/chosen-workspace";
    client.snapshots.push(
      Promise.resolve(unboundSnapshot()),
      Promise.resolve(
        unboundSnapshot([{ path: workspace, name: "Chosen", current: false }]),
      ),
      Promise.resolve(
        activeSnapshot("session-1", `${workspace}/session.jsonl`, {
          workspace,
        }),
      ),
    );
    client.workspaceResult = Promise.resolve({ path: workspace });
    client.creationResult = async (commandId) => ({
      cancelled: false,
      commandId,
      sessionId: "session-1",
      sessionPath: `${workspace}/session.jsonl`,
    });
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();

    await store.getState().actions.chooseWorkspace();
    expect(store.getState().selectedWorkspace).toBe(workspace);
    expect(await store.getState().actions.sendPrompt("first task")).toBe(true);

    expect(client.creations).toHaveLength(1);
    expect(client.creations[0]?.workspacePath).toBe(workspace);
    expect(client.prompts).toEqual([
      { sessionId: "session-1", content: "first task" },
    ]);
    expect(store.getState().selectedWorkspace).toBe(workspace);
    expect(store.getState().selectedPath).toBe(`${workspace}/session.jsonl`);
    store.getState().actions.stop();
  });

  it("keeps an explicit workspace choice across snapshots of the old empty Session", async () => {
    const client = new FakeClient();
    const initial = snapshot();
    initial.workspaces.push({ path: "/tmp/repo-b", name: "B", current: false });
    client.snapshots.push(
      Promise.resolve(initial),
      Promise.resolve(initial),
      Promise.resolve(initial),
    );
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();

    store.getState().actions.setWorkspace("/tmp/repo-b");
    await store.getState().actions.refreshSnapshot();

    expect(store.getState().selectedWorkspace).toBe("/tmp/repo-b");
    expect(store.getState().snapshot?.selectedSession?.cwd).toBe("/tmp/ws");
    expect(client.creations).toEqual([]);
    expect(client.prompts).toEqual([]);
  });

  it("creates a Session in the chosen workspace before sending from an old empty Session", async () => {
    const client = new FakeClient();
    client.creationResult = async (commandId) => ({
      cancelled: false,
      commandId,
      sessionId: "session-b",
      sessionPath: "/tmp/repo-b/session.jsonl",
    });
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(
        activeSnapshot("session-b", "/tmp/repo-b/session.jsonl", {
          workspace: "/tmp/repo-b",
        }),
      ),
    );
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.setWorkspace("/tmp/repo-b");

    expect(await store.getState().actions.sendPrompt("work in B")).toBe(true);
    expect(client.creations).toEqual([
      { workspacePath: "/tmp/repo-b", commandId: expect.any(String) },
    ]);
    expect(client.prompts).toEqual([
      { sessionId: "session-b", content: "work in B" },
    ]);
    store.getState().actions.stop();
  });

  it("never retargets the first prompt to a Session activated by another tab", async () => {
    const client = new FakeClient();
    const workspaceA = "/tmp/repo-a";
    const workspaceB = "/tmp/repo-b";
    client.snapshots.push(
      Promise.resolve(
        unboundSnapshot([
          { path: workspaceA, name: "A", current: false },
          { path: workspaceB, name: "B", current: false },
        ]),
      ),
      Promise.resolve(
        activeSnapshot("session-b", `${workspaceB}/session.jsonl`, {
          workspace: workspaceB,
        }),
      ),
    );
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.setWorkspace(workspaceA);
    client.creationResult = async (commandId) => ({
      cancelled: false,
      commandId,
      sessionId: "session-a",
    });

    expect(
      await store
        .getState()
        .actions.sendPrompt("Edit repository A configuration"),
    ).toBe(false);

    expect(client.prompts).toEqual([]);
    expect(store.getState().snapshot?.currentSessionId).toBe("session-b");
    expect(store.getState().notice).toContain("no longer active");
    expect(store.getState().workspaceDraft).toBe(true);
    const previousCommandId = client.creations[0].commandId;
    client.snapshots.push(
      Promise.resolve(
        activeSnapshot("session-a", `${workspaceA}/session.jsonl`, {
          workspace: workspaceA,
        }),
      ),
    );
    expect(await store.getState().actions.sendPrompt("retry in A")).toBe(true);
    expect(client.creations[1].commandId).not.toBe(previousCommandId);
    expect(client.prompts).toEqual([
      { sessionId: "session-a", content: "retry in A" },
    ]);
  });

  it("binds a first prompt to a new Session before it has a persisted path", async () => {
    const client = new FakeClient();
    const workspace = "/tmp/ws";
    client.snapshots.push(
      Promise.resolve(
        unboundSnapshot([{ path: workspace, name: "WS", current: false }]),
      ),
      Promise.resolve(activeSnapshot("session-new", "current:session-new")),
    );
    client.creationResult = async (commandId) => ({
      cancelled: false,
      commandId,
      sessionId: "session-new",
    });
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.setWorkspace(workspace);

    expect(await store.getState().actions.sendPrompt("first task")).toBe(true);
    expect(client.prompts).toEqual([
      { sessionId: "session-new", content: "first task" },
    ]);
  });

  it("keeps a running agent active when a handled follow-up settles", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const stream = eventStreamHarness();
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();
    stream.emit(runtimeEvent(5, "agent_start", { sessionId: "session-1" }));
    stream.emit(
      runtimeEvent(6, "prompt_settled", {
        sessionId: "session-1",
        commandId: "handled",
      }),
    );
    stream.emit(
      runtimeEvent(7, "prompt_accepted", {
        sessionId: "session-1",
        commandId: "handled",
      }),
    );
    expect(store.getState().livePhase).toBe("running");
    expect(store.getState().liveRunning).toBe(true);
    store.getState().actions.stop();
  });

  it("retries an uncertain admission with the same identity without idling the running turn", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const prompt = vi
      .spyOn(client, "prompt")
      .mockRejectedValueOnce(new TypeError("lost receipt"))
      .mockResolvedValueOnce({ id: "retry", accepted: true });
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    store.setState({ liveRunning: true, livePhase: "running" });
    expect(await store.getState().actions.sendPrompt("once")).toBe(false);
    expect(store.getState().liveRunning).toBe(true);
    expect(store.getState().liveMessages).toHaveLength(1);
    expect(await store.getState().actions.sendPrompt("once")).toBe(true);
    expect(prompt.mock.calls[0]?.[2]).toEqual(expect.any(String));
    expect(prompt.mock.calls[1]?.[2]).toBe(prompt.mock.calls[0]?.[2]);
    expect(prompt.mock.calls[1]?.[3]).toBe("/tmp/ws/session.jsonl");
    expect(prompt.mock.calls[1]?.[4]).toBe(true);
    store.getState().actions.stop();
  });

  it("reconciles an unknown admission and requires an explicit new request", async () => {
    const client = new FakeClient();
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(snapshot()),
    );
    const prompt = vi
      .spyOn(client, "prompt")
      .mockRejectedValueOnce(new TypeError("lost receipt"))
      .mockRejectedValueOnce(
        new WebApiError("unknown", 409, "COMMAND_ADMISSION_UNKNOWN"),
      )
      .mockResolvedValueOnce({ id: "new", accepted: true });
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();

    expect(await store.getState().actions.sendPrompt("once")).toBe(false);
    expect(await store.getState().actions.sendPrompt("once")).toBe(false);
    expect(store.getState().promptAdmissionRecovery).toMatchObject({
      content: "once",
      phase: "ready",
    });
    expect(store.getState().livePhase).toBe("idle");
    expect(store.getState().liveRunning).toBe(false);
    expect(await store.getState().actions.sendPrompt("once")).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(2);

    expect(await store.getState().actions.sendPromptAsNew("edited")).toBe(true);
    expect(prompt.mock.calls[2]?.[1]).toBe("edited");
    expect(prompt.mock.calls[2]?.[2]).not.toBe(prompt.mock.calls[0]?.[2]);
    expect(prompt.mock.calls[2]?.[4]).toBe(false);
    expect(store.getState().promptAdmissionRecovery).toBeNull();
  });

  it("keeps unknown admission recovery bound to its original same-ID file", async () => {
    const client = new FakeClient();
    let current = snapshot();
    vi.spyOn(client, "snapshot").mockImplementation(async () => current);
    const prompt = vi
      .spyOn(client, "prompt")
      .mockRejectedValueOnce(
        new WebApiError("unknown", 409, "COMMAND_ADMISSION_UNKNOWN"),
      );
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    expect(await store.getState().actions.sendPrompt("once")).toBe(false);
    expect(store.getState().promptAdmissionRecovery).toMatchObject({
      sessionId: "session-1",
      sessionPath: "/tmp/ws/session.jsonl",
      phase: "ready",
    });

    current = activeSnapshot("session-1", "/tmp/ws/copy.jsonl");
    expect(await store.getState().actions.refreshSnapshot()).toBe(true);
    expect(await store.getState().actions.sendPromptAsNew("once")).toBe(false);
    expect(prompt).toHaveBeenCalledOnce();
    expect(store.getState().promptAdmissionRecovery?.phase).toBe("ready");
    store.getState().actions.stop();
  });

  it("keeps unknown admission recovery fail-closed when verification fails", async () => {
    const client = new FakeClient();
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.reject(new Error("snapshot unavailable")),
    );
    const prompt = vi
      .spyOn(client, "prompt")
      .mockRejectedValueOnce(new TypeError("lost receipt"))
      .mockRejectedValueOnce(
        new WebApiError("unknown", 409, "COMMAND_ADMISSION_UNKNOWN"),
      )
      .mockResolvedValueOnce({ id: "new", accepted: true });
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();

    await store.getState().actions.sendPrompt("once");
    await store.getState().actions.sendPrompt("once");

    expect(store.getState().promptAdmissionRecovery?.phase).toBe(
      "verification-failed",
    );
    expect(await store.getState().actions.sendPromptAsNew("edited")).toBe(
      false,
    );
    expect(prompt).toHaveBeenCalledTimes(2);

    client.snapshots.push(Promise.resolve(snapshot()));
    await store.getState().actions.checkPromptAdmissionRecovery();
    expect(store.getState().promptAdmissionRecovery?.phase).toBe("ready");
  });

  it("preserves recovery when a replacement fails preflight or is empty", async () => {
    const client = new FakeClient();
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(snapshot()),
    );
    const prompt = vi
      .spyOn(client, "prompt")
      .mockRejectedValueOnce(new TypeError("lost receipt"))
      .mockRejectedValueOnce(
        new WebApiError("unknown", 409, "COMMAND_ADMISSION_UNKNOWN"),
      );
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    await store.getState().actions.sendPrompt("once");
    await store.getState().actions.sendPrompt("once");

    expect(await store.getState().actions.sendPromptAsNew("   ")).toBe(false);
    expect(store.getState().promptAdmissionRecovery?.phase).toBe("ready");

    store.setState({ modelSelectionPending: true });
    expect(await store.getState().actions.sendPromptAsNew("edited")).toBe(
      false,
    );
    expect(store.getState().promptAdmissionRecovery?.phase).toBe("ready");
    expect(store.getState().promptAdmissionRecovery?.content).toBe("once");
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("admits only one concurrent replacement and clears recovery after acceptance", async () => {
    const client = new FakeClient();
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(snapshot()),
    );
    const replacement = deferred<CommandReceipt>();
    const prompt = vi
      .spyOn(client, "prompt")
      .mockRejectedValueOnce(new TypeError("lost receipt"))
      .mockRejectedValueOnce(
        new WebApiError("unknown", 409, "COMMAND_ADMISSION_UNKNOWN"),
      )
      .mockReturnValueOnce(replacement.promise);
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    await store.getState().actions.sendPrompt("once");
    await store.getState().actions.sendPrompt("once");

    const first = store.getState().actions.sendPromptAsNew("edited");
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(3));
    expect(store.getState().promptAdmissionRecovery?.phase).toBe("submitting");
    expect(await store.getState().actions.sendPromptAsNew("edited")).toBe(
      false,
    );
    expect(prompt).toHaveBeenCalledTimes(3);

    replacement.resolve({ id: "new", accepted: true });
    expect(await first).toBe(true);
    expect(store.getState().promptAdmissionRecovery).toBeNull();
  });

  it("turns matching late canonical evidence into a draft resolution", async () => {
    const client = new FakeClient();
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(snapshot()),
    );
    const prompt = vi
      .spyOn(client, "prompt")
      .mockRejectedValueOnce(new TypeError("lost receipt"))
      .mockRejectedValueOnce(
        new WebApiError("unknown", 409, "COMMAND_ADMISSION_UNKNOWN"),
      );
    const stream = eventStreamHarness();
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();
    await store.getState().actions.sendPrompt("once");
    await store.getState().actions.sendPrompt("once");
    const commandId = String(prompt.mock.calls[0]?.[2]);

    stream.emit(
      runtimeEvent(5, "prompt_accepted", {
        sessionId: "session-1",
        commandId,
      }),
    );

    expect(store.getState().promptAdmissionRecovery).toBeNull();
    expect(store.getState().promptAdmissionResolution).toEqual({
      sessionId: "session-1",
      sessionPath: "/tmp/ws/session.jsonl",
      commandId,
      content: "once",
      images: [],
    });
    expect(store.getState().liveMessages).toEqual([
      {
        key: `optimistic-${commandId}`,
        timestamp: expect.any(String),
        optimistic: {
          sessionId: "session-1",
          sessionPath: "/tmp/ws/session.jsonl",
          commandId,
          afterEntryId: null,
          admitted: true,
        },
        message: { role: "user", content: "once" },
      },
    ]);
    expect(await store.getState().actions.sendPrompt("once")).toBe(false);
    store.getState().actions.acknowledgePromptAdmissionResolution(commandId);
    expect(store.getState().promptAdmissionResolution).toBeNull();
    store.getState().actions.stop();
  });

  it("clears recovery when changing workspace without treating navigation as admission evidence", async () => {
    const client = new FakeClient();
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(snapshot()),
    );
    vi.spyOn(client, "prompt")
      .mockRejectedValueOnce(new TypeError("lost receipt"))
      .mockRejectedValueOnce(
        new WebApiError("unknown", 409, "COMMAND_ADMISSION_UNKNOWN"),
      );
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    await store.getState().actions.sendPrompt("once");
    await store.getState().actions.sendPrompt("once");
    store.getState().actions.setWorkspace("/tmp/repo-b");

    expect(store.getState().promptAdmissionRecovery).toBeNull();
    expect(store.getState().promptAdmissionResolution).toBeNull();
  });

  it("abandons unknown admission recovery without clearing its draft content", async () => {
    const client = new FakeClient();
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(snapshot()),
    );
    vi.spyOn(client, "prompt")
      .mockRejectedValueOnce(new TypeError("lost receipt"))
      .mockRejectedValueOnce(
        new WebApiError("unknown", 409, "COMMAND_ADMISSION_UNKNOWN"),
      );
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    await store.getState().actions.sendPrompt("keep me");
    await store.getState().actions.sendPrompt("keep me");

    expect(store.getState().promptAdmissionRecovery?.content).toBe("keep me");
    store.getState().actions.abandonPromptAdmission();
    expect(store.getState().promptAdmissionRecovery).toBeNull();
    expect(store.getState().liveMessages).toHaveLength(0);
  });

  it("keeps canonical running state during recovery and clears it on Session switch", async () => {
    const client = new FakeClient();
    const running = snapshot();
    running.runtime = {
      status: "running",
      activeTurn: {
        sessionId: "session-1",
        commandId: "another-command",
        epoch: 2,
      },
      capabilities: {},
    };
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(running),
    );
    vi.spyOn(client, "prompt")
      .mockRejectedValueOnce(new TypeError("lost receipt"))
      .mockRejectedValueOnce(
        new WebApiError("unknown", 409, "COMMAND_ADMISSION_UNKNOWN"),
      );
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    await store.getState().actions.sendPrompt("once");
    await store.getState().actions.sendPrompt("once");

    expect(store.getState().promptAdmissionRecovery).not.toBeNull();
    expect(store.getState().livePhase).toBe("running");
    expect(store.getState().liveRunning).toBe(true);

    const next = activeSnapshot("session-2", "/tmp/ws/session-2.jsonl", {
      cursor: 9,
    });
    client.snapshots.push(Promise.resolve(next));
    await store.getState().actions.selectSession(next.selectedSession!.path);
    expect(store.getState().promptAdmissionRecovery).toBeNull();
  });

  it("restores the canonical running turn from a snapshot", async () => {
    const client = new FakeClient();
    const running = snapshot();
    running.runtime = {
      ...running.runtime,
      status: "running",
      activeTurn: { sessionId: "session-1", commandId: "turn", epoch: 2 },
    };
    client.snapshots.push(Promise.resolve(running));
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot({ resetCursor: true });
    expect(store.getState().liveRunning).toBe(true);
    expect(store.getState().activeTurn).toEqual(running.runtime.activeTurn);
  });

  it("cancels the exact active turn without optimistically ending it", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const cancellation = deferred<{ state: "accepted" }>();
    const cancel = vi
      .spyOn(client, "cancelActiveTurn")
      .mockReturnValue(cancellation.promise);
    const stream = eventStreamHarness();
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();
    const turn = { sessionId: "session-1", commandId: "turn", epoch: 4 };
    stream.emit(runtimeEvent(5, "turn_started", turn));
    const stopping = store.getState().actions.cancelActiveTurn();
    expect(cancel).toHaveBeenCalledWith(turn);
    expect(store.getState().turnCancellationPending).toBe(true);
    expect(store.getState().liveRunning).toBe(true);
    stream.emit(
      runtimeEvent(6, "turn_settled", {
        ...turn,
        epoch: 3,
        outcome: "cancelled",
      }),
    );
    expect(store.getState().liveRunning).toBe(true);
    cancellation.resolve({ state: "accepted" });
    await stopping;
    expect(store.getState().liveRunning).toBe(true);
    stream.emit(
      runtimeEvent(7, "turn_settled", { ...turn, outcome: "cancelled" }),
    );
    expect(store.getState().activeTurn).toBeNull();
    expect(store.getState().turnTerminalStatus).toBe("cancelled");
    expect(store.getState().liveRunning).toBe(false);
    store.getState().actions.stop();
  });

  it("starts a new admission identity only after a definite rejection", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const prompt = vi
      .spyOn(client, "prompt")
      .mockRejectedValueOnce(
        new WebApiError("full", 503, "PROMPT_ADMISSION_CAPACITY"),
      )
      .mockResolvedValueOnce({
        id: "new",
        accepted: true,
        pendingFollowUps: 2,
      });
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    expect(await store.getState().actions.sendPrompt("once")).toBe(false);
    expect(store.getState().liveMessages).toHaveLength(0);
    expect(await store.getState().actions.sendPrompt("once")).toBe(true);
    expect(prompt.mock.calls[1]?.[2]).not.toBe(prompt.mock.calls[0]?.[2]);
    expect(prompt.mock.calls[1]?.[4]).toBe(false);
    expect(store.getState().pendingFollowUpsReceipt).toBe(2);
    store.getState().actions.stop();
  });

  it("preserves retry identity when successful headers have a truncated receipt body", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("{", { status: 202 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "stable-receipt", accepted: true }), {
          status: 202,
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(client, "prompt").mockImplementation((...args) =>
      WebClient.prototype.prompt.call(client, ...args),
    );
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    expect(await store.getState().actions.sendPrompt("once")).toBe(false);
    expect(store.getState().liveMessages).toHaveLength(1);
    expect(await store.getState().actions.sendPrompt("once")).toBe(true);
    const first = JSON.parse(String(fetcher.mock.calls[0]?.[1].body));
    const second = JSON.parse(String(fetcher.mock.calls[1]?.[1].body));
    expect(second.commandId).toBe(first.commandId);
    expect(second.retry).toBe(true);
    store.getState().actions.stop();
  });

  it("persists only browser-local navigation preferences", () => {
    const client = new FakeClient();
    const store = createWebStore(client);
    store.getState().actions.toggleWorkspace("/tmp/ws");
    store.getState().actions.toggleSidebar(false);

    expect(
      JSON.parse(
        window.sessionStorage.getItem("openpi.collapsed-workspaces") || "[]",
      ),
    ).toEqual(["/tmp/ws"]);
    expect(window.sessionStorage.getItem("openpi.sidebar-collapsed")).toBe(
      "true",
    );
    expect(window.localStorage?.length ?? 0).toBe(0);
  });

  it("preserves spaces in the controlled Session search query", () => {
    const store = createWebStore(new FakeClient());

    store.getState().actions.setQuery("foo ");
    expect(store.getState().query).toBe("foo ");

    store.getState().actions.setQuery(`${store.getState().query}bar`);
    expect(store.getState().query).toBe("foo bar");
  });

  it("keeps mobile drawer state separate from the desktop preference", () => {
    const store = createWebStore(new FakeClient());

    store.getState().actions.toggleSidebar(true);
    expect(store.getState().mobileSidebarOpen).toBe(true);
    expect(store.getState().sidebarCollapsed).toBe(false);

    store.getState().actions.closeMobileSidebar();
    expect(store.getState().mobileSidebarOpen).toBe(false);
    expect(store.getState().sidebarCollapsed).toBe(false);

    store.getState().actions.toggleSidebar(false);
    expect(store.getState().sidebarCollapsed).toBe(true);
    expect(store.getState().mobileSidebarOpen).toBe(false);
  });
});

it("restores the exact archived path without selecting it and refreshes canonical state", async () => {
  const client = new FakeClient();
  const restore = vi
    .spyOn(client, "unarchiveSession")
    .mockResolvedValue({ path: "/tmp/ws/saved.jsonl", archived: false });
  const next = snapshot("Restored");
  client.snapshots.push(Promise.resolve(next));
  const store = createWebStore(client);
  expect(
    await store.getState().actions.unarchiveSession("/tmp/ws/saved.jsonl"),
  ).toBe(true);
  expect(restore).toHaveBeenCalledWith("/tmp/ws/saved.jsonl");
  expect(client.selections).toEqual([]);
  expect(store.getState().snapshot?.sessions[0]?.name).toBe("Restored");
});

it("keeps archive restoration failure observable without pretending to refresh", async () => {
  const client = new FakeClient();
  vi.spyOn(client, "unarchiveSession").mockRejectedValue(
    new Error("archive write failed"),
  );
  const store = createWebStore(client);
  expect(
    await store.getState().actions.unarchiveSession("/tmp/ws/saved.jsonl"),
  ).toBe(false);
  expect(store.getState().notice).toBe("archive write failed");
  expect(client.snapshotPaths).toEqual([]);
});

describe("draft model selection", () => {
  function draftHarness() {
    const client = new FakeClient();
    const store = createWebStore(client);
    const initial = snapshot();
    delete initial.selectedSession;
    delete initial.currentSessionId;
    initial.sessions = [];
    initial.workspaces = [];
    store.setState({ snapshot: initial });
    return { client, store };
  }

  it("prepares settings before the first prompt and reuses the confirmed Session", async () => {
    const { client, store } = draftHarness();
    store.getState().actions.setWorkspace("/tmp/ws");
    client.snapshots.push(Promise.resolve(snapshot()));
    const target = await store.getState().actions.prepareSession();
    expect(target?.sessionId).toBe("session-1");
    expect(client.creations).toHaveLength(1);
    expect(client.prompts).toHaveLength(0);
    expect(await store.getState().actions.prepareSession()).toMatchObject({
      sessionId: target?.sessionId,
      workspacePath: "/tmp/ws",
    });
    expect(client.creations).toHaveLength(1);
  });

  it("does not prepare or prompt when initial workspace selection is cancelled", async () => {
    const { client, store } = draftHarness();
    expect(await store.getState().actions.prepareSession()).toBeNull();
    expect(client.creations).toHaveLength(0);
    expect(client.prompts).toHaveLength(0);
  });

  it("selects before a workspace without creating or mutating a Session and retains it after chooser cancellation", async () => {
    const { client, store } = draftHarness();
    await store.getState().actions.selectModel("test/model");
    await store.getState().actions.chooseWorkspace();
    expect(store.getState().draftModel?.id).toBe("model");
    expect(client.creations).toHaveLength(0);
    expect(client.modelSelections).toHaveLength(0);
    expect(store.getState().selectedWorkspace).toBeNull();
  });

  it("waits for confirmed model selection before the first prompt and ignores duplicate sends", async () => {
    const { client, store } = draftHarness();
    await store.getState().actions.selectModel("test/model");
    store.setState({ selectedWorkspace: "/tmp/ws" });
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(snapshot()),
    );
    const selected = deferred<WebModelSummary>();
    client.modelResult = selected.promise;
    const sending = store.getState().actions.sendPrompt("hello");
    await vi.waitFor(() => expect(client.modelSelections).toHaveLength(1));
    expect(client.prompts).toHaveLength(0);
    expect(await store.getState().actions.sendPrompt("duplicate")).toBe(false);
    selected.resolve(snapshot().models[0]!);
    expect(await sending).toBe(true);
    expect(client.creations).toHaveLength(1);
    expect(client.prompts).toEqual([
      { sessionId: "session-1", content: "hello" },
    ]);
    expect(store.getState().draftModel).toBeNull();
    store.getState().actions.stop();
  });

  it("does not apply a draft model to a Session activated by another tab", async () => {
    const { client, store } = draftHarness();
    await store.getState().actions.selectModel("test/model");
    store.getState().actions.setWorkspace("/tmp/repo-a");
    client.snapshots.push(
      Promise.resolve(
        activeSnapshot("session-b", "/tmp/repo-b/session.jsonl", {
          workspace: "/tmp/repo-b",
        }),
      ),
    );
    client.creationResult = async (commandId) => ({
      cancelled: false,
      commandId,
      sessionId: "session-a",
    });

    expect(await store.getState().actions.sendPrompt("hello A")).toBe(false);
    expect(client.modelSelections).toEqual([]);
    expect(client.prompts).toEqual([]);
    expect(store.getState().draftModel?.id).toBe("model");
    expect(store.getState().notice).toContain("no longer active");
  });

  it("blocks fallback on unavailable model and retries using the already-created Session", async () => {
    const { client, store } = draftHarness();
    await store.getState().actions.selectModel("test/model");
    store.setState({ selectedWorkspace: "/tmp/ws" });
    client.snapshots.push(Promise.resolve(snapshot()));
    client.modelResult = Promise.resolve(snapshot().models[0]!);
    vi.spyOn(client, "selectModel").mockRejectedValueOnce(
      new WebApiError("Model unavailable", 400, "MODEL_NOT_AVAILABLE"),
    );
    expect(await store.getState().actions.sendPrompt("hello")).toBe(false);
    expect(client.prompts).toHaveLength(0);
    expect(store.getState().draftModel?.id).toBe("model");
    expect(store.getState().notice).toBe("Model unavailable");
    client.snapshots.push(Promise.resolve(snapshot()));
    expect(await store.getState().actions.sendPrompt("hello")).toBe(true);
    expect(client.creations).toHaveLength(1);
    store.getState().actions.stop();
  });

  it("keeps the draft and blocks sending when the refreshed Session has a different model", async () => {
    const { client, store } = draftHarness();
    await store.getState().actions.selectModel("test/model");
    store.setState({ selectedWorkspace: "/tmp/ws" });
    const changed = snapshot();
    changed.models = [{ ...changed.models[0]!, id: "other" }];
    client.snapshots.push(
      Promise.resolve(snapshot()),
      Promise.resolve(changed),
    );
    expect(await store.getState().actions.sendPrompt("hello")).toBe(false);
    expect(client.prompts).toHaveLength(0);
    expect(store.getState().draftModel?.id).toBe("model");
    expect(store.getState().notice).toContain("model changed");
  });

  it("rejects a confirmation from a different provider instead of sending with a same-named model", async () => {
    const { client, store } = draftHarness();
    await store.getState().actions.selectModel("test/model");
    store.setState({ selectedWorkspace: "/tmp/ws" });
    client.snapshots.push(Promise.resolve(snapshot()));
    client.modelResult = Promise.resolve({
      ...snapshot().models[0]!,
      provider: "other",
    });
    expect(await store.getState().actions.sendPrompt("hello")).toBe(false);
    expect(client.prompts).toHaveLength(0);
    expect(store.getState().draftModel?.provider).toBe("test");
    expect(store.getState().notice).toContain("not confirmed");
  });

  it("never sends to a newer selected Session after draft creation is superseded", async () => {
    const { client, store } = draftHarness();
    await store.getState().actions.selectModel("test/model");
    store.setState({ selectedWorkspace: "/tmp/ws" });
    const creation = deferred<SessionCreationResult>();
    client.creationResult = () => creation.promise;
    const sending = store.getState().actions.sendPrompt("hello");
    await vi.waitFor(() => expect(client.creations).toHaveLength(1));
    client.snapshots.push(
      Promise.resolve(activeSnapshot("other", "/tmp/ws/other.jsonl")),
    );
    const selecting = store
      .getState()
      .actions.selectSession("/tmp/ws/other.jsonl");
    creation.resolve({
      cancelled: false,
      commandId: client.creations[0]!.commandId,
      sessionId: "session-1",
    });
    expect(await sending).toBe(false);
    await selecting;
    expect(client.prompts).toHaveLength(0);
    expect(client.modelSelections).toHaveLength(0);
    expect(store.getState().draftModel).toBeNull();
  });
});

describe("workspace selection authority", () => {
  const workspace = "/tmp/repo-b";
  const sessionPath = `${workspace}/session.jsonl`;

  async function harness() {
    const client = new FakeClient();
    const initial = snapshot();
    initial.workspaces.push({ path: workspace, name: "B", current: false });
    client.snapshots.push(Promise.resolve(initial));
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    return { client, initial, store };
  }

  it("ignores stale snapshots, blocks duplicate sends, and waits for the exact B Session", async () => {
    const { client, initial, store } = await harness();
    const stale = deferred<WebSnapshot>();
    client.snapshots.push(stale.promise);
    const refreshing = store.getState().actions.refreshSnapshot();
    store.getState().actions.setWorkspace(workspace);
    stale.resolve(initial);
    expect(await refreshing).toBe(false);
    expect(store.getState().selectedWorkspace).toBe(workspace);

    const creation = deferred<SessionCreationResult>();
    client.creationResult = () => creation.promise;
    client.snapshots.push(
      Promise.resolve(activeSnapshot("b", sessionPath, { workspace })),
    );
    const sending = store.getState().actions.sendPrompt("B only");
    await vi.waitFor(() => expect(client.creations).toHaveLength(1));
    expect(store.getState().sessionSwitching).toBe(true);
    expect(await store.getState().actions.sendPrompt("duplicate")).toBe(false);
    expect(client.prompts).toEqual([]);
    creation.resolve({
      cancelled: false,
      commandId: client.creations[0]!.commandId,
      sessionId: "b",
      sessionPath,
    });
    expect(await sending).toBe(true);
    expect(client.prompts).toEqual([{ sessionId: "b", content: "B only" }]);
    store.getState().actions.stop();
  });

  it("retains an imported workspace even when an existing Session stays current", async () => {
    const { client, initial, store } = await harness();
    client.workspaceResult = Promise.resolve({ path: workspace });
    client.snapshots.push(Promise.resolve(initial), Promise.resolve(initial));
    await store.getState().actions.chooseWorkspace();
    await store.getState().actions.refreshSnapshot();
    expect(store.getState().selectedWorkspace).toBe(workspace);
    expect(store.getState().workspaceDraft).toBe(true);
    expect(client.creations).toEqual([]);
    expect(client.prompts).toEqual([]);
  });

  it("reuses the creation command after activation succeeded but its response was lost", async () => {
    const { client, store } = await harness();
    store.getState().actions.setWorkspace(workspace);
    const activated = activeSnapshot("b", sessionPath, { workspace });
    client.creationResult = async () => {
      throw new Error("response lost");
    };
    client.snapshots.push(Promise.resolve(activated));
    expect(await store.getState().actions.sendPrompt("B only")).toBe(false);
    const originalCommand = client.creations[0]!.commandId;
    client.creationResult = async (commandId) => ({
      cancelled: false,
      commandId,
      sessionId: "b",
      sessionPath,
    });
    client.snapshots.push(Promise.resolve(activated));
    expect(await store.getState().actions.sendPrompt("B only")).toBe(true);
    expect(client.creations.map((call) => call.commandId)).toEqual([
      originalCommand,
      originalCommand,
    ]);
    expect(client.prompts).toEqual([{ sessionId: "b", content: "B only" }]);
    store.getState().actions.stop();
  });

  it("retains B on creation failure and retries without falling back to A", async () => {
    const { client, initial, store } = await harness();
    store.getState().actions.setWorkspace(workspace);
    client.creationResult = async () => {
      throw new Error("creation failed");
    };
    client.snapshots.push(Promise.resolve(initial));
    expect(await store.getState().actions.sendPrompt("B only")).toBe(false);
    expect(store.getState().notice).toBe("creation failed");
    expect(store.getState().selectedWorkspace).toBe(workspace);
    expect(store.getState().workspaceDraft).toBe(true);
    expect(client.prompts).toEqual([]);

    client.creationResult = async (commandId) => ({
      cancelled: false,
      commandId,
      sessionId: "b",
      sessionPath,
    });
    client.snapshots.push(
      Promise.resolve(activeSnapshot("b", sessionPath, { workspace })),
    );
    expect(await store.getState().actions.sendPrompt("B only")).toBe(true);
    expect(
      client.creations.every((call) => call.workspacePath === workspace),
    ).toBe(true);
    expect(new Set(client.creations.map((call) => call.commandId)).size).toBe(
      1,
    );
    expect(client.prompts).toEqual([{ sessionId: "b", content: "B only" }]);
    store.getState().actions.stop();
  });

  it("rechecks creation when a newer snapshot supersedes its confirmation", async () => {
    const { client, store } = await harness();
    const creation = deferred<SessionCreationResult>();
    const slowConfirmation = deferred<WebSnapshot>();
    const active = activeSnapshot("b", sessionPath, { workspace });
    client.creationResult = () => creation.promise;
    client.snapshots.push(
      slowConfirmation.promise,
      Promise.resolve(active),
      Promise.resolve(active),
    );
    store.getState().actions.setWorkspace(workspace);

    const sending = store.getState().actions.sendPrompt("B only");
    await vi.waitFor(() => expect(client.creations).toHaveLength(1));
    creation.resolve({
      cancelled: false,
      commandId: client.creations[0]!.commandId,
      sessionId: "b",
      sessionPath,
    });
    await vi.waitFor(() => expect(client.snapshotPaths).toHaveLength(2));

    expect(await store.getState().actions.refreshSnapshot()).toBe(true);
    slowConfirmation.resolve(active);

    expect(await sending).toBe(true);
    expect(client.creations).toHaveLength(1);
    expect(client.prompts).toEqual([{ sessionId: "b", content: "B only" }]);
    expect(store.getState().notice).toBeNull();
    store.getState().actions.stop();
  });

  it.each([
    {
      name: "cancelled creation",
      receipt: { cancelled: true, sessionId: "b" },
      next: snapshot(),
    },
    { name: "missing creation identity", receipt: {}, next: snapshot() },
    {
      name: "different workspace",
      receipt: { cancelled: false, sessionId: "b", sessionPath },
      next: snapshot(),
    },
    {
      name: "different Session in B",
      receipt: { cancelled: false, sessionId: "b", sessionPath },
      next: activeSnapshot("other", `${workspace}/other.jsonl`, { workspace }),
    },
  ])(
    "blocks $name without clearing the workspace draft",
    async ({ receipt, next }) => {
      const { client, store } = await harness();
      store.getState().actions.setWorkspace(workspace);
      client.creationResult = async (commandId) =>
        ({ commandId, ...receipt }) as SessionCreationResult;
      client.snapshots.push(Promise.resolve(next), Promise.resolve(next));
      expect(await store.getState().actions.sendPrompt("B only")).toBe(false);
      expect(client.prompts).toEqual([]);
      expect(store.getState().selectedWorkspace).toBe(workspace);
      expect(store.getState().workspaceDraft).toBe(true);
      expect(store.getState().notice).toBeTruthy();
    },
  );

  it("does not overwrite a newer workspace intent with a late folder chooser result", async () => {
    const { client, store } = await harness();
    const chooser = deferred<WorkspaceSelectionResult>();
    client.workspaceResult = chooser.promise;
    const choosing = store.getState().actions.chooseWorkspace();
    store.getState().actions.setWorkspace(workspace);
    chooser.resolve({ path: "/tmp/old-choice" });
    await choosing;
    expect(store.getState().selectedWorkspace).toBe(workspace);
    expect(client.creations).toEqual([]);
  });

  it("never sends an in-flight B draft after the user chooses C", async () => {
    const { client, store } = await harness();
    const creation = deferred<SessionCreationResult>();
    client.creationResult = () => creation.promise;
    store.getState().actions.setWorkspace(workspace);
    const sending = store.getState().actions.sendPrompt("B only");
    await vi.waitFor(() => expect(client.creations).toHaveLength(1));
    store.getState().actions.setWorkspace("/tmp/repo-c");
    creation.resolve({
      cancelled: false,
      commandId: client.creations[0]!.commandId,
      sessionId: "b",
      sessionPath,
    });
    expect(await sending).toBe(false);
    expect(store.getState().selectedWorkspace).toBe("/tmp/repo-c");
    expect(store.getState().workspaceDraft).toBe(true);
    expect(client.prompts).toEqual([]);
  });

  it("clears workspace intent only when the user explicitly opens a Session", async () => {
    const { client, initial, store } = await harness();
    store.getState().actions.setWorkspace(workspace);
    client.snapshots.push(Promise.resolve(initial));
    await store.getState().actions.selectSession(initial.selectedSession!.path);
    expect(store.getState().workspaceDraft).toBe(false);
    expect(store.getState().selectedWorkspace).toBe("/tmp/ws");
    expect(client.creations).toEqual([]);
  });

  it("choosing the original directory from another draft does not resume its old Session", async () => {
    const { client, initial, store } = await harness();
    store.getState().actions.setWorkspace(workspace);
    store.getState().actions.setWorkspace("/tmp/ws");
    client.snapshots.push(Promise.resolve(initial));
    await store.getState().actions.refreshSnapshot();
    expect(store.getState().selectedWorkspace).toBe("/tmp/ws");
    expect(store.getState().workspaceDraft).toBe(true);
    const createdPath = "/tmp/ws/fresh.jsonl";
    client.creationResult = async (commandId) => ({
      cancelled: false,
      commandId,
      sessionId: "fresh",
      sessionPath: createdPath,
    });
    client.snapshots.push(
      Promise.resolve(activeSnapshot("fresh", createdPath)),
    );
    expect(await store.getState().actions.sendPrompt("new task")).toBe(true);
    expect(client.prompts).toEqual([
      { sessionId: "fresh", content: "new task" },
    ]);
    store.getState().actions.stop();
  });

  it("keeps draft model selection local despite a running Session in A", async () => {
    const { client, initial, store } = await harness();
    initial.runtime.status = "running";
    store.setState({ snapshot: initial, liveRunning: true });
    store.getState().actions.setWorkspace(workspace);
    await store.getState().actions.selectModel("test/model");
    expect(store.getState().draftModel?.id).toBe("model");
    expect(client.modelSelections).toEqual([]);
    expect(client.creations).toEqual([]);
  });
});

function withThinking(
  next: WebSnapshot,
  thinking: Partial<NonNullable<WebSnapshot["thinking"]>> = {},
) {
  next.thinking = {
    level: "medium",
    available: ["off", "minimal", "low", "medium", "high"],
    supported: true,
    revision: 1,
    ...thinking,
  };
  return next;
}

describe("thinking level selection", () => {
  async function harness(
    thinking: Partial<NonNullable<WebSnapshot["thinking"]>> = {},
  ) {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(withThinking(snapshot(), thinking)));
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();
    return { client, store };
  }

  it("sends nothing for the confirmed level and applies a changed level once", async () => {
    const { client, store } = await harness({ level: "medium", revision: 4 });

    store.getState().actions.selectThinking("medium");
    expect(client.thinkings).toEqual([]);
    expect(store.getState().thinkingPendingLevel).toBeNull();

    store.getState().actions.selectThinking("high");
    expect(store.getState().thinkingPendingLevel).toBe("high");
    expect(client.thinkings).toEqual([
      { sessionId: "session-1", level: "high" },
    ]);
    await vi.waitFor(() =>
      expect(store.getState().thinkingPendingLevel).toBeNull(),
    );
    expect(store.getState().snapshot?.thinking).toMatchObject({
      level: "high",
      revision: 1_001,
    });
    store.getState().actions.stop();
  });

  it("keeps a newer pending intent while a selection is in flight", async () => {
    const { client, store } = await harness();
    const first = deferred<WebThinkingState & { sessionId: string }>();
    client.setThinkingResults.push(first.promise);

    store.getState().actions.selectThinking("low");
    store.getState().actions.selectThinking("low");
    expect(client.thinkings).toEqual([
      { sessionId: "session-1", level: "low" },
    ]);
    store.getState().actions.selectThinking("high");
    expect(store.getState().thinkingPendingLevel).toBe("high");
    expect(client.thinkings).toHaveLength(1);

    first.resolve({
      sessionId: "session-1",
      level: "low",
      available: ["off", "minimal", "low", "medium", "high"],
      supported: true,
      revision: 2,
    });
    await vi.waitFor(() =>
      expect(store.getState().thinkingPendingLevel).toBeNull(),
    );
    expect(client.thinkings).toEqual([
      { sessionId: "session-1", level: "low" },
      { sessionId: "session-1", level: "high" },
    ]);
    expect(store.getState().snapshot?.thinking?.level).toBe("high");
    store.getState().actions.stop();
  });

  it("clears pending on a Session switch without touching the new Session", async () => {
    const { client, store } = await harness();
    const first = deferred<WebThinkingState & { sessionId: string }>();
    client.setThinkingResults.push(first.promise);
    client.selectionResults.push(Promise.resolve({}));
    client.snapshots.push(
      Promise.resolve(
        withThinking(activeSnapshot("session-2", "/tmp/ws/b.jsonl"), {
          level: "medium",
          revision: 5,
        }),
      ),
    );

    store.getState().actions.selectThinking("low");
    expect(store.getState().thinkingPendingLevel).toBe("low");
    await store.getState().actions.selectSession("/tmp/ws/b.jsonl");

    expect(store.getState().thinkingPendingLevel).toBeNull();
    expect(store.getState().selectedPath).toBe("/tmp/ws/b.jsonl");

    first.resolve({
      sessionId: "session-1",
      level: "low",
      available: ["off", "minimal", "low", "medium", "high"],
      supported: true,
      revision: 2,
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(store.getState().snapshot?.currentSessionId).toBe("session-2");
    expect(store.getState().snapshot?.thinking).toMatchObject({
      level: "medium",
      revision: 5,
    });
    expect(client.thinkings).toEqual([
      { sessionId: "session-1", level: "low" },
    ]);
    store.getState().actions.stop();
  });

  for (const resetCursor of [false, true]) {
    for (const outcome of ["success", "rejection"] as const) {
      it(`same-ID controller changes require explicit selection and protect a newer thinking POST from late ${outcome} (resetCursor=${resetCursor})`, async () => {
        const { client, store } = await harness({ revision: 40 });
        const superseded = deferred<WebThinkingState & { sessionId: string }>();
        client.setThinkingResults.push(superseded.promise);
        const mutations = vi.spyOn(client, "setThinkingLevel");
        try {
          store.getState().actions.selectThinking("high");
          expect(store.getState().thinkingPendingLevel).toBe("high");

          const copiedPath = "/tmp/ws/copied.jsonl";
          const copied: WebSnapshot = withThinking(
            activeSnapshot("session-1", copiedPath, { cursor: 41 }),
            { level: "medium", revision: 2 },
          );
          copied.sessions.push({
            ...snapshot().sessions[0],
            controller: "none",
          });
          // Keep the old file readable while the controller moves to its
          // same-ID copy. Only explicit selection can enable new mutations.
          client.snapshots.push(
            Promise.resolve({
              ...copied,
              selectedSession: snapshot().selectedSession,
            }),
            Promise.resolve(copied),
          );
          expect(
            await store.getState().actions.refreshSnapshot({ resetCursor }),
          ).toBe(true);
          expect(client.snapshotPaths.at(-1)).toBe("/tmp/ws/session.jsonl");
          expect(store.getState().selectedPath).toBe("/tmp/ws/session.jsonl");
          expect(store.getState().thinkingPendingLevel).toBeNull();
          expect(store.getState().snapshot?.thinking).toMatchObject({
            level: "medium",
            revision: 2,
          });
          store.getState().actions.selectThinking("low");
          expect(mutations).toHaveBeenCalledOnce();
          await store.getState().actions.selectSession(copiedPath);
          expect(store.getState().selectedPath).toBe(copiedPath);

          const newer = deferred<WebThinkingState & { sessionId: string }>();
          client.setThinkingResults.push(newer.promise);
          store.getState().actions.selectThinking("low");
          expect(mutations).toHaveBeenLastCalledWith(
            "session-1",
            "low",
            copiedPath,
          );
          expect(mutations).toHaveBeenCalledTimes(2);
          expect(store.getState().thinkingPendingLevel).toBe("low");

          if (outcome === "success") {
            superseded.resolve({
              ...copied.thinking!,
              sessionId: "session-1",
              level: "high",
              revision: 999,
            });
          } else {
            superseded.reject(
              new WebApiError("old file is inactive", 409, "SESSION_CONFLICT"),
            );
          }
          await new Promise((resolve) => window.setTimeout(resolve, 0));
          expect(store.getState().thinkingPendingLevel).toBe("low");
          expect(store.getState().snapshot?.thinking).toMatchObject({
            level: "medium",
            revision: 2,
          });
          expect(store.getState().notice).toBeNull();
          expect(mutations).toHaveBeenCalledTimes(2);

          newer.resolve({
            ...copied.thinking!,
            sessionId: "session-1",
            level: "low",
            revision: 3,
          });
          await vi.waitFor(() =>
            expect(store.getState().thinkingPendingLevel).toBeNull(),
          );
          expect(store.getState().snapshot?.thinking).toMatchObject({
            level: "low",
            revision: 3,
          });
          expect(
            await store.getState().actions.sendPrompt("after recovery"),
          ).toBe(true);
          expect(client.prompts).toEqual([
            { sessionId: "session-1", content: "after recovery" },
          ]);
        } finally {
          store.getState().actions.stop();
        }
      });
    }
  }

  it("canonical same-ID copy recovery ignores the old file's thinking reconciliation GET", async () => {
    const { client, store } = await harness({ revision: 40 });
    const reconciliation = deferred<WebThinkingState & { sessionId: string }>();
    client.thinkingResult = reconciliation.promise;
    client.setThinkingResults.push(
      Promise.reject(new Error("old POST failed")),
    );
    try {
      store.getState().actions.selectThinking("high");
      await vi.waitFor(() =>
        expect(client.thinkingRequests).toEqual(["session-1"]),
      );
      expect(store.getState().thinkingPendingLevel).toBeNull();

      const copied = withThinking(
        activeSnapshot("session-1", "/tmp/ws/copied.jsonl", { cursor: 41 }),
        { level: "medium", revision: 2 },
      );
      client.snapshots.push(Promise.resolve(copied), Promise.resolve(copied));
      expect(await store.getState().actions.refreshSnapshot()).toBe(true);
      expect(store.getState().selectedPath).toBe("/tmp/ws/copied.jsonl");
      expect(store.getState().snapshot?.thinking).toMatchObject({
        level: "medium",
        revision: 2,
      });

      reconciliation.resolve({
        ...copied.thinking!,
        sessionId: "session-1",
        level: "high",
        revision: 999,
      });
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(store.getState().snapshot?.thinking).toMatchObject({
        level: "medium",
        revision: 2,
      });
    } finally {
      store.getState().actions.stop();
    }
  });

  it("resets pending when the operator selects a different model", async () => {
    const { client, store } = await harness();
    const first = deferred<WebThinkingState & { sessionId: string }>();
    client.setThinkingResults.push(first.promise);
    const model = deferred<WebModelSummary>();
    client.modelResult = model.promise;
    const changed = withThinking(snapshot(), { level: "low", revision: 6 });
    changed.models = [
      {
        provider: "test",
        id: "other",
        name: "other",
        label: "Other model",
        current: true,
      },
    ];
    client.snapshots.push(Promise.resolve(changed));

    store.getState().actions.selectThinking("high");
    const selecting = store.getState().actions.selectModel("test/other");
    expect(store.getState().thinkingPendingLevel).toBeNull();

    model.resolve({
      provider: "test",
      id: "other",
      name: "other",
      label: "Other model",
      current: true,
    });
    await selecting;
    first.resolve({
      sessionId: "session-1",
      level: "high",
      available: ["off", "minimal", "low", "medium", "high"],
      supported: true,
      revision: 2,
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(store.getState().snapshot?.thinking).toMatchObject({
      level: "low",
      revision: 6,
    });
    store.getState().actions.stop();
  });

  it("clears pending, surfaces the failure, and reconciles over GET", async () => {
    const { client, store } = await harness();
    client.setThinkingResults.push(Promise.reject(new Error("network down")));
    client.thinkingResult = Promise.resolve({
      sessionId: "session-1",
      level: "medium",
      available: ["off", "minimal", "low", "medium", "high"],
      supported: true,
      revision: 8,
    });

    store.getState().actions.selectThinking("high");
    await vi.waitFor(() =>
      expect(store.getState().notice).toBe("network down"),
    );
    await vi.waitFor(() =>
      expect(store.getState().snapshot?.thinking?.revision).toBe(8),
    );

    expect(store.getState().thinkingPendingLevel).toBeNull();
    expect(client.thinkingRequests).toEqual(["session-1"]);
    store.getState().actions.stop();
  });

  it("surfaces a Host 501 thinking-control error as a notice", async () => {
    const { client, store } = await harness();
    client.setThinkingResults.push(
      Promise.reject(
        new WebApiError(
          "thinking control is unavailable",
          501,
          "THINKING_CONTROL_UNAVAILABLE",
        ),
      ),
    );

    store.getState().actions.selectThinking("high");
    await vi.waitFor(() =>
      expect(store.getState().notice).toBe("thinking control is unavailable"),
    );
    expect(store.getState().thinkingPendingLevel).toBeNull();
    store.getState().actions.stop();
  });

  it("does not regress when a stale snapshot arrives after a POST patch", async () => {
    const { client, store } = await harness();
    store.getState().actions.selectThinking("high");
    await vi.waitFor(() =>
      expect(store.getState().thinkingPendingLevel).toBeNull(),
    );
    expect(store.getState().snapshot?.thinking?.level).toBe("high");

    client.snapshots.push(
      Promise.resolve(
        withThinking(snapshot(), { level: "minimal", revision: 2 }),
      ),
    );
    expect(await store.getState().actions.refreshSnapshot()).toBe(true);

    expect(store.getState().snapshot?.thinking).toMatchObject({
      level: "high",
      revision: 1_001,
    });
    store.getState().actions.stop();
  });

  it("keeps the newest snapshot revision even before a selection", async () => {
    const { client, store } = await harness({ level: "medium", revision: 10 });
    client.snapshots.push(
      Promise.resolve(withThinking(snapshot(), { level: "low", revision: 4 })),
    );

    expect(await store.getState().actions.refreshSnapshot()).toBe(true);
    expect(store.getState().snapshot?.thinking).toMatchObject({
      level: "medium",
      revision: 10,
    });
    store.getState().actions.stop();
  });

  it("clears the revision gate on a cursor reset after a host restart", async () => {
    const { client, store } = await harness({ level: "medium", revision: 40 });
    store.getState().actions.selectThinking("high");
    await vi.waitFor(() =>
      expect(store.getState().thinkingPendingLevel).toBeNull(),
    );
    expect(store.getState().snapshot?.thinking).toMatchObject({
      level: "high",
      revision: 1_001,
    });
    store.getState().actions.stop();

    // A restarted host restarts its sequence, so the revision floor resets.
    client.snapshots.push(
      Promise.resolve(withThinking(snapshot(), { level: "low", revision: 0 })),
    );
    expect(
      await store.getState().actions.refreshSnapshot({ resetCursor: true }),
    ).toBe(true);

    expect(store.getState().snapshot?.thinking).toMatchObject({
      level: "low",
      revision: 0,
    });
  });

  it("does not resurrect an accepted level when a snapshot omits thinking", async () => {
    const { client, store } = await harness({ level: "medium", revision: 40 });
    store.getState().actions.selectThinking("high");
    await vi.waitFor(() =>
      expect(store.getState().thinkingPendingLevel).toBeNull(),
    );
    expect(store.getState().snapshot?.thinking).toMatchObject({
      level: "high",
    });
    store.getState().actions.stop();

    client.snapshots.push(Promise.resolve(snapshot()));
    expect(await store.getState().actions.refreshSnapshot()).toBe(true);
    expect(store.getState().snapshot?.thinking).toBeUndefined();
  });

  it("adopts the new Session projection even when its revision is lower", async () => {
    const { client, store } = await harness({ level: "medium", revision: 40 });
    store.getState().actions.selectThinking("high");
    await vi.waitFor(() =>
      expect(store.getState().thinkingPendingLevel).toBeNull(),
    );
    expect(store.getState().snapshot?.thinking?.revision).toBe(1_001);
    store.getState().actions.stop();

    client.selectionResults.push(Promise.resolve({}));
    client.snapshots.push(
      Promise.resolve(
        withThinking(activeSnapshot("session-2", "/tmp/ws/b.jsonl"), {
          level: "low",
          revision: 5,
        }),
      ),
    );
    await store.getState().actions.selectSession("/tmp/ws/b.jsonl");

    expect(store.getState().snapshot?.currentSessionId).toBe("session-2");
    expect(store.getState().snapshot?.thinking).toMatchObject({
      level: "low",
      revision: 5,
    });
    store.getState().actions.stop();
  });

  it("accepts an equal-revision snapshot projection", async () => {
    const { client, store } = await harness({ level: "medium", revision: 10 });
    client.snapshots.push(
      Promise.resolve(
        withThinking(snapshot(), { level: "high", revision: 10 }),
      ),
    );

    expect(await store.getState().actions.refreshSnapshot()).toBe(true);
    expect(store.getState().snapshot?.thinking).toMatchObject({
      level: "high",
      revision: 10,
    });
    store.getState().actions.stop();
  });

  it("drops a superseded flush instead of posting a duplicate for the new Session", async () => {
    const { client, store } = await harness();
    const superseded = deferred<WebThinkingState & { sessionId: string }>();
    client.setThinkingResults.push(superseded.promise);

    store.getState().actions.selectThinking("high");
    expect(client.thinkings).toEqual([
      { sessionId: "session-1", level: "high" },
    ]);

    client.selectionResults.push(Promise.resolve({}));
    client.snapshots.push(
      Promise.resolve(
        withThinking(activeSnapshot("session-2", "/tmp/ws/b.jsonl"), {
          level: "medium",
          revision: 5,
        }),
      ),
    );
    await store.getState().actions.selectSession("/tmp/ws/b.jsonl");

    const newer = deferred<WebThinkingState & { sessionId: string }>();
    client.setThinkingResults.push(newer.promise);
    store.getState().actions.selectThinking("low");
    expect(store.getState().thinkingPendingLevel).toBe("low");
    expect(client.thinkings).toEqual([
      { sessionId: "session-1", level: "high" },
      { sessionId: "session-2", level: "low" },
    ]);

    // The superseded session-1 POST settles after the newer flush is in flight.
    superseded.resolve({
      sessionId: "session-1",
      level: "high",
      available: ["off", "minimal", "low", "medium", "high"],
      supported: true,
      revision: 2,
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    // Exactly one POST per intent: the superseded flush is dropped.
    expect(client.thinkings).toEqual([
      { sessionId: "session-1", level: "high" },
      { sessionId: "session-2", level: "low" },
    ]);
    expect(store.getState().thinkingPendingLevel).toBe("low");

    newer.resolve({
      sessionId: "session-2",
      level: "low",
      available: ["off", "minimal", "low", "medium", "high"],
      supported: true,
      revision: 8,
    });
    await vi.waitFor(() =>
      expect(store.getState().thinkingPendingLevel).toBeNull(),
    );
    expect(store.getState().snapshot?.thinking).toMatchObject({
      level: "low",
      revision: 8,
    });
    store.getState().actions.stop();
  });

  it("ignores a stale thinking_level_changed while a POST is in flight", async () => {
    const client = new FakeClient();
    client.snapshots.push(
      Promise.resolve(withThinking(snapshot(), { revision: 10 })),
    );
    const stream = eventStreamHarness();
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();

    const pending = deferred<WebThinkingState & { sessionId: string }>();
    client.setThinkingResults.push(pending.promise);
    store.getState().actions.selectThinking("high");
    expect(store.getState().thinkingPendingLevel).toBe("high");

    stream.emit(
      runtimeEvent(5, "thinking_level_changed", {
        sessionId: "session-1",
        level: "low",
      }),
    );
    expect(store.getState().thinkingPendingLevel).toBe("high");
    expect(store.getState().snapshot?.thinking).toMatchObject({
      level: "medium",
      revision: 10,
    });
    expect(client.thinkings).toEqual([
      { sessionId: "session-1", level: "high" },
    ]);

    pending.resolve({
      sessionId: "session-1",
      level: "high",
      available: ["off", "minimal", "low", "medium", "high"],
      supported: true,
      revision: 20,
    });
    await vi.waitFor(() =>
      expect(store.getState().thinkingPendingLevel).toBeNull(),
    );
    expect(store.getState().snapshot?.thinking).toMatchObject({
      level: "high",
      revision: 20,
    });
    store.getState().actions.stop();
  });

  it("keeps the newer accepted value when an older success resolves late", async () => {
    const { client, store } = await harness();
    const first = deferred<WebThinkingState & { sessionId: string }>();
    client.setThinkingResults.push(first.promise);
    client.selectionResults.push(Promise.resolve({}));
    client.snapshots.push(
      Promise.resolve(
        withThinking(activeSnapshot("session-2", "/tmp/ws/b.jsonl"), {
          level: "medium",
          revision: 5,
        }),
      ),
    );

    store.getState().actions.selectThinking("low");
    await store.getState().actions.selectSession("/tmp/ws/b.jsonl");
    const second = deferred<WebThinkingState & { sessionId: string }>();
    client.setThinkingResults.push(second.promise);
    store.getState().actions.selectThinking("high");
    expect(client.thinkings).toEqual([
      { sessionId: "session-1", level: "low" },
      { sessionId: "session-2", level: "high" },
    ]);

    second.resolve({
      sessionId: "session-2",
      level: "high",
      available: ["off", "minimal", "low", "medium", "high"],
      supported: true,
      revision: 8,
    });
    await vi.waitFor(() =>
      expect(store.getState().snapshot?.thinking?.revision).toBe(8),
    );

    first.resolve({
      sessionId: "session-1",
      level: "low",
      available: ["off", "minimal", "low", "medium", "high"],
      supported: true,
      revision: 2,
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(store.getState().snapshot?.thinking).toMatchObject({
      level: "high",
      revision: 8,
    });
    store.getState().actions.stop();
  });

  it("keeps a newer Session intent when the superseded success resolves first", async () => {
    const { client, store } = await harness();
    const first = deferred<WebThinkingState & { sessionId: string }>();
    client.setThinkingResults.push(first.promise);
    client.selectionResults.push(Promise.resolve({}));
    client.snapshots.push(
      Promise.resolve(
        withThinking(activeSnapshot("session-2", "/tmp/ws/b.jsonl"), {
          level: "medium",
          revision: 5,
        }),
      ),
    );

    store.getState().actions.selectThinking("low");
    await store.getState().actions.selectSession("/tmp/ws/b.jsonl");
    const second = deferred<WebThinkingState & { sessionId: string }>();
    client.setThinkingResults.push(second.promise);
    store.getState().actions.selectThinking("high");

    first.resolve({
      sessionId: "session-1",
      level: "low",
      available: ["off", "minimal", "low", "medium", "high"],
      supported: true,
      revision: 2,
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    // The superseded session-1 flush is dropped; the in-flight session-2 flush
    // still owns the newer intent and no duplicate POST is issued.
    expect(client.thinkings).toEqual([
      { sessionId: "session-1", level: "low" },
      { sessionId: "session-2", level: "high" },
    ]);
    expect(store.getState().thinkingPendingLevel).toBe("high");

    second.resolve({
      sessionId: "session-2",
      level: "high",
      available: ["off", "minimal", "low", "medium", "high"],
      supported: true,
      revision: 8,
    });
    await vi.waitFor(() =>
      expect(store.getState().snapshot?.thinking?.level).toBe("high"),
    );
    expect(store.getState().thinkingPendingLevel).toBeNull();
    store.getState().actions.stop();
  });

  it("applies a local thinking_level_changed patch with its revision", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(withThinking(snapshot())));
    const stream = eventStreamHarness();
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();

    stream.emit(
      runtimeEvent(9, "thinking_level_changed", {
        sessionId: "session-1",
        level: "high",
      }),
    );
    expect(store.getState().snapshot?.thinking).toMatchObject({
      level: "high",
      revision: 9,
    });

    stream.emit(
      runtimeEvent(10, "thinking_level_changed", {
        sessionId: "session-1",
        level: "low",
      }),
    );
    expect(store.getState().snapshot?.thinking).toMatchObject({
      level: "low",
      revision: 10,
    });

    stream.emit(
      runtimeEvent(3, "thinking_level_changed", {
        sessionId: "session-1",
        level: "medium",
      }),
    );
    expect(store.getState().snapshot?.thinking).toMatchObject({
      level: "low",
      revision: 10,
    });
    store.getState().actions.stop();
  });

  it("ignores thinking_level_changed when the snapshot has no projection", async () => {
    const client = new FakeClient();
    client.snapshots.push(Promise.resolve(snapshot()));
    const stream = eventStreamHarness();
    const store = createWebStore(client, {
      consumeEvents: stream.consumeEvents,
    });
    await store.getState().actions.refreshSnapshot();
    store.getState().actions.start();

    stream.emit(
      runtimeEvent(9, "thinking_level_changed", {
        sessionId: "session-1",
        level: "high",
      }),
    );

    expect(store.getState().snapshot?.thinking).toBeUndefined();
    expect(store.getState().notice).toBeNull();
    store.getState().actions.stop();
  });

  it("converges to the last intent in a burst", async () => {
    const { client, store } = await harness();
    const first = deferred<WebThinkingState & { sessionId: string }>();
    client.setThinkingResults.push(first.promise);

    for (const level of ["low", "high", "minimal", "low", "high"]) {
      store.getState().actions.selectThinking(level);
    }
    expect(store.getState().thinkingPendingLevel).toBe("high");
    expect(client.thinkings).toEqual([
      { sessionId: "session-1", level: "low" },
    ]);

    first.resolve({
      sessionId: "session-1",
      level: "low",
      available: ["off", "minimal", "low", "medium", "high"],
      supported: true,
      revision: 2,
    });
    await vi.waitFor(() =>
      expect(store.getState().thinkingPendingLevel).toBeNull(),
    );
    expect(store.getState().snapshot?.thinking?.level).toBe("high");
    expect(client.thinkings.length).toBeLessThanOrEqual(2);
    store.getState().actions.stop();
  });

  it("terminates after jittering between two levels", async () => {
    const { client, store } = await harness();
    for (let index = 0; index < 50; index += 1) {
      store.getState().actions.selectThinking(index % 2 === 0 ? "low" : "high");
      await Promise.resolve();
    }
    await vi.waitFor(() =>
      expect(store.getState().thinkingPendingLevel).toBeNull(),
    );

    expect(store.getState().snapshot?.thinking?.level).toBe("high");
    expect(client.thinkings.length).toBeLessThanOrEqual(51);
    store.getState().actions.stop();
  });

  it("does not deadlock or send again after stop while a POST is in flight", async () => {
    const { client, store } = await harness();
    const first = deferred<WebThinkingState & { sessionId: string }>();
    client.setThinkingResults.push(first.promise);

    store.getState().actions.selectThinking("high");
    expect(client.thinkings).toEqual([
      { sessionId: "session-1", level: "high" },
    ]);
    store.getState().actions.stop();

    first.resolve({
      sessionId: "session-1",
      level: "high",
      available: ["off", "minimal", "low", "medium", "high"],
      supported: true,
      revision: 2,
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(client.thinkings).toEqual([
      { sessionId: "session-1", level: "high" },
    ]);

    store.getState().actions.selectThinking("low");
    await vi.waitFor(() =>
      expect(store.getState().snapshot?.thinking?.level).toBe("low"),
    );
    expect(client.thinkings).toEqual([
      { sessionId: "session-1", level: "high" },
      { sessionId: "session-1", level: "low" },
    ]);
    store.getState().actions.stop();
  });
});
