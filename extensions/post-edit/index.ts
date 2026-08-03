/**
 * post-edit: run ONE configured command after a turn that changed files.
 *
 * Deliberately not an event-hook engine. The trust surface is a single
 * user-typed command string in the package config, off (empty) by default. The
 * tool_result handler only flips a flag — it never awaits or executes, so it
 * cannot slow or wedge the tool pipeline. Execution happens once per turn on
 * agent_settled, which debounces an edit burst into a single run, and is
 * fire-and-forget so a failing command cannot block the session.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  loadSetupConfig,
  SETUP_CONFIG_CHANGED_CHANNEL,
} from "../shared/setup-config.ts";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";

/** Tools whose success means a file on disk changed. */
const MUTATING_TOOLS = new Set(["write", "edit"]);

export default function postEdit(
  pi: ExtensionAPI,
  loadCommand: () => string = () => loadSetupConfig().postEdit.command,
) {
  let command = loadCommand();
  let filesChanged = false;
  let pendingRuns = 0;
  let generation = 0;
  let active: { controller: AbortController } | undefined;

  // Re-read on change, matching the sibling extensions' pattern.
  pi.events.on(SETUP_CONFIG_CHANGED_CHANNEL, () => {
    command = loadCommand();
    if (!command) pendingRuns = 0;
  });

  const runNext = (ctx: ExtensionContext, runGeneration: number) => {
    if (
      runGeneration !== generation ||
      active ||
      pendingRuns === 0 ||
      !command
    ) {
      return;
    }
    pendingRuns--;
    const ran = command;
    const controller = new AbortController();
    active = { controller };

    // Notification is best-effort: the context can go stale (session change,
    // shutdown) while the command runs, and a throwing notify must not become
    // an unhandled rejection that takes the process down.
    const warn = (message: string) => {
      if (generation !== runGeneration) return;
      try {
        if (ctx.mode === "tui" && ctx.hasUI) {
          ctx.ui.notify(sanitizeTerminalText(message), "warning");
        }
      } catch {
        // Nothing better to do — the session that would have shown it is gone.
      }
    };

    // Fire-and-forget: never block settlement on the command. Runs are drained
    // serially so two closely settled changed turns cannot lose the latter.
    void pi
      .exec("sh", ["-c", ran], {
        cwd: ctx.cwd,
        signal: controller.signal,
      })
      .then((result) => {
        if (result.code === 0) return;
        const detail = sanitizeTerminalText(
          result.stderr || result.stdout || "",
        )
          .trim()
          .slice(0, 500);
        warn(
          `post-edit command failed (exit ${result.code}): ${sanitizeTerminalText(ran)}${detail ? `\n${detail}` : ""}`,
        );
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        warn(`post-edit command could not run: ${detail}`);
      })
      .finally(() => {
        if (active?.controller === controller) active = undefined;
        if (generation === runGeneration) runNext(ctx, runGeneration);
      });
  };

  pi.on("tool_result", (event) => {
    // Hot path: only a boolean flip. No await, no exec, no config read that
    // could throw — anything heavier here would tax every tool call.
    if (event.isError) return;
    if (MUTATING_TOOLS.has(event.toolName)) filesChanged = true;
  });

  pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
    if (!filesChanged) return;
    filesChanged = false;
    // `hasUI` is also true in headless RPC mode. This command is intentionally
    // limited to the interactive terminal session that configured it.
    if (ctx.mode !== "tui" || !command) return;
    pendingRuns++;
    runNext(ctx, generation);
  });

  pi.on("session_start", () => {
    generation++;
    filesChanged = false;
    pendingRuns = 0;
    active?.controller.abort();
    active = undefined;
  });

  pi.on("session_shutdown", () => {
    generation++;
    filesChanged = false;
    pendingRuns = 0;
    active?.controller.abort();
    active = undefined;
  });
}
