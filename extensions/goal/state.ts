export const GOAL_ENTRY_TYPE = "session-goal";
export const GOAL_STATUSES = [
  "active",
  "waiting",
  "paused",
  "achieved",
  "impossible",
  "stalled",
  "budget_limited",
  "max_iterations",
  "cleared",
] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface GoalSnapshot {
  version: 1;
  revision: number;
  id: string;
  objective: string;
  condition: string;
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  activeMs: number;
  activeSince?: number;
  maxTurns: number;
  noProgressCap: number;
  wallClockMinutes: number;
  tokenBudget?: number;
  iterations: number;
  parentTokens: number;
  evaluatorTokens: number;
  noProgressCount: number;
  evaluatorFailures: number;
  waitCount: number;
  ledgerReminderUsed: boolean;
  reason?: string;
}

export interface GoalInput {
  objective: string;
  condition: string;
  maxTurns?: number;
  noProgressCap?: number;
  wallClockMinutes?: number;
  tokenBudget?: number;
}

export interface GoalJudge {
  met: boolean;
  impossible: boolean;
  progress: boolean;
  waiting: boolean;
  reason: string;
}

export const GOAL_DEFAULTS = Object.freeze({
  maxTurns: 40,
  noProgressCap: 8,
  wallClockMinutes: 120,
});

export const GOAL_LIMITS = Object.freeze({
  textChars: 500,
  reasonChars: 500,
  maxTurns: 200,
  noProgressCap: 50,
  snapshotBytes: 16_384,
});

const SNAPSHOT_KEYS = new Set([
  "version",
  "revision",
  "id",
  "objective",
  "condition",
  "status",
  "createdAt",
  "updatedAt",
  "activeMs",
  "activeSince",
  "maxTurns",
  "noProgressCap",
  "wallClockMinutes",
  "tokenBudget",
  "iterations",
  "parentTokens",
  "evaluatorTokens",
  "noProgressCount",
  "evaluatorFailures",
  "waitCount",
  "ledgerReminderUsed",
  "reason",
]);
const ACTIVE_STATUSES = new Set<GoalStatus>(["active", "waiting"]);
const UNFINISHED_STATUSES = new Set<GoalStatus>([
  "active",
  "waiting",
  "paused",
]);

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

export function isGoalUnfinished(goal: GoalSnapshot) {
  return UNFINISHED_STATUSES.has(goal.status);
}

export function isGoalRunning(goal: GoalSnapshot) {
  return ACTIVE_STATUSES.has(goal.status);
}

export function createGoalSnapshot(
  input: GoalInput,
  revision: number,
  now: number,
  id: string,
) {
  if (!isRecord(input)) fail("goal input must be an object");
  assertExactKeys(
    input,
    new Set([
      "objective",
      "condition",
      "maxTurns",
      "noProgressCap",
      "wallClockMinutes",
      "tokenBudget",
    ]),
    "goal input",
  );
  const { objective, condition } = normalizeGoalContract(
    input.objective,
    input.condition,
  );
  assertNonNegativeInteger(revision, "revision");
  assertTimestamp(now, "now");
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(id)) {
    fail("id must contain 8..100 URL-safe characters");
  }
  const maxTurns = input.maxTurns ?? GOAL_DEFAULTS.maxTurns;
  const noProgressCap = input.noProgressCap ?? GOAL_DEFAULTS.noProgressCap;
  const wallClockMinutes =
    input.wallClockMinutes ?? GOAL_DEFAULTS.wallClockMinutes;
  assertBoundedPositiveInteger(maxTurns, "maxTurns", GOAL_LIMITS.maxTurns);
  assertBoundedPositiveInteger(
    noProgressCap,
    "noProgressCap",
    GOAL_LIMITS.noProgressCap,
  );
  assertPositiveInteger(wallClockMinutes, "wallClockMinutes");
  if (input.tokenBudget !== undefined) {
    assertPositiveInteger(input.tokenBudget, "tokenBudget");
    if (input.tokenBudget < 1_000) fail("tokenBudget must be at least 1000");
  }

  return validateGoalSnapshot({
    version: 1,
    revision: increment(revision, "revision"),
    id,
    objective,
    condition,
    status: "active",
    createdAt: now,
    updatedAt: now,
    activeMs: 0,
    activeSince: now,
    maxTurns,
    noProgressCap,
    wallClockMinutes,
    ...(input.tokenBudget === undefined
      ? {}
      : { tokenBudget: input.tokenBudget }),
    iterations: 0,
    parentTokens: 0,
    evaluatorTokens: 0,
    noProgressCount: 0,
    evaluatorFailures: 0,
    waitCount: 0,
    ledgerReminderUsed: false,
  });
}

