export const LEDGER_ENTRY_TYPE = "task-ledger";
export const LEDGER_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "done",
  "dropped",
] as const;

export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export interface LedgerItem {
  id: number;
  subject: string;
  detail?: string;
  status: LedgerStatus;
  note?: string;
}

export interface LedgerSnapshot {
  version: 1;
  revision: number;
  nextId: number;
  items: LedgerItem[];
}

export interface LedgerAddInput {
  subject: string;
  detail?: string;
  status?: LedgerStatus;
  note?: string;
}

export interface LedgerUpdateInput {
  id: number;
  subject?: string;
  detail?: string | null;
  status?: LedgerStatus;
  note?: string | null;
}

export interface LedgerFilter {
  id?: number;
  status?: LedgerStatus;
}

export interface LedgerMutation {
  snapshot: LedgerSnapshot;
  items: LedgerItem[];
}

export const LEDGER_LIMITS = Object.freeze({
  subjectChars: 120,
  detailChars: 500,
  noteChars: 500,
  items: 100,
  addBatch: 20,
  snapshotBytes: 16_384,
  projectionChars: 800,
  renderedListChars: 16_384,
});

const REQUIRED_NOTE_STATUSES = new Set<LedgerStatus>([
  "blocked",
  "done",
  "dropped",
]);
const SNAPSHOT_KEYS = new Set(["version", "revision", "nextId", "items"]);
const ITEM_KEYS = new Set(["id", "subject", "detail", "status", "note"]);
const ADD_KEYS = new Set(["subject", "detail", "status", "note"]);
const UPDATE_KEYS = new Set(["id", "subject", "detail", "status", "note"]);
const PROJECTION_HEADER =
  "Session ledger: advisory context, not an instruction to resume unrelated work. " +
  "Real files, git, tests, tools, artifacts, and user confirmation are truth. " +
  "Use ledger_list for details. After compaction/pivot, coordinate with this ledger instead of recreating items.";

export class LedgerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerValidationError";
  }
}

export class LedgerRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerRestoreError";
  }
}

export interface SessionLedger {
  add(input: LedgerAddInput | readonly LedgerAddInput[]): LedgerMutation;
  update(input: LedgerUpdateInput): LedgerMutation;
  list(filter?: LedgerFilter): LedgerItem[];
  snapshot(): LedgerSnapshot;
  project(): string;
  render(filter?: LedgerFilter, maxChars?: number): string;
  commit(snapshot: LedgerSnapshot): void;
}

export function emptyLedgerSnapshot(): LedgerSnapshot {
  return { version: 1, revision: 0, nextId: 1, items: [] };
}

export function validateLedgerSnapshot(value: unknown): LedgerSnapshot {
  if (!isRecord(value)) fail("snapshot must be an object");
  assertExactKeys(value, SNAPSHOT_KEYS, "snapshot");
  if (value.version !== 1)
    fail(`unsupported snapshot version: ${String(value.version)}`);
  assertNonNegativeInteger(value.revision, "snapshot.revision");
  assertPositiveInteger(value.nextId, "snapshot.nextId");
  if (!Array.isArray(value.items)) fail("snapshot.items must be an array");
  if (value.items.length > LEDGER_LIMITS.items) {
    fail(`snapshot.items exceeds ${LEDGER_LIMITS.items}`);
  }

  const ids = new Set<number>();
  const items = value.items.map((item, index) => {
    const checked = validateItem(item, `snapshot.items[${index}]`);
    if (ids.has(checked.id)) fail(`duplicate ledger id: ${checked.id}`);
    ids.add(checked.id);
    return checked;
  });
  const nextId = value.nextId as number;
  if (items.some((item) => item.id >= nextId)) {
    fail("snapshot.nextId must be greater than every item id");
  }
  const snapshot: LedgerSnapshot = {
    version: 1,
    revision: value.revision as number,
    nextId,
    items,
  };
  assertSnapshotBytes(snapshot);
  return snapshot;
}

