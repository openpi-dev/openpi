/** Shared operator-facing agent transcript rendering. */

import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type DefaultTextStyle,
  type MarkdownOptions,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./terminal-text.ts";
import {
  parseToolArgsPreview,
  renderToolActivityLine,
  type ToolActivityStatus,
} from "./tool-activity.ts";

export type AgentTranscriptPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "thinking";
      readonly text: string;
      readonly redacted?: boolean;
    }
  | {
      readonly type: "toolCall";
      readonly toolId: string;
      readonly name: string;
      readonly argsPreview?: string;
    };

export type AgentTranscriptItem =
  | { readonly kind: "user"; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly parts: ReadonlyArray<AgentTranscriptPart>;
    }
  | {
      readonly kind: "toolResult";
      readonly toolId: string;
      readonly name: string;
      readonly isError: boolean;
      readonly outputPreview?: string;
    };

export interface AgentTranscriptDocument {
  readonly items: ReadonlyArray<AgentTranscriptItem>;
  readonly cwd?: string;
  readonly liveAssistant?: { readonly text: string; readonly thinking: string };
  readonly liveTools?: ReadonlyArray<{
    readonly toolId: string;
    readonly name: string;
    readonly argsPreview?: string;
    readonly outputPreview?: string;
    readonly done?: boolean;
    readonly isError?: boolean;
  }>;
  readonly queued?: ReadonlyArray<{
    readonly text: string;
    readonly kind: "steer" | "follow-up";
  }>;
}

const MAX_CACHED_WIDTHS_PER_ITEM = 2;

/**
 * Strip raw ANSI codes, expand tabs, and drop control chars. Terminal-expanded
 * tabs (and stray escapes) make lines wider than the width we declare to the
 * TUI, which desyncs the renderer and smears the overlay.
 */
export function sanitizeText(text: string): string {
  return sanitizeTerminalText(text);
}

function transcriptMarkdownTheme() {
  const theme = getMarkdownTheme();
  return {
    ...theme,
    // Markdown normalizes unordered lists to "- "; use a display bullet so
    // transcript list syntax is never confused with unrendered source.
    listBullet: (text: string) =>
      theme.listBullet(text.replace(/^(?:[-+*]) /, "• ")),
  };
}

function renderMarkdown(
  text: string,
  width: number,
  defaultTextStyle?: DefaultTextStyle,
  options?: MarkdownOptions,
) {
  const clean = sanitizeText(text).trim();
  if (!clean) return [];
  const markdown = new Markdown(
    clean,
    0,
    0,
    transcriptMarkdownTheme(),
    defaultTextStyle,
    options,
  );
  return markdown
    .render(Math.max(1, width))
    .map((line) => truncateToWidth(line, width));
}

function renderUserText(theme: Theme, text: string, width: number) {
  const lines = renderMarkdown(
    text,
    Math.max(1, width - 2),
    { color: (content: string) => theme.fg("userMessageText", content) },
    { preserveOrderedListMarkers: true, preserveBackslashEscapes: true },
  );
  return lines.map((line, index) =>
    truncateToWidth(
      (index === 0 ? theme.fg("accent", "> ") : "  ") + line,
      width,
    ),
  );
}

function renderThinking(theme: Theme, text: string, width: number) {
  const reasoning = sanitizeText(text).trim();
  if (!reasoning) return [];
  const out: string[] = [];
  const prefix = theme.fg("dim", "~ ");
  const defaultTextStyle = {
    color: (content: string) => theme.fg("muted", content),
    italic: true,
  } satisfies DefaultTextStyle;
  const lines = renderMarkdown(
    reasoning,
    Math.max(1, width - 2),
    defaultTextStyle,
  );
  for (let i = 0; i < lines.length; i++) {
    out.push(truncateToWidth((i === 0 ? prefix : "  ") + lines[i], width));
  }
  return out;
}

export type ToolPhase = "live" | "ok" | "error" | "pending";

function activityStatus(phase: ToolPhase): ToolActivityStatus {
  if (phase === "error") return "error";
  if (phase === "ok") return "success";
  return "pending";
}

