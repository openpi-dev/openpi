import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type TuiMode = "regular" | "fullscreen";

interface TuiSettingsManager {
  getGlobalSettings(): { tuiMode?: TuiMode };
  getProjectSettings(): { tuiMode?: TuiMode };
  setTuiMode?(mode: TuiMode): void;
  flush?(): Promise<void>;
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

export function shouldPreferWindowsFullscreen(options: {
  platform: NodeJS.Platform;
  mode: ExtensionContext["mode"];
  globalTuiMode?: TuiMode;
  projectTuiMode?: TuiMode;
  explicitCliTuiMode?: boolean;
}) {
  return (
    shouldInstallWindowsTuiCompatibility(options.platform, options.mode) &&
    options.globalTuiMode === undefined &&
    options.projectTuiMode === undefined &&
    options.explicitCliTuiMode !== true
  );
}

/**
 * Register the Windows renderer workaround.
 *
 * Pi exposes the renderer to widget factories, but not as a direct property
 * on ExtensionContext. The zero-height widget lets us apply the supported
 * renderer setting without replacing OpenPI's header, footer, or editor.
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

    activeUi = ctx.ui;
    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui) => {
        // The renderer can be replaced at runtime when the user switches TUI
        // modes, so apply this when the factory receives the active renderer.
        if (tui.mode === "regular") tui.setClearOnShrink(true);
        return {
          render: () => [],
          invalidate() {},
        };
      },
      { placement: "belowEditor" },
    );

    if (!settingsManagerFactory) return;

    try {
      const settingsManager = await settingsManagerFactory(ctx.cwd);
      const globalSettings = settingsManager.getGlobalSettings();
      const projectSettings = settingsManager.getProjectSettings();
      const explicitCliTuiMode = process.argv.some(
        (arg) => arg === "--tui-mode" || arg.startsWith("--tui-mode="),
      );

      if (
        !shouldPreferWindowsFullscreen({
          platform,
          mode: ctx.mode,
          globalTuiMode: globalSettings.tuiMode,
          projectTuiMode: projectSettings.tuiMode,
          explicitCliTuiMode,
        }) ||
        settingsManager.setTuiMode === undefined
      ) {
        return;
      }

      settingsManager.setTuiMode("fullscreen");
      await settingsManager.flush?.();
      ctx.ui.notify(
        "OpenPI detected the Windows regular-TUI redraw issue and selected fullscreen mode for the next start. Restart Pi to apply it.",
        "warning",
      );
    } catch {
      // A settings write must never prevent the OpenPI session from starting.
    }
  });

  pi.on("session_shutdown", cleanup);
}

export default function windowsTuiCompatibility(pi: ExtensionAPI) {
  registerWindowsTuiCompatibility(pi, process.platform, async (cwd) => {
    const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
    return SettingsManager.create(cwd);
  });
}
