import { sanitizeTerminalText } from "../shared/terminal-text.ts";

export const GOAL_ENTRY_TYPE = "session-goal";
export const GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "budget_limited",
  "complete",
  "cleared",
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface GoalBlockedAudit {
  blocker: string;
  consecutiveTurns: number;
  lastTurn: number;
}

export interface GoalSnapshot {
  version: 2;
  revision: number;
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
  reason?: string;
  deferContinuation?: boolean;
  continuationCount?: number;
  blockedAudit?: GoalBlockedAudit;
  completionAcknowledged?: boolean;
}

export interface GoalInput {
  objective: string;
  tokenBudget?: number;
}

export const GOAL_LIMITS = Object.freeze({
  objectiveChars: 4_000,
  reasonChars: 500,
  snapshotBytes: 32_768,
  emergencyContinuations: 1_000,
});

const SNAPSHOT_KEYS = new Set([
  "version",
  "revision",
  "id",
  "objective",
  "status",
  "tokenBudget",
  "tokensUsed",
  "timeUsedSeconds",
  "createdAt",
  "updatedAt",
  "reason",
  "deferContinuation",
  "continuationCount",
  "blockedAudit",
  "completionAcknowledged",
]);
const RESUMABLE_STATUSES = new Set<GoalStatus>([
  "paused",
  "blocked",
  "usage_limited",
]);
const TERMINAL_STATUSES = new Set<GoalStatus>(["complete", "cleared"]);

export class GoalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalValidationError";
  }
}

export class GoalRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoalRestoreError";
  }
}

export function isGoalVisible(
  goal: GoalSnapshot | undefined,
): goal is GoalSnapshot {
  return goal !== undefined && goal.status !== "cleared";
}

export function isGoalUnfinished(goal: GoalSnapshot) {
  return !TERMINAL_STATUSES.has(goal.status);
}

export function isGoalActive(goal: GoalSnapshot) {
  return goal.status === "active";
}

export function canResumeGoal(goal: GoalSnapshot) {
  return RESUMABLE_STATUSES.has(goal.status);
}

export function normalizeGoalObjective(value: unknown) {
  if (typeof value !== "string") fail("goal objective must be a string");
  const objective = sanitizeTerminalText(value).trim();
  if (!objective) fail("goal objective must not be empty");
  if (Array.from(objective).length > GOAL_LIMITS.objectiveChars) {
    fail(
      `goal objective must be at most ${GOAL_LIMITS.objectiveChars} characters`,
    );
  }
  return objective;
}

export function createGoalSnapshot(
  input: GoalInput,
  revision: number,
  now: number,
  id: string,
) {
  if (!isRecord(input)) fail("goal input must be an object");
  assertExactKeys(input, new Set(["objective", "tokenBudget"]), "goal input");
  assertNonNegativeInteger(revision, "revision");
  assertTimestamp(now, "now");
  assertId(id);
  if (input.tokenBudget !== undefined) {
    assertPositiveInteger(input.tokenBudget, "tokenBudget");
  }

  return validateGoalSnapshot({
    version: 2,
    revision: increment(revision, "revision"),
    id,
    objective: normalizeGoalObjective(input.objective),
    status: "active",
    ...(input.tokenBudget === undefined
      ? {}
      : { tokenBudget: input.tokenBudget }),
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
  });
}

