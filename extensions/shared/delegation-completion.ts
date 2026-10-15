/** A presentation-only join of existing owner facts, never acceptance authority. */
export type DelegationOutcome =
  | "running"
  | "success"
  | "failure"
  | "cancelled"
  | "uncertain"
  | "replayed";

export interface DelegationToolFact {
  readonly callId?: string;
  readonly name: string;
  readonly isError?: boolean;
}

export interface DelegationReplayOrigin {
  readonly executionId: string;
  readonly evidenceRef: string;
}

export interface DelegationCompletionFacts {
  readonly owner: "direct" | "workflow";
  /** Omitted when legacy owner data cannot identify a particular execution. */
  readonly executionId?: string;
  readonly outcome: DelegationOutcome;
  readonly evidenceRef?: string;
  /** Fingerprints correlate only; they cannot be resolved as evidence locators. */
  readonly referenceKind?: "fingerprint" | "owner-locator";
  readonly tools?: readonly DelegationToolFact[];
  readonly toolEvidenceRef?: string;
  readonly textRef?: string;
  readonly structuredRef?: string;
  readonly requestedCwd?: string;
  readonly effectiveCwd?: string;
  readonly isolation?: "shared" | "worktree";
  readonly branch?: string;
  readonly baseSha?: string;
  readonly handoffRef?: string;
  readonly persistence?: "saved" | "failed" | "unknown";
  readonly replay?: { readonly origin: DelegationReplayOrigin | "unknown" };
}

// Recovery references are never truncated into unusable paths or identities.
function boundedReference(value: string | undefined, maxBytes = 4096) {
  return value && Buffer.byteLength(value, "utf8") <= maxBytes
    ? value
    : undefined;
}

export function decodeDelegationReplayOrigin(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("executionId" in value) ||
    !("evidenceRef" in value)
  )
    return undefined;
  const executionId =
    typeof value.executionId === "string"
      ? boundedReference(value.executionId)
      : undefined;
  const evidenceRef =
    typeof value.evidenceRef === "string"
      ? boundedReference(value.evidenceRef)
      : undefined;
  return executionId && evidenceRef ? { executionId, evidenceRef } : undefined;
}

export const COMPLETION_MAX_BYTES = 16 * 1024;

function enumValue<const T extends string>(
  value: unknown,
  allowed: readonly T[],
) {
  return allowed.find((candidate) => candidate === value);
}

