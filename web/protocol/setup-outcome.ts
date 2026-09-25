import { projectAssistantError } from "./types.ts";

export interface WebSetupOutcome {
  /** Pi entry identity, scoped to the current Session branch. */
  requestId: string;
  status: "pending" | "saved" | "unchanged" | "failed" | "cancelled" | "unconfirmed";
  error?: string;
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function rejectedBeforeDelivery(entry: Record<string, unknown>) {
  return entry.type === "custom_message" && entry.customType === "openpi-setup-closed" &&
    ["plan_mode_active", "writer_activation_failed"].includes(String(record(entry.details).reason));
}

/** Read canonical receipts before transcript truncation or presentation hiding. */
export function projectSetupOutcome(entries: readonly unknown[], running: boolean) {
  let outcome: WebSetupOutcome | undefined;
  let start = entries.length - 1;
  for (; start >= 0; start--) {
    const entry = record(entries[start]);
    if (rejectedBeforeDelivery(entry) && typeof entry.id === "string") {
      return { requestId: entry.id, status: "failed", error: typeof entry.content === "string" ? projectAssistantError(entry.content).value : undefined } satisfies WebSetupOutcome;
    }
    if (entry.type === "custom_message" && entry.customType === "openpi-setup-request") break;
  }
  if (start < 0) return undefined;
  for (let index = start; index < entries.length; index++) {
    const raw = entries[index];
    const entry = record(raw);
    const message = entry.type === "custom_message" ? entry : record(entry.message);
    if (entry.type === "custom_message" && message.customType === "openpi-setup-request" && typeof entry.id === "string") {
      outcome = { requestId: entry.id, status: "pending" };
      continue;
    }
    if (!outcome || outcome.status === "saved" || outcome.status === "unchanged") continue;
    if (message.role === "toolResult" && message.toolName === "configure_my_pi_setup") {
      if (message.isError === false) {
        const changed = record(record(message.details).setupReceipt).changed;
        outcome = { requestId: outcome.requestId, status: Array.isArray(changed) && changed.length === 0 ? "unchanged" : "saved" };
      } else if (message.isError === true) {
        const content = Array.isArray(message.content)
          ? message.content.filter((part) => record(part).type === "text").map((part) => record(part).text).join("\n")
          : typeof message.content === "string" ? message.content : "";
        outcome = { requestId: outcome.requestId, status: "failed", error: projectAssistantError(content).value };
      }
    } else if (message.role === "assistant" && message.stopReason === "aborted") {
      // A failed apply may include incomplete recovery evidence. Keep it visible.
      if (outcome.status !== "failed") outcome.status = "cancelled";
    } else if (message.role === "assistant" && message.stopReason === "error") {
      if (outcome.status !== "failed") outcome = { requestId: outcome.requestId, status: "failed", error: typeof message.errorMessage === "string" ? projectAssistantError(message.errorMessage).value : undefined };
    } else if (message.customType === "openpi-setup-closed" || message.role === "user") {
      if (outcome.status === "pending") outcome.status = "unconfirmed";
      // Later ordinary turns must not change the previous setup's outcome.
      if (message.role === "user") break;
    }
  }
  if (outcome?.status === "pending" && !running) outcome.status = "unconfirmed";
  return outcome;
}