export function validateGoalSnapshot(value: unknown): GoalSnapshot {
  if (!isRecord(value)) fail("snapshot must be an object");
  assertExactKeys(value, SNAPSHOT_KEYS, "snapshot");
  if (value.version !== 2) {
    fail(`unsupported snapshot version: ${String(value.version)}`);
  }
  assertNonNegativeInteger(value.revision, "snapshot.revision");
  assertId(value.id);
  const objective = normalizeGoalObjective(value.objective);
  if (!GOAL_STATUSES.includes(value.status as GoalStatus)) {
    fail("snapshot.status is invalid");
  }
  const status = value.status as GoalStatus;
  if (hasOwn(value, "tokenBudget")) {
    assertPositiveInteger(value.tokenBudget, "snapshot.tokenBudget");
  }
  assertNonNegativeInteger(value.tokensUsed, "snapshot.tokensUsed");
  assertNonNegativeInteger(value.timeUsedSeconds, "snapshot.timeUsedSeconds");
  assertTimestamp(value.createdAt, "snapshot.createdAt");
  assertTimestamp(value.updatedAt, "snapshot.updatedAt");
  if ((value.updatedAt as number) < (value.createdAt as number)) {
    fail("snapshot.updatedAt precedes createdAt");
  }
  const reason = hasOwn(value, "reason")
    ? normalizeGoalReason(value.reason)
    : undefined;
  if (
    hasOwn(value, "deferContinuation") &&
    typeof value.deferContinuation !== "boolean"
  ) {
    fail("snapshot.deferContinuation must be boolean");
  }
  if (hasOwn(value, "continuationCount")) {
    assertNonNegativeInteger(
      value.continuationCount,
      "snapshot.continuationCount",
    );
  }
  const blockedAudit = hasOwn(value, "blockedAudit")
    ? validateBlockedAudit(value.blockedAudit, value.continuationCount)
    : undefined;
  if (blockedAudit !== undefined && status !== "active") {
    fail("only an active goal can retain a blocked audit");
  }
  if (
    hasOwn(value, "completionAcknowledged") &&
    value.completionAcknowledged !== true
  ) {
    fail("snapshot.completionAcknowledged must be true when present");
  }
  if (value.completionAcknowledged === true && status !== "complete") {
    fail("only a complete goal can acknowledge completion");
  }

  const snapshot: GoalSnapshot = {
    version: 2,
    revision: value.revision as number,
    id: value.id,
    objective,
    status,
    ...(hasOwn(value, "tokenBudget")
      ? { tokenBudget: value.tokenBudget as number }
      : {}),
    tokensUsed: value.tokensUsed as number,
    timeUsedSeconds: value.timeUsedSeconds as number,
    createdAt: value.createdAt as number,
    updatedAt: value.updatedAt as number,
    ...(reason === undefined ? {} : { reason }),
    ...(value.deferContinuation === true ? { deferContinuation: true } : {}),
    ...(hasOwn(value, "continuationCount")
      ? { continuationCount: value.continuationCount as number }
      : {}),
    ...(blockedAudit === undefined ? {} : { blockedAudit }),
    ...(value.completionAcknowledged === true
      ? { completionAcknowledged: true }
      : {}),
  };
  assertSnapshotBytes(snapshot);
  return snapshot;
}

export interface RestoredGoalState {
  snapshot?: GoalSnapshot;
  migrated: boolean;
}

export function restoreGoalState(
  entries: readonly unknown[],
): RestoredGoalState {
  const candidates = entries.flatMap((entry, position) => {
    const payload = extractGoalPayload(entry);
    return payload.found ? [{ payload: payload.value, position }] : [];
  });
  if (candidates.length === 0) return { migrated: false };

  let winner:
    | {
        position: number;
        revision: number;
        snapshot?: GoalSnapshot;
        migrated: boolean;
        error?: Error;
      }
    | undefined;
  const malformedPositions: number[] = [];

  for (const candidate of candidates) {
    const revision = declaredRevision(candidate.payload);
    let snapshot: GoalSnapshot | undefined;
    let migrated = false;
    let error: Error | undefined;
    try {
      if (isRecord(candidate.payload) && candidate.payload.version === 1) {
        snapshot = migrateV1Snapshot(candidate.payload);
        migrated = true;
      } else {
        snapshot = validateGoalSnapshot(candidate.payload);
      }
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
      malformedPositions.push(candidate.position);
    }
    if (revision === undefined) continue;
    if (
      !winner ||
      revision > winner.revision ||
      (revision === winner.revision && candidate.position > winner.position)
    ) {
      winner = {
        position: candidate.position,
        revision,
        snapshot,
        migrated,
        error,
      };
    }
  }

  if (!winner) {
    throw new GoalRestoreError("goal history contains no ranked snapshot");
  }
  if (malformedPositions.some((position) => position > winner.position)) {
    throw new GoalRestoreError(
      "a later malformed goal entry locks restoration",
    );
  }
  if (!winner.snapshot) {
    throw new GoalRestoreError(
      `winning goal revision ${winner.revision} is malformed: ${winner.error?.message ?? "invalid snapshot"}`,
    );
  }
  return { snapshot: winner.snapshot, migrated: winner.migrated };
}

export function restoreGoalSnapshot(entries: readonly unknown[]) {
  const { snapshot } = restoreGoalState(entries);
  return isGoalVisible(snapshot) ? snapshot : undefined;
}

