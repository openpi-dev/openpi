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
  // Ascending by construction: binary search the first result past the call, so
  // a wide fan of parallel calls whose results all land later cannot degrade
  // into a quadratic pairing scan.
  let low = 0;
  let high = indices.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (indices[middle]! <= callIndex) low = middle + 1;
    else high = middle;
  }
  const index = indices[low];
  if (index === undefined) return undefined;
  const candidate = transcript[index];
  return candidate?.kind === "toolResult" ? candidate : undefined;
}

/** Rows pre-rendered around the window so a scroll step lands on warm rows. */
const DEFAULT_OVERSCAN_ROWS = 6;

/** A resolved frame: the row total, plus rows on demand by absolute position. */
export interface AgentTranscriptFrame {
  /** Total rows including the live tail. Drives the viewport's scroll math. */
  readonly rowCount: number;
  /** Rows [top, top + height), rendering only the items those rows need. */
  rows(top: number, height: number, overscan?: number): string[];
}

/** Everything besides item identity that can change an item's rows. */
interface RenderContext {
  readonly width: number;
  readonly now: number;
  readonly expanded: boolean;
  readonly liveIds: ReadonlySet<string>;
  readonly liveKey: string;
  readonly pairing: PairingIndex;
  /** Discriminates cached rows across cwd, expansion, and native tool output. */
  readonly keyPrefix: string;
}

/**
 * Row layout for one items array under one RenderContext. Heights change only
 * when the items array, the live-tool set, the theme generation, the key
 * prefix, or a referenced tool's native output changes, so a hot repaint
 * validates this in O(1) instead of re-deriving every preceding row.
 */
interface TranscriptLayout {
  readonly keyPrefix: string;
  readonly liveKey: string;
  readonly generation: number;
  /**
   * The pairing index this layout was measured against. Producers rebuild it on
   * every transcript mutation, so identity here is an O(1) content check.
   */
  readonly pairing: PairingIndex;
  length: number;
  last: AgentTranscriptItem | undefined;
  /** offsets[i] is the first row of item i; offsets[length] is the row total. */
  offsets: number[];
  heights: number[];
  /** The exact items these heights were measured from. */
  measured: Array<AgentTranscriptItem | undefined>;
  /** Indices of items whose rows come from a tool, with their revision token. */
  toolItems: number[];
  toolTokens: string[];
  /** Ledger clock at build time; native output moves without items moving. */
  toolGeneration: number;
}

/**
 * Resolve everything besides item identity that can change an item's rows.
 * cwd and expansion both change tool rows, so they belong in the cache key;
 * omitting them would serve a row rendered for a different child or view.
 */
function renderContext(
  document: AgentTranscriptDocument,
  width: number,
  options?: { readonly now?: number; readonly expanded?: boolean },
): RenderContext {
  const liveIds = new Set((document.liveTools ?? []).map((t) => t.toolId));
  const expanded = options?.expanded === true;
  return {
    width,
    now: options?.now ?? Date.now(),
    expanded,
    liveIds,
    liveKey: [...liveIds].sort().join(","),
    pairing: document.pairing ?? buildPairingIndex(document.items),
    keyPrefix: `${width}|${expanded ? "x" : "c"}|${document.cwd ?? ""}`,
  };
}

/** First item whose row range contains `row`. */
function itemAtRow(offsets: ReadonlyArray<number>, row: number) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle + 1]! <= row) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Native tool output changes without the transcript item changing, so cached
 * rows and heights carry the renderer's revision for every tool id they show.
 * A renderer that cannot report revisions yields no suffix and stays uncached.
 */
function toolRevisionToken(
  item: AgentTranscriptItem,
  toolRenderer?: AgentToolRenderer,
) {
  if (!toolRenderer?.revision) return "";
  if (item.kind === "toolResult") {
    return `#${toolRenderer.revision(item.toolId)}`;
  }
  if (item.kind !== "assistant") return "";
  let token = "";
  for (const part of item.parts) {
    if (part.type !== "toolCall") continue;
    token += `#${toolRenderer.revision(part.toolId)}`;
  }
  return token;
}

