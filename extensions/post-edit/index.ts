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

/** Tools whose success means a file on disk changed. */
const MUTATING_TOOLS = new Set(["write", "edit"]);

export default function postEdit(pi: ExtensionAPI) {
  let command = loadSetupConfig().postEdit.command;
  let filesChanged = false;
  let running = false;

  // Re-read on change, matching the sibling extensions' pattern.
  pi.events.on(SETUP_CONFIG_CHANGED_CHANNEL, () => {
    command = loadSetupConfig().postEdit.command;
  });

  pi.on("tool_result", (event) => {
    // Hot path: only a boolean flip. No await, no exec, no config read that
    // could throw — anything heavier here would tax every tool call.
    if (event.isError) return;
    if (MUTATING_TOOLS.has(event.toolName)) filesChanged = true;
  });

  pi.on("agent_settled", (_event, ctx: ExtensionContext) => {
    if (!filesChanged) return;
    // Interactive sessions only: a headless child or `pi -p` run loads this
    // extension too, and neither should silently execute the user's command.
    // Keep the flag set when a previous run is still going, so this turn's
    // edits are picked up by the next settlement instead of being dropped.
    if (!ctx.hasUI || !command || running) return;
    filesChanged = false;

    running = true;
    // The command that is actually about to run: `command` can change under a
    // config update while this is in flight, and the failure message must name
    // what really ran.
    const ran = command;
    // Notification is best-effort: the context can go stale (session change,
    // shutdown) while the command runs, and a throwing notify must not become
    // an unhandled rejection that takes the process down.
    const warn = (message: string) => {
      try {
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
      } catch {
        // Nothing better to do — the session that would have shown it is gone.
      }
    };
    // Fire-and-forget: never block settlement on the command. Success is
    // silent; only a failure is surfaced, and only to the user.
    void pi
      .exec("sh", ["-c", ran])
      .then((result) => {
        if (result.code === 0) return;
        const detail = (result.stderr || result.stdout || "")
          .trim()
          .slice(0, 500);
        warn(
          `post-edit command failed (exit ${result.code}): ${ran}${detail ? `\n${detail}` : ""}`,
        );
      })
      .catch((error: unknown) => {
        warn(
          `post-edit command could not run: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        running = false;
      });
  });

  pi.on("session_shutdown", () => {
    filesChanged = false;
  });
}
