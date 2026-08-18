import { createHash } from "node:crypto";
import {
  type ExtensionAPI,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import {
  DELAYED_ACTIVE_EVIDENCE_POLICY,
  projectActiveEvidence,
} from "./active-evidence.ts";
import { createWorkspaceCleanupGuard } from "./workspace-provenance.ts";

const MAX_BASH_RESULT_CHARS = 8_192;
const BASH_RESULT_HEAD_CHARS = 1_024;
const BASH_RESULT_TAIL_CHARS = 6_144;
const DEFAULT_VALIDATION_TIMEOUT_SECONDS = 180;
const RETRY_VALIDATION_TIMEOUT_SECONDS = 60;
const FAILURE_RECOVERY_WINDOW = 8;
const FAILURE_RECOVERY_THRESHOLD = 3;
const FAILURE_RECOVERY_RESET_SUCCESSES = 3;
const FAILURE_RECOVERY_CHECKPOINT =
  "[OpenPI recovery checkpoint: 3 of the last 8 tool attempts failed. Re-establish the authoritative current state with a read or listing before another mutation. Prefer workspace-relative paths over retyping temporary absolute paths. Do not delete files unless you verified this session created them or the task requires removal. Drop speculative side work, then make one minimal evidence-backed change.]";
const TRAJECTORY_BUDGET_TOOL_ATTEMPTS = 20;
const TRAJECTORY_BUDGET_CHECKPOINT =
  "[OpenPI trajectory checkpoint: 20 tool attempts used. Re-read the user contract and inspect the current artifact. Stop speculative exploration. Run one focused validation that covers the remaining risk; if it passes and the artifact satisfies the contract, finish. Otherwise make one evidence-backed change.]";
const VALIDATION_COMMAND =
  /\b(?:go\s+test|cargo\s+test|pytest|python(?:3)?\s+-m\s+(?:pytest|unittest)|(?:npm|pnpm|yarn|bun)\s+(?:(?:run|run-script)\s+)?test|vitest|jest|mvnw?\b[^\n;&|]*\btest|gradlew?\b[^\n;&|]*\btest)\b/iu;
const BENCHMARK_CONVERGENCE_PROFILE_ENV =
  "OPENPI_BENCHMARK_EXECUTION_CONVERGENCE_PROFILE";
const BENCHMARK_AGENT_ROOT_ENV = "OPENPI_BENCHMARK_AGENT_ROOT";

function textHasFailureMarker(output: string) {
  return /(?:^|\n)(?:--- )?FAIL(?::|\s|$)|(?:^|\n)[^\n]*(?:operation not permitted|permission denied)(?:\n|$)/i.test(
    output,
  );
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite tool argument");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error("non-JSON tool argument");
  if (seen.has(value)) throw new Error("cyclic tool argument");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry, seen)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((left, right) => left.localeCompare(right, "en"))
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`,
      )
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function toolCallFingerprint(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId: string,
) {
  try {
    return createHash("sha256")
      .update(toolName)
      .update("\0")
      .update(canonicalJson(input))
      .digest("hex");
  } catch {
    return `unhashable:${toolCallId}`;
  }
}

function validationCommandFingerprint(command: string) {
  return createHash("sha256").update(command).digest("hex");
}

export default function executionConvergence(pi: ExtensionAPI) {
  const benchmarkProfile = process.env[BENCHMARK_AGENT_ROOT_ENV]
    ? process.env[BENCHMARK_CONVERGENCE_PROFILE_ENV]
    : undefined;
  const v2Enabled = !(benchmarkProfile === "legacy");
  const executionPolicyEnabled =
    benchmarkProfile !== undefined &&
    benchmarkProfile !== "pi-native-execution";
  const activeEvidenceEnabled =
    executionPolicyEnabled &&
    v2Enabled &&
    benchmarkProfile !== "no-active-evidence";
  const activeEvidencePolicy =
    benchmarkProfile === "delayed-active-evidence"
      ? DELAYED_ACTIVE_EVIDENCE_POLICY
      : undefined;
  const modelHintsEnabled =
    executionPolicyEnabled && benchmarkProfile !== "no-model-hints";
  const projectedBashResultIds = new Set<string>();
  const projectedActiveEvidenceEpochs = new Set<string>();
  let confirmWorkspaceDelete:
    | ((paths: readonly string[]) => Promise<boolean>)
    | undefined;
  const workspaceCleanup = createWorkspaceCleanupGuard({
    confirmDelete: async (paths) =>
      (await confirmWorkspaceDelete?.(paths)) ?? false,
  });
  const boundedValidationCalls = new Map<
    string,
    { commandFingerprint: string; timeoutSeconds: number }
  >();
  const timedOutValidationCommands = new Set<string>();
  const pendingAttempts = new Map<
    string,
    { sequence: number; fingerprint: string }
  >();
  const settledAttempts = new Map<
    number,
    { fingerprint: string; failed: boolean }
  >();
  let nextAttemptSequence = 0;
  let nextSettlementSequence = 0;
  let lastFailedFingerprint: string | undefined;
  let failedStreak = 0;
  const recentAttemptFailures: boolean[] = [];
  let recoveryHintLatched = false;
  let successfulAttemptsSinceRecoveryHint = 0;
  let settledToolAttemptCount = 0;
  let trajectoryHintInjected = false;

  const recordSettledAttempts = () => {
    let injectRecoveryHint = false;
    while (settledAttempts.has(nextSettlementSequence)) {
      const settled = settledAttempts.get(nextSettlementSequence)!;
      settledAttempts.delete(nextSettlementSequence);
      nextSettlementSequence += 1;
      settledToolAttemptCount += 1;
      recentAttemptFailures.push(settled.failed);
      if (recentAttemptFailures.length > FAILURE_RECOVERY_WINDOW) {
        recentAttemptFailures.shift();
      }
      if (recoveryHintLatched) {
        successfulAttemptsSinceRecoveryHint = settled.failed
          ? 0
          : successfulAttemptsSinceRecoveryHint + 1;
        if (
          successfulAttemptsSinceRecoveryHint >=
          FAILURE_RECOVERY_RESET_SUCCESSES
        ) {
          recoveryHintLatched = false;
          recentAttemptFailures.length = 0;
          successfulAttemptsSinceRecoveryHint = 0;
        }
      } else if (
        recentAttemptFailures.filter(Boolean).length >=
        FAILURE_RECOVERY_THRESHOLD
      ) {
        recoveryHintLatched = true;
        successfulAttemptsSinceRecoveryHint = 0;
        injectRecoveryHint = true;
      }
      if (!settled.failed) {
        lastFailedFingerprint = undefined;
        failedStreak = 0;
      } else if (settled.fingerprint === lastFailedFingerprint) {
        failedStreak += 1;
      } else {
        lastFailedFingerprint = settled.fingerprint;
        failedStreak = 1;
      }
    }
    return injectRecoveryHint;
  };

  pi.on("tool_call", async (event, ctx) => {
    const fingerprint = toolCallFingerprint(
      event.toolName,
      event.input,
      event.toolCallId,
    );
    if (
      executionPolicyEnabled &&
      lastFailedFingerprint !== undefined &&
      fingerprint !== lastFailedFingerprint
    ) {
      lastFailedFingerprint = undefined;
      failedStreak = 0;
    }
    if (
      executionPolicyEnabled &&
      fingerprint === lastFailedFingerprint &&
      failedStreak >= 2
    ) {
      pi.events.emit("openpi:execution-convergence", {
        type: "loop_gate",
        blockedRepeatedFailures: 1,
      });
      return {
        block: true,
        reason: `Blocked: this exact ${event.toolName} call with identical arguments has already failed repeatedly with no different step in between. Change the arguments or inspect new evidence before retrying.`,
      };
    }
    if (v2Enabled && isToolCallEventType("write", event)) {
      await workspaceCleanup.beforeWrite({
        id: event.toolCallId,
        path: event.input.path,
        cwd: ctx.cwd,
      });
    }
    if (v2Enabled && isToolCallEventType("bash", event)) {
      confirmWorkspaceDelete = (paths) =>
        ctx.ui.confirm(
          "Delete pre-existing workspace files?",
          `The command would delete files that existed before this agent changed them:\n\n${paths.map((candidate) => `- ${candidate}`).join("\n")}\n\nAllow this exact deletion?`,
        );
      let cleanupDecision;
      try {
        cleanupDecision = await workspaceCleanup.before({
          id: event.toolCallId,
          command: event.input.command,
          cwd: ctx.cwd,
        });
      } finally {
        confirmWorkspaceDelete = undefined;
      }
      if (cleanupDecision.kind === "block") {
        pi.events.emit("openpi:execution-convergence", {
          type: "workspace_cleanup_guard",
          blockedPreExistingDeletes: cleanupDecision.protectedPaths.length,
        });
        return { block: true, reason: cleanupDecision.reason };
      }
    }
    if (
      executionPolicyEnabled &&
      isToolCallEventType("bash", event) &&
      event.input.timeout === undefined &&
      VALIDATION_COMMAND.test(event.input.command)
    ) {
      const commandFingerprint = validationCommandFingerprint(
        event.input.command,
      );
      const shortenedRetry = timedOutValidationCommands.has(commandFingerprint);
      const timeoutSeconds = shortenedRetry
        ? RETRY_VALIDATION_TIMEOUT_SECONDS
        : DEFAULT_VALIDATION_TIMEOUT_SECONDS;
      event.input.timeout = timeoutSeconds;
      boundedValidationCalls.set(event.toolCallId, {
        commandFingerprint,
        timeoutSeconds,
      });
      pi.events.emit("openpi:execution-convergence", {
        type: shortenedRetry
          ? "validation_retry_timeout_default"
          : "validation_timeout_default",
        boundedValidationCalls: 1,
        ...(shortenedRetry ? { shortenedValidationRetries: 1 } : {}),
        timeoutSeconds,
      });
    }
    if (executionPolicyEnabled) {
      pendingAttempts.set(event.toolCallId, {
        sequence: nextAttemptSequence,
        fingerprint,
      });
      nextAttemptSequence += 1;
    }
  });

  pi.on("tool_result", async (event) => {
    if (
      v2Enabled &&
      (event.toolName === "bash" || event.toolName === "write")
    ) {
      await workspaceCleanup.after({
        id: event.toolCallId,
        isError: event.isError,
      });
    }
    const output = event.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const boundedValidation = boundedValidationCalls.get(event.toolCallId);
    if (boundedValidation) {
      boundedValidationCalls.delete(event.toolCallId);
      if (
        event.isError &&
        output.includes(
          `Command timed out after ${boundedValidation.timeoutSeconds} seconds`,
        )
      ) {
        timedOutValidationCommands.add(boundedValidation.commandFingerprint);
        pi.events.emit("openpi:execution-convergence", {
          type: "validation_timeout_triggered",
          timedOutValidationCalls: 1,
          timeoutSeconds: boundedValidation.timeoutSeconds,
        });
      }
    }
    const hasFailureMarker =
      event.toolName === "bash" && textHasFailureMarker(output);
    const attempt = pendingAttempts.get(event.toolCallId);
    let injectRecoveryHint = false;
    if (attempt) {
      pendingAttempts.delete(event.toolCallId);
      settledAttempts.set(attempt.sequence, {
        fingerprint: attempt.fingerprint,
        failed: event.isError || hasFailureMarker,
      });
      injectRecoveryHint = recordSettledAttempts();
    }
    const injectTrajectoryHint =
      attempt !== undefined &&
      !trajectoryHintInjected &&
      settledToolAttemptCount >= TRAJECTORY_BUDGET_TOOL_ATTEMPTS;
    if (injectTrajectoryHint) {
      trajectoryHintInjected = true;
      pi.events.emit("openpi:execution-convergence", {
        type: modelHintsEnabled
          ? "trajectory_budget_hint"
          : "trajectory_budget_hint_suppressed",
        ...(modelHintsEnabled
          ? { injectedTrajectoryHints: 1 }
          : { suppressedTrajectoryHints: 1 }),
        toolAttempts: settledToolAttemptCount,
      });
    }
    if (injectRecoveryHint) {
      pi.events.emit("openpi:execution-convergence", {
        type: modelHintsEnabled
          ? "failure_recovery_hint"
          : "failure_recovery_hint_suppressed",
        ...(modelHintsEnabled
          ? { injectedRecoveryHints: 1 }
          : { suppressedRecoveryHints: 1 }),
      });
    }
    const checkpoints = [
      ...(modelHintsEnabled && injectRecoveryHint
        ? [FAILURE_RECOVERY_CHECKPOINT]
        : []),
      ...(modelHintsEnabled && injectTrajectoryHint
        ? [TRAJECTORY_BUDGET_CHECKPOINT]
        : []),
    ];
    if (checkpoints.length === 0) return;
    return {
      content: [
        ...event.content,
        ...checkpoints.map((text) => ({ type: "text" as const, text })),
      ],
    };
  });

  pi.on("agent_settled", () => {
    projectedBashResultIds.clear();
    projectedActiveEvidenceEpochs.clear();
    workspaceCleanup.reset();
    boundedValidationCalls.clear();
    timedOutValidationCommands.clear();
    pendingAttempts.clear();
    settledAttempts.clear();
    nextAttemptSequence = 0;
    nextSettlementSequence = 0;
    lastFailedFingerprint = undefined;
    failedStreak = 0;
    recentAttemptFailures.length = 0;
    recoveryHintLatched = false;
    successfulAttemptsSinceRecoveryHint = 0;
    settledToolAttemptCount = 0;
    trajectoryHintInjected = false;
  });

  pi.on("context", (event) => {
    if (!executionPolicyEnabled) return;
    const activeEvidence = activeEvidenceEnabled
      ? projectActiveEvidence(event.messages, activeEvidencePolicy)
      : undefined;
    const contextMessages = activeEvidence?.messages ?? event.messages;
    if (activeEvidence) {
      const isNewEpoch = !projectedActiveEvidenceEpochs.has(
        activeEvidence.receipt.digest,
      );
      projectedActiveEvidenceEpochs.add(activeEvidence.receipt.digest);
      pi.events.emit("openpi:execution-convergence", {
        type: "active_evidence_projection",
        projectedActiveEvidenceApplications: 1,
        newActiveEvidenceEpochs: isNewEpoch ? 1 : 0,
        closedToolTransactions: activeEvidence.receipt.closedTransactions,
        activeEvidenceCharsRemoved:
          activeEvidence.receipt.originalChars -
          activeEvidence.receipt.projectedChars,
      });
    }
    let projectedBashResultApplications = 0;
    let newlyProjectedBashResults = 0;
    const messages = contextMessages.map((message) => {
      if (
        message.role !== "toolResult" ||
        message.toolName !== "bash" ||
        message.isError ||
        message.content.length !== 1 ||
        message.content[0]?.type !== "text" ||
        textHasFailureMarker(message.content[0].text) ||
        message.content[0].text.length <= MAX_BASH_RESULT_CHARS
      ) {
        return message;
      }

      const text = message.content[0].text;
      projectedBashResultApplications += 1;
      if (!projectedBashResultIds.has(message.toolCallId)) {
        projectedBashResultIds.add(message.toolCallId);
        newlyProjectedBashResults += 1;
      }
      return {
        ...message,
        content: [
          {
            ...message.content[0],
            text: `${text.slice(0, BASH_RESULT_HEAD_CHARS)}\n[OpenPI: Bash output bounded; head and tail retained; rerun a narrower command if the omitted middle is needed]\n${text.slice(-BASH_RESULT_TAIL_CHARS)}`,
          },
        ],
      };
    });

    if (projectedBashResultApplications > 0) {
      pi.events.emit("openpi:execution-convergence", {
        type: "context_projection",
        projectedBashResultApplications,
        newlyProjectedBashResults,
      });
    }
    if (!activeEvidence && projectedBashResultApplications === 0) return;
    return { messages };
  });
}
