import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  applyWindowsTerminalCompatibility,
  readWindowsTerminalCompatibilityEnabled,
  registerWindowsTerminalCompatibility,
  shouldClearShrunkRows,
} from "../../../extensions/windows-terminal-compat/index.ts";

test("enables shrink cleanup for the Windows regular renderer", () => {
  assert.equal(shouldClearShrunkRows("win32", "regular"), true);

  let enabled: boolean | undefined;
  applyWindowsTerminalCompatibility(
    {
      mode: "regular",
      getClearOnShrink() {
        return false;
      },
      setClearOnShrink(value) {
        enabled = value;
      },
    },
    "win32",
  );

  assert.equal(enabled, true);
});

test("does not change non-Windows or fullscreen rendering", () => {
  assert.equal(shouldClearShrunkRows("linux", "regular"), false);
  assert.equal(shouldClearShrunkRows("win32", "fullscreen"), false);

  let calls = 0;
  const tui = {
    mode: "fullscreen" as const,
    getClearOnShrink() {
      return false;
    },
    setClearOnShrink() {
      calls += 1;
    },
  };

  applyWindowsTerminalCompatibility(tui, "win32");
  applyWindowsTerminalCompatibility({ ...tui, mode: "regular" }, "linux");

  assert.equal(calls, 0);
});

test("supports an explicit environment opt-out", () => {
  assert.equal(shouldClearShrunkRows("win32", "regular", false), false);

  let calls = 0;
  applyWindowsTerminalCompatibility(
    {
      mode: "regular",
      getClearOnShrink() {
        return false;
      },
      setClearOnShrink() {
        calls += 1;
      },
    },
    "win32",
    false,
  );

  assert.equal(calls, 0);
});

test("preserves an explicit native false renderer setting", () => {
  let calls = 0;
  applyWindowsTerminalCompatibility(
    {
      mode: "regular",
      getClearOnShrink() {
        return false;
      },
      setClearOnShrink() {
        calls += 1;
      },
    },
    "win32",
    false,
  );
  assert.equal(calls, 0);
});

test("uses the project setting ahead of the global setting", async () => {
  const enabled = await readWindowsTerminalCompatibilityEnabled({
    platform: "win32",
    cwd: "/repo",
    settingsReaderFactory: () => ({
      getGlobalSettings: () => ({ terminal: { clearOnShrink: true } }),
      getProjectSettings: () => ({ terminal: { clearOnShrink: false } }),
    }),
  });

  assert.equal(enabled, false);
});

test("uses an explicit global setting when the project does not override it", async () => {
  const enabled = await readWindowsTerminalCompatibilityEnabled({
    platform: "win32",
    cwd: "/repo",
    settingsReaderFactory: () => ({
      getGlobalSettings: () => ({ terminal: { clearOnShrink: false } }),
      getProjectSettings: () => ({}),
    }),
  });

  assert.equal(enabled, false);
});

test("defaults to the Windows compatibility behavior only when native settings are unset", async () => {
  const enabled = await readWindowsTerminalCompatibilityEnabled({
    platform: "win32",
    cwd: "/repo",
    settingsReaderFactory: () => ({
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({}),
    }),
  });

  assert.equal(enabled, true);
});

test("gives the environment opt-out and settings-read failures fail-closed precedence", async () => {
  let reads = 0;
  const disabledByEnvironment = await readWindowsTerminalCompatibilityEnabled({
    platform: "win32",
    clearOnShrinkEnv: "0",
    cwd: "/repo",
    settingsReaderFactory: () => {
      reads += 1;
      return {
        getGlobalSettings: () => ({}),
        getProjectSettings: () => ({}),
      };
    },
  });
  const disabledByReadFailure = await readWindowsTerminalCompatibilityEnabled({
    platform: "win32",
    cwd: "/repo",
    settingsReaderFactory: () => {
      throw new Error("unreadable settings");
    },
  });
  const disabledByReportedError = await readWindowsTerminalCompatibilityEnabled(
    {
      platform: "win32",
      cwd: "/repo",
      settingsReaderFactory: () => ({
        getGlobalSettings: () => ({}),
        getProjectSettings: () => ({}),
        drainErrors: () => [new Error("invalid settings")],
      }),
    },
  );

  assert.equal(disabledByEnvironment, false);
  assert.equal(reads, 0);
  assert.equal(disabledByReadFailure, false);
  assert.equal(disabledByReportedError, false);
});