export function applyLedgerAdd(
  current: LedgerSnapshot,
  additions: readonly LedgerAddInput[],
): LedgerMutation {
  const base = validateLedgerSnapshot(current);
  if (additions.length < 1) fail("add requires at least one item");
  if (additions.length > LEDGER_LIMITS.addBatch) {
    fail(`add batch exceeds ${LEDGER_LIMITS.addBatch}`);
  }
  if (base.items.length + additions.length > LEDGER_LIMITS.items) {
    fail(`ledger exceeds ${LEDGER_LIMITS.items} items`);
  }

  let nextId = base.nextId;
  const added = additions.map((addition, index) => {
    if (!isRecord(addition)) fail(`additions[${index}] must be an object`);
    assertExactKeys(addition, ADD_KEYS, `additions[${index}]`);
    assertPositiveInteger(nextId, "allocated id");
    const item = validateItem(
      {
        id: nextId,
        subject: addition.subject,
        ...(hasOwn(addition, "detail") ? { detail: addition.detail } : {}),
        status: addition.status ?? "pending",
        ...(hasOwn(addition, "note") ? { note: addition.note } : {}),
      },
      `additions[${index}]`,
    );
    nextId += 1;
    return item;
  });

  const candidate = validateLedgerSnapshot({
    version: 1,
    revision: increment(base.revision, "snapshot revision"),
    nextId,
    items: [...base.items, ...added],
  });
  return { snapshot: candidate, items: cloneItems(added) };
}

export function applyLedgerUpdate(
  current: LedgerSnapshot,
  update: LedgerUpdateInput,
): LedgerMutation {
  const base = validateLedgerSnapshot(current);
  if (!isRecord(update)) fail("update must be an object");
  assertExactKeys(update, UPDATE_KEYS, "update");
  assertPositiveInteger(update.id, "update.id");
  if (Object.keys(update).length === 1)
    fail("update must change at least one field");

  const index = base.items.findIndex((item) => item.id === update.id);
  if (index < 0) fail(`ledger item T${update.id} does not exist`);
  const previous = base.items[index];
  const status = hasOwn(update, "status")
    ? validateStatus(update.status, "update.status")
    : previous.status;
  const statusChanged = status !== previous.status;
  const entersRequiredNote =
    statusChanged && REQUIRED_NOTE_STATUSES.has(status);

  if (entersRequiredNote && !hasOwn(update, "note")) {
    fail(`a fresh note is required when status changes to ${status}`);
  }

  let note = previous.note;
  if (statusChanged && REQUIRED_NOTE_STATUSES.has(previous.status))
    note = undefined;
  if (hasOwn(update, "note")) note = update.note ?? undefined;

  const changed = validateItem(
    {
      id: previous.id,
      subject: hasOwn(update, "subject") ? update.subject : previous.subject,
      ...(hasOwn(update, "detail")
        ? update.detail === null
          ? {}
          : { detail: update.detail }
        : previous.detail === undefined
          ? {}
          : { detail: previous.detail }),
      status,
      ...(note === undefined ? {} : { note }),
    },
    "updated item",
  );
  if (
    changed.subject === previous.subject &&
    changed.detail === previous.detail &&
    changed.status === previous.status &&
    changed.note === previous.note
  ) {
    fail(`update does not change T${update.id}`);
  }

  const items = base.items.slice();
  items[index] = changed;
  const candidate = validateLedgerSnapshot({
    version: 1,
    revision: increment(base.revision, "snapshot revision"),
    nextId: base.nextId,
    items,
  });
  return { snapshot: candidate, items: cloneItems([changed]) };
}

export function restoreLedgerSnapshot(
  entries: readonly unknown[],
): LedgerSnapshot {
  const candidates = entries.flatMap((entry, position) => {
    const payload = extractLedgerPayload(entry);
    return payload.found ? [{ payload: payload.value, position }] : [];
  });
  if (candidates.length === 0) return emptyLedgerSnapshot();

  let winner:
    | {
        position: number;
        revision: number;
        snapshot?: LedgerSnapshot;
        error?: Error;
      }
    | undefined;
  const unknownVersions: number[] = [];
  const unrankedMalformed: number[] = [];
  let nextIdHighWater = 1;

  for (const candidate of candidates) {
    const revision = declaredRevision(candidate.payload);
    const version = declaredVersion(candidate.payload);
    const unknownVersion = version !== undefined && version !== 1;
    if (unknownVersion) unknownVersions.push(candidate.position);

    let snapshot: LedgerSnapshot | undefined;
    let error: Error | undefined;
    if (unknownVersion) {
      error = new LedgerRestoreError(
        `unsupported snapshot version: ${String(version)}`,
      );
    } else {
      try {
        snapshot = validateLedgerSnapshot(candidate.payload);
        nextIdHighWater = Math.max(nextIdHighWater, snapshot.nextId);
      } catch (caught) {
        error = caught instanceof Error ? caught : new Error(String(caught));
      }
    }
    if (revision === undefined) {
      unrankedMalformed.push(candidate.position);
      continue;
    }
    if (
      !winner ||
      revision > winner.revision ||
      (revision === winner.revision && candidate.position > winner.position)
    ) {
      winner = { position: candidate.position, revision, snapshot, error };
    }
  }

  if (!winner) {
    throw new LedgerRestoreError(
      "ledger history contains no restorable snapshot",
    );
  }
  if (
    unknownVersions.some((position) => position > winner.position) ||
    unrankedMalformed.some((position) => position > winner.position)
  ) {
    throw new LedgerRestoreError(
      "a later unknown or malformed ledger entry locks restoration",
    );
  }
  if (!winner.snapshot) {
    throw new LedgerRestoreError(
      `winning ledger revision ${winner.revision} is malformed: ${winner.error?.message ?? "invalid snapshot"}`,
    );
  }

  const maxId = winner.snapshot.items.reduce(
    (maximum, item) => Math.max(maximum, item.id),
    0,
  );
  const nextId = Math.max(
    nextIdHighWater,
    winner.snapshot.nextId,
    increment(maxId, "item id"),
  );
  return validateLedgerSnapshot({ ...winner.snapshot, nextId });
}

