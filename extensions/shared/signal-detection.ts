/**
 * Task-completion signal detection — shared domain layer for the signal-sync
 * extensions (multi-signal-sync, commit-task-sync).
 *
 * DDD: pure functions only — no I/O, no timers, no ui. Everything here is
 * unit-testable without a harness: pattern matching, command extraction,
 * authorization-phrase detection, and reminder injection all live in this
 * module; the extensions only wire events to these functions.
 *
 * Signal model (MECE): completion signals are commit / verify / authorization
 * / no-change (D) / cancelled (E). D/E have no detectable signal; A/B/C are
 * covered here.
 */

export type SignalKind = "commit" | "verify" | "authorization";

/** A. Bash commands indicating a commit happened. */
const COMMIT_PATTERNS = [/\bgit\s+commit\b/];

/** B. Bash commands indicating verification passed (tsc/test/verify). */
const VERIFY_PATTERNS = [
  /\btsc\b/,
  /\bnpx\s+tsc\b/,
  /\bnpm\s+run\s+verify/,
  /\bnode\s+scripts\/verify/,
  /--test\b/,
  /\bverify:/,
];

/** C. Owner authorization phrases (user message). */
const AUTHORIZATION_PATTERNS = [
  /授权/,
  /同意/,
  /批准/,
  /裁定/,
  /\bapproved\b/i,
  /\bauthorized\b/i,
];

/** Signal → Chinese label for reminders. */
export const SIGNAL_LABEL: Record<SignalKind, string> = {
  commit: "commit",
  verify: "验证通过",
  authorization: "业主授权",
};

/**
 * Extract the bash command string from a tool_result event.
 * Pi's event shape may vary; try common field names.
 */
export function extractCommand(event: {
  input?: unknown;
  params?: unknown;
}): string | null {
  const fromInput =
    typeof event.input === "object" && event.input !== null
      ? (event.input as Record<string, unknown>).command
      : undefined;
  if (typeof fromInput === "string") return fromInput;

  const fromParams =
    typeof event.params === "object" && event.params !== null
      ? (event.params as Record<string, unknown>).command
      : undefined;
  if (typeof fromParams === "string") return fromParams;

  if (typeof event.input === "string") return event.input;
  if (typeof event.params === "string") return event.params;

  return null;
}

/** Which signals a single bash command carries (empty when none). */
export function detectSignals(command: string): SignalKind[] {
  const detected: SignalKind[] = [];
  if (COMMIT_PATTERNS.some((pattern) => pattern.test(command))) {
    detected.push("commit");
  }
  if (VERIFY_PATTERNS.some((pattern) => pattern.test(command))) {
    detected.push("verify");
  }
  return detected;
}

/** Flatten message content (string or blocks) to text. */
export function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "object" && block !== null && "text" in block
          ? String((block as { text: unknown }).text)
          : "",
      )
      .join("\n");
  }
  return "";
}

/**
 * Whether the most recent user message contains an authorization phrase
 * (signal C). Iterates messages from the end.
 */
export function lastUserMessageHasAuthorization(messages: unknown[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as
      { role?: string; content?: unknown } | undefined;
    if (!message || message.role !== "user") continue;
    const text = messageContentText(message.content);
    if (!text) return false; // last user message has no text → no auth signal
    return AUTHORIZATION_PATTERNS.some((pattern) => pattern.test(text));
  }
  return false;
}

/** Reminder body for the detected signals. */
export function buildReminderText(
  signals: readonly SignalKind[],
  context = "multi-signal-sync",
): string {
  const labels = signals.map((s) => SIGNAL_LABEL[s]).join(" + ");
  if (context === "commit-task-sync") {
    return `⚠️ 上轮检测到 git commit 成功。请检查 tasks 状态同步：
- 如有完成项（commit/reviewer/授权后 done），**立即 tasks_update done** 带 commit SHA + reviewer 结论
- 如有 blocked→done（业主授权/ADR 落地），同步 status
- 这是 ${context} hook 自动提醒（防 tasks 残留，不靠 agent 记忆力）`;
  }
  return `⚠️ 上轮检测到完成信号（${labels}）。请检查 tasks 状态同步：
- commit/验证通过 → 如有完成项，**立即 tasks_update done** 带 commit SHA + reviewer 结论
- 业主授权 → 如有 blocked task 因授权解除阻塞，同步 status（blocked→done）
- 无变更完成（分析/设计结论）→ 收口时 tasks_update（此类型无信号，靠收口审计纪律）
- 这是 ${context} hook 自动提醒（MECE：commit/验证/授权 三信号，防 tasks 残留）
注入后自动清除（仅提醒一次/信号）。`;
}

/**
 * Inject a reminder into messages (agent-visible next turn), cloned so the
 * original array is untouched. Appends the block to the last user message;
 * returns undefined when no injectable user message exists.
 */
export function injectReminder(
  messages: unknown[],
  text: string,
  tag: string,
): unknown[] | undefined {
  const next = structuredClone(messages) as Array<{
    role?: string;
    content?: unknown;
  }>;
  const safeTag = tag.replaceAll(/[<>]/g, "");
  for (let index = next.length - 1; index >= 0; index--) {
    const message = next[index];
    if (message.role !== "user") continue;
    const block = {
      type: "text",
      text: `\n\n<${safeTag}>\n${text}\n</${safeTag}>`,
    };
    if (typeof message.content === "string") {
      message.content = [{ type: "text", text: message.content }, block];
    } else if (Array.isArray(message.content)) {
      message.content.push(block);
    } else {
      return undefined;
    }
    return next;
  }
  return undefined;
}
