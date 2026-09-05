import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  registerWindowsTuiCompatibility,
  shouldInstallWindowsTuiCompatibility,
  shouldPreferWindowsFullscreen,
} from "../../../extensions/windows-tui-compatibility/index.ts";

type WidgetFactory = (
  tui: TUI,
  theme: unknown,
) => Component & { dispose?(): void };

function createHarness(
  platform: NodeJS.Platform,
  mode: ExtensionContext["mode"] = "tui",
  settingsManagerFactory?: Parameters<
    typeof registerWindowsTuiCompatibility
  >[2],
) {
  const hooks = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  let widgetFactory: WidgetFactory | undefined;
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
        if (content) widgetFactory = content;
        else {
          widgetFactory = undefined;
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
    mount(tui: TUI) {
      return widgetFactory?.(tui, {});
    },
    get widgetFactory() {
      return widgetFactory;
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
    shouldPreferWindowsFullscreen({ platform: "win32", mode: "tui" }),
    true,
  );
  assert.equal(
    shouldPreferWindowsFullscreen({
      platform: "win32",
      mode: "tui",
      globalTuiMode: "regular",
    }),
    false,
  );
  assert.equal(
    shouldPreferWindowsFullscreen({
      platform: "win32",
      mode: "tui",
      projectTuiMode: "fullscreen",
    }),
    false,
  );
  assert.equal(
    shouldPreferWindowsFullscreen({
      platform: "win32",
      mode: "tui",
      explicitCliTuiMode: true,
    }),
    false,
  );

  const linux = createHarness("linux");
  linux.emit("session_start");
  assert.equal(linux.widgetFactory, undefined);
});

test("enables clear-on-shrink for regular TUI but not fullscreen", () => {
  const harness = createHarness("win32");
  harness.emit("session_start");

  const clearOnShrink: boolean[] = [];
  harness.mount({
    mode: "regular",
    setClearOnShrink(enabled: boolean) {
      clearOnShrink.push(enabled);
    },
    requestRender(force?: boolean) {
      assert.equal(force, undefined);
    },
  } as TUI);
  assert.deepEqual(clearOnShrink, [true]);

  clearOnShrink.length = 0;
  harness.mount({
    mode: "fullscreen",
    setClearOnShrink(enabled: boolean) {
      clearOnShrink.push(enabled);
    },
    requestRender(force?: boolean) {
      assert.equal(force, undefined);
    },
  } as TUI);
  assert.deepEqual(clearOnShrink, []);
});

test("persists fullscreen only when no TUI mode is configured", async () => {
  let selectedMode: string | undefined;
  let flushCount = 0;
  const unset = createHarness("win32", "tui", async () => ({
    getGlobalSettings: () => ({}),
    getProjectSettings: () => ({}),
    setTuiMode: (mode: "regular" | "fullscreen") => {
      selectedMode = mode;
    },
    flush: async () => {
      flushCount += 1;
    },
  }));
  await unset.emit("session_start");
  assert.equal(selectedMode, "fullscreen");
  assert.equal(flushCount, 1);
  assert.match(unset.notifications[0] ?? "", /Restart Pi/);

  const explicit = createHarness("win32", "tui", async () => ({
    getGlobalSettings: () => ({ tuiMode: "regular" as const }),
    getProjectSettings: () => ({}),
    setTuiMode: () => {
      throw new Error("must not override an explicit mode");
    },
  }));
  await explicit.emit("session_start");
  assert.deepEqual(explicit.notifications, []);
});

test("cleans up the compatibility widget on shutdown", () => {
  const harness = createHarness("win32");
  harness.emit("session_start");
  assert.ok(harness.widgetFactory);

  harness.emit("session_shutdown");

  assert.equal(harness.widgetFactory, undefined);
  assert.equal(harness.widgetCleared, true);
});
