import {
  isSetupPromptEcho,
  setupDisplayMessage,
  setupPromptParent,
} from "../../../../protocol/prompt-navigation.ts";
import type { WebTurnTiming } from "../../../../protocol/turn-timing.ts";
import type {
  WebLiveMessage,
  WebSnapshot,
} from "../../../../protocol/types.ts";
import type { LiveEntry } from "../../store/web-store.ts";

type PersistedEntry = NonNullable<
  WebSnapshot["selectedSession"]
>["entries"][number];
export interface DisplayEntry {
  compaction?: true;
  forkSnapshotBoundary?: true;
  key: string;
  entryId?: string;
  timingKey?: string;
  ambiguousTimingIdentity?: true;
  timestamp?: string;
  message: WebLiveMessage;
  timing?: WebTurnTiming;
  optimistic?: LiveEntry["optimistic"];
}

function messageIdentity(message: WebLiveMessage) {
  if (message.role === "toolResult" && message.toolCallId)
    return `tool-result-${message.toolCallId}`;
  if (message.timestamp !== undefined)
    return `message-${message.role}-${message.timestamp}`;
  return undefined;
}

function disclosureSignature(message: WebLiveMessage) {
  return ["assistant", "toolResult"].includes(message.role ?? "") &&
    !message.truncation?.truncated
    ? JSON.stringify(message)
    : null;
}

function contentSignature(message: WebLiveMessage) {
  return JSON.stringify([
    message.role,
    message.content,
    (message.parts ?? [])
      .filter((part) => message.role !== "user" || part.type !== "text")
      .map((part) =>
        part.type === "image"
          ? [
              part.type,
              part.mimeType,
              // Pi persists user image data and MIME type without its filename.
              message.role === "user" ? undefined : part.name,
            ]
          : part.type,
      ),
    message.stopReason,
    message.errorMessage,
    message.toolCallId,
  ]);
}

function legacySignature(message: WebLiveMessage) {
  return message.role === "user"
    ? contentSignature(message)
    : JSON.stringify({ ...message, timestamp: undefined });
}

export interface TranscriptPresentationState {
  nativeRowKeys: Map<string, string>;
  ambiguousTimingIds: Set<string>;
}

interface PersistedProjection {
  nativeById: Map<string, PersistedEntry>;
  exactNative: Map<string, PersistedEntry[]>;
  baseEntries: DisplayEntry[];
  indexById: Map<string, number>;
  lookupIndexes: Map<string, number[]>;
  ambiguousNativeIds: string[];
  customIndexes: Map<string, number[]>;
  nativeByIdentity: Map<string, number[]>;
  nativeByLegacySignature: Map<string, number[]>;
  nativeMessages: { identity: string | undefined; signature: string }[];
  promptCandidates: {
    key: string;
    position: number | undefined;
    parentId: string | null | undefined;
    signature: string;
  }[];
  promptsBySignature: Map<string, PersistedProjection["promptCandidates"]>;
  commandInputs: Map<string, string>;
  persistedPositions: Map<string, number>;
}

interface PersistedProjectionCache {
  projection: PersistedProjection;
  length: number;
  head: PersistedEntry | undefined;
  tail: PersistedEntry | undefined;
}

const persistedProjectionCache = new WeakMap<
  readonly PersistedEntry[],
  Map<string | undefined, PersistedProjectionCache>
>();

