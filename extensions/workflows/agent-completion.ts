import {
  delegationCompletionText,
  projectDelegationCompletion,
} from "../shared/delegation-completion.ts";
import type { AgentRecord } from "./model.ts";

export function workflowAgentCompletion(runId: string, agent: AgentRecord) {
  if (agent.completion) return agent.completion;
  const evidenceRef = `${runId}/workflow.json`;
  const transcriptRef = `${runId}/transcripts.json#/${agent.index}`;
  const resultRef =
    agent.state !== "running" &&
    agent.resultPersistence === "saved" &&
    agent.resultArtifact
      ? `${runId}/${agent.resultArtifact}`
      : undefined;
  return projectDelegationCompletion({
    owner: "workflow",
    executionId: agent.callId,
    outcome:
      agent.state === "uncertain"
        ? "uncertain"
        : (agent.executionOutcome ??
          (agent.replayed
            ? "replayed"
            : agent.state === "running"
              ? "running"
              : agent.invocation?.executionState === "settled" &&
                  agent.invocation.outcome === "success"
                ? "success"
                : "uncertain")),
    evidenceRef,
    toolEvidenceRef: transcriptRef,
    tools: agent.transcript.flatMap((entry) =>
      entry.role === "toolResult"
        ? [
            {
              callId: entry.toolCallId,
              name: entry.name ?? "unknown",
              isError: entry.isError,
            },
          ]
        : [],
    ),
    textRef: agent.resultHasText ? resultRef : undefined,
    structuredRef: agent.resultHasStructured ? resultRef : undefined,
    persistence: agent.resultPersistence ?? "unknown",
    requestedCwd: agent.requestedCwd,
    effectiveCwd: agent.effectiveCwd,
    isolation: agent.isolation,
    branch: agent.worktreeBranch ?? agent.worktreeCleanup?.branch,
    baseSha: agent.worktreeCleanup?.baseSha,
    handoffRef: agent.worktreeHandoffArtifact
      ? `${runId}/${agent.worktreeHandoffArtifact}`
      : undefined,
    ...(agent.replayed || agent.replayOrigin !== undefined
      ? { replay: { origin: agent.replayOrigin ?? "unknown" } }
      : {}),
  });
}

export function workflowCompletionLines(
  runId: string,
  agents: readonly AgentRecord[],
) {
  return [
    ...agents
      .slice(0, 16)
      .map((agent) =>
        delegationCompletionText(workflowAgentCompletion(runId, agent)),
      ),
    ...(agents.length > 16
      ? [
          `${agents.length - 16} completion projection(s) omitted; see workflow.json and transcripts.json.`,
        ]
      : []),
  ];
}