export function transitionGoal(
  current: GoalSnapshot,
  status: GoalStatus,
  now: number,
  reason?: string,
) {
  const base = validateGoalSnapshot(current);
  assertTimestampAfter(now, base.updatedAt);
  const {
    reason: _reason,
    deferContinuation: _defer,
    blockedAudit: _blockedAudit,
    completionAcknowledged: _acknowledged,
    ...stable
  } = base;
  return validateGoalSnapshot({
    ...stable,
    revision: increment(base.revision, "revision"),
    status,
    updatedAt: now,
    ...(reason === undefined ? {} : { reason: normalizeGoalReason(reason) }),
  });
}

/**
 * Resume a goal to active on explicit user action. Unlike a plain
 * transitionGoal, this resets continuationCount: resuming is the user's
 * deliberate "run it again", and it is the only recovery path from the
 * emergency continuation breaker (which trips at emergencyContinuations and is
 * otherwise preserved by ...stable across every other transition). Without the
 * reset, resume() would flip to active and dispatchPrompt would immediately
 * re-trip the breaker, so resume could never actually recover the goal.
 */
export function resumeGoal(
  current: GoalSnapshot,
  now: number,
  reason?: string,
) {
  const base = validateGoalSnapshot(current);
  assertTimestampAfter(now, base.updatedAt);
  const {
    reason: _reason,
    deferContinuation: _defer,
    blockedAudit: _blockedAudit,
    completionAcknowledged: _acknowledged,
    continuationCount: _continuationCount,
    ...stable
  } = base;
  return validateGoalSnapshot({
    ...stable,
    revision: increment(base.revision, "revision"),
    status: "active",
    updatedAt: now,
    ...(reason === undefined ? {} : { reason: normalizeGoalReason(reason) }),
  });
}

export function editGoalObjective(
  current: GoalSnapshot,
  objective: unknown,
  now: number,
) {
  const base = validateGoalSnapshot(current);
  assertTimestampAfter(now, base.updatedAt);
  let status: GoalStatus =
    base.status === "complete" || base.status === "budget_limited"
      ? "active"
      : base.status;
  if (
    status === "active" &&
    base.tokenBudget !== undefined &&
    base.tokensUsed >= base.tokenBudget
  ) {
    status = "budget_limited";
  }
  const {
    reason: _reason,
    deferContinuation: _defer,
    blockedAudit: _blockedAudit,
    completionAcknowledged: _acknowledged,
    ...stable
  } = base;
  return validateGoalSnapshot({
    ...stable,
    revision: increment(base.revision, "revision"),
    objective: normalizeGoalObjective(objective),
    status,
    updatedAt: now,
  });
}

export function recordBlockedAudit(
  current: GoalSnapshot,
  blocker: unknown,
  now: number,
) {
  const base = validateGoalSnapshot(current);
  if (base.status !== "active") {
    fail("only an active goal can record a blocked audit");
  }
  const normalizedBlocker = normalizeGoalReason(blocker);
  const turn = base.continuationCount ?? 0;
  const previous = base.blockedAudit;
  if (previous?.blocker === normalizedBlocker && previous.lastTurn === turn) {
    return { snapshot: base, audit: previous, recorded: false };
  }
  assertTimestampAfter(now, base.updatedAt);
  const audit: GoalBlockedAudit = {
    blocker: normalizedBlocker,
    consecutiveTurns:
      previous?.blocker === normalizedBlocker && previous.lastTurn === turn - 1
        ? increment(previous.consecutiveTurns, "blockedAudit.consecutiveTurns")
        : 1,
    lastTurn: turn,
  };
  return {
    snapshot: validateGoalSnapshot({
      ...base,
      revision: increment(base.revision, "revision"),
      updatedAt: now,
      blockedAudit: audit,
    }),
    audit,
    recorded: true,
  };
}

export function clearBlockedAudit(current: GoalSnapshot, now: number) {
  const base = validateGoalSnapshot(current);
  if (!base.blockedAudit) return base;
  assertTimestampAfter(now, base.updatedAt);
  const { blockedAudit: _blockedAudit, ...withoutAudit } = base;
  return validateGoalSnapshot({
    ...withoutAudit,
    revision: increment(base.revision, "revision"),
    updatedAt: now,
  });
}

