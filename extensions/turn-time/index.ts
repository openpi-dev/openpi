/**
 * Close each finished request with the time it took, rendered under the final
 * message. The entry is TUI-only: it is never sent to the model.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

interface TurnTimeData {
  ms: number;
}

/** Sub-second requests are noise, not information. */
const MIN_REPORTED_MS = 1_000;

export function formatTurnDuration(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${(seconds % 60).toString().padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

export default function (pi: ExtensionAPI) {
  // Measured from the first agent run to the settle that ends the request, so
  // retries, auto-compaction, and queued continuations are all included.
  let startedAt: number | undefined;

  pi.registerEntryRenderer<TurnTimeData>(
    "turn-time",
    (entry, _options, theme) => {
      const ms = entry.data?.ms;
      return new Text(
        theme.fg(
          "dim",
          `✳ Worked for ${ms === undefined ? "?" : formatTurnDuration(ms)}`,
        ),
        1,
        0,
      );
    },
  );

  pi.on("agent_start", () => {
    startedAt ??= Date.now();
  });

  pi.on("agent_settled", () => {
    if (startedAt === undefined) return;
    const ms = Date.now() - startedAt;
    startedAt = undefined;
    if (ms < MIN_REPORTED_MS) return;
    pi.appendEntry<TurnTimeData>("turn-time", { ms });
  });

  pi.on("session_shutdown", () => {
    startedAt = undefined;
  });
}
