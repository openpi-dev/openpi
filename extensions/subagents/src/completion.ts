import { directEvidenceRef } from "./evidence.ts";
import { projectDelegationCompletion } from "../../shared/delegation-completion.ts";
import type { SubagentSnapshot } from "./domain.ts";

export function subagentCompletion(snap: SubagentSnapshot) {
  const retainedStart = snap.transcriptVersion - snap.transcript.length;
  const runTranscript =
    snap.runTranscriptStart === undefined
      ? []
      : snap.transcript.slice(
          Math.max(0, snap.runTranscriptStart - retainedStart),
        );
  const generation =
    snap.status !== "running" &&
    snap.runGeneration !== undefined &&
    snap.completionGeneration === snap.runGeneration
      ? snap.runGeneration
      : undefined;
  const evidenceRef =
    generation === undefined
      ? undefined
      : snap.evidence?.generation === generation
        ? directEvidenceRef(snap.evidence)
        : undefined;
  return projectDelegationCompletion({
    owner: "direct",
    executionId:
      snap.runGeneration === undefined
        ? undefined
        : `${snap.id}:run:${snap.runGeneration}`,
    outcome: snap.executionUncertain
      ? "uncertain"
      : snap.status === "running"
        ? "running"
        : snap.outcome === "completed"
          ? "success"
          : snap.outcome === "failed"
            ? "failure"
            : snap.outcome === "interrupted"
              ? "cancelled"
              : "uncertain",
    evidenceRef,
    referenceKind: "owner-locator",
    tools: runTranscript.flatMap((item) =>
      item.kind === "toolResult"
        ? [{ callId: item.toolId, name: item.name, isError: item.isError }]
        : [],
    ),
    textRef:
      snap.status !== "running" && snap.finalText && snap.evidence?.finalEntryId
        ? evidenceRef
        : undefined,
    structuredRef:
      evidenceRef && snap.evidence?.structured.status === "saved"
        ? evidenceRef
        : undefined,
    persistence:
      snap.evidence?.parentBound === false ||
      snap.evidence?.structured.status === "failed"
        ? "failed"
        : snap.evidence?.structured.status === "saved"
          ? "saved"
          : "unknown",
    effectiveCwd: snap.cwd,
    requestedCwd: snap.requestedCwd,
    isolation: snap.worktreeBranch ? "worktree" : "shared",
    branch: snap.worktreeBranch,
    baseSha: snap.worktreeBaseSha,
  });
}
