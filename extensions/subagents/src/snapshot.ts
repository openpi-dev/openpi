import type {
  LiveToolState,
  QueuedMessage,
  SubagentMeta,
  SubagentSnapshot,
  SubagentSnapshotProjection,
  TranscriptItem,
  TranscriptPart,
} from "./domain.ts";

/** Aggregate UTF-8 budget for the in-memory subagent read model. */
export const DEFAULT_SUBAGENT_SNAPSHOT_MAX_BYTES = 256 * 1024;

const OMIT_MARKER = "\n[... omitted ...]\n";
const CORE_TEXT_BYTES = 512;
const DISPLAY_ITEM_BYTES = 4 * 1024;
const MAX_TRANSCRIPT_PARTS = 32;
const MAX_META_TEXT_BYTES = 2 * 1024;

interface TrimmedText {
  readonly text: string;
  readonly omittedBytes: number;
}

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

/** Return a valid UTF-8 prefix without splitting a code point. */
export function truncateUtf8Head(value: string, maxBytes: number) {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0) {
    const candidate = bytes.subarray(0, end).toString("utf8");
    if (byteLength(candidate) === end) return candidate;
    end--;
  }
  return "";
}

/** Return a valid UTF-8 suffix without splitting a code point. */
export function truncateUtf8Tail(value: string, maxBytes: number) {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  while (start < bytes.length) {
    const candidate = bytes.subarray(start).toString("utf8");
    if (byteLength(candidate) === bytes.length - start) return candidate;
    start++;
  }
  return "";
}

/** Trim by serialized UTF-8 bytes while retaining both ends of long text. */
function trimText(value: string, maxBytes: number): TrimmedText {
  const originalBytes = byteLength(value);
  if (originalBytes <= maxBytes) return { text: value, omittedBytes: 0 };
  if (maxBytes <= 0) return { text: "", omittedBytes: originalBytes };

  const markerBytes = byteLength(OMIT_MARKER);
  if (maxBytes <= markerBytes) {
    const text = truncateUtf8Head(value, maxBytes);
    return { text, omittedBytes: originalBytes - byteLength(text) };
  }

  const bodyBytes = maxBytes - markerBytes;
  let headBytes = Math.ceil(bodyBytes / 2);
  let tailBytes = Math.floor(bodyBytes / 2);
  let text = `${truncateUtf8Head(value, headBytes)}${OMIT_MARKER}${truncateUtf8Tail(value, tailBytes)}`;
  while (byteLength(text) > maxBytes && (headBytes > 0 || tailBytes > 0)) {
    if (headBytes >= tailBytes && headBytes > 0) headBytes--;
    else if (tailBytes > 0) tailBytes--;
    text = `${truncateUtf8Head(value, headBytes)}${OMIT_MARKER}${truncateUtf8Tail(value, tailBytes)}`;
  }
  return { text, omittedBytes: originalBytes - byteLength(text) };
}

function jsonBytes(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined)
    throw new Error("Subagent snapshot is not serializable");
  return byteLength(serialized);
}

function compactMeta(meta: SubagentMeta | undefined) {
  const source = meta ?? { backend: "pi" as const };
  const model = source.modelLabel
    ? trimText(source.modelLabel, MAX_META_TEXT_BYTES)
    : undefined;
  const sessionFilePath = source.sessionFilePath
    ? trimText(source.sessionFilePath, MAX_META_TEXT_BYTES)
    : undefined;
  return {
    meta: {
      backend: source.backend,
      ...(model ? { modelLabel: model.text } : {}),
      ...(source.contextWindow !== undefined
        ? { contextWindow: source.contextWindow }
        : {}),
      ...(sessionFilePath ? { sessionFilePath: sessionFilePath.text } : {}),
    } satisfies SubagentMeta,
    omittedBytes:
      (model?.omittedBytes ?? 0) + (sessionFilePath?.omittedBytes ?? 0),
  };
}

function compactPart(part: TranscriptPart, maxBytes: number) {
  if (part.type === "toolCall") {
    const toolId = trimText(part.toolId, CORE_TEXT_BYTES);
    const name = trimText(part.name, CORE_TEXT_BYTES);
    const args = part.argsPreview
      ? trimText(part.argsPreview, maxBytes)
      : undefined;
    return {
      part: {
        type: "toolCall" as const,
        toolId: toolId.text,
        name: name.text,
        ...(args ? { argsPreview: args.text } : {}),
      },
      omittedBytes:
        toolId.omittedBytes + name.omittedBytes + (args?.omittedBytes ?? 0),
    } as const;
  }
  const text = trimText(part.text, maxBytes);
  return {
    part: {
      type: part.type,
      text: text.text,
      ...(part.type === "thinking" && part.redacted !== undefined
        ? { redacted: part.redacted }
        : {}),
    },
    omittedBytes: text.omittedBytes,
  } as const;
}