export function normalizeGoalContract(objective: unknown, condition: unknown) {
  const normalizedObjective = normalizeText(objective, "objective", true);
  const normalizedCondition = normalizeText(condition, "condition", true);
  if (
    normalizedObjective.localeCompare(normalizedCondition, "en", {
      sensitivity: "base",
    }) === 0
  ) {
    fail("success condition must be distinct from the objective");
  }
  return {
    objective: normalizedObjective,
    condition: normalizedCondition,
  };
}

export function validateGoalSnapshot(value: unknown): GoalSnapshot {
  if (!isRecord(value)) fail("snapshot must be an object");
  assertExactKeys(value, SNAPSHOT_KEYS, "snapshot");
  if (value.version !== 1)
    fail(`unsupported snapshot version: ${String(value.version)}`);
  assertNonNegativeInteger(value.revision, "snapshot.revision");
  if (
    typeof value.id !== "string" ||
    !/^[A-Za-z0-9_-]{8,100}$/.test(value.id)
  ) {
    fail("snapshot.id is invalid");
  }
  const objective = normalizeText(value.objective, "snapshot.objective", true);
  const condition = normalizeText(value.condition, "snapshot.condition", true);
  if (!GOAL_STATUSES.includes(value.status as GoalStatus)) {
    fail("snapshot.status is invalid");
  }
  const status = value.status as GoalStatus;
  assertTimestamp(value.createdAt, "snapshot.createdAt");
  assertTimestamp(value.updatedAt, "snapshot.updatedAt");
  const createdAt = value.createdAt as number;
  const updatedAt = value.updatedAt as number;
  if (updatedAt < createdAt) fail("snapshot.updatedAt precedes createdAt");
  assertNonNegativeInteger(value.activeMs, "snapshot.activeMs");
  if (ACTIVE_STATUSES.has(status)) {
    assertTimestamp(value.activeSince, "snapshot.activeSince");
    if ((value.activeSince as number) < createdAt)
      fail("snapshot.activeSince precedes createdAt");
  } else if (hasOwn(value, "activeSince")) {
    fail("snapshot.activeSince is only valid while active or waiting");
  }
  assertBoundedPositiveInteger(
    value.maxTurns,
    "snapshot.maxTurns",
    GOAL_LIMITS.maxTurns,
  );
  assertBoundedPositiveInteger(
    value.noProgressCap,
    "snapshot.noProgressCap",
    GOAL_LIMITS.noProgressCap,
  );
  assertPositiveInteger(value.wallClockMinutes, "snapshot.wallClockMinutes");
  if (hasOwn(value, "tokenBudget")) {
    assertPositiveInteger(value.tokenBudget, "snapshot.tokenBudget");
    if ((value.tokenBudget as number) < 1_000)
      fail("snapshot.tokenBudget must be at least 1000");
  }
  for (const key of [
    "iterations",
    "parentTokens",
    "evaluatorTokens",
    "noProgressCount",
    "evaluatorFailures",
    "waitCount",
  ] as const) {
    assertNonNegativeInteger(value[key], `snapshot.${key}`);
  }
  // A malformed historical snapshot must not claim more turns than its cap.
  if ((value.iterations as number) > (value.maxTurns as number))
    fail("snapshot.iterations exceeds maxTurns");
  if (typeof value.ledgerReminderUsed !== "boolean")
    fail("snapshot.ledgerReminderUsed must be boolean");
  const reason = hasOwn(value, "reason")
    ? normalizeText(value.reason, "snapshot.reason", true)
    : undefined;

  const snapshot: GoalSnapshot = {
    version: 1,
    revision: value.revision as number,
    id: value.id,
    objective,
    condition,
    status,
    createdAt,
    updatedAt,
    activeMs: value.activeMs as number,
    ...(ACTIVE_STATUSES.has(status)
      ? { activeSince: value.activeSince as number }
      : {}),
    maxTurns: value.maxTurns as number,
    noProgressCap: value.noProgressCap as number,
    wallClockMinutes: value.wallClockMinutes as number,
    ...(hasOwn(value, "tokenBudget")
      ? { tokenBudget: value.tokenBudget as number }
      : {}),
    iterations: value.iterations as number,
    parentTokens: value.parentTokens as number,
    evaluatorTokens: value.evaluatorTokens as number,
    noProgressCount: value.noProgressCount as number,
    evaluatorFailures: value.evaluatorFailures as number,
    waitCount: value.waitCount as number,
    ledgerReminderUsed: value.ledgerReminderUsed,
    ...(reason === undefined ? {} : { reason }),
  };
  assertSnapshotBytes(snapshot);
  return snapshot;
}

