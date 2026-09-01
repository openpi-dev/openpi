import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

/**
 * Executes web/ui/app.js in a stubbed DOM and feeds it a representative
 * session snapshot. Source-text regex assertions in web-host.test.ts cannot
 * catch runtime crashes (a ReferenceError in one branch blanks the whole
 * conversation); this smoke test renders for real.
 */

interface ElementStub {
  id: string;
  innerHTML: string;
  textContent: string;
  hidden: boolean;
  dataset: Record<string, string>;
  classList: Record<string, unknown>;
  [key: string]: unknown;
}

function makeElement(id: string): ElementStub {
  const listeners = new Map<
    string,
    Array<(event: Record<string, unknown>) => void>
  >();
  return {
    id,
    innerHTML: "",
    textContent: "",
    value: "",
    hidden: false,
    disabled: false,
    dataset: {},
    style: {},
    scrollTop: 0,
    scrollHeight: 100,
    clientHeight: 100,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    getAttribute: () => null,
    addEventListener(
      type: string,
      listener: (event: Record<string, unknown>) => void,
    ) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
    dispatch(type: string, event: Record<string, unknown> = {}) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    scrollTo() {},
    select() {},
    remove() {},
    appendChild() {},
    showModal() {},
    close() {},
  };
}

const SNAPSHOT = {
  protocolVersion: 1,
  generatedAt: new Date().toISOString(),
  cursor: 1,
  currentSessionId: "s1",
  workspaces: [{ path: "/tmp/ws", name: "ws", current: true }],
  sessions: [
    {
      id: "s1",
      path: "/tmp/s1.jsonl",
      cwd: "/tmp/ws",
      name: "demo",
      modified: "",
      created: "",
      messageCount: 5,
      firstMessage: "hello",
    },
  ],
  models: [],
  runtime: {
    status: "idle",
    capabilities: {
      subagents: {
        items: [
          {
            id: "sa-1",
            title: "explore",
            status: "done",
            createdAt: "2026-09-01T10:00:00Z",
            settledAt: "2026-09-01T10:00:30Z",
          },
        ],
        omitted: 2,
        truncated: true,
      },
      workflows: {
        items: [
          {
            runId: "wf-1",
            name: "delivery",
            status: "completed",
            startedAt: "2026-09-01T10:00:00Z",
            finishedAt: "2026-09-01T10:01:00Z",
            agents: { total: 1, running: 0, done: 1, error: 0, uncertain: 0 },
          },
        ],
        omitted: 0,
        truncated: false,
      },
    },
  },
  selectedSession: {
    id: "s1",
    path: "/tmp/s1.jsonl",
    cwd: "/tmp/ws",
    entries: [
      { type: "model_change", id: "e0", timestamp: "2026-09-01T10:00:00Z" },
      {
        type: "message",
        id: "e1",
        timestamp: "2026-09-01T10:00:01Z",
        message: { role: "user", content: "看下仓库结构" },
      },
      {
        type: "message",
        id: "e2",
        timestamp: "2026-09-01T10:00:30Z",
        message: {
          role: "assistant",
          content: "好的",
          parts: [
            { type: "thinking", text: "先列目录" },
            {
              type: "toolCall",
              id: "c1",
              name: "bash",
              arguments: '{\n  "command": "ls"\n}',
            },
            {
              type: "toolCall",
              id: "c2",
              name: "subagent_spawn",
              arguments: '{\n  "prompt": "探索", "name": "explore"\n}',
            },
            {
              type: "toolCall",
              id: "c3",
              name: "workflow",
              arguments:
                '{\n  "script": "export const meta = { name: \'demo\' }"\n}',
            },
          ],
        },
      },
      {
        type: "message",
        id: "e3",
        timestamp: "2026-09-01T10:00:35Z",
        message: {
          role: "toolResult",
          toolName: "bash",
          toolCallId: "c1",
          isError: false,
          content: "file1\nfile2",
        },
      },
      {
        type: "message",
        id: "e4",
        timestamp: "2026-09-01T10:00:40Z",
        message: {
          role: "toolResult",
          toolName: "subagent_spawn",
          toolCallId: "c2",
          isError: false,
          content: "Spawned subagent sa-1",
          details: { id: "sa-1", title: "explore" },
        },
      },
      {
        type: "message",
        id: "e5",
        timestamp: "2026-09-01T10:01:00Z",
        message: {
          role: "toolResult",
          toolName: "workflow",
          toolCallId: "c3",
          isError: false,
          content: "Workflow demo completed",
          details: {
            runId: "wf_abc",
            name: "demo",
            status: "completed",
            agents: [],
          },
        },
      },
      {
        type: "message",
        id: "e6",
        timestamp: "2026-09-01T10:02:00Z",
        message: {
          role: "custom",
          customType: "subagent-result",
          display: true,
          content: "Subagent sa-1 finished.\n\ndone",
          details: {
            id: "sa-1",
            title: "explore",
            status: "done",
            elapsed: "12s",
          },
        },
      },
      {
        type: "message",
        id: "e7",
        timestamp: "2026-09-01T10:03:00Z",
        message: {
          role: "custom",
          customType: "workflow-result",
          display: true,
          content: "delivery",
          details: {
            version: 1,
            entries: [
              {
                deliveryId: "d1",
                runId: "wf_abc",
                status: "completed",
                summary: "demo done",
                alerts: [],
                resultPreview: "{}",
              },
            ],
          },
        },
      },
      {
        type: "message",
        id: "e8",
        timestamp: "2026-09-01T10:04:00Z",
        message: { role: "assistant", content: "中间过程的一句回复" },
      },
      {
        type: "message",
        id: "e9",
        timestamp: "2026-09-01T10:05:00Z",
        message: { role: "assistant", content: "最终总结：**完成（done）**了" },
      },
    ],
  },
};