test("applies the resolved native setting through the session-start bootstrap", async () => {
  const eventHandlers = new Map<
    string,
    Array<(event: unknown, ctx: unknown) => unknown>
  >();
  const busHandlers = new Map<string, Array<(value: unknown) => void>>();
  let editorFactory: ((...args: readonly unknown[]) => unknown) | undefined;
  const pi = {
    on(event: string, handler: (value: unknown, ctx: unknown) => unknown) {
      eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]);
    },
    events: {
      on(event: string, handler: (value: unknown) => void) {
        busHandlers.set(event, [...(busHandlers.get(event) ?? []), handler]);
      },
      emit(event: string, value: unknown) {
        for (const handler of busHandlers.get(event) ?? []) handler(value);
      },
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui",
    cwd: "/repo",
    ui: {
      getEditorComponent: () => () => ({}),
      setEditorComponent(factory: (...args: readonly unknown[]) => unknown) {
        editorFactory = factory;
      },
      onTerminalInput: () => () => {},
    },
  } as unknown as ExtensionContext;

  registerWindowsTerminalCompatibility(pi, {
    platform: "win32",
    settingsReaderFactory: () => ({
      getGlobalSettings: () => ({ terminal: { clearOnShrink: false } }),
      getProjectSettings: () => ({ terminal: { clearOnShrink: true } }),
    }),
  });
  await eventHandlers.get("session_start")?.[0]?.({}, ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(editorFactory);
  let clearOnShrink = false;
  editorFactory?.(
    {
      mode: "regular",
      getClearOnShrink: () => clearOnShrink,
      setClearOnShrink: (value: boolean) => {
        clearOnShrink = value;
      },
    },
    {},
    {},
  );

  assert.equal(clearOnShrink, true);
});

test("does not install a compatibility layer after its session shuts down during settings loading", async () => {
  const eventHandlers = new Map<
    string,
    Array<(event: unknown, ctx: unknown) => unknown>
  >();
  const emitted: string[] = [];
  let terminalInputRegistrations = 0;
  let resolveSettings:
    | ((value: {
        getGlobalSettings(): Record<string, never>;
        getProjectSettings(): Record<string, never>;
      }) => void)
    | undefined;
  const pi = {
    on(event: string, handler: (value: unknown, ctx: unknown) => unknown) {
      eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]);
    },
    events: {
      on() {},
      emit(event: string) {
        emitted.push(event);
      },
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui",
    cwd: "/repo",
    ui: {
      onTerminalInput: () => {
        terminalInputRegistrations++;
        return () => {};
      },
    },
  } as unknown as ExtensionContext;

  registerWindowsTerminalCompatibility(pi, {
    platform: "win32",
    settingsReaderFactory: () =>
      new Promise((resolve) => {
        resolveSettings = resolve;
      }),
  });
  const starting = eventHandlers.get("session_start")?.[0]?.({}, ctx);
  await eventHandlers.get("session_shutdown")?.[0]?.({}, ctx);
  resolveSettings?.({
    getGlobalSettings: () => ({}),
    getProjectSettings: () => ({}),
  });
  await starting;

  assert.equal(emitted.includes("openpi:editor-layers:register"), false);
  assert.equal(terminalInputRegistrations, 0);
});

test("reapplies compatibility after renderer replacement", () => {
  let listener: ((data: string) => unknown) | undefined;
  const remove = (value: (data: string) => unknown) => {
    listener = value;
    return () => {
      listener = undefined;
    };
  };
  let oldClearOnShrink = false;
  const oldRenderer = {
    mode: "fullscreen" as const,
    getClearOnShrink: () => oldClearOnShrink,
    setClearOnShrink: (value: boolean) => {
      oldClearOnShrink = value;
    },
  };
  let newClearOnShrink = false;
  const newRenderer = {
    mode: "regular" as const,
    getClearOnShrink: () => newClearOnShrink,
    setClearOnShrink: (value: boolean) => {
      newClearOnShrink = value;
    },
  };
  let current: {
    mode: "regular" | "fullscreen";
    getClearOnShrink: () => boolean;
    setClearOnShrink: (value: boolean) => void;
  } = oldRenderer;
  const unsubscribe = remove(() => {
    applyWindowsTerminalCompatibility(current, "win32");
  });
  listener?.("input");
  assert.equal(oldClearOnShrink, false);
  current = newRenderer;
  listener?.("input");
  assert.equal(newClearOnShrink, true);
  unsubscribe();
  assert.equal(listener, undefined);
});
