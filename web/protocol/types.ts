import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const WEB_PROTOCOL_VERSION = 1;
export const WEB_MAX_EVENTS = 200;
export const WEB_MAX_TEXT = 12_000;
export const WEB_MAX_ENTRIES = 250;

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

export interface WebSessionProjection {
  id: string;
  path: string;
  cwd: string;
  entries: ReturnType<typeof projectEntry>[];
}

export interface WebLiveMessage {
  role?: string;
  toolName?: string;
  content: string;
  parts?: WebMessagePart[];
}

type WebMessagePart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; name: string; arguments: string };

export interface WebSnapshot {
  protocolVersion: typeof WEB_PROTOCOL_VERSION;
  generatedAt: string;
  cursor: number;
  currentSessionId: string;
  workspaces: WebWorkspaceSummary[];
  sessions: WebSessionSummary[];
  selectedSession?: WebSessionProjection;
  models: WebModelSummary[];
  runtime: {
    status: "idle" | "running" | "unknown";
    capabilities: Record<string, unknown>;
  };
}

export function boundedText(value: string): string {
  return value.length > WEB_MAX_TEXT
    ? `${value.slice(0, WEB_MAX_TEXT)}\n[truncated]`
    : value;
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return boundedText(content);
  if (Array.isArray(content)) {
    return boundedText(
      content
        .flatMap((part) => {
          if (typeof part !== "object" || part === null) return [];
          const typed = part as { text?: unknown; type?: unknown };
          return typeof typed.text === "string"
            ? [typed.text]
            : [];
        })
        .join("\n"),
    );
  }
  return boundedText(String(message.output ?? message.summary ?? ""));
}

function messageParts(message: Record<string, unknown>): WebMessagePart[] {
  if (!Array.isArray(message.content)) return [];
  const parts: WebMessagePart[] = [];
  for (const part of message.content) {
    if (typeof part !== "object" || part === null) continue;
    const typed = part as Record<string, unknown>;
    if (typed.type === "text" && typeof typed.text === "string") {
      parts.push({ type: "text", text: boundedText(typed.text) });
      continue;
    }
    if (typed.type === "thinking" && typeof typed.thinking === "string") {
      parts.push({ type: "thinking", text: boundedText(typed.thinking) });
      continue;
    }
    if (typed.type === "toolCall") {
      let argumentsText = "";
      try {
        argumentsText = JSON.stringify(typed.arguments ?? {}, null, 2);
      } catch {
        argumentsText = String(typed.arguments ?? "");
      }
      parts.push({
        type: "toolCall",
        name: typeof typed.name === "string" ? typed.name : "tool",
        arguments: boundedText(argumentsText),
      });
    }
  }
  return parts;
}

export function projectMessage(message: unknown): WebLiveMessage {
  const value =
    message && typeof message === "object"
      ? (message as Record<string, unknown>)
      : {};
  const parts = messageParts(value);
  return {
    role: typeof value.role === "string" ? value.role : undefined,
    toolName: typeof value.toolName === "string" ? value.toolName : undefined,
    content: messageText(value),
    ...(parts.length > 0 ? { parts } : {}),
  };
}

export function projectEntry(entry: SessionEntry) {
  if (entry.type !== "message") {
    return { type: entry.type, id: entry.id, timestamp: entry.timestamp };
  }
  const message = entry.message as unknown as Record<string, unknown>;
  const projected = projectMessage(message);
  return {
    type: entry.type,
    id: entry.id,
    timestamp: entry.timestamp,
    message: {
      ...projected,
    },
  };
}
