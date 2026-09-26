import assert from "node:assert/strict";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  initTheme,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import sessionsExtension from "../../../extensions/sessions/index.ts";
import type { SessionInfoLike } from "../../../extensions/sessions/sessions.ts";

initTheme("dark");

const input = {
  tab: "\t",
  escape: "\u001b",
  enter: "\r",
  down: "\u001b[B",
  right: "\u001b[C",
};

type Picker = {
  render(width: number): string[];
  handleInput(data: string): void;
  dispose?(): void;
};

const theme = {
  fg: (color: unknown, text: string) =>
    color === "accent" ? `<accent>${text}</accent>` : text,
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
) {
  const sessions = createSessions();
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
    terminal: { columns: width, rows: 24 },
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

      void Promise.resolve(
        factory(tui, theme, { matches: () => false }, done),
      ).then((component) => {
        if (call === 0) {
          firstComponent = component;
          if (firstDone) firstComponent.dispose?.();
          return;
        }
        picker = component;
        pickerDone = done as (value: SessionInfoLike | null) => void;
        picker.render(width);
        pickerReadyResolve?.();
      });
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

  const command = commandHandler("", ctx);
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
  return picker.render(width).join("\n");
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
      assert.match(rendered(picker, 60), /Filter: a/);

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
    assert.match(rendered(picker, 60), /Filter: b/);

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
      assert.match(rendered(picker, 60), /<accent>→ alpha/);
      picker.handleInput("b");
      assert.match(rendered(picker, 60), /Filter: b/);

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
