import {
  type ExtensionAPI,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import {
  loadSetupConfig,
  SETUP_CONFIG_CHANGED_CHANNEL,
} from "../shared/setup-config.ts";
import { createWorkspaceCleanupGuard } from "./workspace-provenance.ts";

const DELETE_CONFIRMATION_TITLE = "Delete pre-existing workspace files?";
const OPAQUE_DELETE_CONFIRMATION_TITLE = "Allow unverified workspace cleanup?";

function deleteConfirmationMessage(paths: readonly string[]) {
  if (paths.length === 0) {
    return "OpenPI cannot verify which workspace files this command may delete. Allow this command to run?";
  }
  return `The command would delete files that existed before this agent changed them:\n\n${paths.map((candidate) => `- ${candidate}`).join("\n")}\n\nAllow this exact deletion?`;
}

export default function workspaceCleanupGuard(pi: ExtensionAPI) {
  const workspaceCleanup = createWorkspaceCleanupGuard(
    loadSetupConfig().workspaceCleanupGuard,
  );

  pi.events.on(SETUP_CONFIG_CHANGED_CHANNEL, () => {
    workspaceCleanup.setMode(loadSetupConfig().workspaceCleanupGuard);
  });

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
          paths.length === 0
            ? OPAQUE_DELETE_CONFIRMATION_TITLE
            : DELETE_CONFIRMATION_TITLE,
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
