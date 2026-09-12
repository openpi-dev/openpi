import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  registerEditorLayer,
  removeEditorLayer,
} from "../shared/editor-layers.ts";

export const WINDOWS_TERMINAL_COMPAT_LAYER = "windows-terminal-compat";

type CompatibleTui = {
  mode: "regular" | "fullscreen";
  getClearOnShrink(): boolean;
  setClearOnShrink(enabled: boolean): void;
};

export function shouldClearShrunkRows(
  platform: NodeJS.Platform,
  mode: "regular" | "fullscreen",
  enabled = true,
) {
  return enabled && platform === "win32" && mode === "regular";
}

export function applyWindowsTerminalCompatibility(
  tui: CompatibleTui,
  platform: NodeJS.Platform,
  enabled = true,
) {
  if (
    shouldClearShrunkRows(platform, tui.mode, enabled) &&
    !tui.getClearOnShrink()
  ) {
    tui.setClearOnShrink(true);
  }
}

function install(ctx: ExtensionContext, pi: ExtensionAPI) {
  if (ctx.mode !== "tui") {
    return;
  }

  const windowsCompatEnabled =
    process.platform === "win32" && process.env.PI_CLEAR_ON_SHRINK !== "0";
  let currentTui: CompatibleTui | undefined;
  let lastMode: CompatibleTui["mode"] | undefined;
  const removeInputListener = ctx.ui.onTerminalInput(() => {
    if (currentTui && currentTui.mode !== lastMode) {
      lastMode = currentTui.mode;
      applyWindowsTerminalCompatibility(
        currentTui,
        process.platform,
        windowsCompatEnabled,
      );
    }
  });
  registerEditorLayer(pi, ctx, {
    id: WINDOWS_TERMINAL_COMPAT_LAYER,
    order: 100,
    wrap: (base, tui) => {
      currentTui = tui;
      lastMode = tui.mode;
      // The regular renderer otherwise leaves rows behind when autocomplete
      // shrinks. This is a terminal redraw compatibility setting, not an
      // editor replacement, so all existing input behavior remains intact.
      applyWindowsTerminalCompatibility(
        tui,
        process.platform,
        windowsCompatEnabled,
      );
      return base;
    },
  });
  pi.on("session_shutdown", () => {
    removeInputListener();
    currentTui = undefined;
  });
}

export default function windowsTerminalCompat(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => install(ctx, pi));
  pi.on("session_shutdown", () => {
    removeEditorLayer(pi, WINDOWS_TERMINAL_COMPAT_LAYER);
  });
}
