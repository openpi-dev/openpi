import {
  type ExtensionAPI,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { createWorkspaceCleanupGuard } from "./workspace-provenance.ts";

const DELETE_CONFIRMATION_TITLE = "Delete pre-existing workspace files?";

function deleteConfirmationMessage(paths: readonly string[]) {
  return `The command would delete files that existed before this agent changed them:\n\n${paths.map((candidate) => `- ${candidate}`).join("\n")}\n\nAllow this exact deletion?`;
}

export default function workspaceCleanupGuard(pi: ExtensionAPI) {
  const workspaceCleanup = createWorkspaceCleanupGuard();

  pi.on("tool_call", async (event, ctx) => {
    if (isToolCallEventType("write", event)) {
      await workspaceCleanup.beforeWrite({
        id: event.toolCallId,
        path: event.input.path,
        cwd: ctx.cwd,
      });
      return;
    }
    if (!isToolCallEventType("bash", event)) return;

    const cleanupDecision = await workspaceCleanup.before({
      id: event.toolCallId,
      command: event.input.command,
      cwd: ctx.cwd,
      confirmDelete: (paths) =>
        ctx.ui.confirm(
          DELETE_CONFIRMATION_TITLE,
          deleteConfirmationMessage(paths),
          { signal: ctx.signal },
        ),
    });
    if (cleanupDecision.kind === "block") {
      return { block: true, reason: cleanupDecision.reason };
    }
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash" && event.toolName !== "write") return;
    await workspaceCleanup.after({
      id: event.toolCallId,
      isError: event.isError,
    });
  });

  pi.on("agent_settled", () => {
    workspaceCleanup.reset();
  });
}