export function acknowledgeGoalCompletion(current: GoalSnapshot, now: number) {
  const base = validateGoalSnapshot(current);
  if (base.status !== "complete" || base.completionAcknowledged) return base;
  assertTimestampAfter(now, base.updatedAt);
  return validateGoalSnapshot({
    ...base,
    revision: increment(base.revision, "revision"),
    updatedAt: now,
    completionAcknowledged: true,
  });
}

export function recordGoalProgress(
  current: GoalSnapshot,
  tokens: number,
  elapsedSeconds: number,
  now: number,
) {
  const base = validateGoalSnapshot(current);
  if (base.status === "cleared") fail("a cleared goal cannot record progress");
  assertNonNegativeInteger(tokens, "tokens");
  assertNonNegativeInteger(elapsedSeconds, "elapsedSeconds");
  assertTimestampAfter(now, base.updatedAt);
  return validateGoalSnapshot({
    ...base,
    revision: increment(base.revision, "revision"),
    tokensUsed: safeAdd(base.tokensUsed, tokens, "tokensUsed"),
    timeUsedSeconds: safeAdd(
      base.timeUsedSeconds,
      elapsedSeconds,
      "timeUsedSeconds",
    ),
    updatedAt: now,
  });
}

export function markContinuationDispatched(current: GoalSnapshot, now: number) {
  const base = validateGoalSnapshot(current);
  if (base.status !== "active") {
    fail("only an active goal can dispatch a continuation");
  }
  assertTimestampAfter(now, base.updatedAt);
  return validateGoalSnapshot({
    ...base,
    revision: increment(base.revision, "revision"),
    continuationCount: increment(
      base.continuationCount ?? 0,
      "continuationCount",
    ),
    updatedAt: now,
  });
}

export function setContinuationDeferred(
  current: GoalSnapshot,
  deferred: boolean,
  now: number,
) {
  const base = validateGoalSnapshot(current);
  if (Boolean(base.deferContinuation) === deferred) return base;
  assertTimestampAfter(now, base.updatedAt);
  const { deferContinuation: _defer, ...stable } = base;
  return validateGoalSnapshot({
    ...stable,
    revision: increment(base.revision, "revision"),
    updatedAt: now,
    ...(deferred ? { deferContinuation: true } : {}),
  });
}

export function budgetLimitTransition(goal: GoalSnapshot, now: number) {
  const checked = validateGoalSnapshot(goal);
  if (
    checked.status !== "active" ||
    checked.tokenBudget === undefined ||
    checked.tokensUsed < checked.tokenBudget
  ) {
    return undefined;
  }
  return transitionGoal(
    checked,
    "budget_limited",
    now,
    `Reached the ${checked.tokenBudget}-token goal budget.`,
  );
}

export function emergencyLimitTransition(goal: GoalSnapshot, now: number) {
  const checked = validateGoalSnapshot(goal);
  if (
    checked.status !== "active" ||
    (checked.continuationCount ?? 0) < GOAL_LIMITS.emergencyContinuations
  ) {
    return undefined;
  }
  return transitionGoal(
    checked,
    "blocked",
    now,
    "Stopped after the internal continuation safety limit.",
  );
}

function migrateV1Snapshot(value: Record<string, unknown>) {
  assertNonNegativeInteger(value.revision, "legacy.revision");
  assertId(value.id);
  const objective = normalizeGoalObjective(value.objective);
  const condition =
    typeof value.condition === "string" ? value.condition.trim() : "";
  const combined =
    condition &&
    condition.localeCompare(objective, "en", { sensitivity: "base" })
      ? `${objective}\n\nSuccess criteria: ${condition}`
      : objective;
  const migratedObjective =
    Array.from(combined).length <= GOAL_LIMITS.objectiveChars
      ? combined
      : objective;
  assertTimestamp(value.createdAt, "legacy.createdAt");
  assertTimestamp(value.updatedAt, "legacy.updatedAt");
  if ((value.updatedAt as number) < (value.createdAt as number)) {
    fail("legacy.updatedAt precedes createdAt");
  }
  assertNonNegativeInteger(value.activeMs, "legacy.activeMs");
  const tokensUsed = nonNegativeIntegerOrZero(value.parentTokens);
  const continuationCount = nonNegativeIntegerOrZero(value.iterations);
  const status = migrateV1Status(value.status);
  if (value.tokenBudget !== undefined) {
    assertPositiveInteger(value.tokenBudget, "legacy.tokenBudget");
  }
  const reason =
    typeof value.reason === "string" && value.reason.trim()
      ? normalizeGoalReason(value.reason)
      : status === "paused" &&
          ["active", "waiting"].includes(String(value.status))
        ? "Paused once while migrating the legacy goal; run /goal resume to continue."
        : undefined;

  return validateGoalSnapshot({
    version: 2,
    revision: increment(value.revision as number, "revision"),
    id: value.id,
    objective: migratedObjective,
    status,
    ...(value.tokenBudget === undefined
      ? {}
      : { tokenBudget: value.tokenBudget }),
    tokensUsed,
    timeUsedSeconds: Math.floor((value.activeMs as number) / 1_000),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(reason === undefined ? {} : { reason }),
    ...(continuationCount > 0 ? { continuationCount } : {}),
  });
}