function compactTranscriptItem(item: TranscriptItem, maxBytes: number) {
  if (item.kind === "user") {
    const text = trimText(item.text, maxBytes);
    return {
      item: { kind: "user" as const, text: text.text },
      omittedBytes: text.omittedBytes,
    } as const;
  }
  if (item.kind === "toolResult") {
    const toolId = trimText(item.toolId, CORE_TEXT_BYTES);
    const name = trimText(item.name, CORE_TEXT_BYTES);
    const output = item.outputPreview
      ? trimText(item.outputPreview, maxBytes)
      : undefined;
    return {
      item: {
        kind: "toolResult" as const,
        toolId: toolId.text,
        name: name.text,
        isError: item.isError,
        ...(output ? { outputPreview: output.text } : {}),
      },
      omittedBytes:
        toolId.omittedBytes + name.omittedBytes + (output?.omittedBytes ?? 0),
    } as const;
  }

  const sourceParts = item.parts;
  const partBudget = Math.max(
    1,
    Math.floor(
      maxBytes /
        Math.max(1, Math.min(sourceParts.length, MAX_TRANSCRIPT_PARTS)),
    ),
  );
  let parts = sourceParts.map((part) => compactPart(part, partBudget));
  let omittedBytes = parts.reduce(
    (total, part) => total + part.omittedBytes,
    0,
  );
  if (parts.length > MAX_TRANSCRIPT_PARTS) {
    const head = Math.ceil(MAX_TRANSCRIPT_PARTS / 2);
    parts = [
      ...parts.slice(0, head),
      ...parts.slice(-Math.floor(MAX_TRANSCRIPT_PARTS / 2)),
    ];
    omittedBytes +=
      jsonBytes(sourceParts) - jsonBytes(parts.map((entry) => entry.part));
  }
  return {
    item: {
      kind: "assistant" as const,
      parts: parts.map((entry) => entry.part),
    },
    omittedBytes,
  } as const;
}

function removeMiddle<T>(items: T[]) {
  if (items.length === 0) return false;
  items.splice(Math.floor(items.length / 2), 1);
  return true;
}

function projectTranscript(
  items: ReadonlyArray<TranscriptItem>,
  maxBytes: number,
) {
  if (items.length === 0)
    return { items: [] as TranscriptItem[], omittedItems: 0, omittedBytes: 0 };
  if (maxBytes <= 2) {
    return {
      items: [],
      omittedItems: items.length,
      omittedBytes: jsonBytes(items),
    };
  }

  let omittedBytes = 0;
  let projected = items.map((item) => {
    const compacted = compactTranscriptItem(item, DISPLAY_ITEM_BYTES);
    omittedBytes += compacted.omittedBytes;
    return compacted.item;
  });
  const originalLength = projected.length;

  while (projected.length > 1 && jsonBytes(projected) > maxBytes)
    removeMiddle(projected);

  if (projected.length > 0 && jsonBytes(projected) > maxBytes) {
    const perItem = Math.max(1, Math.floor(maxBytes / projected.length));
    projected = projected.map((item) => {
      const compacted = compactTranscriptItem(item, perItem);
      omittedBytes += compacted.omittedBytes;
      return compacted.item;
    });
  }
  while (projected.length > 0 && jsonBytes(projected) > maxBytes)
    removeMiddle(projected);

  omittedBytes = Math.max(
    omittedBytes,
    Math.max(0, jsonBytes(items) - jsonBytes(projected)),
  );
  return {
    items: projected,
    omittedItems: originalLength - projected.length,
    omittedBytes,
  };
}

function compactLiveTool(tool: LiveToolState, maxBytes: number) {
  const toolId = trimText(tool.toolId, CORE_TEXT_BYTES);
  const name = trimText(tool.name, CORE_TEXT_BYTES);
  const args = tool.argsPreview
    ? trimText(tool.argsPreview, maxBytes)
    : undefined;
  const output = tool.outputPreview
    ? trimText(tool.outputPreview, maxBytes)
    : undefined;
  return {
    tool: {
      toolId: toolId.text,
      name: name.text,
      ...(args ? { argsPreview: args.text } : {}),
      ...(output ? { outputPreview: output.text } : {}),
      ...(tool.done !== undefined ? { done: tool.done } : {}),
      ...(tool.isError !== undefined ? { isError: tool.isError } : {}),
    },
    omittedBytes:
      toolId.omittedBytes +
      name.omittedBytes +
      (args?.omittedBytes ?? 0) +
      (output?.omittedBytes ?? 0),
  } as const;
}

