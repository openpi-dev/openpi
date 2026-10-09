import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import {
  createEventBus,
  DefaultResourceLoader,
  initTheme,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorComponent, TUI } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import {
  getEditorTheme,
  theme,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { toolExecutionContext } from "../../support/extension-tool-context.ts";
import type { EditorLayer } from "../../../extensions/shared/editor-layers.ts";

test("native extension graphs cycle management strips through the composed editor", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "openpi-native-navigation-"));
  const agentDir = path.join(cwd, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(agentDir);
  initTheme("dark", false);
  const bus = createEventBus();
  const layers: EditorLayer[] = [];
  bus.on("openpi:editor-layers:register", (value) => {
    layers.push((value as { layer: EditorLayer }).layer);
  });
  const names = [
    "clear-context",
    "subagents",
    "windows-terminal-compat",
    "capabilities",
    "suggestions",
    "workflows",
    "image-paste",
  ];
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    eventBus: bus,
    settingsManager: SettingsManager.inMemory(undefined, {
      projectTrusted: false,
    }),
    additionalExtensionPaths: names.map((name) =>
      fileURLToPath(
        new URL(`../../../extensions/${name}/index.ts`, import.meta.url),
      ),
    ),
  });
  type EditorFactory = NonNullable<
    ReturnType<ExtensionContext["ui"]["getEditorComponent"]>
  >;
  let factory: EditorFactory | undefined;
  const widgets = new Map<string, Component & { dispose?(): void }>();
  const tui = {
    requestRender() {},
    terminal: { columns: 120, rows: 24 },
    mode: "regular",
    getClearOnShrink: () => false,
    setClearOnShrink() {},
  } as unknown as TUI;
  const keys = new KeybindingsManager();
  const model = {
    provider: "navigation-fixture",
    id: "unconfigured",
    name: "Unconfigured fixture",
    api: "navigation-fixture-no-provider",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 100,
  };
  // No registered provider or credentials: the real child settles at auth
  // preflight, giving the UI a bounded error notice without any model request.
  const modelRegistry = {
    find: () => model,
    getAll: () => [model],
    getAvailable: () => [model],
    getApiKey: async () => undefined,
    getApiKeyForProvider: async () => undefined,
    authStorage: { getApiKey: async () => undefined, hasAuth: () => false },
  };
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    model,
    modelRegistry,
    isIdle: () => false,
    isProjectTrusted: () => false,
    getContextUsage: () => undefined,
    sessionManager: {
      getLeafId: () => "leaf",
      getBranch: () => [],
      getEntries: () => [],
      getSessionId: () => "native-navigation-fixture",
    },
    ui: {
      theme,
      getEditorComponent: () => factory,
      setEditorComponent: (value: EditorFactory) => {
        factory = value;
      },
      setStatus() {},
      notify() {},
      onTerminalInput: () => () => {},
      setWidget(
        key: string,
        value?: (tui: TUI, theme: ExtensionContext["ui"]["theme"]) => Component,
      ) {
        widgets.get(key)?.dispose?.();
        if (value) widgets.set(key, value(tui, theme));
        else widgets.delete(key);
      },
    },
  } as unknown as ExtensionContext;
  let loaded: ReturnType<DefaultResourceLoader["getExtensions"]> | undefined;
  const emit = async (name: "session_start" | "session_shutdown" | "input") => {
    for (const extension of loaded?.extensions ?? []) {
      for (const handler of extension.handlers.get(name) ?? []) {
        await handler(
          { type: name, source: "interactive", text: "fixture" } as never,
          ctx,
        );
      }
    }
  };
  try {
    await loader.reload();
    loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, names.length);
    let active: string[] = [];
    Object.assign(loaded.runtime, {
      getActiveTools: () => active,
      setActiveTools: (value: string[]) => {
        active = value;
      },
      getAllTools: () => [],
      refreshTools() {},
      getThinkingLevel: () => "off",
      appendEntry() {},
      sendMessage() {
        assert.fail("fixture must not deliver a parent turn");
      },
    });
    await emit("session_start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(factory);
    const ordered = layers.sort(
      (a, b) => a.order - b.order || a.id.localeCompare(b.id),
    );
    assert.deepEqual(
      ordered.map((layer) => layer.id),
      [
        "clear-context",
        "subagents",
        "windows-terminal-compat",
        "capability-intent-highlight",
        "suggestions",
        "workflows",
        "image-paste",
      ],
    );
    const instances = new Map<string, EditorComponent>();
    let base = factory(tui, getEditorTheme(), keys);
    // Observe constructors obtained from actual registered wrap closures, not
    // manually imported copies of the shared navigation class.
    for (const layer of ordered) {
      base = layer.wrap(base, tui, getEditorTheme(), keys);
      instances.set(layer.id, base);
    }
    assert.notEqual(
      instances.get("subagents")!.constructor,
      instances.get("workflows")!.constructor,
    );
    assert.equal(
      instances.get("windows-terminal-compat"),
      instances.get("subagents"),
    );
    const editor = factory(tui, getEditorTheme(), keys);
    const tool = (name: string) => {
      const registered = loaded!.extensions
        .flatMap((extension) => [...extension.tools.values()])
        .find((entry) => entry.definition.name === name);
      assert.ok(registered);
      return registered.definition;
    };
    const rows = () =>
      Object.fromEntries(
        [...widgets].map(([id, widget]) => [
          id,
          widget.render(120).map(stripVTControlCharacters).join("\n"),
        ]),
      );
    const focused = () =>
      Object.entries(rows())
        .filter(([, row]) => row.includes("❯"))
        .map(([id]) => id);
    const down = () => editor.handleInput("\u001b[B");
    down();
    assert.deepEqual(focused(), []);
    assert.equal(editor.getText(), "");
    await tool("subagent_spawn").execute(
      "subagent-fixture",
      {
        prompt: "No model request",
        name: "navigation fixture",
      },
      undefined,
      undefined,
      toolExecutionContext(ctx),
    );
    for (
      let count = 0;
      count < 100 && !rows()["subagent-navigation"]?.includes("✗");
      count++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const settlement = await tool("subagent_wait").execute(
      "fixture-result",
      { ids: ["sa-1"], timeout_ms: 10 },
      undefined,
      undefined,
      toolExecutionContext(ctx),
    );
    assert.match(
      JSON.stringify(settlement.content),
      /No API key found for navigation-fixture/,
    );
    assert.match(rows()["subagent-navigation"] ?? "", /✗.*navigation fixture/);
    down();
    down();
    assert.deepEqual(focused(), ["subagent-navigation"]);
    editor.handleInput("x");
    assert.deepEqual(focused(), []);
    assert.equal(editor.getText(), "x");
    editor.setText("");
    await tool("workflow").execute(
      "workflow-fixture",
      {
        script:
          'export const meta = { name: "navigation workflow" }; return 1;',
        wait: true,
      },
      undefined,
      undefined,
      toolExecutionContext(ctx),
    );
    assert.match(rows()["workflow-navigation"] ?? "", /navigation workflow/);
    for (let cycle = 0; cycle < 3; cycle++) {
      down();
      assert.deepEqual(focused(), ["workflow-navigation"]);
      down();
      assert.deepEqual(
        focused(),
        ["subagent-navigation"],
        JSON.stringify(rows()),
      );
    }
    for (const key of ["\u001b[A", "\u001b[D", "\u001b"]) {
      editor.handleInput(key);
      assert.deepEqual(focused(), []);
      down();
      down();
      assert.deepEqual(focused(), ["subagent-navigation"]);
    }
    editor.handleInput("z");
    assert.deepEqual(focused(), []);
    assert.equal(editor.getText(), "z");
    editor.setText("");
    let shortcuts = 0;
    const appEditor = editor as EditorComponent & {
      onExtensionShortcut?: (data: string) => boolean;
    };
    appEditor.onExtensionShortcut = (data) => {
      if (data !== "\u000f") return false;
      shortcuts++;
      return true;
    };
    down();
    down();
    editor.handleInput("\u000f");
    assert.equal(shortcuts, 1);
    assert.deepEqual(focused(), []);
    await emit("input");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(widgets.size, 0);
    down();
    assert.deepEqual(focused(), []);
    await tool("workflow").execute(
      "workflow-only",
      { script: "return 2;", wait: true },
      undefined,
      undefined,
      toolExecutionContext(ctx),
    );
    down();
    down();
    assert.deepEqual(focused(), ["workflow-navigation"]);
  } finally {
    await emit("session_shutdown");
    for (const widget of widgets.values()) widget.dispose?.();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});
