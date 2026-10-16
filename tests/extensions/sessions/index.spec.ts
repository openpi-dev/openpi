import assert from "node:assert/strict";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  initTheme,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import sessionsExtension from "../../../extensions/sessions/index.ts";
import type { SessionInfoLike } from "../../../extensions/sessions/sessions.ts";

initTheme("dark");

const input = {
  tab: "\t",
  escape: "\u001b",
  enter: "\r",
  down: "\u001b[B",
  right: "\u001b[C",
  up: "\u001b[A",
  pageDown: "\u001b[6~",
};

type Picker = {
  render(width: number): string[];
  handleInput(data: string): void;
  dispose?(): void;
};

const theme = {
  fg: (color: unknown, text: string) =>
    `\u001b[${color === "accent" ? 36 : color === "text" ? 37 : 90}m${text}\u001b[0m`,
  bold: (text: string) => text,
  italic: (text: string) => text,
};

function createSessions(): SessionInfoLike[] {
  return [
    {
      id: "alpha-id",
      name: "alpha",
      cwd: process.cwd(),
      modified: new Date("2026-09-22T12:00:00Z"),
      firstMessage: "alpha work",
      path: "/tmp/openpi-alpha-session.jsonl",
    },
    {
      id: "beta-id",
      name: "beta",
      cwd: process.cwd(),
      modified: new Date("2026-09-22T11:00:00Z"),
      firstMessage: "beta work",
      path: "/tmp/openpi-beta-session.jsonl",
    },
  ];
}