function projectLiveTools(
  tools: ReadonlyArray<LiveToolState>,
  maxBytes: number,
) {
  if (tools.length === 0)
    return { tools: [] as LiveToolState[], omittedTools: 0, omittedBytes: 0 };
  if (maxBytes <= 2)
    return {
      tools: [],
      omittedTools: tools.length,
      omittedBytes: jsonBytes(tools),
    };

  let omittedBytes = 0;
  let projected = tools.map((tool) => {
    const compacted = compactLiveTool(tool, DISPLAY_ITEM_BYTES);
    omittedBytes += compacted.omittedBytes;
    return compacted.tool;
  });
  const originalLength = projected.length;
  while (projected.length > 1 && jsonBytes(projected) > maxBytes)
    removeMiddle(projected);
  while (projected.length > 0 && jsonBytes(projected) > maxBytes)
    removeMiddle(projected);
  omittedBytes = Math.max(
    omittedBytes,
    Math.max(0, jsonBytes(tools) - jsonBytes(projected)),
  );
  return {
    tools: projected,
    omittedTools: originalLength - projected.length,
    omittedBytes,
  };
}

function projectQueued(
  messages: ReadonlyArray<QueuedMessage>,
  maxBytes: number,
) {
  if (messages.length === 0)
    return {
      queued: [] as QueuedMessage[],
      omittedMessages: 0,
      omittedBytes: 0,
    };
  if (maxBytes <= 2)
    return {
      queued: [],
      omittedMessages: messages.length,
      omittedBytes: jsonBytes(messages),
    };

  let projected = messages.map((message) => ({
    kind: message.kind,
    text: trimText(message.text, DISPLAY_ITEM_BYTES).text,
  }));
  const originalLength = projected.length;
  while (projected.length > 1 && jsonBytes(projected) > maxBytes)
    removeMiddle(projected);
  while (projected.length > 0 && jsonBytes(projected) > maxBytes)
    removeMiddle(projected);
  return {
    queued: projected,
    omittedMessages: originalLength - projected.length,
    omittedBytes: Math.max(0, jsonBytes(messages) - jsonBytes(projected)),
  };
}

interface BuildOptions {
  readonly transcriptBytes: number;
  readonly liveAssistantBytes: number;
  readonly liveToolsBytes: number;
  readonly queuedBytes: number;
  readonly finalTextBytes: number;
  readonly promptBytes: number;
  readonly coreBytes: number;
  readonly includeDisplay: boolean;
}

