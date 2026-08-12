export interface InvocationIdentity {
  readonly runId: string;
  readonly callIndex: number;
}

export type InvocationIntentState = "requested";
export type InvocationAdmissionState =
  | "pending"
  | "claimed"
  | "replayed"
  | "rejected";
export type InvocationExecutionState =
  | "pending"
  | "running"
  | "settled"
  | "uncertain";
export type InvocationOutcome = "success" | "error" | "uncertain";

/**
 * Three-plane durable lifecycle for one workflow call.
 *
 * Intent says what the script requested, admission says whether the host
 * accepted or replayed it, and execution says what the child runtime actually
 * proved. Keeping them separate prevents a persisted `running` label from
 * pretending that an interrupted side effect is known to have failed.
 */
export interface InvocationRecord {
  readonly identity: InvocationIdentity;
  readonly intentState: InvocationIntentState;
  readonly admissionState: InvocationAdmissionState;
  readonly executionState: InvocationExecutionState;
  readonly outcome?: InvocationOutcome;
  readonly requestedAt: number;
  readonly claimedAt?: number;
  readonly runningAt?: number;
  readonly terminalAt?: number;
}

export type InvocationTransition =
  | { readonly status: "claimed"; readonly at: number }
  | { readonly status: "running"; readonly at: number }
  | {
      readonly status: "settled";
      readonly outcome: "success" | "error";
      readonly at: number;
    }
  | { readonly status: "replayed"; readonly at: number }
  | { readonly status: "rejected"; readonly at: number };

const ADMISSION_STATES: readonly InvocationAdmissionState[] = [
  "pending",
  "claimed",
  "replayed",
  "rejected",
];
const EXECUTION_STATES: readonly InvocationExecutionState[] = [
  "pending",
  "running",
  "settled",
  "uncertain",
];

function assertIdentity(identity: InvocationIdentity) {
  if (typeof identity.runId !== "string" || identity.runId.trim() === "") {
    throw new Error("runId must be a nonblank string");
  }
  if (!Number.isSafeInteger(identity.callIndex) || identity.callIndex <= 0) {
    throw new Error("callIndex must be a positive safe integer");
  }
}

function assertFinite(value: number | undefined, name: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }
  return value;
}

function immutableSnapshot(record: InvocationRecord) {
  return Object.freeze({
    ...record,
    identity: Object.freeze({ ...record.identity }),
  });
}

function lifecycleLabel(record: InvocationRecord) {
  if (record.admissionState === "replayed") return "replayed";
  if (record.admissionState === "rejected") return "rejected";
  if (
    record.executionState === "settled" ||
    record.executionState === "uncertain"
  ) {
    return "settled";
  }
  if (record.executionState === "running") return "running";
  if (record.admissionState === "claimed") return "claimed";
  return "requested";
}