function persistedTranscriptProjection(
  persisted: readonly PersistedEntry[],
  sessionId: string | undefined,
) {
  let bySession = persistedProjectionCache.get(persisted);
  const cached = bySession?.get(sessionId);
  // Callers sometimes append to the same entries array between renders. The
  // unchanged streaming path keeps that array, so a hit stays independent of
  // history length; a different length or endpoint entry rebuilds.
  if (
    cached &&
    cached.length === persisted.length &&
    cached.head === persisted[0] &&
    cached.tail === persisted[persisted.length - 1]
  )
    return cached.projection;
  const nativeById = new Map(persisted.map((entry) => [entry.id, entry]));
  const exactNative = new Map<string, PersistedEntry[]>();
  for (const entry of persisted) {
    const signature = entry.message && disclosureSignature(entry.message);
    if (!signature) continue;
    const group = exactNative.get(signature) ?? [];
    group.push(entry);
    exactNative.set(signature, group);
  }
  const baseEntries = persisted.flatMap(
    (entry: PersistedEntry): DisplayEntry[] => {
      if (entry.forkSnapshotBoundary)
        return [
          {
            key: entry.id,
            entryId: entry.id,
            timestamp: entry.timestamp,
            forkSnapshotBoundary: true,
            message: { role: "custom", content: "" },
          },
        ];
      if (entry.type === "compaction")
        return [
          {
            key: entry.id,
            entryId: entry.id,
            timestamp: entry.timestamp,
            compaction: true,
            message: { role: "custom", content: "" },
          },
        ];
      if (
        "turnTiming" in entry &&
        entry.turnTiming &&
        entry.turnTiming.sessionId === sessionId
      )
        return [
          {
            key: entry.id,
            timestamp: entry.timestamp,
            timing: entry.turnTiming,
            message: { role: "custom", content: "" },
          },
        ];
      if (entry.type !== "message" || !entry.message) return [];
      const message = setupDisplayMessage(entry.message);
      const parent = setupPromptParent(entry, (id) => nativeById.get(id));
      // The exact command ancestry identifies this episode. Do not collapse
      // separate setup requests merely because their text is the same.
      if (isSetupPromptEcho(entry.message, parent)) return [];
      return [
        {
          // Provider timestamps can repeat across distinct native messages. Live
          // reconciliation and timing remain separate from persisted row identity.
          key: entry.id,
          entryId: entry.id,
          timestamp: entry.timestamp,
          message,
        },
      ];
    },
  );
  const indexById = new Map<string, number>();
  const lookupIndexes = new Map<string, number[]>();
  baseEntries.forEach((entry, index) => {
    if (entry.entryId) indexById.set(entry.entryId, index);
    if (entry.timing || entry.compaction || entry.forkSnapshotBoundary) return;
    const lookup = messageIdentity(entry.message) ?? entry.entryId ?? entry.key;
    const indexes = lookupIndexes.get(lookup) ?? [];
    indexes.push(index);
    lookupIndexes.set(lookup, indexes);
  });
  const ambiguousNativeIds: string[] = [];
  for (const indexes of lookupIndexes.values()) {
    if (indexes.length < 2) continue;
    for (const index of indexes) {
      const id = baseEntries[index]!.entryId;
      if (id) ambiguousNativeIds.push(id);
    }
  }
  const customIndexes = new Map<string, number[]>();
  let customIndex = 0;
  for (const entry of persisted) {
    if (entry.message?.role !== "custom" || entry.message.truncation?.truncated)
      continue;
    const signature = legacySignature(entry.message);
    const indexes = customIndexes.get(signature) ?? [];
    indexes.push(customIndex);
    customIndexes.set(signature, indexes);
    customIndex++;
  }
  const nativeMessages = baseEntries.map((entry) => ({
    identity: messageIdentity(entry.message),
    signature: legacySignature(entry.message),
  }));
  const nativeByIdentity = new Map<string, number[]>();
  const nativeByLegacySignature = new Map<string, number[]>();
  nativeMessages.forEach((candidate, index) => {
    // A live message with no timestamp still matches one native payload by
    // legacy signature, including a native message that does have an identity.
    const legacyIndexes =
      nativeByLegacySignature.get(candidate.signature) ?? [];
    legacyIndexes.push(index);
    nativeByLegacySignature.set(candidate.signature, legacyIndexes);
    if (candidate.identity === undefined) return;
    const indexes = nativeByIdentity.get(candidate.identity) ?? [];
    indexes.push(index);
    nativeByIdentity.set(candidate.identity, indexes);
  });
  const persistedPositions = new Map(
    persisted.map((entry, index) => [entry.id, index]),
  );
  const promptCandidates = baseEntries
    .filter((entry) => entry.message.role === "user")
    .map((entry) => ({
      key: entry.entryId ?? entry.key,
      position: persistedPositions.get(entry.entryId ?? entry.key),
      parentId: nativeById.get(entry.entryId ?? entry.key)?.parentId,
      signature: contentSignature(entry.message),
    }));
  const promptsBySignature = new Map<
    string,
    PersistedProjection["promptCandidates"]
  >();
  for (const candidate of promptCandidates) {
    const group = promptsBySignature.get(candidate.signature) ?? [];
    group.push(candidate);
    promptsBySignature.set(candidate.signature, group);
  }
  const commandInputs = new Map(
    baseEntries.flatMap((entry) =>
      entry.message.role === "user" &&
      entry.message.customType === "openpi-web-command-input" &&
      entry.message.commandId
        ? [[entry.message.commandId, entry.entryId ?? entry.key] as const]
        : [],
    ),
  );
  const projection: PersistedProjection = {
    nativeById,
    exactNative,
    baseEntries,
    indexById,
    lookupIndexes,
    ambiguousNativeIds,
    customIndexes,
    nativeByIdentity,
    nativeByLegacySignature,
    nativeMessages,
    promptCandidates,
    promptsBySignature,
    commandInputs,
    persistedPositions,
  };
  if (!bySession) {
    bySession = new Map();
    persistedProjectionCache.set(persisted, bySession);
  }
  bySession.set(sessionId, {
    projection,
    length: persisted.length,
    head: persisted[0],
    tail: persisted[persisted.length - 1],
  });
  return projection;
}