/**
 * Caches finalized transcript items by identity, width, and render context.
 * Live state remains uncached because it changes on every stream tick; callers
 * clear this cache from their component's invalidate() when Pi changes theme.
 */
export class AgentTranscriptRenderer {
  private itemCache = new WeakMap<AgentTranscriptItem, Map<string, string[]>>();
  private heightCache = new WeakMap<AgentTranscriptItem, Map<string, number>>();
  private layoutCache = new WeakMap<
    ReadonlyArray<AgentTranscriptItem>,
    TranscriptLayout
  >();
  private toolRenderers = new Set<AgentToolRenderer>();
  /** Bumped by invalidate() so cached rows and heights cannot outlive a theme. */
  private generation = 0;

  /**
   * Resolve the row total first so the viewport can settle its anchor, then
   * render only the rows it asks for. Callers that need the whole transcript
   * use render(), which is this with a full-height window.
   */
  beginFrame(
    document: AgentTranscriptDocument,
    width: number,
    theme: Theme,
    options?: { readonly now?: number; readonly expanded?: boolean },
  ): AgentTranscriptFrame {
    if (document.toolRenderer) this.toolRenderers.add(document.toolRenderer);
    const context = renderContext(document, width, options);
    const layout = this.layout(document, theme, context);
    // The live tail is re-rendered every frame by definition: it is the part of
    // the transcript that changes on each stream tick.
    const tail = this.renderTail(document, theme, context);
    const itemRows = () => layout.offsets[layout.length] ?? 0;
    const rowCount = itemRows() + tail.length;

    return {
      rowCount,
      rows: (top: number, height: number, overscan?: number) => {
        const from = Math.max(0, top);
        const to = Math.min(rowCount, from + Math.max(0, height));
        if (to <= from) return [];

        // A visible item that no longer matches what was measured means the
        // offsets this slice was cut against are wrong. Repair and retry within
        // the same frame rather than emitting rows the operator would see move.
        let out = this.collectRows(
          document,
          layout,
          theme,
          context,
          from,
          Math.min(to, itemRows()),
        );
        if (out === undefined) {
          this.resum(layout);
          out =
            this.collectRows(
              document,
              layout,
              theme,
              context,
              from,
              Math.min(to, itemRows()),
            ) ?? [];
        }

        const tailStart = itemRows();
        for (
          let row = Math.max(0, from - tailStart);
          row < to - tailStart;
          row++
        ) {
          const line = tail[row];
          if (line !== undefined) out.push(line);
        }

        this.warmOverscan(
          document,
          layout,
          theme,
          context,
          from,
          to,
          overscan ?? DEFAULT_OVERSCAN_ROWS,
        );
        return out;
      },
    };
  }

  render(
    document: AgentTranscriptDocument,
    width: number,
    theme: Theme,
    options?: { readonly now?: number; readonly expanded?: boolean },
  ) {
    const frame = this.beginFrame(document, width, theme, options);
    return frame.rows(0, frame.rowCount, 0);
  }