function assertRecord(record: InvocationRecord) {
  assertIdentity(record.identity);
  assertFinite(record.requestedAt, "requestedAt");
  if (record.intentState !== "requested") {
    throw new Error("Invalid invocation intent state");
  }
  if (!ADMISSION_STATES.includes(record.admissionState)) {
    throw new Error("Invalid invocation admission state");
  }
  if (!EXECUTION_STATES.includes(record.executionState)) {
    throw new Error("Invalid invocation execution state");
  }
  if (record.admissionState === "claimed") {
    assertFinite(record.claimedAt, "claimedAt");
  }
  if (record.executionState === "running") {
    assertFinite(record.runningAt, "runningAt");
  }
  if (
    record.executionState === "settled" ||
    record.executionState === "uncertain"
  ) {
    assertFinite(record.terminalAt, "terminalAt");
  }
  if (
    record.admissionState === "replayed" &&
    (record.executionState !== "settled" || record.outcome !== "success")
  ) {
    throw new Error("Invalid replayed invocation state");
  }
  if (
    record.admissionState === "rejected" &&
    (record.executionState !== "settled" || record.outcome !== "error")
  ) {
    throw new Error("Invalid rejected invocation state");
  }
  if (
    record.admissionState === "pending" &&
    record.executionState !== "pending" &&
    record.executionState !== "uncertain"
  ) {
    throw new Error("Invalid pending invocation state");
  }
  if (
    record.executionState === "settled" &&
    record.outcome !== "success" &&
    record.outcome !== "error"
  ) {
    throw new Error("Settled invocation requires a success or error outcome");
  }
  if (record.executionState === "uncertain" && record.outcome !== "uncertain") {
    throw new Error("Uncertain invocation requires an uncertain outcome");
  }
  if (
    (record.executionState === "pending" ||
      record.executionState === "running") &&
    record.outcome !== undefined
  ) {
    throw new Error("Nonterminal invocation cannot have an outcome");
  }
  if (
    record.executionState !== "settled" &&
    record.executionState !== "uncertain" &&
    record.terminalAt !== undefined
  ) {
    throw new Error("Nonterminal invocation cannot have terminalAt");
  }
  if (record.admissionState !== "claimed" && record.claimedAt !== undefined) {
    throw new Error("Only a claimed invocation can have claimedAt");
  }
  if (
    record.runningAt !== undefined &&
    (record.admissionState !== "claimed" ||
      (record.executionState !== "running" &&
        record.executionState !== "settled" &&
        record.executionState !== "uncertain"))
  ) {
    throw new Error("Invalid runningAt for invocation state");
  }
  if (
    record.admissionState === "claimed" &&
    record.executionState === "settled" &&
    record.runningAt === undefined
  ) {
    throw new Error("A normally settled invocation requires runningAt");
  }

  const timestamps = [
    ["requestedAt", record.requestedAt],
    ["claimedAt", record.claimedAt],
    ["runningAt", record.runningAt],
    ["terminalAt", record.terminalAt],
  ] as const;
  let previous = record.requestedAt;
  for (const [name, timestamp] of timestamps.slice(1)) {
    if (timestamp === undefined) continue;
    assertFinite(timestamp, name);
    if (timestamp < previous) {
      throw new Error(`${name} cannot precede an earlier lifecycle timestamp`);
    }
    previous = timestamp;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode untrusted persisted data without inventing missing lifecycle facts. */
export function decodeInvocationRecord(value: unknown) {
  if (!isRecord(value) || !isRecord(value.identity)) return undefined;
  const candidate = value as unknown as InvocationRecord;
  try {
    assertRecord(candidate);
    return immutableSnapshot(candidate);
  } catch {
    return undefined;
  }
}

function currentTransitionTime(record: InvocationRecord) {
  if (record.terminalAt !== undefined) {
    return {
      name: "terminalAt",
      at: assertFinite(record.terminalAt, "terminalAt"),
    };
  }
  if (record.runningAt !== undefined) {
    return {
      name: "runningAt",
      at: assertFinite(record.runningAt, "runningAt"),
    };
  }
  if (record.claimedAt !== undefined) {
    return {
      name: "claimedAt",
      at: assertFinite(record.claimedAt, "claimedAt"),
    };
  }
  return { name: "requestedAt", at: record.requestedAt };
}

function assertChronology(record: InvocationRecord, at: number) {
  assertFinite(at, "at");
  const current = currentTransitionTime(record);
  if (at < current.at) {
    throw new Error(`Transition time cannot precede ${current.name}`);
  }
}

function isLegalTransition(
  record: InvocationRecord,
  next: InvocationTransition["status"],
) {
  if (
    record.admissionState === "pending" &&
    record.executionState === "pending"
  ) {
    return next === "claimed" || next === "replayed" || next === "rejected";
  }
  if (
    record.admissionState === "claimed" &&
    record.executionState === "pending"
  ) {
    return next === "running";
  }
  if (
    record.admissionState === "claimed" &&
    record.executionState === "running"
  ) {
    return next === "settled";
  }
  return false;
}

/** Structured identity avoids ambiguous string concatenation of run and call. */
export function createInvocationIdentity(runId: string, callIndex: number) {
  const identity = { runId, callIndex };
  assertIdentity(identity);
  return Object.freeze(identity);
}

/** Start a call record without consulting a clock inside the ledger. */
export function requestInvocation(identity: InvocationIdentity, at: number) {
  assertIdentity(identity);
  assertFinite(at, "at");
  return immutableSnapshot({
    identity,
    intentState: "requested",
    admissionState: "pending",
    executionState: "pending",
    requestedAt: at,
  });
}

/** Apply one normal lifecycle or replay/rejection transition. */
export function transitionInvocation(
  record: InvocationRecord,
  transition: InvocationTransition,
) {
  assertRecord(record);
  if (!isLegalTransition(record, transition.status)) {
    throw new Error(
      `Illegal invocation transition: ${lifecycleLabel(record)} -> ${transition.status}`,
    );
  }
  assertChronology(record, transition.at);

  switch (transition.status) {
    case "claimed":
      return immutableSnapshot({
        ...record,
        admissionState: "claimed",
        claimedAt: transition.at,
      });
    case "running":
      return immutableSnapshot({
        ...record,
        executionState: "running",
        runningAt: transition.at,
      });
    case "settled":
      return immutableSnapshot({
        ...record,
        executionState: "settled",
        outcome: transition.outcome,
        terminalAt: transition.at,
      });
    case "replayed":
      return immutableSnapshot({
        ...record,
        admissionState: "replayed",
        executionState: "settled",
        outcome: "success",
        terminalAt: transition.at,
      });
    case "rejected":
      return immutableSnapshot({
        ...record,
        admissionState: "rejected",
        executionState: "settled",
        outcome: "error",
        terminalAt: transition.at,
      });
  }
}

/** Interrupt recovery is conservative: execution may have happened. */
export function classifyInterruptedInvocation(
  record: InvocationRecord,
  at: number,
) {
  assertRecord(record);
  if (
    record.executionState === "settled" ||
    record.executionState === "uncertain"
  ) {
    throw new Error(
      `Cannot classify terminal invocation ${lifecycleLabel(record)} as uncertain`,
    );
  }
  assertChronology(record, at);
  return immutableSnapshot({
    ...record,
    executionState: "uncertain",
    outcome: "uncertain",
    terminalAt: at,
  });
}