function renderToolLine(
  theme: Theme,
  phase: ToolPhase,
  name: string,
  argsPreview: string | undefined,
  outputPreview: string | undefined,
  width: number,
  now: number,
  cwd?: string,
) {
  const { args, fallback } = parseToolArgsPreview(argsPreview);
  return renderToolActivityLine(
    {
      name,
      args,
      argsFallback: fallback,
      output: outputPreview,
      status: activityStatus(phase),
      cwd,
    },
    theme,
    width,
    now,
  );
}

function renderAssistantItem(
  theme: Theme,
  item: Extract<AgentTranscriptItem, { kind: "assistant" }>,
  width: number,
  tools: ReadonlyMap<string, ToolRenderState>,
  now: number,
  cwd?: string,
) {
  const out: string[] = [];
  for (const part of item.parts) {
    if (part.type === "text") {
      out.push(...renderMarkdown(part.text, width));
    } else if (part.type === "thinking") {
      out.push(
        ...renderThinking(
          theme,
          part.redacted ? "[redacted reasoning]" : part.text,
          width,
        ),
      );
    } else if (part.type === "toolCall") {
      const state = tools.get(part.toolId) ?? { phase: "pending" };
      // A live tool is rendered by the live block, which owns the spinner and
      // the streaming output; rendering the call here too would show the same
      // command twice and make the block reflow when the tool settles.
      if (state.phase === "live") continue;
      out.push(
        renderToolLine(
          theme,
          state.phase,
          part.name,
          part.argsPreview,
          state.result?.outputPreview,
          width,
          now,
          cwd,
        ),
      );
    }
  }
  return out;
}

function renderToolResultItem(
  theme: Theme,
  item: Extract<AgentTranscriptItem, { kind: "toolResult" }>,
  width: number,
  paired: boolean,
  now: number,
  cwd?: string,
) {
  if (paired) return [];
  return [
    renderToolLine(
      theme,
      item.isError ? "error" : "ok",
      item.name,
      undefined,
      item.outputPreview,
      width,
      now,
      cwd,
    ),
  ];
}

function hasEarlierToolCall(
  transcript: ReadonlyArray<AgentTranscriptItem>,
  resultIndex: number,
  toolId: string,
) {
  for (let index = resultIndex - 1; index >= 0; index--) {
    const candidate = transcript[index];
    if (candidate?.kind !== "assistant") continue;
    if (
      candidate.parts.some(
        (part) => part.type === "toolCall" && part.toolId === toolId,
      )
    ) {
      return true;
    }
  }
  return false;
}

function renderTranscriptItem(
  theme: Theme,
  item: AgentTranscriptItem,
  width: number,
  context: ItemContext,
  now: number,
  cwd?: string,
) {
  if (item.kind === "user") return renderUserText(theme, item.text, width);
  if (item.kind === "assistant") {
    return renderAssistantItem(theme, item, width, context.tools, now, cwd);
  }
  return renderToolResultItem(theme, item, width, context.paired, now, cwd);
}

interface ItemContext {
  readonly tools: ReadonlyMap<string, ToolRenderState>;
  readonly paired: boolean;
  /** Cache discriminator: identity plus width is not enough on its own. */
  readonly token: string;
}

interface ToolRenderState {
  readonly phase: ToolPhase;
  readonly result?: Extract<AgentTranscriptItem, { kind: "toolResult" }>;
}

/**
 * An item's rendering depends on its neighbours (does a call have its result
 * yet?) and on live state (is the call still running?), so the cache key has to
 * carry that context or a stale glyph would outlive the phase it described.
 */
function itemContext(
  transcript: ReadonlyArray<AgentTranscriptItem>,
  index: number,
  liveIds: ReadonlySet<string>,
): ItemContext {
  const item = transcript[index]!;
  if (item.kind === "user")
    return { tools: new Map(), paired: false, token: "" };
  if (item.kind === "toolResult") {
    const paired = hasEarlierToolCall(transcript, index, item.toolId);
    return { tools: new Map(), paired, token: paired ? "p" : "o" };
  }

  const tools = new Map<string, ToolRenderState>();
  for (const part of item.parts) {
    if (part.type !== "toolCall") continue;
    if (liveIds.has(part.toolId)) {
      tools.set(part.toolId, { phase: "live" });
      continue;
    }
    const result = findResult(transcript, index, part.toolId);
    tools.set(
      part.toolId,
      result
        ? { phase: result.isError ? "error" : "ok", result }
        : { phase: "pending" },
    );
  }
  return {
    tools,
    paired: false,
    token: [...tools].map(([id, state]) => `${id}:${state.phase}`).join(","),
  };
}

