/** Shared Pi-native operator-facing agent transcript rendering. */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  UserMessageComponent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { TruncatedText } from "@earendil-works/pi-tui";
import type { AgentToolRenderer } from "./agent-tool-renderer.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";
import {
  parseToolArgsPreview,
  renderPaddedToolActivityLine,
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
  /** Pairing index built by the document producer; render falls back to building it. */
  readonly pairing?: PairingIndex;
  readonly cwd?: string;
  /** Ephemeral native renderer for the live child; never persisted. */
  readonly toolRenderer?: AgentToolRenderer;
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

const emptyUsage: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(
  parts: ReadonlyArray<AgentTranscriptPart>,
): AssistantMessage {
  return {
    role: "assistant",
    content: parts.map((part) => {
      if (part.type === "text")
        return { type: "text", text: sanitizeText(part.text) };
      if (part.type === "thinking") {
        return {
          type: "thinking",
          thinking: part.redacted
            ? "[redacted reasoning]"
            : sanitizeText(part.text),
          ...(part.redacted ? { redacted: true } : {}),
        };
      }
      const { args } = parseToolArgsPreview(part.argsPreview);
      return {
        type: "toolCall",
        id: part.toolId,
        name: part.name,
        arguments:
          args !== null && typeof args === "object" && !Array.isArray(args)
            ? args
            : {},
      };
    }),
    api: "openai-responses",
    provider: "openai",
    model: "child-transcript",
    usage: emptyUsage,
    stopReason: parts.some((part) => part.type === "toolCall")
      ? "toolUse"
      : "stop",
    timestamp: 0,
  };
}

function renderUserText(text: string, width: number) {
  const clean = sanitizeText(text).trim();
  if (!clean) return [];
  return new UserMessageComponent(clean, getMarkdownTheme()).render(width);
}

function renderAssistantParts(
  parts: ReadonlyArray<AgentTranscriptPart>,
  width: number,
  streaming = false,
) {
  const component = new AssistantMessageComponent(
    assistantMessage(parts),
    false,
    getMarkdownTheme(),
  );
  if (streaming) component.updateContent(assistantMessage(parts), true);
  return component.render(width);
}

export type ToolPhase = "live" | "ok" | "error" | "pending";

function activityStatus(phase: ToolPhase): ToolActivityStatus {
  if (phase === "error") return "error";
  if (phase === "ok") return "success";
  return "pending";
}

function renderToolBlock(
  theme: Theme,
  phase: ToolPhase,
  toolId: string,
  name: string,
  argsPreview: string | undefined,
  outputPreview: string | undefined,
  width: number,
  now: number,
  cwd?: string,
  toolRenderer?: AgentToolRenderer,
  expanded = false,
) {
  const native = toolRenderer?.renderTool(
    { toolId, name, cwd, expanded },
    width,
  );
  if (native) return native;
  const { args, fallback } = parseToolArgsPreview(argsPreview);
  return [
    "",
    renderPaddedToolActivityLine(
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
    ),
  ];
}

function renderAssistantItem(
  theme: Theme,
  item: Extract<AgentTranscriptItem, { kind: "assistant" }>,
  width: number,
  tools: ReadonlyMap<string, ToolRenderState>,
  now: number,
  cwd?: string,
  toolRenderer?: AgentToolRenderer,
  expanded = false,
) {
  const out = renderAssistantParts(item.parts, width);
  for (const part of item.parts) {
    if (part.type === "toolCall") {
      const state = tools.get(part.toolId) ?? { phase: "pending" };
      // A live tool is rendered by the live block, which owns the spinner and
      // the streaming output; rendering the call here too would show the same
      // command twice and make the block reflow when the tool settles.
      if (state.phase === "live") continue;
      out.push(
        ...renderToolBlock(
          theme,
          state.phase,
          part.toolId,
          part.name,
          part.argsPreview,
          state.result?.outputPreview,
          width,
          now,
          cwd,
          toolRenderer,
          expanded,
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
  toolRenderer?: AgentToolRenderer,
  expanded = false,
) {
  if (paired) return [];
  return renderToolBlock(
    theme,
    item.isError ? "error" : "ok",
    item.toolId,
    item.name,
    undefined,
    item.outputPreview,
    width,
    now,
    cwd,
    toolRenderer,
    expanded,
  );
}

/** Tool-call/tool-result pairing lookups, precomputed in one forward pass. */
export interface PairingIndex {
  /** Earliest call index per tool id; a result only needs "is any call earlier?". */
  readonly firstCallAt: ReadonlyMap<string, number>;
  /** Ascending result indices per tool id; calls pair with the first result AFTER them. */
  readonly resultsById: ReadonlyMap<string, ReadonlyArray<number>>;
}

export function buildPairingIndex(
  transcript: ReadonlyArray<AgentTranscriptItem>,
): PairingIndex {
  const firstCallAt = new Map<string, number>();
  const resultsById = new Map<string, number[]>();
  for (let index = 0; index < transcript.length; index++) {
    const item = transcript[index]!;
    if (item.kind === "assistant") {
      for (const part of item.parts) {
        if (part.type !== "toolCall") continue;
        if (!firstCallAt.has(part.toolId)) firstCallAt.set(part.toolId, index);
      }
      continue;
    }
    if (item.kind !== "toolResult") continue;
    const seen = resultsById.get(item.toolId);
    if (seen) seen.push(index);
    else resultsById.set(item.toolId, [index]);
  }
  return { firstCallAt, resultsById };
}

/** Whether any `toolCall` for this id appears before `resultIndex`. */
function hasEarlierToolCall(
  pairing: PairingIndex,
  resultIndex: number,
  toolId: string,
) {
  const firstCall = pairing.firstCallAt.get(toolId);
  return firstCall !== undefined && firstCall < resultIndex;
}

function renderTranscriptItem(
  theme: Theme,
  item: AgentTranscriptItem,
  width: number,
  context: ItemContext,
  now: number,
  cwd?: string,
  toolRenderer?: AgentToolRenderer,
  expanded = false,
) {
  if (item.kind === "user") return renderUserText(item.text, width);
  if (item.kind === "assistant") {
    return renderAssistantItem(
      theme,
      item,
      width,
      context.tools,
      now,
      cwd,
      toolRenderer,
      expanded,
    );
  }
  return renderToolResultItem(
    theme,
    item,
    width,
    context.paired,
    now,
    cwd,
    toolRenderer,
    expanded,
  );
}

function itemHasTool(item: AgentTranscriptItem) {
  return (
    item.kind === "toolResult" ||
    (item.kind === "assistant" &&
      item.parts.some((part) => part.type === "toolCall"))
  );
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
  pairing: PairingIndex,
): ItemContext {
  const item = transcript[index]!;
  if (item.kind === "user")
    return { tools: new Map(), paired: false, token: "" };
  if (item.kind === "toolResult") {
    const paired = hasEarlierToolCall(pairing, index, item.toolId);
    return { tools: new Map(), paired, token: paired ? "p" : "o" };
  }

  const tools = new Map<string, ToolRenderState>();
  for (const part of item.parts) {
    if (part.type !== "toolCall") continue;
    if (liveIds.has(part.toolId)) {
      tools.set(part.toolId, { phase: "live" });
      continue;
    }
    const result = findResult(transcript, pairing, index, part.toolId);
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
  pairing: PairingIndex,
  callIndex: number,
  toolId: string,
) {
  const indices = pairing.resultsById.get(toolId);
  if (!indices) return undefined;
  // Ascending by construction, so the first entry past the call is the match.
  for (const index of indices) {
    if (index <= callIndex) continue;
    const candidate = transcript[index];
    return candidate?.kind === "toolResult" ? candidate : undefined;
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
  private toolRenderers = new Set<AgentToolRenderer>();

  render(
    document: AgentTranscriptDocument,
    width: number,
    theme: Theme,
    options?: { readonly now?: number; readonly expanded?: boolean },
  ) {
    const out: string[] = [];
    const now = options?.now ?? Date.now();
    const expanded = options?.expanded === true;
    const liveTools = document.liveTools ?? [];
    if (document.toolRenderer) this.toolRenderers.add(document.toolRenderer);
    const liveIds = new Set(liveTools.map((tool) => tool.toolId));
    const pairing = document.pairing ?? buildPairingIndex(document.items);

    for (let index = 0; index < document.items.length; index++) {
      const item = document.items[index];
      const context = itemContext(document.items, index, liveIds, pairing);
      const key = `${width}|${context.token}`;
      const cacheable = !document.toolRenderer || !itemHasTool(item);
      const cached = cacheable ? this.itemCache.get(item)?.get(key) : undefined;
      const lines =
        cached ??
        renderTranscriptItem(
          theme,
          item,
          width,
          context,
          now,
          document.cwd,
          document.toolRenderer,
          expanded,
        );
      if (!cached && cacheable) {
        const widths = this.itemCache.get(item) ?? new Map<string, string[]>();
        if (widths.size >= MAX_CACHED_WIDTHS_PER_ITEM) {
          const oldestWidth = widths.keys().next().value;
          if (oldestWidth !== undefined) widths.delete(oldestWidth);
        }
        widths.set(key, lines);
        this.itemCache.set(item, widths);
      }
      if (lines.length > 0) {
        out.push(...lines);
      }
    }
    while (out.length > 0 && out[out.length - 1] === "") out.pop();

    // Live streaming assistant buffers (cleared when the finalized message lands).
    if (document.liveAssistant) {
      const { thinking, text } = document.liveAssistant;
      const parts: AgentTranscriptPart[] = [];
      if (thinking.trim()) parts.push({ type: "thinking", text: thinking });
      if (text.trim()) parts.push({ type: "text", text });
      out.push(...renderAssistantParts(parts, width, true));
    }

    // Live tool executions. The manager drops a live entry when its ToolEnd
    // lands, and the transcript's call line then takes over with the settled
    // glyph in the same column, so the block never reflows.
    for (const tool of liveTools) {
      const phase: ToolPhase = tool.done
        ? tool.isError
          ? "error"
          : "ok"
        : "live";
      out.push(
        ...renderToolBlock(
          theme,
          phase,
          tool.toolId,
          tool.name,
          tool.argsPreview,
          tool.outputPreview,
          width,
          now,
          document.cwd,
          document.toolRenderer,
          expanded,
        ),
      );
    }

    // Match Pi's pending-message projection. The dequeue hint is intentionally
    // omitted because the child page does not expose Pi's queue editor.
    if ((document.queued?.length ?? 0) > 0) out.push("");
    for (const message of document.queued ?? []) {
      const label = message.kind === "steer" ? "Steering" : "Follow-up";
      out.push(
        ...new TruncatedText(
          theme.fg("dim", `${label}: ${sanitizeText(message.text)}`),
          1,
          0,
        ).render(width),
      );
    }

    return out;
  }

  invalidate() {
    this.itemCache = new WeakMap();
    for (const renderer of this.toolRenderers) renderer.invalidate?.();
    this.toolRenderers.clear();
  }
}
