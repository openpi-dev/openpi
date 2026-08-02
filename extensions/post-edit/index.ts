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
    filesChanged = false;
    // Interactive sessions only: a headless child or `pi -p` run loads this
    // extension too, and neither should silently execute the user's command.
    if (!ctx.hasUI || !command || running) return;

    running = true;
    // Fire-and-forget: never block settlement on the command. Success is
    // silent; only a failure is surfaced, and only to the user.
    void pi
      .exec("sh", ["-c", command])
      .then((result) => {
        if (result.code === 0) return;
        const detail = (result.stderr || result.stdout || "")
          .trim()
          .slice(0, 500);
        ctx.ui.notify(
          `post-edit command failed (exit ${result.code}): ${command}${detail ? `\n${detail}` : ""}`,
          "warning",
        );
      })
      .catch((error: unknown) => {
        ctx.ui.notify(
          `post-edit command could not run: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
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