function firstUnmatched(indexes: number[] | undefined, matched: Set<number>) {
  if (!indexes) return -1;
  for (const index of indexes) if (!matched.has(index)) return index;
  return -1;
}

export function displayedThinkingDuration(
  entry: DisplayEntry,
  durations: Record<string, number>,
) {
  const keys = [
    entry.timingKey,
    entry.key,
    entry.entryId,
    entry.ambiguousTimingIdentity ? undefined : messageIdentity(entry.message),
  ];
  for (const key of keys) {
    if (!key) continue;
    const duration = durations[key];
    if (duration !== undefined) return duration;
  }
  return undefined;
}

export function buildEntries(
  snapshot: WebSnapshot,
  liveMessages: LiveEntry[],
  presentation: TranscriptPresentationState,
) {
  const { nativeRowKeys, ambiguousTimingIds } = presentation;
  const selected = snapshot.selectedSession;
  const persisted = selected?.entries ?? [];
  const projection = persistedTranscriptProjection(persisted, selected?.id);
  for (const id of nativeRowKeys.keys())
    if (!projection.nativeById.has(id)) nativeRowKeys.delete(id);
  for (const id of ambiguousTimingIds)
    if (!projection.nativeById.has(id)) ambiguousTimingIds.delete(id);
  // Native IDs own historic rows. A live disclosure can keep its existing DOM
  // only when both sides contain exactly one complete, equal projected payload.
  const exactLive = new Map<string, LiveEntry[]>();
  for (const live of liveMessages) {
    if (live.optimistic) continue;
    const signature = disclosureSignature(live.message);
    if (!signature) continue;
    const group = exactLive.get(signature) ?? [];
    group.push(live);
    exactLive.set(signature, group);
  }
  const aliasedKeys = new Set(nativeRowKeys.values());
  for (const [signature, live] of exactLive) {
    const native = projection.exactNative.get(signature);
    if (native?.length !== 1 || live.length !== 1) continue;
    const id = native[0]!.id;
    const key = live[0]!.key;
    if (
      nativeRowKeys.has(id) ||
      ambiguousTimingIds.has(id) ||
      aliasedKeys.has(key) ||
      projection.nativeById.has(key)
    )
      continue;
    nativeRowKeys.set(id, key);
    aliasedKeys.add(key);
  }
  for (const id of projection.ambiguousNativeIds) ambiguousTimingIds.add(id);
  const timingAt = new Map<number, string | null>();
  const ambiguousLiveTiming = new Set<string>();
  for (const live of liveMessages) {
    const lookup = messageIdentity(live.message) ?? live.key;
    const indexes = projection.lookupIndexes.get(lookup);
    if (!indexes) continue;
    // Provider timestamps can repeat; timing must follow the same payload
    // qualification as native/live message reconciliation.
    const signature = legacySignature(live.message);
    const matches = indexes.filter(
      (index) => projection.nativeMessages[index]?.signature === signature,
    );
    if (matches.length !== indexes.length || indexes.length > 1)
      ambiguousLiveTiming.add(lookup);
    if (matches.length === 1) {
      const index = matches[0]!;
      const id = projection.baseEntries[index]!.entryId;
      const establishedKey = id ? nativeRowKeys.get(id) : undefined;
      if (
        (establishedKey && establishedKey !== live.key) ||
        (id && ambiguousTimingIds.has(id) && !establishedKey && live.key !== id)
      ) {
        ambiguousLiveTiming.add(lookup);
        continue;
      }
      const previous = timingAt.get(index);
      if (previous === undefined || previous === live.key)
        timingAt.set(index, live.key);
      else {
        // Equal payloads still cannot identify which live message owns timing.
        timingAt.set(index, null);
        ambiguousLiveTiming.add(lookup);
      }
    }
  }
  for (const identity of ambiguousLiveTiming)
    for (const index of projection.lookupIndexes.get(identity) ?? []) {
      const id = projection.baseEntries[index]!.entryId;
      if (id) ambiguousTimingIds.add(id);
    }
  const acknowledgedPrompts = new Set(
    liveMessages.flatMap((entry) =>
      entry.optimistic?.projectedEntryId
        ? [entry.optimistic.projectedEntryId]
        : [],
    ),
  );
  const projectedPrompts: { key: string; entryId: string }[] = [];
  const pendingPrompts: DisplayEntry[] = [];
  const execution =
    snapshot.selectedExecution?.sessionId === selected?.id &&
    snapshot.selectedExecution?.sessionPath === selected?.path
      ? snapshot.selectedExecution
      : undefined;
  const queued = execution?.pendingFollowUps ?? 0;
  const mergeLimit = Math.max(
    0,
    liveMessages.filter(
      (entry) =>
        entry.optimistic?.admitted &&
        !entry.optimistic.projectedEntryId &&
        !projection.commandInputs.has(entry.optimistic.commandId),
    ).length - queued,
  );
  let mergedRegularPrompts = 0;
  const suppressedLiveUsers = new Set<string>();
  const matchedCustomMessages = new Set<number>();
  const matchedMessages = new Set<number>();
  const appended: DisplayEntry[] = [];
  for (const live of liveMessages) {
    if (live.optimistic?.projectedEntryId) continue;
    if (live.message.role === "custom" && !live.message.truncation?.truncated) {
      const signature = legacySignature(live.message);
      const match = firstUnmatched(
        projection.customIndexes.get(signature),
        matchedCustomMessages,
      );
      if (match >= 0) {
        matchedCustomMessages.add(match);
        continue;
      }
    }
    const commandId =
      live.optimistic?.commandId ??
      (live.key.startsWith("optimistic-")
        ? live.key.slice("optimistic-".length)
        : undefined);
    const commandEntry = commandId
      ? projection.commandInputs.get(commandId)
      : undefined;
    if (commandEntry) {
      if (live.optimistic)
        projectedPrompts.push({ key: live.key, entryId: commandEntry });
      continue;
    }
    const message = setupDisplayMessage(live.message);
    if (message.role === "user" && live.optimistic) {
      // This only merges duplicate presentation; it is not a delivery receipt.
      const after =
        live.optimistic.afterEntryId === null
          ? -1
          : projection.persistedPositions.get(live.optimistic.afterEntryId);
      const acknowledgement =
        !live.optimistic.admitted || mergedRegularPrompts >= mergeLimit
          ? undefined
          : projection.promptsBySignature
              .get(contentSignature(message))
              ?.find(
                (entry) =>
                  entry.position !== undefined &&
                  (after !== undefined
                    ? entry.position > after
                    : entry.parentId === live.optimistic?.afterEntryId) &&
                  !acknowledgedPrompts.has(entry.key),
              );
      if (acknowledgement) {
        acknowledgedPrompts.add(acknowledgement.key);
        projectedPrompts.push({ key: live.key, entryId: acknowledgement.key });
        mergedRegularPrompts++;
        continue;
      }
    } else {
      const admission =
        message.role === "user"
          ? liveMessages.find(
              (pending) =>
                pending.optimistic?.admitted &&
                !pending.optimistic.projectedEntryId &&
                !suppressedLiveUsers.has(pending.key) &&
                !projectedPrompts.some((pair) => pair.key === pending.key) &&
                pending.optimistic.sessionId === selected?.id &&
                pending.optimistic.sessionPath === selected?.path &&
                contentSignature(setupDisplayMessage(pending.message)) ===
                  contentSignature(message),
            )
          : undefined;
      if (admission) {
        suppressedLiveUsers.add(admission.key);
        continue;
      }
      const identity = messageIdentity(message);
      const legacy = legacySignature(message);
      const match =
        identity === undefined
          ? firstUnmatched(
              projection.nativeByLegacySignature.get(legacy),
              matchedMessages,
            )
          : ((projection.nativeByIdentity.get(identity) ?? []).find(
              (index) =>
                !matchedMessages.has(index) &&
                projection.nativeMessages[index]?.signature === legacy,
            ) ?? -1);
      if (match >= 0) {
        matchedMessages.add(match);
        continue;
      }
    }
    const next: DisplayEntry = {
      key: live.key,
      timingKey: live.key,
      ambiguousTimingIdentity: ambiguousLiveTiming.has(
        messageIdentity(message) ?? live.key,
      )
        ? true
        : undefined,
      timestamp: live.timestamp ?? new Date().toISOString(),
      message,
      optimistic: live.optimistic,
    };
    if (message.role === "user" && live.optimistic) pendingPrompts.push(next);
    else appended.push(next);
  }
  const queueCounts = new Map<string, number>();
  for (const message of execution?.queuedMessages ?? [])
    queueCounts.set(message, (queueCounts.get(message) ?? 0) + 1);
  const visiblePending = pendingPrompts.filter((entry) => {
    if (
      !entry.optimistic?.admitted ||
      entry.optimistic.commandId === execution?.activeTurn?.commandId
    )
      return true;
    const count = queueCounts.get(entry.message.content) ?? 0;
    if (!count) return true;
    queueCounts.set(entry.message.content, count - 1);
    return false;
  });
  // The existing projection receipt also keeps the user row's presentation
  // identity stable while its optimistic input becomes a native Session entry.
  // Native entry IDs, order and action targets remain canonical.
  const promptKeys = new Map(
    liveMessages.flatMap((live) =>
      live.optimistic?.projectedEntryId
        ? [[live.optimistic.projectedEntryId, live.key] as const]
        : [],
    ),
  );
  for (const pair of projectedPrompts) promptKeys.set(pair.entryId, pair.key);
  let persistedRows = projection.baseEntries;
  const rewrite = (index: number, entry: DisplayEntry) => {
    if (persistedRows === projection.baseEntries)
      persistedRows = projection.baseEntries.slice();
    persistedRows[index] = entry;
  };
  for (const id of ambiguousTimingIds) {
    const index = projection.indexById.get(id);
    if (index === undefined) continue;
    const current = persistedRows[index];
    if (!current || current.ambiguousTimingIdentity) continue;
    rewrite(index, { ...current, ambiguousTimingIdentity: true });
  }
  for (const [index, timingKey] of timingAt) {
    if (timingKey === null) continue;
    const current = persistedRows[index];
    if (!current || current.timingKey === timingKey) continue;
    rewrite(index, { ...current, timingKey });
  }
  for (const [id, key] of nativeRowKeys) {
    const index = projection.indexById.get(id);
    if (index === undefined) continue;
    const current = persistedRows[index];
    if (!current || current.key === key) continue;
    rewrite(index, { ...current, key });
  }
  for (const [entryId, key] of promptKeys) {
    const index = projection.indexById.get(entryId);
    if (index === undefined) continue;
    const current = persistedRows[index];
    if (!current || current.key === key) continue;
    rewrite(index, { ...current, key });
  }
  return {
    entries: persistedRows.concat(appended, visiblePending),
    projectedPrompts,
  };
}
