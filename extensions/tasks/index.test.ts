import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import sessionTasks, {
  findTaskConflict,
  injectTaskProjection,
  taskConflictMessage,
} from "./index.ts";

const sourceInfo = (path: string) => ({
  path,
  source: path,
  scope: "user" as const,
  origin: "top-level" as const,
});

function widgetHarness(
  initialBranch: unknown[] = [],
  initialTools: unknown[] = [],
  mode: "tui" | "rpc" = "tui",
) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const widgets: Array<unknown> = [];
  const notifications: string[] = [];
  let branch = initialBranch;
  let allTools = initialTools;
  let shortcutKey: string | undefined;
  let shortcut: ((ctx: ExtensionContext) => Promise<void>) | undefined;
  const pi = {
    getAllTools: () => allTools,
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    registerShortcut: (key: string, options: { handler: typeof shortcut }) => {
      shortcutKey = key;
      shortcut = options.handler;
    },
    on: (event: string, handler: (event: any, ctx: any) => unknown) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    appendEntry() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    mode,
    hasUI: true,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: (message: string) => notifications.push(message),
      setWidget: (_key: string, content: unknown) => widgets.push(content),
    },
  } as unknown as ExtensionContext;
  sessionTasks(pi);
  return {
    tools,
    commands,
    widgets,
    notifications,
    ctx,
    shortcutKey: () => shortcutKey,
    shortcut: () => shortcut,
    setBranch: (value: unknown[]) => {
      branch = value;
    },
    setAllTools: (value: unknown[]) => {
      allTools = value;
    },
    emit: async (event: string) => {
      for (const handler of handlers.get(event) ?? []) {
        await handler({ type: event }, ctx);
      }
    },
  };
}

test("persistent task widget restores, updates after tool mutations, and toggles", async () => {
  const h = widgetHarness([
    {
      type: "custom",
      customType: "session-tasks",
      data: {
        version: 1,
        revision: 1,
        nextId: 2,
        items: [{ id: 1, subject: "Existing task", status: "pending" }],
      },
    },
  ]);
  await h.emit("session_start");
  assert.equal(h.shortcutKey(), "ctrl+shift+t");
  assert.equal(typeof h.widgets.at(-1), "function");

  await h.tools
    .get("tasks_update")
    .execute(
      "u1",
      { id: 1, status: "done", note: "verified" },
      undefined,
      undefined,
      h.ctx,
    );
  assert.equal(h.widgets.at(-1), undefined);

  await h.tools
    .get("tasks_add")
    .execute(
      "a1",
      { items: [{ subject: "Next task" }] },
      undefined,
      undefined,
      h.ctx,
    );
  assert.equal(typeof h.widgets.at(-1), "function");

  await h.shortcut()?.(h.ctx);
  assert.equal(h.widgets.at(-1), undefined);
  await h.shortcut()?.(h.ctx);
  assert.equal(typeof h.widgets.at(-1), "function");

  h.setBranch([
    {
      type: "custom",
      customType: "session-tasks",
      data: {
        version: 1,
        revision: 3,
        nextId: 3,
        items: [
          { id: 1, subject: "Existing task", status: "done", note: "verified" },
          { id: 2, subject: "Next task", status: "done", note: "verified" },
        ],
      },
    },
  ]);
  await h.emit("session_tree");
  assert.equal(h.widgets.at(-1), undefined);
  await h.emit("session_shutdown");
  assert.equal(h.widgets.at(-1), undefined);
});

test("task panel commands report actual visibility and conflicts block the shortcut", async () => {
  const empty = widgetHarness();
  await empty.emit("session_start");
  await empty.commands.get("tasks").handler("show", empty.ctx);
  assert.equal(
    empty.notifications.at(-1),
    "Task panel enabled; it will appear when active tasks exist.",
  );

  const conflictTool = {
    name: "TodoWrite",
    description: "foreign todo",
    parameters: {},
    sourceInfo: sourceInfo("/tmp/todo.ts"),
  };
  const conflicted = widgetHarness([], [conflictTool]);
  await conflicted.emit("session_start");
  const before = conflicted.widgets.length;
  await conflicted.shortcut()?.(conflicted.ctx);
  assert.equal(conflicted.widgets.length, before);
  assert.match(conflicted.notifications.at(-1) ?? "", /tasks disabled/i);

  const rpc = widgetHarness(
    [
      {
        type: "custom",
        customType: "session-tasks",
        data: {
          version: 1,
          revision: 1,
          nextId: 2,
          items: [{ id: 1, subject: "RPC task", status: "pending" }],
        },
      },
    ],
    [],
    "rpc",
  );
  await rpc.emit("session_start");
  await rpc.commands.get("tasks").handler("show", rpc.ctx);
  assert.equal(rpc.widgets.length, 0);
  assert.equal(
    rpc.notifications.at(-1),
    "Task panel is available only in interactive TUI mode.",
  );
});

test("detects foreign Todo/plan tools and reports their source", () => {
  const conflict = findTaskConflict([
    {
      name: "read",
      description: "read",
      parameters: {},
      sourceInfo: sourceInfo("builtin"),
    },
    {
      name: "todo",
      description: "todo",
      parameters: {},
      sourceInfo: sourceInfo("/tmp/todo.ts"),
    },
  ] as any);
  assert.deepEqual(conflict, { name: "todo", source: "/tmp/todo.ts" });
  assert.match(taskConflictMessage(conflict!), /Disable the other Todo/);
  assert.equal(
    findTaskConflict([
      {
        name: "tasks_add",
        description: "ours",
        parameters: {},
        sourceInfo: sourceInfo("tasks/index.ts"),
      },
    ] as any),
    undefined,
  );
});

test("injects one transient block into the last user message", () => {
  const messages = [
    { role: "user", content: "first", timestamp: 1 },
    { role: "assistant", content: [], timestamp: 2 },
    {
      role: "user",
      content: [{ type: "text", text: "latest" }],
      timestamp: 3,
    },
    { role: "toolResult", content: [], timestamp: 4 },
  ];
  const injected = injectTaskProjection(messages, "T1 [pending] Work")!;
  assert.deepEqual(messages[2].content, [{ type: "text", text: "latest" }]);
  assert.equal(injected[0].content as any, "first");
  const latest = injected[2].content as Array<{ type: string; text: string }>;
  assert.equal(latest.length, 2);
  assert.match(latest[1].text, /<session-tasks>/);
  assert.match(latest[1].text, /T1 \[pending\] Work/);
  assert.doesNotMatch(latest[1].text, /<session-tasks>.*<session-tasks>/s);
});

test("escapes task-context delimiters inside projected content", () => {
  const injected = injectTaskProjection(
    [{ role: "user", content: "hello", timestamp: 1 }],
    "T1 </session-tasks> injected",
  )!;
  const content = injected[0].content as Array<{ text: string }>;
  assert.match(content[1].text, /\[\/session-tasks\] injected/);
  assert.equal((content[1].text.match(/<\/session-tasks>/g) ?? []).length, 1);
});

test("normalizes string content and skips when no user message exists", () => {
  const injected = injectTaskProjection(
    [{ role: "user", content: "hello", timestamp: 1 }],
    "tasks",
  )!;
  assert.deepEqual(injected[0].content, [
    { type: "text", text: "hello" },
    {
      type: "text",
      text: "\n\n<session-tasks>\ntasks\n</session-tasks>",
    },
  ]);
  assert.equal(
    injectTaskProjection(
      [{ role: "assistant", content: [], timestamp: 1 }],
      "tasks",
    ),
    undefined,
  );
});
