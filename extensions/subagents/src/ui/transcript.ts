import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  AgentTranscriptRenderer,
  type AgentTranscriptDocument,
} from "../../../shared/agent-transcript.ts";
import type { SubagentSnapshot } from "../domain.ts";

export { sanitizeText } from "../../../shared/agent-transcript.ts";
export {
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  spinnerFrame,
} from "../../../shared/spinner.ts";
export { summarizeToolArgs } from "../../../shared/tool-activity.ts";
export type { ToolPhase } from "../../../shared/agent-transcript.ts";

/** Thin projection from Direct Subagent state to the shared UI document. */
export function subagentTranscriptDocument(
  snap: SubagentSnapshot,
): AgentTranscriptDocument {
  return {
    items: snap.transcript,
    cwd: snap.cwd,
    ...(snap.liveAssistant ? { liveAssistant: snap.liveAssistant } : {}),
    ...(snap.liveTools.length > 0 ? { liveTools: snap.liveTools } : {}),
    ...(snap.queued.length > 0 ? { queued: snap.queued } : {}),
  };
}

/** Compatibility wrapper around the shared renderer's historical Direct API. */
export class TranscriptRenderer {
  private renderer = new AgentTranscriptRenderer();

  render(
    snap: SubagentSnapshot,
    width: number,
    theme: Theme,
    options?: { readonly now?: number },
  ) {
    return this.renderer.render(
      subagentTranscriptDocument(snap),
      width,
      theme,
      options,
    );
  }

  invalidate() {
    this.renderer.invalidate();
  }
}

export function buildTranscriptLines(
  snap: SubagentSnapshot,
  width: number,
  theme: Theme,
  renderer?: TranscriptRenderer,
  options?: { readonly now?: number },
) {
  return (renderer ?? new TranscriptRenderer()).render(
    snap,
    width,
    theme,
    options,
  );
}