export function projectLedger(snapshot: LedgerSnapshot): string {
  const checked = validateLedgerSnapshot(snapshot);
  const rank: Record<LedgerStatus, number> = {
    in_progress: 0,
    blocked: 1,
    pending: 2,
    done: 3,
    dropped: 4,
  };
  const actionable = checked.items
    .filter((item) => rank[item.status] < 3)
    .sort((left, right) => rank[left.status] - rank[right.status]);
  if (actionable.length === 0) return "";

  let output = PROJECTION_HEADER;
  for (const item of actionable) {
    const line = `\nT${item.id} [${item.status}] ${singleLine(item.subject)}`;
    if (charCount(output + line) > LEDGER_LIMITS.projectionChars) break;
    output += line;
  }
  return takeChars(output, LEDGER_LIMITS.projectionChars);
}

export function listLedgerItems(
  snapshot: LedgerSnapshot,
  filter: LedgerFilter = {},
): LedgerItem[] {
  const checked = validateLedgerSnapshot(snapshot);
  validateFilter(filter);
  return cloneItems(
    checked.items.filter(
      (item) =>
        (filter.id === undefined || item.id === filter.id) &&
        (filter.status === undefined || item.status === filter.status),
    ),
  );
}

export function renderLedgerList(
  snapshot: LedgerSnapshot,
  filter: LedgerFilter = {},
  maxChars: number = LEDGER_LIMITS.renderedListChars,
): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    fail("maxChars must be a positive safe integer");
  }
  const bound = Math.min(maxChars, LEDGER_LIMITS.renderedListChars);
  const items = listLedgerItems(snapshot, filter);
  const text =
    items.length === 0
      ? "No ledger items."
      : items
          .map((item) => {
            const lines = [
              `T${item.id} [${item.status}] ${singleLine(item.subject)}`,
            ];
            if (item.detail !== undefined)
              lines.push(`  detail: ${singleLine(item.detail)}`);
            if (item.note !== undefined)
              lines.push(`  note: ${singleLine(item.note)}`);
            return lines.join("\n");
          })
          .join("\n");
  return takeChars(text, bound);
}

export function createSessionLedger(
  initial: LedgerSnapshot = emptyLedgerSnapshot(),
): SessionLedger {
  let current = cloneSnapshot(validateLedgerSnapshot(initial));
  return {
    add(input) {
      const additions = Array.isArray(input) ? input : [input];
      return cloneMutation(applyLedgerAdd(current, additions));
    },
    update(input) {
      return cloneMutation(applyLedgerUpdate(current, input));
    },
    list(filter) {
      return listLedgerItems(current, filter);
    },
    snapshot() {
      return cloneSnapshot(current);
    },
    project() {
      return projectLedger(current);
    },
    render(filter, maxChars) {
      return renderLedgerList(current, filter, maxChars);
    },
    commit(snapshot) {
      current = cloneSnapshot(validateLedgerSnapshot(snapshot));
    },
  };
}

