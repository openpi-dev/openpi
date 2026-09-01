import type { AgentToolRenderer } from "../../../shared/agent-tool-renderer.ts";
import {
  buildPairingIndex,
  type AgentTranscriptDocument,
  type PairingIndex,
} from "../../../shared/agent-transcript.ts";
import type { SubagentSnapshot } from "../domain.ts";

/** Cached items + pairing, keyed on snapshot identity and transcriptVersion. */
interface StableTranscriptParts {
  readonly version: number;
  readonly items: ReadonlyArray<SubagentSnapshot["transcript"][number]>;
  readonly pairing: PairingIndex;
}

const stableCache = new WeakMap<SubagentSnapshot, StableTranscriptParts>();

function stableParts(snap: SubagentSnapshot): StableTranscriptParts {
  const cached = stableCache.get(snap);
  if (cached && cached.version === snap.transcriptVersion) return cached;
  const parts: StableTranscriptParts = {
    version: snap.transcriptVersion,
    items: snap.transcript,
    pairing: buildPairingIndex(snap.transcript),
  };
  stableCache.set(snap, parts);
  return parts;
}

/** Thin projection from Direct Subagent state to the shared UI document. */
export function subagentTranscriptDocument(
  snap: SubagentSnapshot,
  toolRenderer?: AgentToolRenderer,
): AgentTranscriptDocument {
  const { items, pairing } = stableParts(snap);
  return {
    items,
    pairing,
    cwd: snap.cwd,
    ...(toolRenderer ? { toolRenderer } : {}),
    ...(snap.liveAssistant ? { liveAssistant: snap.liveAssistant } : {}),
    ...(snap.liveTools.length > 0 ? { liveTools: snap.liveTools } : {}),
    ...(snap.queued.length > 0 ? { queued: snap.queued } : {}),
  };
}