export function restoreGoalSnapshot(
  entries: readonly unknown[],
): GoalSnapshot | undefined {
  const candidates = entries.flatMap((entry, position) => {
    const payload = extractGoalPayload(entry);
    return payload.found ? [{ payload: payload.value, position }] : [];
  });
  if (candidates.length === 0) return undefined;

  let winner:
    | {
        position: number;
        revision: number;
        snapshot?: GoalSnapshot;
        error?: Error;
      }
    | undefined;
  const malformedPositions: number[] = [];

  for (const candidate of candidates) {
    const revision = declaredRevision(candidate.payload);
    let snapshot: GoalSnapshot | undefined;
    let error: Error | undefined;
    try {
      snapshot = validateGoalSnapshot(candidate.payload);
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
      winner = { position: candidate.position, revision, snapshot, error };
    }
  }

  if (!winner)
    throw new GoalRestoreError("goal history contains no ranked snapshot");
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
  return winner.snapshot;
}

export function transitionGoal(
  current: GoalSnapshot,
  status: GoalStatus,
  now: number,
  reason?: string,
) {
  const base = validateGoalSnapshot(current);
  assertTimestamp(now, "now");
  if (now < base.updatedAt) fail("now precedes snapshot.updatedAt");
  const wasRunning = ACTIVE_STATUSES.has(base.status);
  const willRun = ACTIVE_STATUSES.has(status);
  const activeMs =
    wasRunning && !willRun
      ? safeAdd(base.activeMs, now - (base.activeSince as number), "activeMs")
      : base.activeMs;
  const { activeSince: _activeSince, reason: _reason, ...stable } = base;
  return validateGoalSnapshot({
    ...stable,
    revision: increment(base.revision, "revision"),
    status,
    updatedAt: now,
    activeMs,
    ...(willRun ? { activeSince: wasRunning ? base.activeSince : now } : {}),
    ...(reason === undefined
      ? {}
      : { reason: normalizeText(reason, "reason", true) }),
  });
}

export function recordGoalSettlement(
  current: GoalSnapshot,
  parentTokens: number,
  now: number,
) {
  const base = validateGoalSnapshot(current);
  if (!isGoalRunning(base)) fail("only a running goal can settle");
  assertNonNegativeInteger(parentTokens, "parentTokens");
  return validateGoalSnapshot({
    ...base,
    revision: increment(base.revision, "revision"),
    updatedAt: now,
    iterations: increment(base.iterations, "iterations"),
    parentTokens: safeAdd(base.parentTokens, parentTokens, "parentTokens"),
  });
}

export function applyGoalJudge(
  current: GoalSnapshot,
  judge: GoalJudge,
  evaluatorTokens: number,
  now: number,
) {
  const base = validateGoalSnapshot(current);
  assertNonNegativeInteger(evaluatorTokens, "evaluatorTokens");
  if (judge.met) {
    return withEvaluatorTokens(
      transitionGoal(base, "achieved", now, judge.reason),
      evaluatorTokens,
      0,
    );
  }
  if (judge.impossible) {
    return withEvaluatorTokens(
      transitionGoal(base, "impossible", now, judge.reason),
      evaluatorTokens,
      0,
    );
  }
  if (judge.waiting) {
    const waiting = transitionGoal(base, "waiting", now, judge.reason);
    return withEvaluatorTokens(
      validateGoalSnapshot({
        ...waiting,
        waitCount: increment(base.waitCount, "waitCount"),
      }),
      evaluatorTokens,
      0,
    );
  }
  const noProgressCount = judge.progress
    ? 0
    : increment(base.noProgressCount, "noProgressCount");
  const status = noProgressCount >= base.noProgressCap ? "stalled" : "active";
  const judged = transitionGoal(base, status, now, judge.reason);
  return withEvaluatorTokens(
    validateGoalSnapshot({
      ...judged,
      noProgressCount,
      waitCount: judge.progress ? 0 : base.waitCount,
    }),
    evaluatorTokens,
    0,
  );
}

