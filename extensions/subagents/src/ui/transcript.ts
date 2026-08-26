import type { AgentToolRenderer } from "../../../shared/agent-tool-renderer.ts";
import type { AgentTranscriptDocument } from "../../../shared/agent-transcript.ts";
import type { SubagentSnapshot } from "../domain.ts";

/** Thin projection from Direct Subagent state to the shared UI document. */
export function subagentTranscriptDocument(
  snap: SubagentSnapshot,
  toolRenderer?: AgentToolRenderer,
): AgentTranscriptDocument {
  return {
    items: snap.transcript,
    cwd: snap.cwd,
    ...(toolRenderer ? { toolRenderer } : {}),
    ...(snap.liveAssistant ? { liveAssistant: snap.liveAssistant } : {}),
    ...(snap.liveTools.length > 0 ? { liveTools: snap.liveTools } : {}),
    ...(snap.queued.length > 0 ? { queued: snap.queued } : {}),
  };
}
