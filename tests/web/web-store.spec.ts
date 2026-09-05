// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebEvent, WebSnapshot } from "../../web/protocol/types.ts";
import {
  type CommandReceipt,
  type SessionMutationResult,
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

class FakeClient extends WebClient {
  snapshots: Array<Promise<WebSnapshot>> = [];
  snapshotPaths: Array<string | null | undefined> = [];
  workspaceResult: Promise<WorkspaceSelectionResult> = Promise.resolve({
    cancelled: true,
  });
  creationResult: Promise<SessionMutationResult> = Promise.resolve({});
  selectionResults: Array<Promise<SessionMutationResult>> = [];
  modelResult: Promise<CommandReceipt> = Promise.resolve({
    id: "model-1",
    accepted: true,
  });
  promptResult = Promise.resolve({ id: "prompt-1", accepted: true });
  creations: Array<{ commandId: string; workspacePath: string }> = [];
  selections: string[] = [];
  modelSelections: Array<{
    provider: string;
    modelId: string;
    sessionId: string;
  }> = [];
  prompts: Array<{ sessionId: string; content: string }> = [];

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
    return this.creationResult;
  }

  override selectSession(path: string) {
    this.selections.push(path);
    return this.selectionResults.shift() ?? Promise.resolve({});
  }

  override selectModel(provider: string, modelId: string, sessionId: string) {
    this.modelSelections.push({ provider, modelId, sessionId });
    return this.modelResult;
  }

  override prompt(sessionId: string, content: string) {
    this.prompts.push({ sessionId, content });
    return this.promptResult;
  }
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

describe("OpenPI Web store", () => {
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

  it("falls back to the canonical active Session when a selected transcript is stale", async () => {
    const client = new FakeClient();
    const stale = activeSnapshot("session-2", "/tmp/ws/current.jsonl");
    stale.sessions.unshift({
      ...stale.sessions[0]!,
      id: "session-1",
      path: "/tmp/ws/browsed.jsonl",
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

    expect(client.snapshotPaths).toEqual(["/tmp/ws/browsed.jsonl", null]);
    expect(store.getState().selectedPath).toBe("/tmp/ws/current.jsonl");
    expect(store.getState().snapshot?.selectedSession?.id).toBe("session-2");
    expect(store.getState().cursor).toBe(6);
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

  it("recovers the canonical Session after an external activation", async () => {
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

    stream.emit(
      runtimeEvent(5, "session_switched", {
        sessionId: "session-2",
        sessionPath: "/tmp/ws/external.jsonl",
      }),
    );
    await vi.waitFor(() =>
      expect(store.getState().sessionSwitching).toBe(false),
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
    const creation = deferred<SessionMutationResult>();
    client.creationResult = creation.promise;
    client.selectionResults.push(Promise.resolve({}));
    const store = createWebStore(client);
    await store.getState().actions.refreshSnapshot();

    const creating = store.getState().actions.createSession("/tmp/ws");
    await vi.waitFor(() => expect(client.creations).toHaveLength(1));
    const selecting = store.getState().actions.selectSession("/tmp/ws/b.jsonl");
    creation.resolve({});
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
    const creation = deferred<SessionMutationResult>();
    client.creationResult = creation.promise;
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
    creation.resolve({});
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
    const model = deferred<CommandReceipt>();
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
