/**
 * Extension-level repaint accounting: the strip widget's own timer is covered
 * in navigation.test.ts, but the manager notifies on *every* child event
 * (streaming deltas, tool cycles, usage ramps), and each notify reaches
 * `ui.setStatus`. Pi's `setStatus` requests a global render without diffing the
 * text, so an unchanged footer write is an invisible full repaint. These tests
 * drive a real spawn through a stub backend and spy on the UI to prove the
 * complete manager -> setStatus path collapses unchanged writes while still
 * reporting every real state change.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import subagents from "../../../extensions/subagents/index.ts";
import { __setSubagentTestBackends } from "../../../extensions/subagents/src/runtime.ts";
import { makeStubBackend } from "../../support/subagents-stub.ts";

const SETTLE_TIMEOUT_MS = 15_000;
/** Longer than the 500 ms subagent strip cadence, short enough to stay cheap. */
const IDLE_OBSERVATION_MS = 900;

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
  inverse: (text: string) => text,
};

type WidgetFactory = (
  tui: TUI,
  theme: unknown,
) => Component & {
  dispose?(): void;
};

interface Harness {
  readonly statusWrites: Array<string | undefined>;
  readonly renders: () => number;
  readonly spawn: (prompt: string) => Promise<void>;
  readonly settled: Promise<void>;
  readonly widget: () => (Component & { dispose?(): void }) | undefined;
  readonly shutdown: () => Promise<void>;
}

function harness(mode: ExtensionContext["mode"], cwd: string): Harness {
  const hooks = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  const tools = new Map<
    string,
    { execute: (...args: unknown[]) => Promise<unknown> }
  >();
  const statusWrites: Array<string | undefined> = [];
  let renders = 0;
  let widgetFactory: WidgetFactory | undefined;
  let widget: (Component & { dispose?(): void }) | undefined;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });

  let activeTools: string[] = [];
  const pi = {
    events: { on: () => () => undefined, emit: () => {} },
    on(event: string, handler: unknown) {
      hooks.set(
        event,
        handler as (event: unknown, ctx: ExtensionContext) => unknown,
      );
    },
    registerTool(tool: {
      name: string;
      execute: (...args: unknown[]) => Promise<unknown>;
    }) {
      tools.set(tool.name, tool);
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
    appendEntry(customType: string) {
      if (customType === "subagent-finished") resolveSettled();
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd,
    mode,
    hasUI: true,
    isIdle: () => false,
    isProjectTrusted: () => false,
    getContextUsage: () => undefined,
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "session",
      getEntries: () => [],
      getLeafId: () => "leaf",
    },
    ui: {
      theme,
      getEditorComponent: () => undefined,
      setEditorComponent() {},
      setStatus(_key: string, text: string | undefined) {
        statusWrites.push(text);
      },
      setWidget(_key: string, content: WidgetFactory | undefined) {
        widgetFactory = content;
        if (!content) {
          widget?.dispose?.();
          widget = undefined;
        }
      },
      notify() {},
    },
  } as unknown as ExtensionContext;

  subagents(pi);
  hooks.get("session_start")?.({}, ctx);

  return {
    statusWrites,
    renders: () => renders,
    async spawn(prompt: string) {
      await tools
        .get("subagent_spawn")
        ?.execute(
          "call-spawn",
          { prompt, name: "stub run" },
          new AbortController().signal,
          undefined,
          ctx,
        );
    },
    settled,
    widget() {
      // Instantiating the captured factory is what the real TUI does on the
      // first paint, and it is the only way the widget's timer starts.
      if (!widget && widgetFactory) {
        widget = widgetFactory(
          {
            requestRender() {
              renders += 1;
            },
          } as unknown as TUI,
          theme,
        );
      }
      return widget;
    },
    async shutdown() {
      widget?.dispose?.();
      await hooks.get("session_shutdown")?.({}, ctx);
    },
  };
}

async function withStubBackend(run: (cwd: string) => Promise<void>) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "openpi-status-repaint-"),
  );
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(directory, "agent");
  __setSubagentTestBackends([
    makeStubBackend({
      backend: "pi",
      defaultModelLabel: "stub-model",
      contextWindow: 200_000,
      toolName: "bash",
      cadenceMs: 5,
    }),
  ]);
  try {
    await run(directory);
  } finally {
    __setSubagentTestBackends(undefined);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
}

function withTimeout<T>(promise: Promise<T>, label: string) {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for ${label}`)),
        SETTLE_TIMEOUT_MS,
      );
      timer.unref?.();
    }),
  ]);
}

test("a streaming subagent writes the TUI footer status once", async () => {
  await withStubBackend(async (cwd) => {
    const ui = harness("tui", cwd);
    try {
      await ui.spawn("Look around and report.");
      const widget = ui.widget();
      assert.ok(widget, "spawning makes the below-editor strip visible");

      await withTimeout(ui.settled, "the stub subagent to settle");
      // Streaming, tool, and usage events all folded into the snapshot, so the
      // manager notified many times over.
      const line = widget.render(120).join("");
      assert.match(line, /% ctx/, "usage events reached the strip");

      // The TUI footer line is intentionally empty for subagents (the strip
      // carries the same activity), so every notify after the first would have
      // rewritten the same `undefined` and repainted the whole terminal.
      assert.deepEqual(ui.statusWrites, [undefined]);

      const settledRenders = ui.renders();
      await new Promise((resolve) => setTimeout(resolve, IDLE_OBSERVATION_MS));
      assert.equal(
        ui.renders(),
        settledRenders,
        "a settled strip stops asking for renders",
      );
    } finally {
      await ui.shutdown();
    }
  });
});

test("non-TUI footer status still reports every real activity change", async () => {
  await withStubBackend(async (cwd) => {
    const ui = harness("print", cwd);
    try {
      await ui.spawn("Look around and report.");
      await withTimeout(ui.settled, "the stub subagent to settle");

      // Outside the TUI the footer is the only report, so it must follow the
      // counts: empty, then running, then done. The dozens of streaming events
      // in between all render the same "1 running" text and are collapsed.
      assert.deepEqual(
        ui.statusWrites.map((text) => text?.replace(/^subagents: /, "")),
        [
          undefined,
          "1 running · /subagents to view",
          "1 done · /subagents to view",
        ],
      );
    } finally {
      await ui.shutdown();
    }
  });
});
