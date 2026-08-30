import {
  calculateContextTokens,
  type AgentSession,
  estimateTokens,
} from "@earendil-works/pi-coding-agent";
import { type AgentUsage, emptyUsage, type TranscriptEntry } from "./model.ts";
import { safeStringify, truncateUtf8 } from "./serialization.ts";

const TRANSCRIPT_ENTRY_MAX_BYTES = 16 * 1024;
const TRANSCRIPT_TOTAL_MAX_BYTES = 256 * 1024;
const TRANSCRIPT_MAX_ENTRIES = 200;

type AgentMessage = AgentSession["messages"][number];
export type ProgressAssistantMessage = Extract<
  AgentMessage,
  { role: "assistant" }
>;

export interface ProgressToolTiming {
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

type ContextTokens = number | null | undefined;

interface ProjectedTranscriptEntry {
  role: TranscriptEntry["role"];
  text: string;
  sourceTextTruncated: boolean;
  name?: string;
  sourceToolCallId?: string;
  isError?: boolean;
  timestamp?: number;
}

export interface AgentProgressProjectionSnapshot {
  preview: string;
  usage: AgentUsage;
  latestAssistant?: ProgressAssistantMessage;
  transcript: TranscriptEntry[];
}

function validAssistantContextTokens(message: ProgressAssistantMessage) {
  if (
    message.stopReason === "aborted" ||
    message.stopReason === "error" ||
    !message.usage
  ) {
    return undefined;
  }
  const tokens = calculateContextTokens(message.usage);
  return tokens > 0 ? tokens : undefined;
}

function boundedSourceText(text: string) {
  const bounded = truncateUtf8(text, TRANSCRIPT_ENTRY_MAX_BYTES);
  return { text: bounded, sourceTextTruncated: bounded !== text };
}

function safeJson(value: unknown) {
  return safeStringify(value, {
    maxBytes: TRANSCRIPT_ENTRY_MAX_BYTES,
    maxDepth: 12,
    maxNodes: 2_000,
  });
}

function messageEntries(message: AgentMessage): ProjectedTranscriptEntry[] {
  if (message.role === "user") {
    const source =
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) =>
              part.type === "text" ? part.text : `[image: ${part.mimeType}]`,
            )
            .join("\n");
    if (!source.trim()) return [];
    return [
      {
        role: "user",
        ...boundedSourceText(source),
        timestamp: message.timestamp,
      },
    ];
  }

  if (message.role === "assistant") {
    const entries: ProjectedTranscriptEntry[] = [];
    for (const part of message.content) {
      if (part.type === "text" && part.text.trim()) {
        entries.push({
          role: "assistant",
          ...boundedSourceText(part.text),
          timestamp: message.timestamp,
        });
        continue;
      }
      if (part.type === "thinking" && part.thinking.trim()) {
        entries.push({
          role: "thinking",
          ...boundedSourceText(part.thinking),
          timestamp: message.timestamp,
        });
        continue;
      }
      if (part.type === "toolCall") {
        entries.push({
          role: "tool",
          ...boundedSourceText(safeJson(part.arguments)),
          name: part.name,
          sourceToolCallId: part.id,
          timestamp: message.timestamp,
        });
      }
    }
    return entries;
  }

  if (message.role !== "toolResult") return [];
  const source = message.content
    .map((part) =>
      part.type === "text" ? part.text : `[image: ${part.mimeType}]`,
    )
    .join("\n");
  return [
    {
      role: "toolResult",
      ...boundedSourceText(source),
      name: message.toolName,
      sourceToolCallId: message.toolCallId,
      isError: message.isError,
      timestamp: message.timestamp,
    },
  ];
}

