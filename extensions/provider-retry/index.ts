import {
  type AssistantMessage,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isGatewayConcurrencyLimit } from "../shared/provider-errors.ts";

/** Supply the transient wording Pi needs without inventing an HTTP status. */
export function normalizeGatewayConcurrencyError(message: AssistantMessage) {
  if (
    message.stopReason !== "error" ||
    !isGatewayConcurrencyLimit(message.errorMessage) ||
    isRetryableAssistantError(message)
  )
    return message;
  const normalized = {
    ...message,
    errorMessage: `Rate limit: ${message.errorMessage}`,
  };
  // Keep Pi's explicit quota/billing exclusions authoritative as well.
  return isRetryableAssistantError(normalized) ? normalized : message;
}

export default function providerRetry(pi: ExtensionAPI) {
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const message = normalizeGatewayConcurrencyError(event.message);
    if (message !== event.message) return { message };
  });
}