  /**
   * Rows [from, to) of the items block, or undefined when a visible item no
   * longer matches what was measured and the layout must be re-summed first.
   *
   * The two known ways a height can go stale are caught before the row total is
   * published: in-place replacement by itemsUnmoved, and unrevisioned native
   * output by remeasureUnrevisioned. No test reaches this check (verified by
   * sentinel injection across every suite that renders a transcript), so it is
   * a last-resort guard for a cache-key input nobody has enumerated yet. It is
   * deliberately kept rather than deleted: the failure it prevents is a
   * misaligned viewport, and repairing costs one extra pass over the window
   * while removing it would make that misalignment permanent for the frame.
   */
  private collectRows(
    document: AgentTranscriptDocument,
    layout: TranscriptLayout,
    theme: Theme,
    context: RenderContext,
    from: number,
    to: number,
  ) {
    const out: string[] = [];
    if (to <= from) return out;
    for (
      let index = itemAtRow(layout.offsets, from);
      index < layout.length;
      index++
    ) {
      const start = layout.offsets[index] ?? 0;
      if (start >= to) break;
      const lines = this.itemLines(document, index, theme, context);
      // Identity is the cause, height is the symptom; either one means these
      // offsets no longer describe the document.
      if (
        layout.measured[index] !== document.items[index] ||
        lines.length !== layout.heights[index]
      ) {
        layout.measured[index] = document.items[index];
        layout.heights[index] = lines.length;
        return undefined;
      }
      const sliceFrom = Math.max(0, from - start);
      const sliceTo = Math.min(lines.length, to - start);
      for (let row = sliceFrom; row < sliceTo; row++) out.push(lines[row]!);
    }
    return out;
  }

  /** Rebuild the prefix sums from recorded heights. No item is re-rendered. */
  private resum(layout: TranscriptLayout) {
    for (let index = 0; index < layout.length; index++) {
      layout.offsets[index + 1] =
        (layout.offsets[index] ?? 0) + (layout.heights[index] ?? 0);
    }
  }

  /**
   * Pre-render cacheable neighbours so a scroll step reuses rows instead of
   * rendering them under the operator's keypress. Items drawn by a native
   * renderer without revisions are skipped: they cannot be cached, so warming
   * them would be pure overhead.
   */
  private warmOverscan(
    document: AgentTranscriptDocument,
    layout: TranscriptLayout,
    theme: Theme,
    context: RenderContext,
    from: number,
    to: number,
    overscan: number,
  ) {
    if (overscan <= 0 || layout.length === 0) return;
    const start = Math.max(0, from - overscan);
    const end = Math.min(layout.offsets[layout.length] ?? 0, to + overscan);
    for (
      let index = itemAtRow(layout.offsets, start);
      index < layout.length;
      index++
    ) {
      const itemStart = layout.offsets[index] ?? 0;
      if (itemStart >= end) break;
      if (itemStart >= from && itemStart < to) continue;
      const item = document.items[index];
      if (!item) break;
      if (!this.cacheable(document, item)) continue;
      this.itemLines(document, index, theme, context);
    }
  }

  /**
   * Without a revision the native output can change silently, so those items
   * are re-rendered every frame exactly as they were before windowing.
   */
  private cacheable(
    document: AgentTranscriptDocument,
    item: AgentTranscriptItem,
  ) {
    return (
      !document.toolRenderer ||
      !itemHasTool(item) ||
      document.toolRenderer.revision !== undefined
    );
  }

  private itemKey(
    document: AgentTranscriptDocument,
    item: AgentTranscriptItem,
    index: number,
    context: RenderContext,
  ) {
    const itemContextValue = itemContext(
      document.items,
      index,
      context.liveIds,
      context.pairing,
    );
    return {
      context: itemContextValue,
      key: `${context.keyPrefix}|${itemContextValue.token}${toolRevisionToken(item, document.toolRenderer)}`,
    };
  }

  /** Rows for one item, reusing the identity+context cache where allowed. */
  private itemLines(
    document: AgentTranscriptDocument,
    index: number,
    theme: Theme,
    context: RenderContext,
  ): string[] {
    const item = document.items[index];
    if (!item) return [];
    const { context: itemContextValue, key } = this.itemKey(
      document,
      item,
      index,
      context,
    );
    const cacheable = this.cacheable(document, item);
    const cached = cacheable ? this.itemCache.get(item)?.get(key) : undefined;
    if (cached) return cached;
    const lines = renderTranscriptItem(
      theme,
      item,
      context.width,
      itemContextValue,
      context.now,
      document.cwd,
      document.toolRenderer,
      context.expanded,
    );
    if (cacheable) this.remember(this.itemCache, item, key, lines);
    this.remember(this.heightCache, item, key, lines.length);
    return lines;
  }