export function projectDelegationCompletion(input: DelegationCompletionFacts) {
  const referenceKind =
    input.referenceKind === undefined
      ? ("owner-locator" as const)
      : (enumValue(input.referenceKind, ["fingerprint", "owner-locator"]) ??
        "unknown");
  const facts = {
    owner: enumValue(input.owner, ["direct", "workflow"]) ?? "unknown",
    outcome:
      enumValue(input.outcome, [
        "running",
        "success",
        "failure",
        "cancelled",
        "uncertain",
        "replayed",
      ]) ?? "uncertain",
    isolation: enumValue(input.isolation, ["shared", "worktree"]),
    persistence: enumValue(input.persistence, ["saved", "failed", "unknown"]),
    // Retain no caller-owned replay object or unchecked metadata.
    replay: input.replay
      ? {
          origin:
            decodeDelegationReplayOrigin(input.replay?.origin) ??
            ("unknown" as const),
        }
      : undefined,
    executionId: boundedReference(input.executionId),
    evidenceRef: boundedReference(input.evidenceRef),
    toolEvidenceRef: boundedReference(input.toolEvidenceRef),
    textRef: boundedReference(input.textRef),
    structuredRef: boundedReference(input.structuredRef),
    // Paths and guessable path hashes are not owner identities.
    requestedCwd: undefined,
    effectiveCwd: undefined,
    branch: boundedReference(input.branch, 512),
    baseSha: boundedReference(input.baseSha, 128),
    handoffRef: boundedReference(input.handoffRef),
  };
  const tools = input.tools ?? [];
  const projection = {
    version: 1 as const,
    identity: {
      owner: facts.owner,
      executionId: facts.executionId ?? "unknown",
    },
    observed: {
      outcome: facts.outcome,
      referenceKind,
      ...(facts.evidenceRef ? { evidenceRef: facts.evidenceRef } : {}),
      tools: {
        // Normalized owner transcripts are bounded, not complete audit logs.
        coverage: "partial" as const,
        omitted: Math.max(0, tools.length - 16),
        ...(facts.toolEvidenceRef || facts.evidenceRef
          ? { evidenceRef: facts.toolEvidenceRef ?? facts.evidenceRef }
          : {}),
        items: tools.slice(0, 16).map((tool) => ({
          ...(boundedReference(tool.callId, 512)
            ? { callId: tool.callId }
            : {}),
          name: tool.name.slice(0, 128),
          ...(tool.name.length > 128 ? { nameTruncated: true } : {}),
          returned:
            tool.isError === undefined
              ? ("unknown" as const)
              : tool.isError
                ? ("error" as const)
                : ("success" as const),
          // isError:false is a tool return, NOT a process exit observation.
          processExit: { status: "unknown" as const },
          // Do not parse previews or model prose into command evidence.
          command: { status: "unknown" as const },
        })),
      },
    },
    modelClaimed: {
      referenceKind,
      status:
        facts.textRef || facts.structuredRef
          ? ("referenced" as const)
          : ("unknown" as const),
      ...(facts.textRef ? { textRef: facts.textRef } : {}),
      ...(facts.structuredRef ? { structuredRef: facts.structuredRef } : {}),
    },
    verification: {
      status: "unknown" as const,
      // This mechanism never runs tests or an additional verifier/model.
      automatic: { status: "not-run" as const },
    },
    workspace: {
      isolation: facts.isolation ?? "unknown",
      attribution:
        facts.isolation === "worktree"
          ? ("checkout-only" as const)
          : ("unknown" as const),
      ...(facts.requestedCwd ? { requestedCwd: facts.requestedCwd } : {}),
      ...(facts.effectiveCwd ? { effectiveCwd: facts.effectiveCwd } : {}),
      ...(facts.branch ? { branch: facts.branch } : {}),
      ...(facts.baseSha ? { baseSha: facts.baseSha } : {}),
      ...(facts.handoffRef ? { handoffRef: facts.handoffRef } : {}),
    },
    persistence: { status: facts.persistence ?? "unknown" },
    ...(facts.replay
      ? {
          replay: { newExecution: false as const, origin: facts.replay.origin },
        }
      : {}),
  };

  // At most 16 tool items and a fixed number of reference fields are examined.
  // Drop whole optional references, never fabricate a truncated locator. The
  // canonical owner record is not mutated. JSON escaping counts toward budget.
  const overBudget = () =>
    Buffer.byteLength(JSON.stringify(projection), "utf8") >
    COMPLETION_MAX_BYTES;
  while (overBudget() && projection.observed.tools.items.length) {
    projection.observed.tools.items.pop();
    projection.observed.tools.omitted++;
  }
  if (overBudget()) delete projection.workspace.handoffRef;
  if (overBudget()) delete projection.observed.tools.evidenceRef;
  if (overBudget() && projection.replay) projection.replay.origin = "unknown";
  if (overBudget()) delete projection.modelClaimed.structuredRef;
  if (overBudget()) delete projection.modelClaimed.textRef;
  if (overBudget()) delete projection.observed.evidenceRef;
  if (overBudget()) projection.identity.executionId = "unknown";
  projection.modelClaimed.status =
    projection.modelClaimed.textRef || projection.modelClaimed.structuredRef
      ? "referenced"
      : "unknown";
  if (
    !projection.observed.evidenceRef &&
    !projection.observed.tools.evidenceRef
  )
    projection.observed.referenceKind = "unknown";
  if (projection.modelClaimed.status === "unknown")
    projection.modelClaimed.referenceKind = "unknown";
  // Recheck after metadata changes; shed remaining optional workspace fields.
  if (overBudget()) {
    delete projection.workspace.branch;
    delete projection.workspace.baseSha;
    delete projection.workspace.requestedCwd;
    delete projection.workspace.effectiveCwd;
  }
  // Only validated enums and fixed-size unknown facts remain after shedding.
  // Fail closed rather than ever returning an over-budget projection.
  if (overBudget())
    throw new Error("Delegation completion exceeds byte budget");
  return projection;
}

export type DelegationCompletion = ReturnType<
  typeof projectDelegationCompletion
>;

export function delegationCompletionText(completion: DelegationCompletion) {
  const origin = completion.replay?.origin;
  return [
    `Completion evidence (not acceptance): ${completion.identity.owner}/${completion.identity.executionId}`,
    `observed=${completion.observed.outcome}`,
    ...(completion.observed.evidenceRef
      ? [
          `${completion.observed.referenceKind === "fingerprint" ? "evidence-fingerprint" : "evidence"}=${completion.observed.evidenceRef}`,
        ]
      : []),
    `${completion.modelClaimed.referenceKind === "fingerprint" ? "model-claim-fingerprint" : "model-claims"}=${completion.modelClaimed.structuredRef ?? completion.modelClaimed.textRef ?? "unknown"}`,
    "verification=unknown; auto=not-run; exit/command=unknown",
    `workspace=${completion.workspace.isolation}/${completion.workspace.attribution}`,
    `persistence=${completion.persistence.status}`,
    ...(completion.workspace.handoffRef
      ? [`handoff=${completion.workspace.handoffRef}`]
      : []),
    ...(completion.replay
      ? [
          `replay=no-new-execution; origin=${origin && origin !== "unknown" ? `${origin.executionId} (${origin.evidenceRef})` : "unknown"}`,
        ]
      : []),
  ].join("; ");
}
