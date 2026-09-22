/**
 * post-edit: run ONE configured command after a turn with successful Write/Edit operations.
 *
 * Deliberately not an event-hook engine. The trust surface is a single
 * user-typed command string in the package config, off (empty) by default. The
 * tool_result handler only flips a flag — it never awaits or executes, so it
 * cannot slow or wedge the tool pipeline. Execution happens once per turn on
 * agent_settled, which debounces an edit burst into a single run, and is
 * asynchronous. The next agent start and tool calls join outstanding runs so
 * a foreground formatter cannot race the next turn's reads or writes. This is
 * session-local coordination, not a workspace lock or an acceptance gate.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  loadSetupConfig,
  SETUP_CONFIG_CHANGED_CHANNEL,
} from "../shared/setup-config.ts";
import { onSetupApply } from "../shared/setup-apply.ts";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";

/** Tools whose success means a file on disk changed. */
const MUTATING_TOOLS = new Set(["write", "edit"]);
const NOTICE_COMMAND_MAX_CHARS = 160;
const NOTICE_DETAIL_MAX_CHARS = 320;

function boundedNoticeText(value: string, maxChars: number) {
  const chars = [...sanitizeTerminalText(value).trim()];
  if (chars.length <= maxChars) return chars.join("");
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}

export default function postEdit(
  pi: ExtensionAPI,
  loadCommand: () => string = () => loadSetupConfig().postEdit.command,
) {
  let command = loadCommand();
  let filesChanged = false;
  const pendingRuns: Array<{
    command: string;
    cwd: string;
    ctx: ExtensionContext;
    generation: number;
  }> = [];
  let generation = 0;
  let active: { controller: AbortController; done: Promise<void> } | undefined;

  // Re-read on change, matching the sibling extensions' pattern.
  onSetupApply(pi, () => {
    command = loadCommand();
  });
  pi.events.on(SETUP_CONFIG_CHANGED_CHANNEL, () => {
    // Discard queued work only after all consumers accepted the config.
    // The apply phase may still roll back and must preserve that work.
    if (!command) pendingRuns.length = 0;
  });

  const runNext = () => {
    if (active) return;
    const run = pendingRuns.shift();
    if (!run) return;
    const { command: ran, cwd, ctx, generation: runGeneration } = run;
    const controller = new AbortController();

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
    const done = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) return;
        return pi.exec("sh", ["-c", ran], { cwd, signal: controller.signal });
      })
      .then((result) => {
        if (!result) return;
        if (result.killed) {
          warn(
            `post-edit command interrupted: ${boundedNoticeText(ran, NOTICE_COMMAND_MAX_CHARS)}`,
          );
          return;
        }
        if (result.code === 0) return;
        const commandPreview = boundedNoticeText(ran, NOTICE_COMMAND_MAX_CHARS);
        const detail = boundedNoticeText(
          result.stderr || result.stdout || "",
          NOTICE_DETAIL_MAX_CHARS,
        );
        warn(
          `post-edit command failed (exit ${result.code}): ${commandPreview}${detail ? `\n${detail}` : ""}`,
        );
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        warn(
          `post-edit command could not run: ${boundedNoticeText(detail, NOTICE_DETAIL_MAX_CHARS)}`,
        );
      })
      .finally(() => {
        if (active?.controller === controller) active = undefined;
        runNext();
      });
    active = { controller, done };
  };

  const joinRuns = async (signal?: AbortSignal) => {
    if (!active || signal?.aborted) return;
    let onAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // Cancellation releases the Agent, not the still-running command. This
      // lets session teardown reach session_shutdown and request termination.
      // finally starts the next queued run before resolving the previous one.
      while (active && !signal?.aborted) {
        await Promise.race([active.done, aborted]);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };

  pi.on("agent_start", async (_event, ctx) => {
    // Unlike prompt preflight, this also covers native custom-message wakeups
    // and runs after Pi has installed the current Agent's cancellation signal.
    if (ctx.mode === "tui") await joinRuns(ctx.signal);
  });

  pi.on("tool_call", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    // Backstop for a command scheduled after this Agent's start event.
    // Custom tools can also read the workspace, so do not filter by tool name.
    // Fencing a tool does not make its result schedule post-edit.
    const callGeneration = generation;
    const signal = ctx.signal;
    await joinRuns(signal);
    if (signal?.aborted || callGeneration !== generation) {
      return {
        block: true,
        reason:
          "Agent interrupted or session changed while waiting for post-edit.",
      };
    }
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
    // `hasUI` is also true in headless RPC mode. This command is intentionally
    // limited to the interactive terminal session that configured it.
    if (ctx.mode !== "tui" || !command) return;
    pendingRuns.push({ command, cwd: ctx.cwd, ctx, generation });
    runNext();
  });

  const reset = () => {
    generation++;
    filesChanged = false;
    pendingRuns.length = 0;
    // Abort requests termination; only completion of pi.exec releases active.
    // Pi does not promise termination of detached command descendants.
    active?.controller.abort();
  };

  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
}
