import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { WebCapabilitySnapshot } from "../../extensions/shared/web-observer-registry.ts";

export const WEB_PROTOCOL_VERSION = 1;
export const WEB_MAX_EVENTS = 200;
export const WEB_MAX_EVENT_BYTES = 64 * 1024;
export const WEB_MAX_TEXT = 12_000;
export const WEB_MAX_SESSION_PREVIEW = 500;
const WEB_MAX_METADATA_TEXT = 500;
export const WEB_MAX_ENTRIES = 250;
export const WEB_MAX_MESSAGE_PARTS = 64;
export const WEB_MAX_SESSIONS = 500;
export const WEB_MAX_WORKSPACES = 250;
export const WEB_MAX_MODELS = 250;
export const WEB_MAX_SELECTED_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
export const WEB_MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

export interface WebEvent {
  protocolVersion: typeof WEB_PROTOCOL_VERSION;
  sequence: number;
  type: string;
  timestamp: string;
  detail?: Record<string, unknown>;
}

export interface WebSessionSummary {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  modified: string;
  created: string;
  messageCount: number;
  firstMessage: string;
  archived?: boolean;
  ungrouped?: boolean;
}

export interface WebWorkspaceSummary {
  path: string;
  name: string;
  current: boolean;
}

export interface WebModelSummary {
  provider: string;
  id: string;
  name: string;
  label: string;
  current: boolean;
}

export interface WebProjectionTruncation {
  readonly truncated: boolean;
  readonly entriesOmitted: number;
  readonly messagePartsOmitted: number;
  readonly messagesTruncated: number;
  readonly maxBytes: number;
}

export interface WebSessionProjection {
  id: string;
  path: string;
  cwd: string;
  entries: ReturnType<typeof projectEntry>[];
  bytes: number;
  truncation: WebProjectionTruncation;
}

export interface WebMessageTruncation {
  readonly truncated: true;
  readonly text?: true;
  readonly partsOmitted?: number;
  readonly details?: true;
}

export interface WebLiveMessage {
  role?: string;
  toolName?: string;
  content: string;
  parts?: WebMessagePart[];
  toolCallId?: string;
  isError?: boolean;
  customType?: string;
  display?: boolean;
  details?: unknown;
  truncation?: WebMessageTruncation;
}

export type WebMessagePart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; id?: string; name: string; arguments: string };

export interface WebSnapshotTruncation {
  truncated: boolean;
  sessionsOmitted: number;
  workspacesOmitted: number;
  modelsOmitted: number;
  maxBytes: number;
  bytes: number;
}

export interface WebSnapshot {
  protocolVersion: typeof WEB_PROTOCOL_VERSION;
  generatedAt: string;
  cursor: number;
  /** Absent until the browser selects or creates a real Web Session. */
  currentSessionId?: string;
  workspaces: WebWorkspaceSummary[];
  sessions: WebSessionSummary[];
  selectedSession?: WebSessionProjection;
  models: WebModelSummary[];
  runtime: {
    status: "idle" | "running" | "unknown";
    capabilities: WebCapabilitySnapshot;
  };
  truncation: WebSnapshotTruncation;
}

interface BoundedText {
  readonly value: string;
  readonly truncated: boolean;
}

function boundedTextProjection(value: string, maxLength: number): BoundedText {
  return value.length > maxLength
    ? {
        value: `${value.slice(0, maxLength)}\n[truncated]`,
        truncated: true,
      }
    : { value, truncated: false };
}

export function boundedText(value: string, maxLength = WEB_MAX_TEXT): string {
  return boundedTextProjection(value, maxLength).value;
}

const WEB_MAX_DETAILS_BYTES = 24 * 1024;
const WEB_MAX_STRUCTURED_DEPTH = 6;
const WEB_MAX_STRUCTURED_NODES = 512;
const WEB_MAX_STRUCTURED_PROPERTIES = 128;
const WEB_MAX_STRUCTURED_ARRAY_ITEMS = 128;

interface StructuredBudget {
  bytes: number;
  nodes: number;
  truncated: boolean;
  readonly seen: WeakSet<object>;
}

function consumeStructuredText(value: string, budget: StructuredBudget) {
  const candidate = value.slice(0, Math.min(value.length, budget.bytes));
  const encoded = textEncoder.encode(candidate);
  if (encoded.byteLength <= budget.bytes) {
    budget.bytes -= encoded.byteLength;
    if (candidate.length < value.length) budget.truncated = true;
    return candidate;
  }
  budget.truncated = true;
  if (budget.bytes <= 0) return "";
  const bounded = new TextDecoder().decode(encoded.slice(0, budget.bytes));
  budget.bytes = 0;
  return bounded;
}

