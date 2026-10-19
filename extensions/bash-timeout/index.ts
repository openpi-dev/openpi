/**
 * Non-interactive runs cannot be interrupted: nobody presses Esc in
 * `pi -p`/`--mode json` or in a subagent/workflow child session, so an
 * unbounded bash command can hang until the outer deadline kills everything.
 * Give bash a bounded default there. Interactive (tui) and rpc sessions keep
 * Pi's native behavior — no default timeout.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_BASH_TIMEOUT_SECONDS = 120;

export const BASH_TIMEOUT_NOTE = `OpenPI applied its default ${DEFAULT_BASH_TIMEOUT_SECONDS}-second limit because this non-interactive run called bash without a timeout. If the command legitimately needs longer, run it again with a larger timeout (in seconds); start long-running services in the background with nohup … &.`;

export default function (pi: ExtensionAPI) {
  const injected = new Set<string>();

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "bash") return;
    if (ctx.mode !== "print" && ctx.mode !== "json") return;
    if (event.input.timeout !== undefined) return;
    event.input.timeout = DEFAULT_BASH_TIMEOUT_SECONDS;
    injected.add(event.toolCallId);
  });

  pi.on("tool_result", (event) => {
    if (!injected.delete(event.toolCallId)) return;
    const timedOut =
      event.isError &&
      event.content.some(
        (part) =>
          part.type === "text" &&
          part.text.includes(
            `Command timed out after ${DEFAULT_BASH_TIMEOUT_SECONDS} seconds`,
          ),
      );
    if (!timedOut) return;
    return {
      content: [
        ...event.content,
        { type: "text" as const, text: BASH_TIMEOUT_NOTE },
      ],
    };
  });
}