function validateItem(value: unknown, path: string): LedgerItem {
  if (!isRecord(value)) fail(`${path} must be an object`);
  assertExactKeys(value, ITEM_KEYS, path);
  assertPositiveInteger(value.id, `${path}.id`);
  assertText(
    value.subject,
    `${path}.subject`,
    LEDGER_LIMITS.subjectChars,
    true,
  );
  const status = validateStatus(value.status, `${path}.status`);
  if (hasOwn(value, "detail")) {
    assertText(
      value.detail,
      `${path}.detail`,
      LEDGER_LIMITS.detailChars,
      false,
    );
  }
  if (hasOwn(value, "note")) {
    assertText(value.note, `${path}.note`, LEDGER_LIMITS.noteChars, true);
  }
  if (REQUIRED_NOTE_STATUSES.has(status) && !hasOwn(value, "note")) {
    fail(`${path}.note is required for ${status}`);
  }
  return {
    id: value.id as number,
    subject: value.subject as string,
    ...(hasOwn(value, "detail") ? { detail: value.detail as string } : {}),
    status,
    ...(hasOwn(value, "note") ? { note: value.note as string } : {}),
  };
}

function validateStatus(value: unknown, path: string): LedgerStatus {
  if (!LEDGER_STATUSES.includes(value as LedgerStatus)) {
    fail(`${path} must be a valid ledger status`);
  }
  return value as LedgerStatus;
}

function validateFilter(filter: LedgerFilter) {
  if (!isRecord(filter)) fail("filter must be an object");
  assertExactKeys(filter, new Set(["id", "status"]), "filter");
  if (filter.id !== undefined) assertPositiveInteger(filter.id, "filter.id");
  if (filter.status !== undefined)
    validateStatus(filter.status, "filter.status");
}

function extractLedgerPayload(entry: unknown): {
  found: boolean;
  value?: unknown;
} {
  if (!isRecord(entry)) return { found: false };
  if (
    hasOwn(entry, "version") ||
    (hasOwn(entry, "revision") && hasOwn(entry, "items"))
  ) {
    return { found: true, value: entry };
  }
  if (hasOwn(entry, "snapshot")) {
    if (
      entry.type === undefined ||
      entry.type === LEDGER_ENTRY_TYPE ||
      entry.customType === LEDGER_ENTRY_TYPE
    ) {
      return { found: true, value: entry.snapshot };
    }
  }
  const isLedgerEnvelope =
    entry.type === LEDGER_ENTRY_TYPE ||
    entry.customType === LEDGER_ENTRY_TYPE ||
    (entry.type === "custom" && entry.customType === LEDGER_ENTRY_TYPE);
  if (isLedgerEnvelope && hasOwn(entry, "data")) {
    return { found: true, value: entry.data };
  }
  return { found: false };
}

function declaredRevision(value: unknown) {
  if (!isRecord(value)) return undefined;
  return Number.isSafeInteger(value.revision) && (value.revision as number) >= 0
    ? (value.revision as number)
    : undefined;
}

function declaredVersion(value: unknown) {
  if (!isRecord(value) || !hasOwn(value, "version")) return undefined;
  return value.version;
}

function assertSnapshotBytes(snapshot: LedgerSnapshot) {
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  if (bytes > LEDGER_LIMITS.snapshotBytes) {
    fail(
      `serialized snapshot exceeds ${LEDGER_LIMITS.snapshotBytes} UTF-8 bytes`,
    );
  }
}

function assertText(
  value: unknown,
  path: string,
  maxChars: number,
  requireNonBlank: boolean,
) {
  if (typeof value !== "string") fail(`${path} must be a string`);
  if (/\p{Cc}/u.test(value))
    fail(`${path} must not contain control characters`);
  if (charCount(value) > maxChars)
    fail(`${path} exceeds ${maxChars} characters`);
  if (requireNonBlank && value.trim().length === 0)
    fail(`${path} must not be blank`);
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

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path} contains unknown field: ${key}`);
  }
}

function increment(value: number, path: string) {
  const next = value + 1;
  if (!Number.isSafeInteger(next)) fail(`${path} exhausted safe integers`);
  return next;
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

function charCount(value: string) {
  return Array.from(value).length;
}

function takeChars(value: string, maximum: number) {
  const characters = Array.from(value);
  if (characters.length <= maximum) return value;
  if (maximum === 1) return "…";
  return characters.slice(0, maximum - 1).join("") + "…";
}

function singleLine(value: string) {
  return value.replace(/\s+/gu, " ").trim();
}

function cloneItems(items: readonly LedgerItem[]) {
  return items.map((item) => ({ ...item }));
}

function cloneSnapshot(snapshot: LedgerSnapshot): LedgerSnapshot {
  return { ...snapshot, items: cloneItems(snapshot.items) };
}

function cloneMutation(mutation: LedgerMutation): LedgerMutation {
  return {
    snapshot: cloneSnapshot(mutation.snapshot),
    items: cloneItems(mutation.items),
  };
}

function fail(message: string): never {
  throw new LedgerValidationError(message);
}