  /** Bounded per-item cache: a child page is read at one or two widths. */
  private remember<T>(
    cache: WeakMap<AgentTranscriptItem, Map<string, T>>,
    item: AgentTranscriptItem,
    key: string,
    value: T,
  ) {
    const keyed = cache.get(item) ?? new Map<string, T>();
    if (keyed.size >= MAX_CACHED_WIDTHS_PER_ITEM && !keyed.has(key)) {
      const oldest = keyed.keys().next().value;
      if (oldest !== undefined) keyed.delete(oldest);
    }
    keyed.set(key, value);
    cache.set(item, keyed);
  }

  /**
   * Height of one item, measured once per identity+context and then reused.
   * Measuring is a render, so this is only paid for genuinely new rows.
   */
  private itemHeight(
    document: AgentTranscriptDocument,
    index: number,
    theme: Theme,
    context: RenderContext,
  ) {
    const item = document.items[index];
    if (!item) return 0;
    const { key } = this.itemKey(document, item, index, context);
    const cached = this.heightCache.get(item)?.get(key);
    if (cached !== undefined) return cached;
    return this.itemLines(document, index, theme, context).length;
  }

  /**
   * Row offsets for the items block. Appends extend the cached prefix sums, a
   * native tool update re-measures only the items that reference it, and
   * anything else (front trimming from compaction, width, expansion, or theme
   * change) re-sums from cached heights without re-rendering settled rows.
   */
  private layout(
    document: AgentTranscriptDocument,
    theme: Theme,
    context: RenderContext,
  ): TranscriptLayout {
    const items = document.items;
    const toolGeneration = document.toolRenderer?.generation?.() ?? 0;
    const cached = this.layoutCache.get(items);
    // A document that carries its own pairing index rebuilds it on mutation, so
    // identity settles content in O(1). Without one, fall back to comparing the
    // measured items, which is the same order of growth as building the index.
    const trusted = document.pairing !== undefined;
    const reusable =
      cached !== undefined &&
      cached.keyPrefix === context.keyPrefix &&
      cached.liveKey === context.liveKey &&
      cached.generation === this.generation &&
      (trusted
        ? cached.pairing === context.pairing
        : this.itemsUnmoved(cached, items));

    if (reusable) {
      if (
        cached.length === items.length &&
        cached.last === items[items.length - 1]
      ) {
        this.settleToolRows(cached, document, theme, context, toolGeneration);
        this.remeasureUnrevisioned(cached, document, theme, context);
        return cached;
      }
      // Append-only growth keeps every preceding offset valid.
      if (
        items.length > cached.length &&
        cached.last === items[cached.length - 1]
      ) {
        this.settleToolRows(cached, document, theme, context, toolGeneration);
        for (let index = cached.length; index < items.length; index++) {
          const item = items[index];
          if (!item) break;
          const metrics = this.itemHeight(document, index, theme, context);
          cached.heights[index] = metrics;
          cached.measured[index] = item;
          if (itemHasTool(item)) {
            cached.toolItems.push(index);
            cached.toolTokens.push(
              toolRevisionToken(item, document.toolRenderer),
            );
          }
        }
        cached.length = items.length;
        cached.last = items[items.length - 1];
        this.remeasureUnrevisioned(cached, document, theme, context);
        this.resum(cached);
        return cached;
      }
    }

    const heights: number[] = [];
    const measured: Array<AgentTranscriptItem | undefined> = [];
    const offsets: number[] = [0];
    const toolItems: number[] = [];
    const toolTokens: string[] = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (!item) break;
      const height = this.itemHeight(document, index, theme, context);
      heights.push(height);
      measured.push(item);
      offsets.push((offsets[index] ?? 0) + height);
      if (itemHasTool(item)) {
        toolItems.push(index);
        toolTokens.push(toolRevisionToken(item, document.toolRenderer));
      }
    }
    const layout: TranscriptLayout = {
      keyPrefix: context.keyPrefix,
      liveKey: context.liveKey,
      generation: this.generation,
      pairing: context.pairing,
      length: items.length,
      last: items[items.length - 1],
      offsets,
      heights,
      measured,
      toolItems,
      toolTokens,
      toolGeneration,
    };
    this.layoutCache.set(items, layout);
    return layout;
  }

  /**
   * A renderer without revision() can change its native output with no cache
   * key movement, so those heights cannot be trusted between frames. They are
   * re-measured here, before the row total is published, rather than being
   * discovered mid-slice once the total is already wrong.
   *
   * These items are also uncached, so this is the same per-frame work the
   * pre-windowing renderer already did for them, restricted to tool items.
   */
  private remeasureUnrevisioned(
    layout: TranscriptLayout,
    document: AgentTranscriptDocument,
    theme: Theme,
    context: RenderContext,
  ) {
    if (!document.toolRenderer || document.toolRenderer.revision) return;
    let moved = false;
    for (const index of layout.toolItems) {
      if (index >= layout.length) continue;
      const item = document.items[index];
      if (!item) continue;
      // The recorded height is keyed on inputs that did not move, so it would
      // just echo the stale value. Render to find the current height.
      const lines = this.itemLines(document, index, theme, context);
      if (lines.length === layout.heights[index]) continue;
      layout.heights[index] = lines.length;
      layout.measured[index] = item;
      moved = true;
    }
    if (!moved) return;
    this.resum(layout);
  }

  /**
   * Whether every already-measured slot still holds the item it was measured
   * from. Endpoint checks catch appends and front trimming, but a same-length
   * in-place replacement moves rows without moving either endpoint, and the row
   * total is published before any slice is cut, so it has to be caught here.
   *
   * Only reached when the document omits a pairing index: producers that supply
   * one rebuild it on every transcript mutation, which makes pairing identity an
   * O(1) proxy for this walk. Callers without an index already pay O(n) to build
   * one, so this walk adds no order of growth.
   */
  private itemsUnmoved(
    layout: TranscriptLayout,
    items: ReadonlyArray<AgentTranscriptItem>,
  ) {
    const checked = Math.min(layout.length, items.length);
    for (let index = 0; index < checked; index++) {
      if (layout.measured[index] !== items[index]) return false;
    }
    return true;
  }

  /**
   * Re-measure only the items whose native tool output moved. Revision lookups
   * are map reads, so a streaming tool costs its own rows plus prefix-sum
   * arithmetic instead of a fresh pass over settled history.
   */
  private settleToolRows(
    layout: TranscriptLayout,
    document: AgentTranscriptDocument,
    theme: Theme,
    context: RenderContext,
    toolGeneration: number,
  ) {
    if (layout.toolGeneration === toolGeneration) return;
    layout.toolGeneration = toolGeneration;
    let moved = false;
    for (let slot = 0; slot < layout.toolItems.length; slot++) {
      const index = layout.toolItems[slot];
      if (index === undefined || index >= layout.length) continue;
      const item = document.items[index];
      if (!item) continue;
      const token = toolRevisionToken(item, document.toolRenderer);
      if (token === layout.toolTokens[slot]) continue;
      layout.toolTokens[slot] = token;
      const metrics = this.itemHeight(document, index, theme, context);
      layout.heights[index] = metrics;
      layout.measured[index] = item;
      moved = true;
    }
    if (!moved) return;
    this.resum(layout);
  }

  private renderTail(
    document: AgentTranscriptDocument,
    theme: Theme,
    context: RenderContext,
  ) {
    const out: string[] = [];
    const { width, now, expanded } = context;
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
    for (const tool of document.liveTools ?? []) {
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
    this.heightCache = new WeakMap();
    this.layoutCache = new WeakMap();
    this.generation++;
    for (const renderer of this.toolRenderers) renderer.invalidate?.();
    this.toolRenderers.clear();
  }
}