function buildCandidate(snapshot: SubagentSnapshot, options: BuildOptions) {
  const title = trimText(snapshot.title, options.coreBytes);
  const prompt = trimText(snapshot.prompt, options.promptBytes);
  const cwd = trimText(snapshot.cwd, options.coreBytes);
  const errorText = snapshot.errorText
    ? trimText(snapshot.errorText, options.coreBytes)
    : undefined;
  // This is a compact recovery reference, not display text. It is retained
  // only as an already-validated digest identity.
  const resultArtifact = snapshot.resultArtifact;
  const meta = compactMeta(snapshot.meta);
  const transcript = options.includeDisplay
    ? projectTranscript(snapshot.transcript, options.transcriptBytes)
    : {
        items: [],
        omittedItems: snapshot.transcript.length,
        omittedBytes:
          snapshot.transcript.length > 0 ? jsonBytes(snapshot.transcript) : 0,
      };
  const liveAssistant = snapshot.liveAssistant
    ? {
        text: trimText(
          snapshot.liveAssistant.text,
          Math.floor(options.liveAssistantBytes / 2),
        ),
        thinking: trimText(
          snapshot.liveAssistant.thinking,
          Math.ceil(options.liveAssistantBytes / 2),
        ),
      }
    : undefined;
  const liveTools = options.includeDisplay
    ? projectLiveTools(snapshot.liveTools, options.liveToolsBytes)
    : {
        tools: [],
        omittedTools: snapshot.liveTools.length,
        omittedBytes:
          snapshot.liveTools.length > 0 ? jsonBytes(snapshot.liveTools) : 0,
      };
  const queued = options.includeDisplay
    ? projectQueued(snapshot.queued, options.queuedBytes)
    : {
        queued: [],
        omittedMessages: snapshot.queued.length,
        omittedBytes:
          snapshot.queued.length > 0 ? jsonBytes(snapshot.queued) : 0,
      };
  const finalText = trimText(snapshot.finalText, options.finalTextBytes);

  const candidate: Record<string, unknown> = {
    id: snapshot.id,
    origin: snapshot.origin,
    backend: snapshot.backend,
    title: title.text,
    prompt: prompt.text,
    cwd: cwd.text,
    status: snapshot.status,
    ...(snapshot.outcome ? { outcome: snapshot.outcome } : {}),
    ...(snapshot.worktreeBranch
      ? { worktreeBranch: snapshot.worktreeBranch }
      : {}),
    createdAt: snapshot.createdAt,
    ...(snapshot.settledAt !== undefined
      ? { settledAt: snapshot.settledAt }
      : {}),
    ...(errorText ? { errorText: errorText.text } : {}),
    meta: meta.meta,
    usage: {
      ...(snapshot.usage.tokens !== undefined
        ? { tokens: snapshot.usage.tokens }
        : {}),
      ...(snapshot.usage.contextWindow !== undefined
        ? { contextWindow: snapshot.usage.contextWindow }
        : {}),
    },
    transcriptVersion: snapshot.transcriptVersion,
    transcript: transcript.items,
    ...(snapshot.liveAssistant
      ? {
          liveAssistant: {
            text: liveAssistant?.text.text ?? "",
            thinking: liveAssistant?.thinking.text ?? "",
          },
        }
      : {}),
    liveTools: liveTools.tools,
    queued: queued.queued,
    finalText: finalText.text,
    ...(snapshot.finalTextTruncated ? { finalTextTruncated: true } : {}),
    ...(resultArtifact ? { resultArtifact } : {}),
    turns: snapshot.turns,
  };

  const prior = snapshot.snapshot;
  const omitted = {
    // A projected snapshot can be projected again when the aggregate budget
    // changes. Preserve the known omission, but never count the same bytes or
    // entries again on every projection.
    transcriptItems: Math.max(
      prior?.omitted.transcriptItems ?? 0,
      transcript.omittedItems,
    ),
    liveTools: Math.max(prior?.omitted.liveTools ?? 0, liveTools.omittedTools),
    queued: Math.max(prior?.omitted.queued ?? 0, queued.omittedMessages),
    liveAssistantBytes: Math.max(
      prior?.omitted.liveAssistantBytes ?? 0,
      (liveAssistant?.text.omittedBytes ?? 0) +
        (liveAssistant?.thinking.omittedBytes ?? 0),
    ),
    finalTextBytes: Math.max(
      prior?.omitted.finalTextBytes ?? 0,
      finalText.omittedBytes,
    ),
    promptBytes: Math.max(prior?.omitted.promptBytes ?? 0, prompt.omittedBytes),
  };
  const explicitOmittedBytes =
    title.omittedBytes +
    prompt.omittedBytes +
    cwd.omittedBytes +
    (errorText?.omittedBytes ?? 0) +
    meta.omittedBytes +
    transcript.omittedBytes +
    liveTools.omittedBytes +
    queued.omittedBytes +
    (liveAssistant?.text.omittedBytes ?? 0) +
    (liveAssistant?.thinking.omittedBytes ?? 0) +
    finalText.omittedBytes;
  const sourceForMeasurement = { ...snapshot, snapshot: undefined };
  const omittedBytes = Math.max(
    prior?.omittedBytes ?? 0,
    explicitOmittedBytes,
    Math.max(0, jsonBytes(sourceForMeasurement) - jsonBytes(candidate)),
  );
  const metadata = {
    maxBytes: 0,
    bytes: 0,
    truncated:
      omittedBytes > 0 ||
      omitted.transcriptItems > 0 ||
      omitted.liveTools > 0 ||
      omitted.queued > 0,
    omittedBytes,
    omitted,
  } satisfies Omit<SubagentSnapshotProjection, "maxBytes" | "bytes"> & {
    maxBytes: number;
    bytes: number;
  };
  return { candidate, metadata };
}