function boundedStructuredValue(
  value: unknown,
  budget: StructuredBudget,
  depth = 0,
): unknown {
  if (budget.nodes-- <= 0 || depth > WEB_MAX_STRUCTURED_DEPTH) {
    budget.truncated = true;
    return undefined;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return consumeStructuredText(value, budget);
  if (typeof value === "bigint") return consumeStructuredText(String(value), budget);
  if (typeof value !== "object") {
    budget.truncated = true;
    return undefined;
  }
  if (budget.seen.has(value)) {
    budget.truncated = true;
    return undefined;
  }
  budget.seen.add(value);
  if (Array.isArray(value)) {
    const length = Math.min(value.length, WEB_MAX_STRUCTURED_ARRAY_ITEMS);
    if (value.length > length) budget.truncated = true;
    const projected: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const item = boundedStructuredValue(value[index], budget, depth + 1);
      if (item !== undefined) projected.push(item);
      if (budget.nodes <= 0 || budget.bytes <= 0) break;
    }
    return projected;
  }
  const projected: Record<string, unknown> = {};
  let scannedProperties = 0;
  for (const key in value) {
    if (scannedProperties++ >= WEB_MAX_STRUCTURED_PROPERTIES) {
      budget.truncated = true;
      break;
    }
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      budget.truncated = true;
      continue;
    }
    const boundedKey = consumeStructuredText(key, budget);
    const item = boundedStructuredValue(descriptor.value, budget, depth + 1);
    if (item !== undefined) projected[boundedKey] = item;
    if (budget.nodes <= 0 || budget.bytes <= 0) break;
  }
  return projected;
}

function detailsProjection(value: unknown) {
  if (value === undefined || value === null) {
    return { value: undefined, truncated: false };
  }
  const budget: StructuredBudget = {
    bytes: WEB_MAX_DETAILS_BYTES,
    nodes: WEB_MAX_STRUCTURED_NODES,
    truncated: false,
    seen: new WeakSet(),
  };
  const projected = boundedStructuredValue(value, budget);
  if (!budget.truncated && jsonByteLength(projected) > WEB_MAX_DETAILS_BYTES) {
    budget.truncated = true;
  }
  return {
    value: budget.truncated ? undefined : projected,
    truncated: budget.truncated,
  };
}

/** Keep structured tool details only when they serialize small and clean. */
export function boundedDetails(value: unknown): unknown {
  return detailsProjection(value).value;
}

function projectContent(message: Record<string, unknown>) {
  const content = message.content;
  if (typeof content === "string") {
    const text = boundedTextProjection(content, WEB_MAX_TEXT);
    return {
      content: text.value,
      parts: [] as WebMessagePart[],
      partsOmitted: 0,
      textTruncated: text.truncated,
    };
  }
  if (!Array.isArray(content)) {
    const fallback =
      typeof message.output === "string"
        ? message.output
        : typeof message.summary === "string"
          ? message.summary
          : "";
    const text = boundedTextProjection(
      fallback,
      WEB_MAX_TEXT,
    );
    return {
      content: text.value,
      parts: [] as WebMessagePart[],
      partsOmitted: 0,
      textTruncated: text.truncated,
    };
  }

  const parts: WebMessagePart[] = [];
  let visibleText = "";
  let textTruncated = false;
  const retainedParts = Math.min(content.length, WEB_MAX_MESSAGE_PARTS);
  for (let index = 0; index < retainedParts; index++) {
    const part = content[index];
    if (typeof part !== "object" || part === null) continue;
    const typed = part as Record<string, unknown>;
    let projected: WebMessagePart | undefined;
    if (typed.type === "text" && typeof typed.text === "string") {
      const text = boundedTextProjection(typed.text, WEB_MAX_TEXT);
      projected = { type: "text", text: text.value };
      textTruncated ||= text.truncated;
      if (visibleText.length < WEB_MAX_TEXT) {
        const separator = visibleText.length > 0 ? "\n" : "";
        const remaining = WEB_MAX_TEXT - visibleText.length - separator.length;
        if (remaining > 0) visibleText += `${separator}${text.value.slice(0, remaining)}`;
        if (text.value.length > remaining) textTruncated = true;
      } else {
        textTruncated = true;
      }
    } else if (
      typed.type === "thinking" &&
      typeof typed.thinking === "string"
    ) {
      const text = boundedTextProjection(typed.thinking, WEB_MAX_TEXT);
      projected = { type: "thinking", text: text.value };
      textTruncated ||= text.truncated;
    } else if (typed.type === "toolCall") {
      const argumentsBudget: StructuredBudget = {
        bytes: WEB_MAX_TEXT,
        nodes: WEB_MAX_STRUCTURED_NODES,
        truncated: false,
        seen: new WeakSet(),
      };
      const boundedArguments = boundedStructuredValue(
        typed.arguments ?? {},
        argumentsBudget,
      );
      const argumentsText = JSON.stringify(boundedArguments ?? {});
      const argumentsProjection = boundedTextProjection(
        argumentsText,
        WEB_MAX_TEXT,
      );
      const id =
        typeof typed.id === "string"
          ? boundedTextProjection(typed.id, WEB_MAX_METADATA_TEXT)
          : undefined;
      const name = boundedTextProjection(
        typeof typed.name === "string" ? typed.name : "tool",
        WEB_MAX_METADATA_TEXT,
      );
      projected = {
        type: "toolCall",
        ...(id ? { id: id.value } : {}),
        name: name.value,
        arguments: argumentsProjection.value,
      };
      textTruncated ||=
        argumentsProjection.truncated ||
        argumentsBudget.truncated ||
        id?.truncated === true ||
        name.truncated;
    }
    if (!projected) continue;
    parts.push(projected);
  }
  const contentText = boundedTextProjection(visibleText, WEB_MAX_TEXT);
  return {
    content: contentText.value,
    parts,
    partsOmitted: Math.max(0, content.length - retainedParts),
    textTruncated: textTruncated || contentText.truncated,
  };
}