async function withPicker(
  width: number,
  run: (harness: {
    picker: Picker;
    tui: { terminal: { columns: number; rows: number } };
    sessions: SessionInfoLike[];
    switchedPath: () => string | undefined;
    pickerSettled: () => boolean;
    waitForCommand: () => Promise<void>;
  }) => Promise<void>,
  options: { rows?: number; sessions?: SessionInfoLike[]; args?: string } = {},
) {
  const sessions = options.sessions ?? createSessions();
  const originalList = SessionManager.list;
  SessionManager.list = async () =>
    sessions as unknown as Awaited<ReturnType<typeof SessionManager.list>>;

  let commandHandler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  const pi = {
    registerCommand(
      _name: string,
      command: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      commandHandler = command.handler;
    },
  } as unknown as ExtensionAPI;
  sessionsExtension(pi);
  assert.ok(commandHandler);

  const tui = {
    terminal: { columns: width, rows: options.rows ?? 24 },
    requestRender() {},
  };
  let customCall = 0;
  let firstComponent: Picker | undefined;
  let firstDone = false;
  let picker: Picker | undefined;
  let pickerDone: ((value: SessionInfoLike | null) => void) | undefined;
  let pickerReadyResolve: (() => void) | undefined;
  const pickerReady = new Promise<void>((resolve) => {
    pickerReadyResolve = resolve;
  });
  let pickerWasSettled = false;
  let selectedPath: string | undefined;

  type CustomFactory = (
    tui: unknown,
    theme: unknown,
    keybindings: unknown,
    done: (value: unknown) => void,
  ) => Picker | Promise<Picker>;

  const custom = (factory: CustomFactory) => {
    const call = customCall++;
    return new Promise<unknown>((resolve) => {
      let doneCalled = false;
      const done = (value: unknown) => {
        if (doneCalled) return;
        doneCalled = true;
        if (call === 0) firstDone = true;
        if (call === 1) pickerWasSettled = true;
        resolve(value);
      };

      void Promise.resolve(factory(tui, theme, getKeybindings(), done)).then(
        (component) => {
          if (call === 0) {
            firstComponent = component;
            if (firstDone) firstComponent.dispose?.();
            return;
          }
          picker = component;
          pickerDone = done as (value: SessionInfoLike | null) => void;
          picker.render(width);
          pickerReadyResolve?.();
        },
      );
    });
  };

  const ctx = {
    hasUI: true,
    cwd: process.cwd(),
    ui: {
      custom,
      notify() {},
    },
    switchSession: async (path: string) => {
      selectedPath = path;
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;

  const command = commandHandler(options.args ?? "", ctx);
  await pickerReady;
  assert.ok(picker);

  try {
    await run({
      picker,
      tui,
      sessions,
      switchedPath: () => selectedPath,
      pickerSettled: () => pickerWasSettled,
      waitForCommand: () => command,
    });
  } finally {
    if (!pickerWasSettled) pickerDone?.(null);
    picker.dispose?.();
    await command;
    SessionManager.list = originalList;
  }
}

function rendered(picker: Picker, width: number) {
  return stripVTControlCharacters(picker.render(width).join("\n"));
}

test("narrow /sessions keeps Tab focus on the visible list", async () => {
  await withPicker(
    60,
    async ({
      picker,
      sessions,
      pickerSettled,
      switchedPath,
      waitForCommand,
    }) => {
      picker.handleInput(input.tab);
      picker.handleInput("a");
      assert.match(rendered(picker, 60), /⌕ \[ a \]/);

      picker.handleInput(input.down);
      assert.match(rendered(picker, 60), /→ beta/);

      picker.handleInput(input.enter);
      assert.equal(pickerSettled(), true);
      await waitForCommand();
      assert.equal(switchedPath(), sessions[1]!.path);
    },
  );
});

test("narrow /sessions keeps Right focus on the visible list and Escape cancels", async () => {
  await withPicker(60, async ({ picker, pickerSettled, switchedPath }) => {
    picker.handleInput(input.right);
    picker.handleInput("b");
    assert.match(rendered(picker, 60), /⌕ \[ b \]/);

    picker.handleInput(input.escape);
    assert.equal(pickerSettled(), true);
    assert.equal(switchedPath(), undefined);
  });
});

test("shrinking a preview restores list focus before the next input", async () => {
  await withPicker(
    100,
    async ({ picker, tui, pickerSettled, switchedPath }) => {
      picker.handleInput(input.right);
      tui.terminal.columns = 60;
      // Input may arrive before the first render at the new width.
      picker.handleInput("b");
      assert.match(rendered(picker, 60), /⌕ \[ b \]/);

      picker.handleInput(input.escape);
      assert.equal(pickerSettled(), true);
      assert.equal(switchedPath(), undefined);
    },
  );
});

test("wide /sessions keeps preview toggles and selection confirmation", async () => {
  await withPicker(
    100,
    async ({
      picker,
      sessions,
      pickerSettled,
      switchedPath,
      waitForCommand,
    }) => {
      picker.handleInput(input.right);
      picker.handleInput("t");
      picker.handleInput("h");
      const output = rendered(picker, 100);
      assert.match(output, /compact/);
      assert.match(output, /hide thinking/);

      picker.handleInput(input.enter);
      assert.equal(pickerSettled(), true);
      await waitForCommand();
      assert.equal(switchedPath(), sessions[0]!.path);
    },
  );
});

function manySessions() {
  return Array.from({ length: 20 }, (_, index) => ({
    id: `s${index}`,
    name: `s${index}`,
    cwd: process.cwd(),
    modified: new Date(Date.UTC(2026, 8, 22, 12, 0, 20 - index)),
    firstMessage: `work ${index}`,
    path: `/tmp/openpi-search-s${index}.jsonl`,
  }));
}

test("single-pane separator never hides the native selected Session behind overlay clipping", async () => {
  await withPicker(
    60,
    async ({ picker, sessions, waitForCommand, switchedPath }) => {
      picker.handleInput(input.up);
      const displayed = stripVTControlCharacters(
        picker.render(60).slice(0, 15).join("\n"),
      );
      assert.match(displayed, /→ s19(?:\s|$)/u);
      assert.ok(
        picker.render(60).length <= 15,
        "complete picker fits the actual overlay height",
      );
      picker.handleInput(input.enter);
      await waitForCommand();
      assert.equal(switchedPath(), sessions[19]!.path);
    },
    { rows: 15, sessions: manySessions() },
  );
});

test("search contour, separator and selected item fit native cell and row budgets", async () => {
  for (const width of [20, 40, 79, 80, 120, 160]) {
    for (const rows of [12, 15, 24]) {
      for (const args of ["1", "", "100"]) {
        await withPicker(
          width,
          async ({ picker }) => {
            for (const key of [
              undefined,
              input.down,
              input.pageDown,
              input.up,
            ]) {
              if (key) picker.handleInput(key);
              const lines = picker.render(width);
              const text = stripVTControlCharacters(lines.join("\n"));
              assert.ok(
                lines.length <= rows,
                `${width}x${rows} /sessions ${args}: height ${lines.length}`,
              );
              assert.ok(
                lines.every((line) => visibleWidth(line) <= width),
                `${width}x${rows}: cell width`,
              );
              assert.match(text, /⌕ \[ type to f(?:ilter|\.\.\.) \]/u);
              assert.ok(
                lines.some((line) =>
                  stripVTControlCharacters(line).trim().startsWith("────"),
                ),
              );
              assert.match(
                stripVTControlCharacters(lines.slice(0, rows).join("\n")),
                /→ s\d/u,
              );
            }
          },
          { rows, args, sessions: manySessions() },
        );
      }
    }
  }
});

test("search clipping is only presentation and preserves query, backspace and focus", async () => {
  const query = "界".repeat(30) + "é";
  const entries = [
    { ...createSessions()[0]!, name: query },
    createSessions()[1]!,
  ];
  for (const width of [20, 40, 80, 120, 160]) {
    await withPicker(
      width,
      async ({ picker, sessions, waitForCommand, switchedPath }) => {
        for (const key of query) picker.handleInput(key);
        const lines = picker.render(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        const filter = lines
          .map(stripVTControlCharacters)
          .find((line) => line.includes("⌕ ["))!;
        assert.match(filter, / \]/u);
        assert.match(rendered(picker, width), /→/u);
        picker.handleInput("x");
        assert.match(rendered(picker, width), /No matching/u);
        picker.handleInput("\u007f");
        assert.match(rendered(picker, width), /→/u);
        if (width >= 80) {
          assert.ok(
            picker.render(width).some((line) => line.includes("\u001b[36m⌕ [")),
          );
          picker.handleInput(input.tab);
          assert.ok(
            picker.render(width).some((line) => line.includes("\u001b[90m⌕ [")),
          );
        }
        picker.handleInput(input.enter);
        await waitForCommand();
        assert.equal(switchedPath(), sessions[0]!.path);
      },
      { sessions: entries },
    );
  }
});