export function recordEvaluatorFailure(current: GoalSnapshot, now: number) {
  const base = validateGoalSnapshot(current);
  const failures = increment(base.evaluatorFailures, "evaluatorFailures");
  const next =
    failures >= 3
      ? transitionGoal(
          base,
          "paused",
          now,
          "Paused after 3 consecutive evaluator failures.",
        )
      : transitionGoal(base, base.status, now, base.reason);
  return validateGoalSnapshot({ ...next, evaluatorFailures: failures });
}

export function markLedgerReminderUsed(current: GoalSnapshot, now: number) {
  const base = validateGoalSnapshot(current);
  if (base.ledgerReminderUsed) return base;
  return validateGoalSnapshot({
    ...base,
    revision: increment(base.revision, "revision"),
    updatedAt: now,
    ledgerReminderUsed: true,
  });
}

export function activeDurationMs(goal: GoalSnapshot, now: number) {
  const checked = validateGoalSnapshot(goal);
  const live = isGoalRunning(checked)
    ? Math.max(0, now - (checked.activeSince as number))
    : 0;
  return checked.activeMs + live;
}

export function hardLimitTransition(goal: GoalSnapshot, now: number) {
  const checked = validateGoalSnapshot(goal);
  if (checked.iterations >= checked.maxTurns) {
    return transitionGoal(
      checked,
      "max_iterations",
      now,
      `Reached the ${checked.maxTurns}-turn limit.`,
    );
  }
  if (
    checked.tokenBudget !== undefined &&
    checked.parentTokens >= checked.tokenBudget
  ) {
    return transitionGoal(
      checked,
      "budget_limited",
      now,
      `Reached the ${checked.tokenBudget}-token parent-run budget.`,
    );
  }
  if (activeDurationMs(checked, now) >= checked.wallClockMinutes * 60_000) {
    return transitionGoal(
      checked,
      "budget_limited",
      now,
      `Reached the ${checked.wallClockMinutes}-minute active wall-clock limit.`,
    );
  }
  return undefined;
}

function withEvaluatorTokens(
  snapshot: GoalSnapshot,
  tokens: number,
  evaluatorFailures: number,
) {
  return validateGoalSnapshot({
    ...snapshot,
    evaluatorTokens: safeAdd(
      snapshot.evaluatorTokens,
      tokens,
      "evaluatorTokens",
    ),
    evaluatorFailures,
  });
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

function normalizeText(value: unknown, path: string, nonBlank: boolean) {
  if (typeof value !== "string") fail(`${path} must be a string`);
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (/\p{Cc}/u.test(normalized))
    fail(`${path} must not contain control characters`);
  const length = Array.from(normalized).length;
  if (nonBlank && length === 0) fail(`${path} must not be blank`);
  if (length > GOAL_LIMITS.textChars)
    fail(`${path} exceeds ${GOAL_LIMITS.textChars} characters`);
  return normalized;
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

function assertTimestamp(value: unknown, path: string) {
  assertNonNegativeInteger(value, path);
}

function assertPositiveInteger(value: unknown, path: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    fail(`${path} must be a positive safe integer`);
}

function assertBoundedPositiveInteger(
  value: unknown,
  path: string,
  maximum: number,
) {
  assertPositiveInteger(value, path);
  if ((value as number) > maximum) fail(`${path} exceeds ${maximum}`);
}

function assertNonNegativeInteger(value: unknown, path: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail(`${path} must be a non-negative safe integer`);
}

function increment(value: number, path: string) {
  return safeAdd(value, 1, path);
}

function safeAdd(left: number, right: number, path: string) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0)
    fail(`${path} exhausted safe integers`);
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(message: string): never {
  throw new GoalValidationError(message);
}
