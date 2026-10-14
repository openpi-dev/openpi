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

type TerminalSettings = {
  terminal?: {
    clearOnShrink?: boolean;
  };
};

type SettingsReader = {
  getGlobalSettings(): TerminalSettings;
  getProjectSettings(): TerminalSettings;
  drainErrors?(): readonly unknown[];
};

type SettingsReaderFactory = (
  cwd: string,
) => SettingsReader | Promise<SettingsReader>;

type WindowsTerminalCompatibilityOptions = {
  readonly platform?: NodeJS.Platform;
  readonly clearOnShrinkEnv?: string;
  readonly settingsReaderFactory?: SettingsReaderFactory;
};

type WindowsTerminalCompatibilityRuntime = {
  readonly platform: NodeJS.Platform;
  readonly clearOnShrinkEnv?: string;
  readonly settingsReaderFactory: SettingsReaderFactory;
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

export async function readWindowsTerminalCompatibilityEnabled(options: {
  readonly platform: NodeJS.Platform;
  readonly clearOnShrinkEnv?: string;
  readonly cwd: string;
  readonly settingsReaderFactory: SettingsReaderFactory;
}) {
  if (options.platform !== "win32" || options.clearOnShrinkEnv === "0") {
    return false;
  }

  try {
    const settings = await options.settingsReaderFactory(options.cwd);
    if ((settings.drainErrors?.().length ?? 0) > 0) return false;

    const project = settings.getProjectSettings().terminal?.clearOnShrink;
    if (project !== undefined) return project;

    const global = settings.getGlobalSettings().terminal?.clearOnShrink;
    return global ?? true;
  } catch {
    return false;
  }
}

async function install(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  options: WindowsTerminalCompatibilityRuntime,
  isCurrent: () => boolean,
) {
  if (ctx.mode !== "tui") {
    return;
  }

  const windowsCompatEnabled = await readWindowsTerminalCompatibilityEnabled({
    platform: options.platform,
    clearOnShrinkEnv: options.clearOnShrinkEnv,
    cwd: ctx.cwd,
    settingsReaderFactory: options.settingsReaderFactory,
  });
  if (!isCurrent()) return;
  let currentTui: CompatibleTui | undefined;
  let lastMode: CompatibleTui["mode"] | undefined;
  const removeInputListener = ctx.ui.onTerminalInput(() => {
    if (currentTui && currentTui.mode !== lastMode) {
      lastMode = currentTui.mode;
      applyWindowsTerminalCompatibility(
        currentTui,
        options.platform,
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
        options.platform,
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

export function registerWindowsTerminalCompatibility(
  pi: ExtensionAPI,
  options: WindowsTerminalCompatibilityOptions = {},
) {
  let generation = 0;
  const settingsReaderFactory =
    options.settingsReaderFactory ??
    (async (cwd) => {
      const { SettingsManager } = await import(
        "@earendil-works/pi-coding-agent"
      );
      return SettingsManager.create(cwd);
    });
  const runtime = {
    platform: options.platform ?? process.platform,
    clearOnShrinkEnv:
      options.clearOnShrinkEnv ?? process.env.PI_CLEAR_ON_SHRINK,
    settingsReaderFactory,
  };

  pi.on("session_start", async (_event, ctx) => {
    const currentGeneration = ++generation;
    await install(ctx, pi, runtime, () => generation === currentGeneration);
  });
  pi.on("session_shutdown", () => {
    generation += 1;
    removeEditorLayer(pi, WINDOWS_TERMINAL_COMPAT_LAYER);
  });
}

export default function windowsTerminalCompat(pi: ExtensionAPI) {
  registerWindowsTerminalCompatibility(pi);
}
