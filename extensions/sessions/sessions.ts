import { sanitizeTerminalText } from "../shared/terminal-text.ts";

export interface SessionInfoLike {
  id: string;
  name?: string;
  cwd: string;
  modified: Date;
  created?: Date;
  firstMessage: string;
  path: string;
  messageCount?: number;
}

export type PreviewContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image"; mimeType?: string }
      | { type: "toolCall"; name: string; arguments?: Record<string, unknown> }
      | { type: "thinking"; thinking?: string; redacted?: boolean }
    >;

export interface PreviewMessageLike {
  role: string;
  content?: PreviewContent;
  toolName?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  summary?: string;
}

export type PreviewBlock =
  | { kind: "notice"; text: string }
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string; redacted?: boolean }
  | { kind: "toolCall"; name: string; args?: string }
  | { kind: "toolResult"; name?: string; text: string; isError?: boolean }
  | { kind: "bash"; command: string; output?: string; isError?: boolean }
  | { kind: "summary"; label: string; text: string }
  | { kind: "custom"; label: string; text: string };

export interface SessionPreview {
  title: string;
  subtitle: string;
  blocks: PreviewBlock[];
  error?: string;
}

export interface SessionPaneLayout {
  mode: "single" | "split";
  listWidth: number;
  previewWidth: number;
}

export function parseLimit(args: string | undefined, defaultLimit = 5): number {
  if (!args) return defaultLimit;
  const parsed = Number.parseInt(args.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultLimit;
  return parsed;
}

const pad = (value: number): string => value.toString().padStart(2, "0");

export function formatTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay === 1) return "Yesterday";
  return `${diffDay}d ago`;
}

const cleanDisplayLine = (text: string) =>
  sanitizeTerminalText(text).replace(/\s+/gu, " ").trim();

export function buildSessionLabel(session: SessionInfoLike): string {
  const trimmedName = cleanDisplayLine(session.name ?? "");
  if (trimmedName) return trimmedName;
  const id = cleanDisplayLine(session.id);
  return id.length > 8 ? id.slice(0, 8) : id;
}

const normalizeSnippet = (text: string, maxLength: number): string => {
  const cleaned = cleanDisplayLine(text);
  const fallback = cleaned.length > 0 ? cleaned : "No messages";
  if (maxLength < 1) return "";
  if (fallback.length <= maxLength) return fallback;
  if (maxLength === 1) return "…";
  return `${fallback.slice(0, maxLength - 1)}…`;
};

export function buildSessionDescription(
  session: SessionInfoLike,
  snippetMax = 60,
): string {
  const snippet = normalizeSnippet(session.firstMessage ?? "", snippetMax);
  return `${formatTimestamp(session.modified)} • ${snippet} — ${cleanDisplayLine(session.cwd)}`;
}

export interface SessionSearchEntry {
  session: SessionInfoLike;
  searchText: string;
}

export const buildSearchText = (session: SessionInfoLike): string =>
  [
    session.name?.trim() ?? "",
    session.id,
    session.cwd,
    session.firstMessage ?? "",
  ]
    .join(" ")
    .toLowerCase();

export function buildSessionSearchEntries(
  sessions: SessionInfoLike[],
): SessionSearchEntry[] {
  return sessions.map((session) => ({
    session,
    searchText: buildSearchText(session),
  }));
}

export function filterSessionEntries(
  entries: SessionSearchEntry[],
  filter: string,
): SessionSearchEntry[] {
  const normalized = filter.trim().toLowerCase();
  if (!normalized) return entries;

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return entries;

  return entries.filter((entry) =>
    tokens.every((token) => entry.searchText.includes(token)),
  );
}

export function filterSessionInfos(
  sessions: SessionInfoLike[],
  filter: string,
): SessionInfoLike[] {
  return filterSessionEntries(buildSessionSearchEntries(sessions), filter).map(
    (entry) => entry.session,
  );
}

/**
 * Mirror pi-tui SelectList's centered viewport so background stats work is
 * limited to rows the picker can actually render. Keep the formula locked by
 * tests because SelectList does not expose its visible range.
 */
export function selectSessionStatsWindow(
  sessions: readonly SessionInfoLike[],
  selectedPath: string,
  maxVisible: number,
) {
  if (sessions.length === 0) return [];
  const visible = Math.max(1, Math.min(maxVisible, sessions.length));
  const found = sessions.findIndex((session) => session.path === selectedPath);
  const selectedIndex = found >= 0 ? found : 0;
  const startIndex = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(visible / 2),
      sessions.length - visible,
    ),
  );
  return sessions.slice(startIndex, startIndex + visible);
}

export function getSessionPaneLayout(width: number): SessionPaneLayout {
  if (width < 80) {
    return { mode: "single", listWidth: width, previewWidth: 0 };
  }

  const dividerWidth = 3;
  const available = Math.max(0, width - dividerWidth);
  let listRatio = 0.36;
  if (width < 110) {
    listRatio = 0.42;
  } else if (width >= 180) {
    listRatio = 0.32;
  }

  const listWidth = Math.max(
    34,
    Math.min(58, Math.floor(available * listRatio)),
  );
  return {
    mode: "split",
    listWidth,
    previewWidth: Math.max(0, available - listWidth),
  };
}

const cleanPreviewText = (text: string) =>
  sanitizeTerminalText(text).replace(/\s+$/g, "");

function sanitizePreviewValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeTerminalText(value);
  if (Array.isArray(value)) return value.map(sanitizePreviewValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      sanitizeTerminalText(key),
      sanitizePreviewValue(nested),
    ]),
  );
}

function textBlocksFromContent(
  content: PreviewContent | undefined,
): PreviewBlock[] {
  if (!content) return [];
  if (typeof content === "string") {
    const text = cleanPreviewText(content);
    return text.trim() ? [{ kind: "assistant", text }] : [];
  }

  const blocks: PreviewBlock[] = [];
  for (const part of content) {
    if (part.type === "text") {
      const text = cleanPreviewText(part.text);
      if (text.trim()) blocks.push({ kind: "assistant", text });
    } else if (part.type === "image") {
      const mimeType = cleanDisplayLine(part.mimeType ?? "");
      blocks.push({
        kind: "notice",
        text: `[image${mimeType ? `: ${mimeType}` : ""}]`,
      });
    } else if (part.type === "toolCall") {
      const args =
        part.arguments && Object.keys(part.arguments).length > 0
          ? JSON.stringify(sanitizePreviewValue(part.arguments))
          : undefined;
      blocks.push({
        kind: "toolCall",
        name: cleanDisplayLine(part.name),
        args,
      });
    } else if (part.type === "thinking") {
      blocks.push({
        kind: "thinking",
        text: part.redacted
          ? "[thinking redacted]"
          : cleanPreviewText(part.thinking ?? "[thinking]"),
        redacted: part.redacted,
      });
    }
  }
  return blocks;
}

function contentToPlainText(content: PreviewContent | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image")
        return `[image${part.mimeType ? `: ${part.mimeType}` : ""}]`;
      if (part.type === "toolCall") return `[tool call: ${part.name}]`;
      if (part.type === "thinking")
        return part.redacted
          ? "[thinking redacted]"
          : (part.thinking ?? "[thinking]");
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function messageToBlocks(message: PreviewMessageLike): PreviewBlock[] {
  if (message.role === "user") {
    const text = cleanPreviewText(contentToPlainText(message.content));
    return text ? [{ kind: "user", text }] : [];
  }

  if (message.role === "assistant") {
    return textBlocksFromContent(message.content);
  }

  if (message.role === "toolResult" || message.role === "tool") {
    const text = cleanPreviewText(contentToPlainText(message.content));
    return text
      ? [
          {
            kind: "toolResult",
            name: message.toolName
              ? cleanDisplayLine(message.toolName)
              : undefined,
            text,
            isError: message.isError,
          },
        ]
      : [];
  }

  if (message.role === "bashExecution") {
    const command = message.command ?? "";
    return command || message.output
      ? [
          {
            kind: "bash",
            command: cleanPreviewText(command),
            output: cleanPreviewText(message.output ?? ""),
            isError: message.isError,
          },
        ]
      : [];
  }

  if (
    message.role === "compactionSummary" ||
    message.role === "branchSummary"
  ) {
    const text = cleanPreviewText(
      message.summary ?? contentToPlainText(message.content),
    );
    return text
      ? [
          {
            kind: "summary",
            label:
              message.role === "branchSummary" ? "Branch summary" : "Summary",
            text,
          },
        ]
      : [];
  }

  const text = cleanPreviewText(
    message.summary ?? contentToPlainText(message.content),
  );
  return text
    ? [
        {
          kind: "custom",
          label: cleanDisplayLine(message.role) || "Message",
          text,
        },
      ]
    : [];
}

export function buildSessionPreview(
  session: SessionInfoLike,
  messages: PreviewMessageLike[],
  options: {
    maxMessages?: number;
    totalMessages?: number;
    truncatedBytes?: number;
  } = {},
): SessionPreview {
  const maxMessages = options.maxMessages ?? 80;
  const blocks: PreviewBlock[] = [];
  const visibleMessages =
    messages.length > maxMessages ? messages.slice(-maxMessages) : messages;
  const totalMessages = Math.max(
    visibleMessages.length,
    options.totalMessages ?? messages.length,
  );
  const omitted = Math.max(0, totalMessages - visibleMessages.length);

  if (omitted > 0) {
    blocks.push({
      kind: "notice",
      text: `… ${omitted} earlier messages omitted`,
    });
  }
  if ((options.truncatedBytes ?? 0) > 0) {
    blocks.push({
      kind: "notice",
      text: `… ${options.truncatedBytes} bytes of preview content omitted`,
    });
  }

  for (const message of visibleMessages) {
    blocks.push(...messageToBlocks(message));
  }

  const messageCount = session.messageCount ?? totalMessages;
  return {
    title: buildSessionLabel(session),
    subtitle: `${formatTimestamp(session.modified)} · ${messageCount} messages · ${cleanDisplayLine(session.cwd)}`,
    blocks:
      blocks.length > 0
        ? blocks
        : [{ kind: "notice", text: "No previewable messages." }],
  };
}

export function buildPreviewError(
  session: SessionInfoLike,
  error: unknown,
): SessionPreview {
  const message = cleanPreviewText(
    error instanceof Error ? error.message : String(error),
  );
  return {
    title: buildSessionLabel(session),
    subtitle: `${formatTimestamp(session.modified)} · preview unavailable`,
    blocks: [{ kind: "notice", text: `Failed to load preview: ${message}` }],
    error: message,
  };
}