/** The result for a call, if it has already landed later in the transcript. */
function findResult(
  transcript: ReadonlyArray<AgentTranscriptItem>,
  callIndex: number,
  toolId: string,
) {
  for (let index = callIndex + 1; index < transcript.length; index++) {
    const candidate = transcript[index];
    if (candidate?.kind === "toolResult" && candidate.toolId === toolId) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Caches finalized transcript items by identity and width. Live state remains
 * uncached because it changes on every stream tick; callers clear this cache
 * from their component's invalidate() when Pi changes theme.
 */
export class AgentTranscriptRenderer {
  private itemCache = new WeakMap<AgentTranscriptItem, Map<string, string[]>>();

  render(
    document: AgentTranscriptDocument,
    width: number,
    theme: Theme,
    options?: { readonly now?: number },
  ) {
    const out: string[] = [];
    const now = options?.now ?? Date.now();
    const liveTools = document.liveTools ?? [];
    const liveIds = new Set(liveTools.map((tool) => tool.toolId));

    for (let index = 0; index < document.items.length; index++) {
      const item = document.items[index];
      const context = itemContext(document.items, index, liveIds);
      const key = `${width}|${context.token}`;
      const cached = this.itemCache.get(item)?.get(key);
      const lines =
        cached ??
        renderTranscriptItem(theme, item, width, context, now, document.cwd);
      if (!cached) {
        const widths = this.itemCache.get(item) ?? new Map<string, string[]>();
        if (widths.size >= MAX_CACHED_WIDTHS_PER_ITEM) {
          const oldestWidth = widths.keys().next().value;
          if (oldestWidth !== undefined) widths.delete(oldestWidth);
        }
        widths.set(key, lines);
        this.itemCache.set(item, widths);
      }
      if (lines.length > 0) {
        if (out.length > 0 && !context.paired) out.push("");
        out.push(...lines);
      }
    }
    while (out.length > 0 && out[out.length - 1] === "") out.pop();

    // Live streaming assistant buffers (cleared when the finalized message lands).
    if (document.liveAssistant) {
      const { thinking, text } = document.liveAssistant;
      const before = out.length;
      if (out.length > 0) out.push("");
      if (thinking.trim()) out.push(...renderThinking(theme, thinking, width));
      if (text.trim()) out.push(...renderMarkdown(text, width));
      if (out.length === before + 1) out.pop();
    }

    // Live tool executions. The manager drops a live entry when its ToolEnd
    // lands, and the transcript's call line then takes over with the settled
    // glyph in the same column, so the block never reflows.
    for (const tool of liveTools) {
      if (out.length > 0) out.push("");
      const phase: ToolPhase = tool.done
        ? tool.isError
          ? "error"
          : "ok"
        : "live";
      out.push(
        renderToolLine(
          theme,
          phase,
          tool.name,
          tool.argsPreview,
          tool.outputPreview,
          width,
          now,
          document.cwd,
        ),
      );
    }

    // Queued steering/follow-up messages: show them immediately so Enter
    // visibly acknowledges the user's input instead of appearing to do nothing.
    for (const message of document.queued ?? []) {
      if (out.length > 0) out.push("");
      const prefix = theme.fg("warning", `> [queued ${message.kind}] `);
      const wrapped = wrapTextWithAnsi(
        sanitizeText(message.text),
        Math.max(1, width - visibleWidth(prefix)),
      );
      for (let i = 0; i < wrapped.length; i++) {
        out.push(
          truncateToWidth(
            (i === 0 ? prefix : " ".repeat(visibleWidth(prefix))) +
              theme.fg("muted", wrapped[i]),
            width,
          ),
        );
      }
    }

    return out;
  }

  invalidate() {
    this.itemCache = new WeakMap();
  }
}
