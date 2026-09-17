import {
  type ExtensionAPI,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { WORKSPACE_CLEANUP_CONFIRMATION_CHANNEL } from "../shared/tool-confirmation.ts";
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

    const confirmation = {
      sessionId: ctx.sessionManager.getSessionId(),
      toolCallId: event.toolCallId,
    };
    const cleanupDecision = await workspaceCleanup.before({
      id: event.toolCallId,
      command: event.input.command,
      cwd: ctx.cwd,
      confirmDelete: async (paths) => {
        pi.events.emit(WORKSPACE_CLEANUP_CONFIRMATION_CHANNEL, {
          ...confirmation,
          waiting: true,
        });
        const approved = await ctx.ui.confirm(
          DELETE_CONFIRMATION_TITLE,
          deleteConfirmationMessage(paths),
          { signal: ctx.signal },
        );
        if (approved) {
          pi.events.emit(WORKSPACE_CLEANUP_CONFIRMATION_CHANNEL, {
            ...confirmation,
            waiting: false,
          });
        }
        return approved;
      },
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
