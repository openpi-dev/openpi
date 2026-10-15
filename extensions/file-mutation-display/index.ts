import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { loadSetupConfig } from "../shared/setup-config.ts";
import {
  activityEnabled,
  activityRenderers,
  withActivityRenderer,
} from "./render.ts";

function compact<TParams extends TSchema, TDetails, TState>(
  definition: ToolDefinition<TParams, TDetails, TState>,
  enabled: boolean,
) {
  return enabled ? withActivityRenderer(definition) : definition;
}

/**
 * Override only Pi's TUI projection. Every wrapped definition retains its
 * native schema, prompt metadata, execute function, result, and details.
 */
export default function fileMutationDisplay(pi: ExtensionAPI) {
  // Modern hosts separate presentation from tool execution. Register the same
  // resolver in TUI and headless Sessions so child inspection inherits it
  // without replacing the child's shell/filesystem executor.
  type Presentation = Pick<
    ToolDefinition,
    "renderCall" | "renderResult" | "renderShell"
  >;
  const host = pi as ExtensionAPI & {
    registerToolRenderer?: (
      resolver: (
        name: string,
        next: () => Presentation | undefined,
      ) => Presentation | undefined,
    ) => void;
  };
  const modern = typeof host.registerToolRenderer === "function";
  if (host.registerToolRenderer) {
    host.registerToolRenderer((name, next) => {
      const base = next();
      if (!base) return base;
      const display = loadSetupConfig().ui;
      return activityEnabled(name, display)
        ? { ...base, ...activityRenderers(name, base) }
        : base;
    });
  }
  pi.on("session_start", (_event, ctx) => {
    const display = loadSetupConfig().ui;
    // This extension changes only the interactive TUI projection. Headless
    // sessions must keep Pi's native definitions, especially bash: replacing
    // it here would drop the SettingsManager-provided shellPath and can make
    // Windows resolve the WSL System32 stub instead of the configured shell.
    if (ctx.mode !== "tui") return;

    // Ctrl+O remains a temporary override. A new/reloaded session starts from
    // the persisted defaults instead of inheriting an old expanded toggle.
    ctx.ui.setToolsExpanded(
      display.subagentResultDisplay === "full" &&
        display.bashToolDisplay === "full" &&
        display.fileMutationDisplay === "full",
    );

    if (modern) return;

    pi.registerTool(
      compact(
        createBashToolDefinition(ctx.cwd),
        display.bashToolDisplay !== "full",
      ),
    );
    pi.registerTool(
      compact(
        createWriteToolDefinition(ctx.cwd),
        display.fileMutationDisplay !== "full",
      ),
    );
    pi.registerTool(
      compact(
        createEditToolDefinition(ctx.cwd),
        display.fileMutationDisplay !== "full",
      ),
    );
    pi.registerTool(withActivityRenderer(createReadToolDefinition(ctx.cwd)));
    pi.registerTool(withActivityRenderer(createGrepToolDefinition(ctx.cwd)));
    pi.registerTool(withActivityRenderer(createFindToolDefinition(ctx.cwd)));
    pi.registerTool(withActivityRenderer(createLsToolDefinition(ctx.cwd)));
  });
}
