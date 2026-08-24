/** In-memory association between a workflow transcript projection and its child renderer. */

import type { AgentToolRenderer } from "../shared/agent-tool-renderer.ts";
import type { TranscriptEntry } from "./model.ts";

const renderers = new WeakMap<
  ReadonlyArray<TranscriptEntry>,
  AgentToolRenderer
>();

export function bindWorkflowToolRenderer<
  T extends ReadonlyArray<TranscriptEntry>,
>(transcript: T, renderer: AgentToolRenderer): T {
  renderers.set(transcript, renderer);
  return transcript;
}

export function workflowToolRenderer(
  transcript: ReadonlyArray<TranscriptEntry>,
) {
  return renderers.get(transcript);
}