function migrateV1Status(value: unknown): GoalStatus {
  switch (value) {
    case "active":
    case "waiting":
    case "paused":
      return "paused";
    case "achieved":
      return "complete";
    case "impossible":
    case "stalled":
      return "blocked";
    case "budget_limited":
    case "max_iterations":
      return "budget_limited";
    case "cleared":
      return "cleared";
    default:
      fail("legacy.status is invalid");
  }
}

function extractGoalPayload(entry: unknown): {
  found: boolean;
  value?: unknown;
} {
  if (
    !isRecord(entry) ||
    entry.type !== "custom" ||
    entry.customType !== GOAL_ENTRY_TYPE
  ) {
    return { found: false };
  }
  return { found: true, value: hasOwn(entry, "data") ? entry.data : undefined };
}

function declaredRevision(value: unknown) {
  if (!isRecord(value)) return undefined;
  return Number.isSafeInteger(value.revision) && (value.revision as number) >= 0
    ? (value.revision as number)
    : undefined;
}

function validateBlockedAudit(value: unknown, continuationCount: unknown) {
  if (!isRecord(value)) fail("snapshot.blockedAudit must be an object");
  assertExactKeys(
    value,
    new Set(["blocker", "consecutiveTurns", "lastTurn"]),
    "snapshot.blockedAudit",
  );
  const blocker = normalizeGoalReason(value.blocker);
  assertPositiveInteger(
    value.consecutiveTurns,
    "snapshot.blockedAudit.consecutiveTurns",
  );
  assertNonNegativeInteger(value.lastTurn, "snapshot.blockedAudit.lastTurn");
  const currentTurn =
    typeof continuationCount === "number" ? continuationCount : 0;
  if ((value.lastTurn as number) > currentTurn) {
    fail("snapshot.blockedAudit.lastTurn exceeds continuationCount");
  }
  if ((value.consecutiveTurns as number) > (value.lastTurn as number) + 1) {
    fail("snapshot.blockedAudit.consecutiveTurns exceeds elapsed goal turns");
  }
  return {
    blocker,
    consecutiveTurns: value.consecutiveTurns as number,
    lastTurn: value.lastTurn as number,
  };
}

export function normalizeGoalReason(value: unknown) {
  if (typeof value !== "string") fail("reason must be a string");
  const reason = sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
  if (!reason) fail("reason must not be blank");
  if (Array.from(reason).length > GOAL_LIMITS.reasonChars) {
    fail(`reason exceeds ${GOAL_LIMITS.reasonChars} characters`);
  }
  return reason;
}

function assertSnapshotBytes(snapshot: GoalSnapshot) {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  if (bytes > GOAL_LIMITS.snapshotBytes) {
    fail(
      `serialized snapshot exceeds ${GOAL_LIMITS.snapshotBytes} UTF-8 bytes`,
    );
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path} contains unknown field: ${key}`);
  }
}

function assertId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(value)) {
    fail("id must contain 8..100 URL-safe characters");
  }
}

function assertTimestamp(value: unknown, path: string) {
  assertNonNegativeInteger(value, path);
}

function assertTimestampAfter(value: unknown, previous: number) {
  assertTimestamp(value, "now");
  if ((value as number) < previous) fail("now precedes snapshot.updatedAt");
}

function assertPositiveInteger(value: unknown, path: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${path} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(value: unknown, path: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${path} must be a non-negative safe integer`);
  }
}

function nonNegativeIntegerOrZero(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : 0;
}

function increment(value: number, path: string) {
  return safeAdd(value, 1, path);
}

function safeAdd(left: number, right: number, path: string) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    fail(`${path} exhausted safe integers`);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(message: string): never {
  throw new GoalValidationError(message);
}
