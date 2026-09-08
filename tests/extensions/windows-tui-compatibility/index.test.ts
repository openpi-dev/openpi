import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  registerWindowsTuiCompatibility,
  shouldEnableWindowsClearOnShrink,
  shouldInstallWindowsTuiCompatibility,
} from "../../../extensions/windows-tui-compatibility/index.ts";

type WidgetFactory = (
  tui: TUI,
  theme: unknown,
) => Component & { dispose?(): void };

function createTui(mode: TUI["mode"], clearOnShrink: boolean[] = []) {
  return {
    mode,
    setClearOnShrink(enabled: boolean) {
      clearOnShrink.push(enabled);
    },
  } as TUI;
}

function createHarness(
  platform: NodeJS.Platform,
  mode: ExtensionContext["mode"] = "tui",
  settingsManagerFactory?: Parameters<
    typeof registerWindowsTuiCompatibility
  >[2],
  initialTui: TUI = createTui("regular"),
) {
  const hooks = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  let widgetFactory: WidgetFactory | undefined;
  let widget: ReturnType<WidgetFactory> | undefined;
  let activeTui = initialTui;
  let widgetFactoryCalls = 0;
  let widgetCleared = false;
  const notifications: string[] = [];

  const pi = {
    on(event: string, handler: unknown) {
      hooks.set(
        event,
        handler as (event: unknown, ctx: ExtensionContext) => unknown,
      );
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: "C:\\project",
    mode,
    hasUI: mode === "tui",
    ui: {
      setWidget(_key: string, content: WidgetFactory | undefined) {
        widget?.dispose?.();
        if (content) {
          widgetFactory = content;
          widgetFactoryCalls += 1;
          widget = content(activeTui, {});
        } else {
          widgetFactory = undefined;
          widget = undefined;
          widgetCleared = true;
        }
      },
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;

  registerWindowsTuiCompatibility(pi, platform, settingsManagerFactory);

  return {
    ctx,
    emit(event: string) {
      return hooks.get(event)?.({}, ctx);
    },
    switchTuiMode(tui: TUI) {
      // Pi keeps the component instance, swaps its active renderer, and then
      // invalidates the remounted component tree.
      const remountedWidget = widget;
      activeTui = tui;
      remountedWidget?.invalidate();
    },
    get widgetFactory() {
      return widgetFactory;
    },
    get widgetFactoryCalls() {
      return widgetFactoryCalls;
    },
    get widgetCleared() {
      return widgetCleared;
    },
    get notifications() {
      return notifications;
    },
  };
}

test("installs only for interactive Windows sessions", () => {
  assert.equal(shouldInstallWindowsTuiCompatibility("win32", "tui"), true);
  assert.equal(shouldInstallWindowsTuiCompatibility("linux", "tui"), false);
  assert.equal(shouldInstallWindowsTuiCompatibility("win32", "rpc"), false);

  assert.equal(
    shouldEnableWindowsClearOnShrink({ platform: "win32", mode: "tui" }),
    true,
  );
  assert.equal(
    shouldEnableWindowsClearOnShrink({
      platform: "win32",
      mode: "tui",
      globalClearOnShrink: false,
    }),
    false,
  );
  assert.equal(
    shouldEnableWindowsClearOnShrink({
      platform: "win32",
      mode: "tui",
      globalClearOnShrink: true,
    }),
    false,
  );
  assert.equal(
    shouldEnableWindowsClearOnShrink({
      platform: "win32",
      mode: "tui",
      projectClearOnShrink: false,
    }),
    false,
  );

  const linux = createHarness("linux");
  linux.emit("session_start");
  assert.equal(linux.widgetFactory, undefined);
});

test("enables clear-on-shrink for regular TUI but not fullscreen", async () => {
  const settingsManagerFactory = async () => ({
    getGlobalSettings: () => ({}),
    getProjectSettings: () => ({}),
  });
  const regularWrites: boolean[] = [];
  const regular = createHarness(
    "win32",
    "tui",
    settingsManagerFactory,
    createTui("regular", regularWrites),
  );
  await regular.emit("session_start");
  assert.deepEqual(regularWrites, [true]);

  const fullscreenWrites: boolean[] = [];
  const fullscreen = createHarness(
    "win32",
    "tui",
    settingsManagerFactory,
    createTui("fullscreen", fullscreenWrites),
  );
  await fullscreen.emit("session_start");
  assert.deepEqual(fullscreenWrites, []);
});

test("enables clear-on-shrink after a native switch to regular TUI", async () => {
  const fullscreenWrites: boolean[] = [];
  const harness = createHarness(
    "win32",
    "tui",
    async () => ({
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({}),
    }),
    createTui("fullscreen", fullscreenWrites),
  );
  await harness.emit("session_start");

  assert.equal(harness.widgetFactoryCalls, 1);
  assert.deepEqual(fullscreenWrites, []);

  const regularWrites: boolean[] = [];
  harness.switchTuiMode(createTui("regular", regularWrites));

  assert.equal(harness.widgetFactoryCalls, 2);
  assert.deepEqual(regularWrites, [true]);
});

test("keeps the workaround session-local and respects explicit clear-on-shrink", async () => {
  const fullscreenWrites: boolean[] = [];
  const explicit = createHarness(
    "win32",
    "tui",
    async () => ({
      getGlobalSettings: () => ({ terminal: { clearOnShrink: false } }),
      getProjectSettings: () => ({}),
      drainErrors: () => [],
    }),
    createTui("fullscreen", fullscreenWrites),
  );
  await explicit.emit("session_start");

  const regularWrites: boolean[] = [];
  explicit.switchTuiMode(createTui("regular", regularWrites));

  assert.deepEqual(fullscreenWrites, []);
  assert.deepEqual(regularWrites, []);
  assert.deepEqual(explicit.notifications, []);
});

test("fails closed when settings cannot be read", async () => {
  const clearOnShrink: boolean[] = [];
  const harness = createHarness(
    "win32",
    "tui",
    async () => {
      throw new Error("malformed settings");
    },
    createTui("regular", clearOnShrink),
  );
  await harness.emit("session_start");

  assert.deepEqual(clearOnShrink, []);
});

test("cleans up the compatibility widget on shutdown", () => {
  const harness = createHarness("win32");
  harness.emit("session_start");
  assert.ok(harness.widgetFactory);

  harness.emit("session_shutdown");

  assert.equal(harness.widgetFactory, undefined);
  assert.equal(harness.widgetCleared, true);
});
