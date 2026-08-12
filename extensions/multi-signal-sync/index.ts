/**
 * multi-signal-sync: MECE task-completion signals → remind agent to sync tasks.
 *
 * DDD wiring layer only: all signal detection, reminder building, and
 * injection logic lives in `../shared/signal-detection.ts` (pure functions,
 * unit-tested). This file only wires pi events to those functions:
 *
 *   tool_result (bash)   → detectSignals →  context injection + Tasks-widget
 *   context (auth phrase) → lastUserMessageHasAuthorization
 *   agent_settled        → pin/clear the Tasks-widget attachment row
 *
 * **First principles**: task status should be driven by REAL completion
 * signals, not agent memory. MECE decomposition = commit / verify /
 * authorization / no-change (D) / cancelled (E); D/E have no signal.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { setTaskWidgetAttachment } from "../shared/task-widget-attachment.ts";
import {
  SIGNAL_LABEL,
  buildReminderText,
  detectSignals,
  extractCommand,
  injectReminder,
  lastUserMessageHasAuthorization,
  type SignalKind,
} from "../shared/signal-detection.ts";

const REMINDER_TAG = "multi-signal-sync";

export default function multiSignalSync(pi: ExtensionAPI) {
  let signals: SignalKind[] = []; // context 注入用（下轮消费）
  let pendingNotify: SignalKind[] = []; // agent_settled Tasks-widget 驻留用（本轮消费）
  let statusShown = false;
  let generation = 0;

  const addSignal = (kind: SignalKind) => {
    if (!signals.includes(kind)) signals.push(kind);
    if (!pendingNotify.includes(kind)) pendingNotify.push(kind);
  };

  /** A + B: tool_result — hot path, boolean flag only (no await/exec). */
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
      for (const kind of detectSignals(command)) addSignal(kind);
    },
  );

  /** C + reminder: context — auth phrase detection + next-turn injection. */
  pi.on("context", (event) => {
    if (lastUserMessageHasAuthorization(event.messages)) {
      addSignal("authorization");
    }
    if (signals.length === 0) return;
    const detected = signals;
    signals = [];
    const messages = injectReminder(
      event.messages,
      buildReminderText(detected, REMINDER_TAG),
      REMINDER_TAG,
    );
    if (messages) {
      return { messages: messages as typeof event.messages };
    }
  });

  /**
   * Channel 1 — agent_settled: pin the completion reminder onto the Tasks
   * widget (first row under the census header; not the footer status bar).
   * 下一轮（无新信号）：清除该行。
   */
  pi.on("agent_settled", (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    try {
      if (pendingNotify.length > 0) {
        const labels = pendingNotify.map((s) => SIGNAL_LABEL[s]).join(" + ");
        pendingNotify = [];
        setTaskWidgetAttachment(`⚠️ 完成信号（${labels}）— 请同步 tasks`);
        statusShown = true;
      } else if (statusShown) {
        setTaskWidgetAttachment(undefined);
        statusShown = false;
      }
    } catch {
      // Session may have ended; best-effort status update.
    }
  });

  /** Reset on session lifecycle. */
  pi.on("session_start", () => {
    generation++;
    signals = [];
    pendingNotify = [];
    statusShown = false;
    setTaskWidgetAttachment(undefined);
  });

  pi.on("session_shutdown", () => {
    generation++;
    signals = [];
    pendingNotify = [];
    statusShown = false;
    setTaskWidgetAttachment(undefined);
  });
}
