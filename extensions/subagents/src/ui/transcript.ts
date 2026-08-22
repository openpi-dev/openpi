/**
 * Transcript rendering for the takeover view: turns a SubagentSnapshot's
 * normalized transcript + live state into width-bounded TUI lines. The domain
 * stream stays normalized and bounded; this renderer only formats its previews.
 */

import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type DefaultTextStyle,
  type MarkdownOptions,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../../shared/terminal-text.ts";
import type { SubagentSnapshot, TranscriptItem } from "../domain.ts";

const MAX_CACHED_WIDTHS_PER_ITEM = 2;

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

/** Frame cadence, shared with the dashboard and takeover headers. */
export const SPINNER_INTERVAL_MS = 120;

export function spinnerFrame(now: number) {
  const frame = Math.floor(now / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[
    (frame + SPINNER_FRAMES.length) % SPINNER_FRAMES.length
  ];
}

/**
 * Strip raw ANSI codes, expand tabs, and drop control chars. Terminal-expanded
 * tabs (and stray escapes) make lines wider than the width we declare to the
 * TUI, which desyncs the renderer and smears the overlay.
 */
export function sanitizeText(text: string): string {
  return sanitizeTerminalText(text);
}

function singleLinePreview(text: string) {
  // Keep meaningful whitespace inside parsed commands and paths; only fold
  // physical line breaks so a preview remains one terminal row.
  return sanitizeText(text).replace(/\r?\n/g, " ↵ ");
}

function compactPreview(text: string) {
  return singleLinePreview(text).trim();
}

function stringField(value: Record<string, unknown>, field: string) {
  const candidate = value[field];
  return typeof candidate === "string" && candidate.length > 0
    ? singleLinePreview(candidate)
    : undefined;
}

function parsedArgs(preview: string) {
  try {
    const value: unknown = JSON.parse(preview);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Turn common tool arguments into a useful, bounded summary without retaining raw args. */
export function summarizeToolArgs(
  name: string,
  argsPreview?: string,
  cwd?: string,
) {
  if (!argsPreview) return undefined;

  const fallback = compactPreview(argsPreview);
  if (!fallback || fallback === "{}") return undefined;

  const args = parsedArgs(fallback);
  if (!args) return fallback;

  const path = (field: string) => {
    const value = stringField(args, field);
    return value ? relativeToCwd(value, cwd) : undefined;
  };

  const tool = name.toLowerCase();
  if (tool === "bash") return stringField(args, "command") ?? fallback;
  if (tool === "read" || tool === "write" || tool === "edit") {
    return path("path") ?? fallback;
  }
  if (tool === "rg" || tool === "fd") {
    const pattern = stringField(args, "pattern");
    const searchPath = path("path");
    if (pattern && searchPath) return `${pattern} · ${searchPath}`;
    return pattern ?? searchPath ?? fallback;
  }
  return fallback;
}

/** Absolute paths inside the child's own checkout read as noise; relativize. */
function relativeToCwd(path: string, cwd?: string) {
  if (!cwd) return path;
  if (path === cwd) return ".";
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
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

function renderToolBody(
  theme: Theme,
  name: string,
  argsPreview?: string,
  cwd?: string,
) {
  const toolName = sanitizeText(name);
  const preview = summarizeToolArgs(toolName, argsPreview, cwd);
  // The `$` form only earns its prompt when there is a command to show; a bare
  // `$ ` would read as an empty shell line.
  if (toolName === "bash" && preview) return theme.fg("dim", `$ ${preview}`);
  return (
    theme.fg("toolTitle", toolName) +
    (preview ? theme.fg("dim", ` ${preview}`) : "")
  );
}

function firstOutputPreview(outputPreview?: string) {
  return (
    sanitizeText(outputPreview ?? "")
      .split("\n")
      .find((line) => line.trim()) ?? ""
  );
}

/**
 * One execution owns exactly one glyph column, on its command line. Output
 * lines are plain indented text so a block keeps identical columns from the
 * moment the command starts to the moment it settles.
 */
export type ToolPhase = "live" | "ok" | "error" | "pending";

function phaseGlyph(theme: Theme, phase: ToolPhase, now: number) {
  switch (phase) {
    case "live":
      return theme.fg("warning", spinnerFrame(now));
    case "ok":
      return theme.fg("success", "✓");
    case "error":
      return theme.fg("error", "✗");
    case "pending":
      return theme.fg("dim", "·");
  }
}

/** Command line: `<glyph> $ cmd` for bash, `<glyph> name args` otherwise. */
function renderToolLine(
  theme: Theme,
  phase: ToolPhase,
  name: string,
  argsPreview: string | undefined,
  width: number,
  now: number,
  cwd?: string,
) {
  return truncateToWidth(
    `${phaseGlyph(theme, phase, now)} ${renderToolBody(theme, name, argsPreview, cwd)}`,
    width,
  );
}

/** Output line: indented under the command, no second glyph. */
function renderOutputLine(
  theme: Theme,
  isError: boolean,
  outputPreview: string,
  width: number,
  cwd?: string,
) {
  // Tool output echoes the absolute search path back (fd/rg print what they
  // were given); inside the child's own checkout the relative form is enough.
  const text = cwd ? outputPreview.split(`${cwd}/`).join("") : outputPreview;
  const preview = text || "(no output)";
  const content = isError
    ? theme.fg(text ? "error" : "dim", preview)
    : theme.fg("dim", preview);
  return truncateToWidth(`    ${content}`, width);
}

function renderAssistantItem(
  theme: Theme,
  item: Extract<TranscriptItem, { kind: "assistant" }>,
  width: number,
  phases: ReadonlyMap<string, ToolPhase>,
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
      const phase = phases.get(part.toolId) ?? "pending";
      // A live tool is rendered by the live block, which owns the spinner and
      // the streaming output; rendering the call here too would show the same
      // command twice and make the block reflow when the tool settles.
      if (phase === "live") continue;
      out.push(
        renderToolLine(
          theme,
          phase,
          part.name,
          part.argsPreview,
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
  item: Extract<TranscriptItem, { kind: "toolResult" }>,
  width: number,
  paired: boolean,
  now: number,
  cwd?: string,
) {
  const preview = firstOutputPreview(item.outputPreview);
  // An orphan result (its call is not the previous item) still needs a glyph:
  // there is no command line above it to carry one.
  if (!paired) {
    return [
      renderToolLine(
        theme,
        item.isError ? "error" : "ok",
        item.name,
        undefined,
        width,
        now,
      ),
      ...(preview
        ? [renderOutputLine(theme, item.isError, preview, width, cwd)]
        : []),
    ];
  }
  return [renderOutputLine(theme, item.isError, preview, width, cwd)];
}

function isPairedToolResult(
  previous: TranscriptItem | undefined,
  current: TranscriptItem,
) {
  if (
    !previous ||
    previous.kind !== "assistant" ||
    current.kind !== "toolResult"
  ) {
    return false;
  }
  const lastPart = previous.parts[previous.parts.length - 1];
  return lastPart?.type === "toolCall" && lastPart.toolId === current.toolId;
}

function renderTranscriptItem(
  theme: Theme,
  item: TranscriptItem,
  width: number,
  context: ItemContext,
  now: number,
  cwd?: string,
) {
  if (item.kind === "user") return renderUserText(theme, item.text, width);
  if (item.kind === "assistant") {
    return renderAssistantItem(theme, item, width, context.phases, now, cwd);
  }
  return renderToolResultItem(theme, item, width, context.paired, now, cwd);
}

interface ItemContext {
  readonly phases: ReadonlyMap<string, ToolPhase>;
  readonly paired: boolean;
  /** Cache discriminator: identity plus width is not enough on its own. */
  readonly token: string;
}

/**
 * An item's rendering depends on its neighbours (does a call have its result
 * yet?) and on live state (is the call still running?), so the cache key has to
 * carry that context or a stale glyph would outlive the phase it described.
 */
function itemContext(
  transcript: ReadonlyArray<TranscriptItem>,
  index: number,
  liveIds: ReadonlySet<string>,
): ItemContext {
  const item = transcript[index]!;
  if (item.kind === "user")
    return { phases: new Map(), paired: false, token: "" };
  if (item.kind === "toolResult") {
    const paired = isPairedToolResult(transcript[index - 1], item);
    return { phases: new Map(), paired, token: paired ? "p" : "o" };
  }

  const phases = new Map<string, ToolPhase>();
  for (const part of item.parts) {
    if (part.type !== "toolCall") continue;
    if (liveIds.has(part.toolId)) {
      phases.set(part.toolId, "live");
      continue;
    }
    const result = findResult(transcript, index, part.toolId);
    phases.set(
      part.toolId,
      result ? (result.isError ? "error" : "ok") : "pending",
    );
  }
  return {
    phases,
    paired: false,
    token: [...phases].map(([id, phase]) => `${id}:${phase}`).join(","),
  };
}

/** The result for a call, if it has already landed later in the transcript. */
function findResult(
  transcript: ReadonlyArray<TranscriptItem>,
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
export class TranscriptRenderer {
  private itemCache = new WeakMap<TranscriptItem, Map<string, string[]>>();

  render(
    snap: SubagentSnapshot,
    width: number,
    theme: Theme,
    options?: { readonly now?: number },
  ) {
    const out: string[] = [];
    const now = options?.now ?? Date.now();
    const liveIds = new Set(snap.liveTools.map((tool) => tool.toolId));

    for (let index = 0; index < snap.transcript.length; index++) {
      const item = snap.transcript[index];
      const context = itemContext(snap.transcript, index, liveIds);
      const key = `${width}|${context.token}`;
      const cached = this.itemCache.get(item)?.get(key);
      const lines =
        cached ??
        renderTranscriptItem(theme, item, width, context, now, snap.cwd);
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
        if (
          out.length > 0 &&
          !isPairedToolResult(snap.transcript[index - 1], item)
        ) {
          out.push("");
        }
        out.push(...lines);
      }
    }
    while (out.length > 0 && out[out.length - 1] === "") out.pop();

    // Live streaming assistant buffers (cleared when the finalized message lands).
    if (snap.liveAssistant) {
      const { thinking, text } = snap.liveAssistant;
      const before = out.length;
      if (out.length > 0) out.push("");
      if (thinking.trim()) out.push(...renderThinking(theme, thinking, width));
      if (text.trim()) out.push(...renderMarkdown(text, width));
      if (out.length === before + 1) out.pop();
    }

    // Live tool executions. The manager drops a live entry when its ToolEnd
    // lands, and the transcript's call line then takes over with the settled
    // glyph in the same column, so the block never reflows.
    for (const tool of snap.liveTools) {
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
          width,
          now,
          snap.cwd,
        ),
      );
      const preview = firstOutputPreview(tool.outputPreview);
      if (preview)
        out.push(
          renderOutputLine(theme, !!tool.isError, preview, width, snap.cwd),
        );
    }

    // Queued steering/follow-up messages: show them immediately so Enter
    // visibly acknowledges the user's input instead of appearing to do nothing.
    for (const message of snap.queued) {
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

/** Render a subagent's conversation as width-bounded lines. */
export function buildTranscriptLines(
  snap: SubagentSnapshot,
  width: number,
  theme: Theme,
  renderer?: TranscriptRenderer,
  options?: { readonly now?: number },
) {
  return (renderer ?? new TranscriptRenderer()).render(
    snap,
    width,
    theme,
    options,
  );
}