function assistantText(message: ProgressAssistantMessage) {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function addAssistantUsage(
  usage: AgentUsage,
  message: ProgressAssistantMessage,
) {
  usage.turns++;
  const current = message.usage;
  if (!current) return;
  usage.input += current.input || 0;
  usage.output += current.output || 0;
  usage.cacheRead += current.cacheRead || 0;
  usage.cacheWrite += current.cacheWrite || 0;
  usage.cost += current.cost?.total || 0;
}

function toolMetadata(
  toolCallId: string,
  timings: ReadonlyMap<string, ProgressToolTiming>,
) {
  const timing = timings.get(toolCallId);
  return {
    toolCallId: truncateUtf8(toolCallId, 1024),
    ...(timing?.startedAt === undefined ? {} : { startedAt: timing.startedAt }),
    ...(timing?.finishedAt === undefined
      ? {}
      : { finishedAt: timing.finishedAt }),
    ...(timing?.durationMs === undefined
      ? {}
      : { durationMs: timing.durationMs }),
  };
}

/**
 * Bounded, ephemeral projection of Pi's active child messages.
 *
 * Pi remains canonical. Normal finalized messages are folded once; startup,
 * compaction, and terminal settlement replace this state from Pi's messages.
 */
export class AgentProgressProjection {
  private usage = emptyUsage();
  private preview = "";
  private latestAssistant?: ProgressAssistantMessage;
  private firstEntry?: ProjectedTranscriptEntry;
  private tailEntries: ProjectedTranscriptEntry[] = [];
  private totalEntries = 0;
  private contextTokens: ContextTokens;

  constructor(
    messages: readonly AgentMessage[] = [],
    contextTokens?: ContextTokens,
  ) {
    this.replace(messages, contextTokens);
  }

  replace(messages: readonly AgentMessage[], contextTokens?: ContextTokens) {
    this.usage = emptyUsage();
    this.preview = "";
    this.latestAssistant = undefined;
    this.firstEntry = undefined;
    this.tailEntries = [];
    this.totalEntries = 0;
    this.contextTokens = contextTokens;
    for (const message of messages) this.ingest(message, false);
  }

  append(message: AgentMessage) {
    this.ingest(message, true);
  }

  private ingest(message: AgentMessage, updateContext: boolean) {
    if (message.role === "assistant") {
      addAssistantUsage(this.usage, message);
      this.latestAssistant = message;
      const text = assistantText(message);
      if (text) this.preview = text;
    }

    if (updateContext && this.contextTokens !== undefined) {
      const assistantTokens =
        message.role === "assistant"
          ? validAssistantContextTokens(message)
          : undefined;
      if (assistantTokens !== undefined) {
        this.contextTokens = assistantTokens;
      } else if (this.contextTokens !== null) {
        this.contextTokens += estimateTokens(message);
      }
    }

    for (const entry of messageEntries(message)) this.pushEntry(entry);
  }

  private pushEntry(entry: ProjectedTranscriptEntry) {
    this.totalEntries++;
    if (!this.firstEntry) {
      this.firstEntry = entry;
      return;
    }
    this.tailEntries.push(entry);
    if (this.tailEntries.length >= TRANSCRIPT_MAX_ENTRIES) {
      this.tailEntries.shift();
    }
  }

  snapshot(
    toolTimings: ReadonlyMap<string, ProgressToolTiming> = new Map(),
  ): AgentProgressProjectionSnapshot {
    const selected = this.firstEntry
      ? [this.firstEntry, ...this.tailEntries]
      : [];
    const transcript: TranscriptEntry[] = [];
    let totalBytes = 0;
    for (const entry of selected) {
      const remaining = TRANSCRIPT_TOTAL_MAX_BYTES - totalBytes;
      if (remaining <= 0) break;
      const text = truncateUtf8(
        entry.text,
        Math.min(TRANSCRIPT_ENTRY_MAX_BYTES, remaining),
      );
      totalBytes += Buffer.byteLength(text, "utf8");
      const truncated = entry.sourceTextTruncated || text !== entry.text;
      transcript.push({
        role: entry.role,
        text: truncated ? `${text}\n[transcript entry truncated]` : text,
        ...(entry.name === undefined ? {} : { name: entry.name }),
        ...(entry.sourceToolCallId === undefined
          ? {}
          : toolMetadata(entry.sourceToolCallId, toolTimings)),
        ...(entry.isError === undefined ? {} : { isError: entry.isError }),
        ...(entry.timestamp === undefined
          ? {}
          : { timestamp: entry.timestamp }),
      });
    }
    if (transcript.length < this.totalEntries) {
      transcript.push({
        role: "toolResult",
        name: "transcript",
        text: `[transcript truncated: retained ${transcript.length} of ${this.totalEntries} entries]`,
      });
    }
    return {
      preview: this.preview,
      usage: {
        ...this.usage,
        ...(typeof this.contextTokens === "number"
          ? { contextTokens: this.contextTokens }
          : {}),
      },
      latestAssistant: this.latestAssistant,
      transcript,
    };
  }
}

export function transcriptFromMessages(
  messages: AgentMessage[],
  toolTimings: ReadonlyMap<string, ProgressToolTiming> = new Map(),
) {
  return new AgentProgressProjection(messages).snapshot(toolTimings).transcript;
}
