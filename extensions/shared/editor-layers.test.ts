import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createCapabilitiesExtension } from "../capabilities/index.ts";
import subagents from "../subagents/index.ts";
import suggestions from "../suggestions/index.ts";
import workflows from "../workflows/index.ts";

type EditorFactory = NonNullable<
  ReturnType<ExtensionContext["ui"]["getEditorComponent"]>
>;

function createEventBus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel: string, data: unknown) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on(channel: string, handler: (data: unknown) => void) {
      const listeners = handlers.get(channel) ?? new Set();
      listeners.add(handler);
      handlers.set(channel, listeners);
      return () => listeners.delete(handler);
    },
  };
}

function editorLifecycleHarness() {
  const lifecycle = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => unknown>
  >();
  const events = createEventBus();
  let editorFactory: EditorFactory | undefined;
  let editorWrites = 0;

  const load = (factory: ExtensionFactory) => {
    let activeTools: string[] = [];
    const api = {
      events,
      on(event: string, handler: unknown) {
        lifecycle.set(event, [
          ...(lifecycle.get(event) ?? []),
          handler as (event: unknown, ctx: ExtensionContext) => unknown,
        ]);
      },
      registerTool(tool: { name: string }) {
        activeTools = [
          ...activeTools.filter((name) => name !== tool.name),
          tool.name,
        ];
      },
      getActiveTools: () => [...activeTools],
      setActiveTools(names: string[]) {
        activeTools = [...names];
      },
      getAllTools: () => [],
      registerCommand() {},
      registerMessageRenderer() {},
      registerEntryRenderer() {},
      getThinkingLevel: () => "off",
      sendMessage() {},
      appendEntry() {},
    } as unknown as ExtensionAPI;
    factory(api);
  };

  load(subagents);
  load(
    createCapabilitiesExtension({
      loadConfig: () => ({ capabilities: { discovery: "explicit" } }),
    }),
  );
  load(suggestions);
  load(workflows);

  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    isProjectTrusted: () => false,
    sessionManager: {
      getLeafId: () => "leaf",
      getBranch: () => [],
      getSessionId: () => "session",
      getEntries: () => [],
    },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      getEditorComponent: () => editorFactory,
      setEditorComponent(factory: EditorFactory | undefined) {
        editorFactory = factory;
        editorWrites += 1;
      },
      setStatus() {},
      setWidget() {},
      notify() {},
    },
  } as unknown as ExtensionContext;

  const emit = async (event: string) => {
    for (const handler of lifecycle.get(event) ?? []) {
      await handler({ type: event }, ctx);
    }
  };

  return {
    emit,
    editorFactory: () => editorFactory,
    editorWrites: () => editorWrites,
  };
}

test("one session binds all OpenPI editor layers with one UI write", async () => {
  const first = editorLifecycleHarness();
  await first.emit("session_start");
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(first.editorWrites(), 1);
  assert.equal(typeof first.editorFactory(), "function");

  await first.emit("session_shutdown");

  const resumed = editorLifecycleHarness();
  await resumed.emit("session_start");
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(resumed.editorWrites(), 1);
  assert.equal(typeof resumed.editorFactory(), "function");
  assert.notEqual(resumed.editorFactory(), first.editorFactory());
});