type SnapshotFixture = Omit<
  typeof SNAPSHOT,
  "currentSessionId" | "selectedSession"
> & {
  currentSessionId?: string;
  selectedSession?: typeof SNAPSHOT.selectedSession;
};

async function renderApp(
  options: {
    eventRecords?: string[];
    snapshot?: SnapshotFixture;
    storageValues?: Record<string, string>;
  } = {},
) {
  const elements = new Map<string, ElementStub>();
  const shell = makeElement("shell");
  const documentStub = {
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    querySelector: (selector: string) =>
      selector === ".conversation-shell" ? shell : null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => makeElement("dynamic"),
    documentElement: makeElement("html"),
    body: makeElement("body"),
  };
  const stored = new Map(Object.entries(options.storageValues ?? {}));
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  };
  const replaced: string[] = [];
  let eventFetches = 0;
  let snapshotFetches = 0;
  let readerCancellations = 0;
  const encodedEvents = (options.eventRecords || []).map((record) =>
    new TextEncoder().encode(record),
  );
  const context: Record<string, unknown> = {
    console,
    document: documentStub,
    localStorage: storage,
    sessionStorage: storage,
    navigator: { language: "en-US" },
    location: { hash: "#token=test", pathname: "/", search: "" },
    history: {
      replaceState: (_state: unknown, _title: string, path: string) =>
        replaced.push(path),
    },
    fetch: async (url: unknown) => {
      if (String(url).startsWith("/events")) {
        eventFetches++;
        const connectionEvents = eventFetches === 1 ? encodedEvents : [];
        let index = 0;
        return {
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              cancel: async () => {
                readerCancellations++;
              },
              read: () =>
                index < connectionEvents.length
                  ? Promise.resolve({
                      done: false,
                      value: connectionEvents[index++],
                    })
                  : new Promise(() => {}),
            }),
          },
        };
      }
      snapshotFetches++;
      return {
        ok: true,
        status: 200,
        json: async () => options.snapshot ?? SNAPSHOT,
        text: async () => "",
      };
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URLSearchParams,
    URL,
    TextDecoder,
    TextEncoder,
    Element: class Element {},
  };
  context.window = {
    localStorage: storage,
    sessionStorage: storage,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  };
  context.globalThis = context;
  vm.createContext(context as vm.Context);
  // Load the real marked UMD so Markdown rendering is exercised for real.
  const markedSource = readFileSync(
    new URL("../../node_modules/marked/lib/marked.umd.js", import.meta.url),
    "utf8",
  );
  vm.runInContext(markedSource, context as vm.Context, {
    filename: "marked.umd.js",
  });
  const source = readFileSync(
    new URL("../../web/ui/app.js", import.meta.url),
    "utf8",
  );
  vm.runInContext(source, context as vm.Context, { filename: "app.js" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  return {
    elements,
    stored,
    replaced,
    eventFetches: () => eventFetches,
    snapshotFetches: () => snapshotFetches,
    readerCancellations: () => readerCancellations,
    context,
    state: vm.runInContext("state", context as vm.Context) as typeof SNAPSHOT &
      Record<string, unknown>,
    selectSession: vm.runInContext("selectSession", context as vm.Context) as (
      path: string,
    ) => Promise<void>,
    createSession: vm.runInContext("createSession", context as vm.Context) as (
      workspacePath: string,
    ) => Promise<void>,
    chooseWorkspace: vm.runInContext(
      "chooseWorkspace",
      context as vm.Context,
    ) as () => Promise<void>,
    selectModel: vm.runInContext("selectModel", context as vm.Context) as (
      value: string,
    ) => Promise<void>,
    sendPrompt: vm.runInContext(
      "sendPrompt",
      context as vm.Context,
    ) as () => Promise<void>,
    updateComposer: vm.runInContext(
      "updateComposer",
      context as vm.Context,
    ) as () => void,
    refreshSnapshot: vm.runInContext(
      "refreshSnapshot",
      context as vm.Context,
    ) as (options?: {
      resetCursor?: boolean;
      epoch?: number;
    }) => Promise<boolean>,
  };
}

function response(body: unknown = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("app.js renders a full session without runtime errors", async () => {
  const { elements } = await renderApp();
  const conversation = elements.get("conversation");
  assert.ok(conversation, "conversation element exists");
  assert.match(conversation.innerHTML, /message-row user/);
  assert.match(conversation.innerHTML, /assistant-detail/);
  assert.match(conversation.innerHTML, /tool-details/);
  assert.match(conversation.innerHTML, /runtime-activity/);
  assert.match(conversation.innerHTML, /explore/);
  assert.match(conversation.innerHTML, /\+2 omitted/);
  assert.match(conversation.innerHTML, /delivery/);
  assert.match(conversation.innerHTML, /file1/);
  assert.match(conversation.innerHTML, /最终总结/);
});

test("app.js moves the bootstrap token into tab storage and clears the URL", async () => {
  const { stored, replaced } = await renderApp();
  assert.equal(stored.get("openpi.web.token"), "test");
  assert.deepEqual(replaced, ["/"]);
});

test("app.js resnapshots on an SSE cursor gap", async () => {
  const app = await renderApp({
    eventRecords: ['id: 3\ndata: {"sequence":3,"type":"runtime_changed"}\n\n'],
  });
  assert.equal(app.eventFetches(), 1);
  assert.ok(app.snapshotFetches() >= 2);
  assert.ok(app.readerCancellations() >= 1);
});

test("app.js invalidates snapshots for cross-tab session metadata events", async () => {
  const app = await renderApp({
    eventRecords: [
      'id: 2\ndata: {"sequence":2,"type":"session_renamed","detail":{"sessionPath":"/tmp/s1.jsonl"}}\n\nid: 3\ndata: {"sequence":3,"type":"session_archived","detail":{"sessionPath":"/tmp/s1.jsonl"}}\n\n',
    ],
  });

  assert.equal(app.eventFetches(), 1);
  assert.ok(app.snapshotFetches() >= 2);
});

test("app.js recovers the canonical active session after external activation while disconnected", async () => {
  const app = await renderApp();
  const staleBrowse = structuredClone(SNAPSHOT);
  staleBrowse.currentSessionId = "s2";
  staleBrowse.sessions = [
    { ...staleBrowse.sessions[0], id: "s1", path: "/tmp/b.jsonl" },
    { ...staleBrowse.sessions[0], id: "s2", path: "/tmp/c.jsonl" },
  ];
  staleBrowse.selectedSession.id = "s1";
  staleBrowse.selectedSession.path = "/tmp/b.jsonl";
  const canonical = structuredClone(staleBrowse);
  canonical.selectedSession.id = "s2";
  canonical.selectedSession.path = "/tmp/c.jsonl";
  const snapshots = [staleBrowse, canonical];
  const requests: string[] = [];
  app.context.fetch = async (url: unknown) => {
    requests.push(String(url));
    const snapshot = snapshots.shift();
    assert.ok(snapshot);
    return response(snapshot);
  };
  vm.runInContext(
    'state.selectedPath = "/tmp/b.jsonl"',
    app.context as vm.Context,
  );

  const recovered = await app.refreshSnapshot({ resetCursor: true });

  assert.equal(recovered, true);
  assert.deepEqual(requests, [
    "/api/snapshot?path=%2Ftmp%2Fb.jsonl",
    "/api/snapshot",
  ]);
  assert.equal(app.state.selectedPath, "/tmp/c.jsonl");
  assert.equal(
    vm.runInContext(
      "state.snapshot.selectedSession.id",
      app.context as vm.Context,
    ),
    "s2",
  );
});

test("app.js clears a vanished selected path and retries canonical snapshot once", async () => {
  const app = await renderApp();
  const canonical = structuredClone(SNAPSHOT);
  canonical.currentSessionId = "s2";
  canonical.sessions[0].id = "s2";
  canonical.sessions[0].path = "/tmp/c.jsonl";
  canonical.selectedSession.id = "s2";
  canonical.selectedSession.path = "/tmp/c.jsonl";
  const { selectedSession: _selectedSession, ...vanished } =
    structuredClone(canonical);
  const snapshots = [vanished, canonical];
  const requests: string[] = [];
  app.context.fetch = async (url: unknown) => {
    requests.push(String(url));
    const snapshot = snapshots.shift();
    assert.ok(snapshot);
    return response(snapshot);
  };
  vm.runInContext(
    'state.selectedPath = "/tmp/vanished.jsonl"',
    app.context as vm.Context,
  );

  const recovered = await app.refreshSnapshot({ resetCursor: true });

  assert.equal(recovered, true);
  assert.deepEqual(requests, [
    "/api/snapshot?path=%2Ftmp%2Fvanished.jsonl",
    "/api/snapshot",
  ]);
  assert.equal(app.state.selectedPath, "/tmp/c.jsonl");
});

test("app.js commits only the latest same-epoch snapshot and cursor", async () => {
  const app = await renderApp();
  const older = deferred<ReturnType<typeof response>>();
  const newer = deferred<ReturnType<typeof response>>();
  const oldSnapshot = structuredClone(SNAPSHOT);
  oldSnapshot.cursor = 9;
  const newSnapshot = structuredClone(SNAPSHOT);
  newSnapshot.cursor = 10;
  const requests = [older, newer];
  app.context.fetch = async () => {
    const request = requests.shift();
    assert.ok(request);
    return request.promise;
  };

  const oldRefresh = app.refreshSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const newRefresh = app.refreshSnapshot();
  newer.resolve(response(newSnapshot));
  assert.equal(await newRefresh, true);
  older.resolve(response(oldSnapshot));
  assert.equal(await oldRefresh, false);

  assert.equal(
    vm.runInContext("state.snapshot.cursor", app.context as vm.Context),
    10,
  );
  assert.equal(app.state.cursor, 10);
});

test("app.js ignores an older same-epoch snapshot failure after newer success", async () => {
  const app = await renderApp();
  const older = deferred<ReturnType<typeof response>>();
  const newer = deferred<ReturnType<typeof response>>();
  const requests = [older, newer];
  app.context.fetch = async () => {
    const request = requests.shift();
    assert.ok(request);
    return request.promise;
  };

  const oldRefresh = app.refreshSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const newRefresh = app.refreshSnapshot();
  newer.resolve(response(SNAPSHOT));
  assert.equal(await newRefresh, true);
  older.reject(new Error("late snapshot failure"));
  assert.equal(await oldRefresh, false);

  assert.equal(app.elements.get("connection-state")?.textContent, "Connected");
  assert.doesNotMatch(
    app.elements.get("composer-hint")?.textContent || "",
    /late snapshot failure/,
  );
});

test("app.js renders remote Markdown images as inert links", async () => {
  const snapshot = structuredClone(SNAPSHOT);
  const message = snapshot.selectedSession.entries.find(
    (entry) => entry.type === "message" && entry.id === "e9",
  );
  assert.ok(message?.message);
  message.message.content = "![tracker](https://example.test/pixel.png)";

  const { elements } = await renderApp({ snapshot });
  const html = elements.get("conversation")?.innerHTML || "";
  assert.doesNotMatch(html, /<img\b/u);
  assert.match(html, /href="https:\/\/example\.test\/pixel\.png"/u);
  assert.match(html, /\[image: tracker\]/u);
});

test("app.js ignores prompt state for a different active session", async () => {
  const { elements } = await renderApp({
    eventRecords: [
      'id: 2\ndata: {"sequence":2,"type":"prompt_failed","detail":{"sessionId":"other","error":"wrong session"}}\n\n',
    ],
  });
  assert.doesNotMatch(
    elements.get("composer-hint")?.textContent || "",
    /wrong session/,
  );
});

test("app.js keeps the newest session selection when older requests settle late", async () => {
  const app = await renderApp();
  const first = deferred<ReturnType<typeof response>>();
  const second = deferred<ReturnType<typeof response>>();
  const snapshotB = structuredClone(SNAPSHOT);
  snapshotB.selectedSession.path = "/tmp/b.jsonl";
  snapshotB.sessions[0].path = "/tmp/b.jsonl";
  const fetches = [first, second];
  app.context.fetch = async (url: unknown) => {
    if (String(url) === "/api/sessions/select") {
      const next = fetches.shift();
      assert.ok(next);
      return next.promise;
    }
    if (String(url).startsWith("/api/snapshot")) return response(snapshotB);
    throw new Error(`unexpected request: ${String(url)}`);
  };

  const selectingA = app.selectSession("/tmp/a.jsonl");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(app.elements.get("prompt-input")?.disabled, true);
  assert.doesNotMatch(
    app.elements.get("conversation")?.innerHTML || "",
    /最终总结/,
  );
  assert.match(
    app.elements.get("conversation")?.innerHTML || "",
    /Switching session/,
  );
  const selectingB = app.selectSession("/tmp/b.jsonl");
  first.reject(new Error("late A failure"));
  await selectingA;
  second.resolve(response());
  await selectingB;

  assert.equal(app.state.selectedPath, "/tmp/b.jsonl");
  assert.equal(app.state.sessionSwitching, false);
  assert.doesNotMatch(
    app.elements.get("composer-hint")?.textContent || "",
    /late A failure/,
  );
});

test("app.js falls back to canonical current instead of pairing a stale transcript", async () => {
  const app = await renderApp();
  app.context.fetch = async (url: unknown) => {
    if (String(url) === "/api/sessions/select") return response();
    if (String(url).startsWith("/api/snapshot")) return response(SNAPSHOT);
    throw new Error(`unexpected request: ${String(url)}`);
  };

  await app.selectSession("/tmp/b.jsonl");

  assert.equal(app.state.selectedPath, "/tmp/s1.jsonl");
  assert.match(app.elements.get("session-header")?.innerHTML || "", /demo/);
});

test("app.js ignores an old prompt admission after switching sessions", async () => {
  const app = await renderApp();
  const prompt = deferred<ReturnType<typeof response>>();
  const snapshotB = structuredClone(SNAPSHOT);
  snapshotB.selectedSession.path = "/tmp/b.jsonl";
  snapshotB.sessions[0].path = "/tmp/b.jsonl";
  app.context.fetch = async (url: unknown) => {
    if (String(url) === "/api/prompt") return prompt.promise;
    if (String(url) === "/api/sessions/select") return response();
    if (String(url).startsWith("/api/snapshot")) return response(snapshotB);
    throw new Error(`unexpected request: ${String(url)}`);
  };
  const input = app.elements.get("prompt-input");
  assert.ok(input);
  input.value = "message for A";
  const sending = app.sendPrompt();
  await app.selectSession("/tmp/b.jsonl");
  input.value = "draft for B";
  prompt.resolve(response({ accepted: true }));
  await sending;

  assert.equal(input.value, "draft for B");
  assert.equal(app.state.liveRunning, false);
  assert.equal(app.state.selectedPath, "/tmp/b.jsonl");
  assert.notEqual(
    app.elements.get("composer-hint")?.textContent,
    "Message accepted by OpenPI Web.",
  );
});

test("app.js orders session creation with newer selection intent", async () => {
  const app = await renderApp();
  const creation = deferred<ReturnType<typeof response>>();
  const snapshotB = structuredClone(SNAPSHOT);
  snapshotB.selectedSession.path = "/tmp/b.jsonl";
  snapshotB.sessions[0].path = "/tmp/b.jsonl";
  const requests: string[] = [];
  app.context.fetch = async (url: unknown) => {
    requests.push(String(url));
    if (String(url) === "/api/sessions") return creation.promise;
    if (String(url) === "/api/sessions/select") return response();
    if (String(url).startsWith("/api/snapshot")) return response(snapshotB);
    throw new Error(`unexpected request: ${String(url)}`);
  };

  const creating = app.createSession("/tmp/ws");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const selecting = app.selectSession("/tmp/b.jsonl");
  creation.resolve(response({ cancelled: false }));
  await Promise.all([creating, selecting]);

  assert.deepEqual(requests.slice(0, 2), [
    "/api/sessions",
    "/api/sessions/select",
  ]);
  assert.equal(app.state.selectedPath, "/tmp/b.jsonl");
  assert.equal(app.state.sessionSwitching, false);
});

test("app.js correlates own create events before and after the HTTP receipt", async () => {
  const app = await renderApp();
  const creation = deferred<ReturnType<typeof response>>();
  const created = structuredClone(SNAPSHOT);
  created.currentSessionId = "s2";
  created.selectedSession.id = "s2";
  created.selectedSession.path = "/tmp/created.jsonl";
  created.sessions[0].id = "s2";
  created.sessions[0].path = "/tmp/created.jsonl";
  let commandId = "";
  app.context.fetch = async (url: unknown, options?: { body?: string }) => {
    if (String(url) === "/api/sessions") {
      commandId = JSON.parse(options?.body || "{}").commandId;
      return creation.promise;
    }
    if (String(url).startsWith("/api/snapshot")) return response(created);
    throw new Error(`unexpected request: ${String(url)}`);
  };

  const creating = app.createSession("/tmp/ws");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(commandId);
  const epoch = app.state.sessionEpoch;
  vm.runInContext(
    `applyRuntimeEvent({sequence: 2, type: "session_switched", detail: {sessionPath: "/tmp/created.jsonl", commandId: ${JSON.stringify(commandId)}}})`,
    app.context as vm.Context,
  );
  assert.equal(app.state.sessionEpoch, epoch);
  creation.resolve(
    response({
      cancelled: false,
      commandId,
      sessionPath: "/tmp/created.jsonl",
    }),
  );
  await creating;
  vm.runInContext(
    `state.promptAdmissionPending = true; state.promptAdmissionToken = 99; applyRuntimeEvent({sequence: 3, type: "session_created", detail: {sessionPath: "/tmp/created.jsonl", commandId: ${JSON.stringify(commandId)}}})`,
    app.context as vm.Context,
  );

  assert.equal(app.state.sessionEpoch, epoch);
  assert.equal(app.state.promptAdmissionPending, true);
  assert.equal(app.state.promptAdmissionToken, 99);
});

test("app.js lets a newer external activation invalidate queued creation", async () => {
  const app = await renderApp();
  const external = structuredClone(SNAPSHOT);
  external.currentSessionId = "s2";
  external.selectedSession.id = "s2";
  external.selectedSession.path = "/tmp/external.jsonl";
  external.sessions[0].id = "s2";
  external.sessions[0].path = "/tmp/external.jsonl";
  let createRequests = 0;
  app.context.fetch = async (url: unknown) => {
    if (String(url) === "/api/sessions") {
      createRequests++;
      return response({ cancelled: false });
    }
    if (String(url).startsWith("/api/snapshot")) return response(external);
    throw new Error(`unexpected request: ${String(url)}`);
  };

  const creating = app.createSession("/tmp/ws");
  vm.runInContext(
    'applyRuntimeEvent({sequence: 2, type: "session_switched", detail: {sessionPath: "/tmp/external.jsonl"}})',
    app.context as vm.Context,
  );
  await creating;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(createRequests, 0);
  assert.equal(app.state.selectedPath, "/tmp/external.jsonl");
  assert.equal(app.state.sessionSwitching, false);
});

test("app.js settles an admitted prompt that Pi handles without an agent turn", async () => {
  const app = await renderApp();
  vm.runInContext(
    'applyRuntimeEvent({sequence: 2, type: "prompt_accepted", detail: {sessionId: "s1", commandId: "c1"}})',
    app.context as vm.Context,
  );
  assert.equal(app.state.liveRunning, true);
  vm.runInContext(
    'applyRuntimeEvent({sequence: 3, type: "prompt_settled", detail: {sessionId: "s1", commandId: "c1"}})',
    app.context as vm.Context,
  );
  assert.equal(app.state.liveRunning, false);
  assert.equal(app.state.livePhase, "idle");
  vm.runInContext(
    'applyRuntimeEvent({sequence: 4, type: "prompt_settled", detail: {sessionId: "s1", commandId: "c2"}}); applyRuntimeEvent({sequence: 5, type: "prompt_accepted", detail: {sessionId: "s1", commandId: "c2"}})',
    app.context as vm.Context,
  );
  assert.equal(app.state.liveRunning, false);
  const input = app.elements.get("prompt-input");
  assert.ok(input);
  input.value = "handled locally";
  app.context.fetch = async (url: unknown) => {
    if (String(url) === "/api/prompt") {
      return response({ id: "c2", accepted: true });
    }
    if (String(url).startsWith("/api/snapshot")) return response(SNAPSHOT);
    throw new Error(`unexpected request: ${String(url)}`);
  };
  await app.sendPrompt();
  vm.runInContext(
    'applyRuntimeEvent({sequence: 6, type: "prompt_accepted", detail: {sessionId: "s1", commandId: "c2"}})',
    app.context as vm.Context,
  );
  assert.equal(app.state.liveRunning, false);
  vm.runInContext(
    "for (let index = 0; index < 40; index++) rememberTerminalPrompt(`bounded-${index}`)",
    app.context as vm.Context,
  );
  assert.equal((app.state.terminalPromptIds as Set<string>).size, 32);
});

test("app.js scopes model selection to its session epoch", async () => {
  const app = await renderApp();
  const model = deferred<ReturnType<typeof response>>();
  const external = structuredClone(SNAPSHOT);
  external.currentSessionId = "s2";
  external.selectedSession.id = "s2";
  external.selectedSession.path = "/tmp/external.jsonl";
  external.sessions[0].id = "s2";
  external.sessions[0].path = "/tmp/external.jsonl";
  let modelBody: Record<string, unknown> | undefined;
  app.context.fetch = async (url: unknown, options?: { body?: string }) => {
    if (String(url) === "/api/model") {
      modelBody = JSON.parse(options?.body || "{}");
      return model.promise;
    }
    if (String(url).startsWith("/api/snapshot")) return response(external);
    throw new Error(`unexpected request: ${String(url)}`);
  };

  const selectingModel = app.selectModel("provider/model");
  await new Promise((resolve) => setTimeout(resolve, 0));
  vm.runInContext(
    'applyRuntimeEvent({sequence: 2, type: "session_switched", detail: {sessionPath: "/tmp/external.jsonl"}})',
    app.context as vm.Context,
  );
  model.reject(new Error("late model response"));
  await selectingModel;

  assert.deepEqual(modelBody, {
    provider: "provider",
    modelId: "model",
    sessionId: "s1",
  });
  assert.doesNotMatch(
    app.elements.get("composer-hint")?.textContent || "",
    /late model response/,
  );
});

test("app.js renders the landing state for an empty selection", async () => {
  const { elements } = await renderApp();
  const conversation = elements.get("conversation");
  assert.ok(conversation);
  assert.ok(conversation.innerHTML.length > 0);
});

test("app.js accepts an unbound snapshot and preserves a chosen workspace through Session creation", async () => {
  const unbound = structuredClone(SNAPSHOT) as SnapshotFixture;
  delete unbound.currentSessionId;
  delete unbound.selectedSession;
  unbound.workspaces = [];
  unbound.sessions = [];
  const app = await renderApp({ snapshot: unbound });

  assert.equal(app.state.selectedWorkspace, null);
  assert.equal(app.state.selectedPath, null);
  assert.equal(app.elements.get("prompt-input")?.readOnly, true);

  const chosenPath = "/tmp/chosen-workspace";
  const chosen = structuredClone(unbound);
  chosen.workspaces = [{ path: chosenPath, name: "chosen", current: false }];
  const activated = structuredClone(SNAPSHOT);
  activated.workspaces[0] = {
    path: chosenPath,
    name: "chosen",
    current: true,
  };
  activated.sessions[0].cwd = chosenPath;
  activated.selectedSession.cwd = chosenPath;
  let currentSnapshot: SnapshotFixture = chosen;
  let sessionCreations = 0;
  const prompts: Array<{ sessionId: string; content: string }> = [];
  app.context.fetch = async (url: unknown, options?: { body?: string }) => {
    if (String(url) === "/api/workspaces/select") {
      return response({ cancelled: false, path: chosenPath });
    }
    if (String(url) === "/api/sessions") {
      sessionCreations++;
      currentSnapshot = activated;
      return response({ cancelled: false, sessionPath: "/tmp/s1.jsonl" });
    }
    if (String(url) === "/api/prompt") {
      prompts.push(JSON.parse(options?.body || "{}"));
      return response({ id: "first-prompt", accepted: true });
    }
    if (String(url).startsWith("/api/snapshot")) {
      return response(currentSnapshot);
    }
    throw new Error(`unexpected request: ${String(url)}`);
  };

  await app.chooseWorkspace();
  assert.equal(app.state.selectedWorkspace, chosenPath);
  assert.equal(app.elements.get("prompt-input")?.readOnly, false);
  assert.equal(app.elements.get("prompt-input")?.disabled, false);
  assert.equal(app.elements.get("send-prompt")?.disabled, false);

  const input = app.elements.get("prompt-input");
  assert.ok(input);
  input.value = "first task";
  const composer = app.elements.get("composer");
  assert.ok(composer);
  (composer.dispatch as (type: string, event: Record<string, unknown>) => void)(
    "submit",
    { preventDefault() {} },
  );
  while (prompts.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(sessionCreations, 1);
  assert.deepEqual(prompts, [{ sessionId: "s1", content: "first task" }]);
  assert.equal(app.state.selectedWorkspace, chosenPath);
  assert.equal(app.state.selectedPath, "/tmp/s1.jsonl");
  assert.equal(input.value, "");
});

test("snapshot archive state remains authoritative over legacy browser storage", async () => {
  const { elements } = await renderApp({
    storageValues: {
      "openpi.archived-sessions": JSON.stringify(["/tmp/s1.jsonl"]),
    },
  });
  const workspaces = elements.get("workspaces");
  assert.ok(workspaces);
  assert.match(workspaces.innerHTML, /demo/);
});