export function projectMessage(message: unknown): WebLiveMessage {
  const value =
    message && typeof message === "object"
      ? (message as Record<string, unknown>)
      : {};
  const content = projectContent(value);
  const details = detailsProjection(value.details);
  const role =
    typeof value.role === "string"
      ? boundedTextProjection(value.role, WEB_MAX_METADATA_TEXT)
      : undefined;
  const toolName =
    typeof value.toolName === "string"
      ? boundedTextProjection(value.toolName, WEB_MAX_METADATA_TEXT)
      : undefined;
  const toolCallId =
    typeof value.toolCallId === "string"
      ? boundedTextProjection(value.toolCallId, WEB_MAX_METADATA_TEXT)
      : undefined;
  const customType =
    typeof value.customType === "string"
      ? boundedTextProjection(value.customType, WEB_MAX_METADATA_TEXT)
      : undefined;
  const metadataTruncated =
    role?.truncated === true ||
    toolName?.truncated === true ||
    toolCallId?.truncated === true ||
    customType?.truncated === true;
  const truncated =
    content.textTruncated ||
    content.partsOmitted > 0 ||
    details.truncated ||
    metadataTruncated;
  return {
    role: role?.value,
    toolName: toolName?.value,
    content: content.content,
    ...(content.parts.length > 0 ? { parts: content.parts } : {}),
    ...(toolCallId ? { toolCallId: toolCallId.value } : {}),
    ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
    ...(customType ? { customType: customType.value } : {}),
    ...(typeof value.display === "boolean" ? { display: value.display } : {}),
    ...(details.value !== undefined ? { details: details.value } : {}),
    ...(truncated
      ? {
          truncation: {
            truncated: true as const,
            ...(content.textTruncated || metadataTruncated
              ? { text: true as const }
              : {}),
            ...(content.partsOmitted > 0
              ? { partsOmitted: content.partsOmitted }
              : {}),
            ...(details.truncated ? { details: true as const } : {}),
          },
        }
      : {}),
  };
}

export function projectEntry(entry: SessionEntry) {
  if (entry.type !== "message") {
    return { type: entry.type, id: entry.id, timestamp: entry.timestamp };
  }
  return {
    type: entry.type,
    id: entry.id,
    timestamp: entry.timestamp,
    message: projectMessage(entry.message),
  };
}

const textEncoder = new TextEncoder();

export function jsonByteLength(value: unknown) {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

export function projectEntries(entries: readonly SessionEntry[]) {
  const retained = entries.slice(-WEB_MAX_ENTRIES);
  const projected: ReturnType<typeof projectEntry>[] = [];
  let bytes = 2;
  let messagePartsOmitted = 0;
  let messagesTruncated = 0;
  for (let index = retained.length - 1; index >= 0; index--) {
    const entry = projectEntry(retained[index]!);
    const entryBytes = jsonByteLength(entry) + (projected.length > 0 ? 1 : 0);
    if (bytes + entryBytes > WEB_MAX_SELECTED_TRANSCRIPT_BYTES) break;
    projected.unshift(entry);
    bytes += entryBytes;
    if (entry.type === "message" && entry.message) {
      messagePartsOmitted += entry.message.truncation?.partsOmitted ?? 0;
      if (entry.message.truncation) messagesTruncated++;
    }
  }
  const entriesOmitted = entries.length - projected.length;
  return {
    entries: projected,
    bytes,
    truncation: {
      truncated:
        entriesOmitted > 0 ||
        messagePartsOmitted > 0 ||
        messagesTruncated > 0,
      entriesOmitted,
      messagePartsOmitted,
      messagesTruncated,
      maxBytes: WEB_MAX_SELECTED_TRANSCRIPT_BYTES,
    } satisfies WebProjectionTruncation,
  };
}