function finishCandidate(
  candidate: Record<string, unknown>,
  metadata: ReturnType<typeof buildCandidate>["metadata"],
  cap: number,
) {
  let bytes = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    candidate.snapshot = { ...metadata, maxBytes: cap, bytes };
    const nextBytes = jsonBytes(candidate);
    if (nextBytes === bytes) return nextBytes <= cap ? candidate : undefined;
    bytes = nextBytes;
  }
  candidate.snapshot = { ...metadata, maxBytes: cap, bytes };
  const finalBytes = jsonBytes(candidate);
  return finalBytes <= cap ? candidate : undefined;
}

/**
 * Build one detached, bounded model/UI snapshot. Lifecycle identity and
 * terminal facts remain explicit; transcript-like data is reconstructible from
 * the native child session and is the first material shed under pressure.
 */
export function projectSubagentSnapshot(
  snapshot: SubagentSnapshot,
  maxBytes = DEFAULT_SUBAGENT_SNAPSHOT_MAX_BYTES,
): SubagentSnapshot | undefined {
  const cap = Math.floor(maxBytes);
  if (!Number.isFinite(cap) || cap <= 0) return undefined;

  const levels: BuildOptions[] = [
    {
      transcriptBytes: Math.floor(cap * 0.28),
      liveAssistantBytes: Math.floor(cap * 0.16),
      liveToolsBytes: Math.floor(cap * 0.16),
      queuedBytes: Math.floor(cap * 0.1),
      finalTextBytes: Math.floor(cap * 0.16),
      promptBytes: Math.floor(cap * 0.08),
      coreBytes: CORE_TEXT_BYTES,
      includeDisplay: true,
    },
    {
      transcriptBytes: Math.floor(cap * 0.12),
      liveAssistantBytes: Math.floor(cap * 0.08),
      liveToolsBytes: Math.floor(cap * 0.08),
      queuedBytes: Math.floor(cap * 0.05),
      finalTextBytes: Math.floor(cap * 0.08),
      promptBytes: Math.floor(cap * 0.04),
      coreBytes: Math.floor(CORE_TEXT_BYTES / 2),
      includeDisplay: true,
    },
    {
      transcriptBytes: 2,
      liveAssistantBytes: 2,
      liveToolsBytes: 2,
      queuedBytes: 2,
      finalTextBytes: Math.min(4 * 1024, Math.floor(cap * 0.08)),
      promptBytes: Math.min(CORE_TEXT_BYTES, Math.floor(cap * 0.04)),
      coreBytes: Math.floor(CORE_TEXT_BYTES / 2),
      includeDisplay: false,
    },
    {
      transcriptBytes: 2,
      liveAssistantBytes: 2,
      liveToolsBytes: 2,
      queuedBytes: 2,
      finalTextBytes: 1,
      promptBytes: 1,
      coreBytes: 64,
      includeDisplay: false,
    },
  ];

  for (const options of levels) {
    const built = buildCandidate(snapshot, options);
    const candidate = finishCandidate(built.candidate, built.metadata, cap);
    if (candidate) return candidate as unknown as SubagentSnapshot;
  }
  return undefined;
}

/** Measure the exact JSON UTF-8 size of one snapshot projection. */
export function measureSubagentSnapshotBytes(snapshot: SubagentSnapshot) {
  return jsonBytes(snapshot);
}

/**
 * Project the complete manager read model under one shared UTF-8 byte cap.
 * Equal per-entry budgets make a single large child and many medium children
 * obey the same aggregate bound and keep older entries from consuming all
 * space. The array wrapper is charged before allocating entry budgets.
 */
export function projectSubagentSnapshots(
  snapshots: ReadonlyArray<SubagentSnapshot>,
  maxBytes = DEFAULT_SUBAGENT_SNAPSHOT_MAX_BYTES,
): ReadonlyArray<SubagentSnapshot> | undefined {
  const cap = Math.floor(maxBytes);
  if (!Number.isFinite(cap) || cap <= 0) return undefined;
  if (snapshots.length === 0) return [];
  const wrapperBytes = 2 + Math.max(0, snapshots.length - 1);
  const perEntry = Math.floor((cap - wrapperBytes) / snapshots.length);
  if (perEntry <= 0) return undefined;
  const projected = snapshots.map((snapshot) =>
    projectSubagentSnapshot(snapshot, perEntry),
  );
  if (projected.some((snapshot) => snapshot === undefined)) return undefined;
  const result = projected as SubagentSnapshot[];
  return jsonBytes(result) <= cap ? result : undefined;
}

export function measureSubagentSnapshotsBytes(
  snapshots: ReadonlyArray<SubagentSnapshot>,
) {
  return jsonBytes(snapshots);
}
