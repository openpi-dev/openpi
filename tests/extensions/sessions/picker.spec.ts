import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  type TUI,
} from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import sessionsExtension from "../../../extensions/sessions/index.ts";
import type { SessionInfoLike } from "../../../extensions/sessions/sessions.ts";

vi.mock("../../../extensions/sessions/git-stats.ts", () => ({
  createSessionStatsLoader: () => ({
    get: () => undefined,
    reconcile: async () => undefined,
    cancel: () => undefined,
  }),
}));

const sessions: SessionInfoLike[] = ["Alpha", "Beta", "Alpine"].map(
  (name, index) => ({
    id: `session-${index}`,
    name,
    cwd: "/tmp/project",
    modified: new Date("2026-09-21T12:00:00Z"),
    firstMessage: "",
    path: `/tmp/session-${index}.jsonl`,
  }),
);

const cleanups: Array<() => void> = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

async function openPicker(columns: number) {
  type CustomFactory = Parameters<ExtensionCommandContext["ui"]["custom"]>[0];
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  const api = {
    registerCommand: (_name: string, registered: typeof command) => {
      command = registered;
    },
  } as unknown as ExtensionAPI;
  sessionsExtension(api);
  assert.ok(command);

  const terminal = { columns, rows: 24 };
  const tui = { terminal, requestRender: () => undefined } as unknown as TUI;
  const theme = {
    fg: (_color: string, value: string) => value,
    bold: (value: string) => value,
    italic: (value: string) => value,
  } as unknown as Parameters<CustomFactory>[1];
  const keybindings = getKeybindings() as Parameters<CustomFactory>[2];
  let picker: (Component & { dispose?(): void }) | undefined;
  let finish: ((result: unknown) => void) | undefined;
  let resolveReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const completed = vi.fn();
  const switchSession = vi.fn(async () => ({ cancelled: false }));
  const ctx = {
    cwd: "/tmp/project",
    hasUI: true,
    switchSession,
    ui: {
      notify: vi.fn(),
      // The first custom view lists native Sessions; test the picker that follows.
      custom: vi
        .fn()
        .mockResolvedValueOnce(sessions)
        .mockImplementationOnce(
          (factory: CustomFactory) =>
            new Promise<unknown>((resolve, reject) => {
              finish = resolve;
              void Promise.resolve(
                factory(tui, theme, keybindings, (result) => {
                  completed(result);
                  resolve(result);
                }),
              ).then((component) => {
                picker = component;
                resolveReady?.();
              }, reject);
            }),
        ),
    },
  } as unknown as ExtensionCommandContext;
  const running = command.handler("", ctx);
  cleanups.push(() => {
    picker?.dispose?.();
    finish?.(null);
  });
  await Promise.race([ready, running]);
  assert.ok(picker?.handleInput);
  const component = picker;
  const input = picker.handleInput.bind(picker);
  const render = () => component.render(terminal.columns).join("\n");
  render();

  return { terminal, input, render, completed, switchSession, running };
}

const scenarios = [
  { name: "Tab in a narrow picker", columns: 60, key: "\t", resize: false },
  {
    name: "Right in a narrow picker",
    columns: 60,
    key: "\u001b[C",
    resize: false,
  },
  {
    name: "a focused preview resized to a narrow picker",
    columns: 100,
    key: "\t",
    resize: true,
  },
];

for (const scenario of scenarios) {
  test(`${scenario.name} preserves search, navigation, and opening a Session`, async () => {
    const harness = await openPicker(scenario.columns);
    harness.input(scenario.key);
    if (scenario.resize) harness.terminal.columns = 60;
    harness.render();

    harness.input("a");
    harness.input("l");
    const filtered = harness.render();
    assert.match(filtered, /Alpha/);
    assert.match(filtered, /Alpine/);
    assert.doesNotMatch(filtered, /Beta/);

    harness.input("\u001b[B");
    assert.match(harness.render(), /→ Alpine/);
    harness.input("\r");
    assert.deepEqual(harness.completed.mock.calls, [[sessions[2]]]);
    await harness.running;
    assert.deepEqual(harness.switchSession.mock.calls, [[sessions[2]!.path]]);
  });

  test(`${scenario.name} preserves Escape cancellation`, async () => {
    const harness = await openPicker(scenario.columns);
    harness.input(scenario.key);
    if (scenario.resize) harness.terminal.columns = 60;
    harness.render();

    harness.input("\u001b");
    assert.deepEqual(harness.completed.mock.calls, [[null]]);
    await harness.running;
    assert.equal(harness.switchSession.mock.calls.length, 0);
  });
}

for (const scenario of [
  {
    name: "Tab and Enter",
    focusKey: "\t",
    finishKey: "\r",
    result: sessions[0],
  },
  {
    name: "Right and Escape",
    focusKey: "\u001b[C",
    finishKey: "\u001b",
    result: null,
  },
]) {
  test(`a wide picker preserves preview controls with ${scenario.name}`, async () => {
    const harness = await openPicker(120);
    harness.input(scenario.focusKey);
    harness.input("t");
    harness.input("h");
    const preview = harness.render();
    assert.match(preview, /compact/);
    assert.match(preview, /hide thinking/);
    assert.match(preview, /Filter: type to filter/);
    assert.match(preview, /Beta/);

    harness.input(scenario.finishKey);
    assert.deepEqual(harness.completed.mock.calls, [[scenario.result]]);
    await harness.running;
    assert.deepEqual(
      harness.switchSession.mock.calls,
      scenario.result ? [[scenario.result.path]] : [],
    );
  });
}

test("a narrow picker treats t and h as search text after Tab", async () => {
  const harness = await openPicker(60);
  harness.input("\t");
  harness.input("t");
  harness.input("h");
  const filtered = harness.render();
  assert.match(filtered, /Filter: th/);
  assert.match(filtered, /No matching sessions/);
});

for (const restoreWidth of [false, true]) {
  test(
    restoreWidth
      ? "rendering narrow then wide restores list search without intervening input"
      : "resizing a focused preview restores list search before the next render",
    async () => {
      const harness = await openPicker(100);
      harness.input("\t");
      harness.terminal.columns = 60;
      if (restoreWidth) {
        harness.render();
        harness.terminal.columns = 100;
        harness.render();
      }

      harness.input("a");
      harness.input("l");
      const filtered = harness.render();
      assert.match(filtered, /Alpha/);
      assert.match(filtered, /Alpine/);
      assert.doesNotMatch(filtered, /Beta/);
    },
  );
}
