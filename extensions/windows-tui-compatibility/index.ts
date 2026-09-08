import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

interface TuiSettings {
  terminal?: {
    clearOnShrink?: boolean;
  };
}

interface TuiSettingsManager {
  getGlobalSettings(): TuiSettings;
  getProjectSettings(): TuiSettings;
  drainErrors?(): readonly unknown[];
}

type TuiSettingsManagerFactory = (
  cwd: string,
) => TuiSettingsManager | Promise<TuiSettingsManager>;

const WIDGET_KEY = "openpi-windows-tui-compatibility";

/**
 * The main-screen renderer can leave stale autocomplete rows on Windows.
 * Keep the workaround limited to interactive Windows sessions so RPC/print
 * users and non-Windows terminals are unaffected.
 */
export function shouldInstallWindowsTuiCompatibility(
  platform: NodeJS.Platform,
  mode: ExtensionContext["mode"],
) {
  return platform === "win32" && mode === "tui";
}

export function shouldEnableWindowsClearOnShrink(options: {
  platform: NodeJS.Platform;
  mode: ExtensionContext["mode"];
  globalClearOnShrink?: boolean;
  projectClearOnShrink?: boolean;
}) {
  return (
    shouldInstallWindowsTuiCompatibility(options.platform, options.mode) &&
    options.globalClearOnShrink === undefined &&
    options.projectClearOnShrink === undefined
  );
}

function readClearOnShrinkSettings(settingsManager: TuiSettingsManager) {
  const globalSettings = settingsManager.getGlobalSettings();
  const projectSettings = settingsManager.getProjectSettings();
  return {
    globalClearOnShrink: globalSettings.terminal?.clearOnShrink,
    projectClearOnShrink: projectSettings.terminal?.clearOnShrink,
  };
}

/**
 * Register the Windows renderer workaround.
 *
 * Pi exposes the renderer to widget factories, but not as a direct property
 * on ExtensionContext. The zero-height widget lets us apply the supported
 * renderer setting without replacing OpenPI's header, footer, or editor.
 *
 * The renderer setting is deliberately session-local. Pi's SettingsManager
 * setters persist global preferences, so this compatibility extension only
 * reads the existing clear-on-shrink settings and never changes tuiMode or
 * terminal preferences on the user's behalf.
 */
export function registerWindowsTuiCompatibility(
  pi: ExtensionAPI,
  platform: NodeJS.Platform,
  settingsManagerFactory?: TuiSettingsManagerFactory,
) {
  let activeUi: ExtensionContext["ui"] | undefined;

  const cleanup = () => {
    const ui = activeUi;
    activeUi = undefined;
    try {
      ui?.setWidget(WIDGET_KEY, undefined);
    } catch {
      // The renderer may already be gone during shutdown.
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    cleanup();
    if (!shouldInstallWindowsTuiCompatibility(platform, ctx.mode)) return;

    let enableClearOnShrink = false;
    if (settingsManagerFactory) {
      try {
        const settingsManager = await settingsManagerFactory(ctx.cwd);
        const settings = readClearOnShrinkSettings(settingsManager);
        const settingsErrors = settingsManager.drainErrors?.() ?? [];
        enableClearOnShrink =
          settingsErrors.length === 0 &&
          shouldEnableWindowsClearOnShrink({
            platform,
            mode: ctx.mode,
            ...settings,
          });
      } catch {
        // Settings reads must never prevent the OpenPI session from starting.
      }
    }

    activeUi = ctx.ui;

    function installWidget() {
      if (activeUi !== ctx.ui) return;

      ctx.ui.setWidget(
        WIDGET_KEY,
        (tui) => {
          if (tui.mode === "regular" && enableClearOnShrink) {
            tui.setClearOnShrink(true);
          }
          return {
            render: () => [],
            invalidate() {
              // Pi remounts existing components and invalidates them after a
              // native TUI mode switch. A component created for fullscreen
              // can therefore reinstall itself against the new renderer.
              if (tui.mode === "fullscreen") installWidget();
            },
          };
        },
        { placement: "belowEditor" },
      );
    }

    installWidget();
  });

  pi.on("session_shutdown", cleanup);
}

export default function windowsTuiCompatibility(pi: ExtensionAPI) {
  registerWindowsTuiCompatibility(pi, process.platform, async (cwd) => {
    const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
    return SettingsManager.create(cwd);
  });
}
