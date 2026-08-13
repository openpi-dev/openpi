/**
 * commit-task-sync: detect successful `git commit` → remind agent to sync tasks.
 *
 * DDD wiring layer: signal detection, reminder text, and injection live in
 * `../shared/signal-detection.ts` (shared with multi-signal-sync — commit
 * detection is one concern, one implementation). This file only wires the
 * tool_result / agent_settled / context events to those functions.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  buildReminderText,
  claimSignalInjection,
  detectSignals,
  extractCommand,
  injectReminder,
  resetSignalInjectionClaim,
} from "../shared/signal-detection.ts";

const REMINDER_TAG = "commit-task-sync";

export default function commitTaskSync(pi: ExtensionAPI) {
  let commitDetected = false;

  /** tool_result: hot path. Only flip a boolean. */
  pi.on(
    "tool_result",
    (event: {
      toolName: string;
      isError?: boolean;
      input?: unknown;
      params?: unknown;
    }) => {
      if (event.isError) return;
      if (event.toolName !== "bash") return;
      const command = extractCommand(event);
      if (!command) return;
      if (detectSignals(command).includes("commit")) {
        commitDetected = true;
      }
    },
  );

  /**
   * Channel 1 — agent_settled: TUI notify (user-visible, advisory).
   * Does NOT reset commitDetected (context handler owns the reset).
   */
  pi.on("agent_settled", (_event: unknown, ctx: ExtensionContext) => {
    if (!commitDetected) return;
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    try {
      ctx.ui.notify(
        "⚠️ git commit 检测到 — 请检查 tasks 状态同步（如有完成项，tasks_update done 带 commit SHA）",
        "warning",
      );
    } catch {
      // Session may have ended; best-effort notification.
    }
  });

  /**
   * Channel 2 — context: inject reminder into next turn's messages
   * (agent-visible, mandatory). Resets commitDetected after injection
   * (remind once per commit).
   */
  pi.on("context", (event) => {
    if (!commitDetected) return;
    commitDetected = false;
    // Cross-extension dedupe: multi-signal-sync also detects commit; one
    // injection is enough.
    if (!claimSignalInjection(["commit"])) return;
    const messages = injectReminder(
      event.messages,
      buildReminderText(["commit"], REMINDER_TAG),
      REMINDER_TAG,
    );
    if (messages) {
      return { messages: messages as typeof event.messages };
    }
  });

  /** Reset on session lifecycle. */
  pi.on("session_start", () => {
    commitDetected = false;
  });

  pi.on("session_shutdown", () => {
    commitDetected = false;
    resetSignalInjectionClaim();
  });
}
