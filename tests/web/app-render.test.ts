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
    addEventListener() {},
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
  runtime: { status: "idle", capabilities: {} },
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

async function renderApp() {
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
  const storage = { getItem: () => null, setItem() {} };
  const context: Record<string, unknown> = {
    console,
    document: documentStub,
    localStorage: storage,
    sessionStorage: storage,
    navigator: {},
    location: { hash: "#token=test" },
    fetch: async (url: unknown) =>
      String(url).startsWith("/events")
        ? {
            ok: true,
            body: { getReader: () => ({ read: () => new Promise(() => {}) }) },
          }
        : {
            ok: true,
            status: 200,
            json: async () => SNAPSHOT,
            text: async () => "",
          },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URLSearchParams,
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
  // Load the real marked UMD so markdown rendering (including the CJK strong
  // extension) is exercised for real.
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
  return { elements };
}

test("app.js renders a full session without runtime errors", async () => {
  const { elements } = await renderApp();
  const conversation = elements.get("conversation");
  assert.ok(conversation, "conversation element exists");
  assert.match(conversation.innerHTML, /message-row user/);
  assert.match(conversation.innerHTML, /thinking-line/);
  assert.match(conversation.innerHTML, /tool-line/);
  assert.match(conversation.innerHTML, /activity-card subagent/);
  assert.match(conversation.innerHTML, /activity-card workflow/);
  // Family results merged into call cards do not render separate rows.
  assert.doesNotMatch(conversation.innerHTML, /subagent wait ·/);
  // Non-family results keep their own row.
  assert.match(conversation.innerHTML, /file1/);
  // Only the user message and the final assistant answer show copy/time.
  const actionBars = conversation.innerHTML.match(/message-actions/g) || [];
  assert.equal(actionBars.length, 2);
  // CJK bold (**完成（done）**) must render through the cjkStrong extension.
  assert.match(conversation.innerHTML, /<strong>完成（done）<\/strong>/);
});

test("app.js renders the landing state for an empty selection", async () => {
  const { elements } = await renderApp();
  const conversation = elements.get("conversation");
  assert.ok(conversation);
  assert.ok(conversation.innerHTML.length > 0);
});
