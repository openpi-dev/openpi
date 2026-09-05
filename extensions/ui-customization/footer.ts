import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  hyperlink,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type {
  FooterItem,
  FooterLayoutItem,
  FooterLines,
  FooterStyle,
} from "../shared/setup-config.ts";
import type {
  GitInfoState,
  ModelInfoState,
} from "../shared/dashboard-state.ts";

// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

const RESET = "\x1b[0m";
const POWERLINE_ARROW = "\ue0b0"; //  — decorative; text remains readable without Nerd Font
const MODEL_ICON = "\uec10"; // Codicon: sparkle
const CONTEXT_ICON = "\uebe4"; // Codicon: pie-chart
const DIRECTORY_ICON = "\uea83"; // Codicon: folder

/** Higher = keep longer when the line is too narrow. */
const PRIORITY: Record<FooterItem, number> = {
  cwd: 100,
  model: 95,
  context: 90,
  git: 80,
  pr: 75,
  thinking: 70,
  cost: 40,
  cache: 35,
  throughput: 30,
};

interface PowerlineColors {
  fg: number;
  bg: number;
}

const POWERLINE_COLORS: Record<FooterItem, PowerlineColors> = {
  cwd: { fg: 231, bg: 33 },
  model: { fg: 231, bg: 61 },
  thinking: { fg: 231, bg: 97 },
  context: { fg: 231, bg: 64 },
  cache: { fg: 16, bg: 37 },
  cost: { fg: 16, bg: 136 },
  throughput: { fg: 231, bg: 66 },
  git: { fg: 231, bg: 239 },
  pr: { fg: 231, bg: 25 },
};

const MONO_COLORS: readonly PowerlineColors[] = [
  { fg: 231, bg: 240 },
  { fg: 16, bg: 252 },
  { fg: 231, bg: 236 },
  { fg: 16, bg: 250 },
  { fg: 231, bg: 238 },
  { fg: 16, bg: 248 },
  { fg: 231, bg: 242 },
  { fg: 16, bg: 254 },
  { fg: 231, bg: 244 },
];

export type SegmentTone =
  | "text"
  | "muted"
  | "dim"
  | "warning"
  | "error"
  | "accent";

export interface FooterSegment {
  readonly id: FooterItem;
  readonly text: string;
  readonly priority: number;
  readonly tone: SegmentTone;
  readonly fg: number;
  readonly bg: number;
}

export interface FooterRenderOptions {
  readonly cwd: string;
  readonly modelInfo: ModelInfoState;
  readonly gitInfo: GitInfoState;
  readonly style: FooterStyle;
  readonly lines: FooterLines;
  readonly width: number;
  readonly theme: Pick<Theme, "fg">;
  readonly formatPullRequest?: (number: number, url: string) => string;
  readonly statuses?: Iterable<string>;
}

function sanitizeTerminalLabel(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

export function formatTokens(tokens: number) {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

export function formatDirectory(
  cwd: string,
  home = homedir(),
  pathModule = process.platform === "win32" ? win32 : posix,
) {
  const relativePath = pathModule.relative(home, cwd);
  const outsideHome =
    relativePath === ".." ||
    relativePath.startsWith(`..${pathModule.sep}`) ||
    pathModule.isAbsolute(relativePath);
  const display = outsideHome
    ? cwd
    : relativePath
      ? `~/${relativePath.replaceAll(pathModule.sep, "/")}`
      : "~";
  return sanitizeTerminalLabel(display);
}

function contextTone(percent: number | null): SegmentTone {
  if (percent === null) return "muted";
  if (percent >= 90) return "error";
  if (percent >= 70) return "warning";
  return "muted";
}

function contextBg(percent: number | null, base: number) {
  if (percent === null) return base;
  if (percent >= 90) return 160;
  if (percent >= 70) return 178;
  return base;
}

function ansi256(fg: number, bg: number, text: string) {
  return `\x1b[38;5;${fg};48;5;${bg}m${text}${RESET}`;
}

function ansi256FgBg(fg: number, bg: number | null, text: string) {
  if (bg === null) return `\x1b[38;5;${fg}m${text}${RESET}`;
  return `\x1b[38;5;${fg};48;5;${bg}m${text}${RESET}`;
}

function defaultPullRequest(number: number, url: string) {
  const label = `PR #${number}`;
  return getCapabilities().hyperlinks ? hyperlink(label, url) : label;
}

/**
 * Build the value catalog for every FooterItem. Empty text means "not available
 * right now" and the segment is omitted from the line.
 */
export function buildSegmentCatalog(
  cwd: string,
  modelInfo: ModelInfoState,
  gitInfo: GitInfoState,
  formatPullRequest: (
    number: number,
    url: string,
  ) => string = defaultPullRequest,
): Record<FooterItem, { text: string; tone: SegmentTone }> {
  const contextWindow =
    modelInfo.contextWindow > 0 ? formatTokens(modelInfo.contextWindow) : "";
  const contextText =
    modelInfo.contextPercent === null
      ? contextWindow
        ? // Occupancy is unknown right after compaction, until the next reply.
          `?%/${contextWindow}`
        : ""
      : `${Math.round(modelInfo.contextPercent)}%${contextWindow ? `/${contextWindow}` : ""}`;

  const modelText = modelInfo.provider
    ? `${modelInfo.provider}/${modelInfo.modelId}`
    : modelInfo.modelId;

  return {
    cwd: { text: `${DIRECTORY_ICON} ${formatDirectory(cwd)}`, tone: "text" },
    model: { text: `${MODEL_ICON} ${modelText}`, tone: "muted" },
    thinking: { text: modelInfo.thinking, tone: "muted" },
    context: {
      text: contextText ? `${CONTEXT_ICON} ${contextText}` : "",
      tone: contextTone(modelInfo.contextPercent),
    },
    cache: {
      text:
        modelInfo.cachePercent !== null
          ? `cache ${Math.round(modelInfo.cachePercent)}%`
          : "",
      tone: "muted",
    },
    cost: { text: `$${modelInfo.cost.toFixed(2)}`, tone: "muted" },
    throughput: {
      text:
        modelInfo.tokensPerSecond === null
          ? "— tok/s"
          : `~${Math.round(modelInfo.tokensPerSecond)} tok/s`,
      tone: "muted",
    },
    git: { text: gitInfo.branch ? `⎇ ${gitInfo.branch}` : "", tone: "muted" },
    pr: {
      text: gitInfo.pullRequest
        ? formatPullRequest(gitInfo.pullRequest.number, gitInfo.pullRequest.url)
        : "",
      tone: "accent",
    },
  };
}

function colorsFor(
  id: FooterItem,
  style: FooterStyle,
  index: number,
  contextPercent: number | null,
): PowerlineColors {
  if (style === "powerline-mono") {
    return MONO_COLORS[index % MONO_COLORS.length]!;
  }
  const base = POWERLINE_COLORS[id];
  if (id === "context") {
    return { fg: base.fg, bg: contextBg(contextPercent, base.bg) };
  }
  return base;
}

export function resolveLineSegments(
  layout: readonly FooterLayoutItem[],
  catalog: ReturnType<typeof buildSegmentCatalog>,
  style: FooterStyle,
  contextPercent: number | null,
): { left: FooterSegment[]; right: FooterSegment[] } {
  const left: FooterSegment[] = [];
  const right: FooterSegment[] = [];
  let side: FooterSegment[] = left;
  let colorIndex = 0;

  for (const item of layout) {
    if (item === "flex") {
      side = right;
      continue;
    }
    const entry = catalog[item];
    if (!entry.text) continue;
    const colors = colorsFor(item, style, colorIndex, contextPercent);
    colorIndex += 1;
    side.push({
      id: item,
      text: entry.text,
      priority: PRIORITY[item],
      tone: entry.tone,
      fg: colors.fg,
      bg: colors.bg,
    });
  }

  return { left, right };
}

function paintPlain(segment: FooterSegment, theme: Pick<Theme, "fg">) {
  return theme.fg(segment.tone, segment.text);
}

function joinPlain(
  segments: readonly FooterSegment[],
  theme: Pick<Theme, "fg">,
) {
  return segments
    .map((segment) => paintPlain(segment, theme))
    .join(theme.fg("dim", " · "));
}

function renderPowerlineSide(segments: readonly FooterSegment[]) {
  if (segments.length === 0) return "";

  let output = "";
  for (let index = 0; index < segments.length; index += 1) {
    const current = segments[index]!;
    output += ansi256(current.fg, current.bg, ` ${current.text} `);
    const next = segments[index + 1];
    if (next) {
      // Arrow inherits previous bg as fg and next bg as bg — classic powerline seam.
      output += ansi256FgBg(current.bg, next.bg, POWERLINE_ARROW);
    }
  }
  const last = segments[segments.length - 1]!;
  output += ansi256FgBg(last.bg, null, POWERLINE_ARROW);
  return output;
}

function renderPowerlineLine(
  left: readonly FooterSegment[],
  right: readonly FooterSegment[],
  width: number,
) {
  const leftText = renderPowerlineSide(left);
  const rightText = renderPowerlineSide(right);
  if (!rightText) return truncateToWidth(leftText, width);
  if (!leftText) return truncateToWidth(rightText, width);

  const gap = width - visibleWidth(leftText) - visibleWidth(rightText);
  if (gap >= 1) {
    return truncateToWidth(`${leftText}${" ".repeat(gap)}${rightText}`, width);
  }
  return truncateToWidth(`${leftText}${" ".repeat(1)}${rightText}`, width);
}

function renderPlainLine(
  left: readonly FooterSegment[],
  right: readonly FooterSegment[],
  width: number,
  theme: Pick<Theme, "fg">,
) {
  const leftText = joinPlain(left, theme);
  const rightText = joinPlain(right, theme);
  if (!rightText) return truncateToWidth(leftText, width);
  if (!leftText) return truncateToWidth(rightText, width);

  const naturalGap = width - visibleWidth(leftText) - visibleWidth(rightText);
  if (naturalGap >= 1) {
    return `${leftText}${" ".repeat(naturalGap)}${rightText}`;
  }

  const leftWidth = Math.max(1, Math.floor(width * 0.45));
  const rightWidth = Math.max(1, width - leftWidth - 1);
  const fittedLeft = truncateToWidth(leftText, leftWidth);
  const fittedRight = truncateToWidth(rightText, rightWidth);
  const gap = Math.max(
    1,
    width - visibleWidth(fittedLeft) - visibleWidth(fittedRight),
  );
  return truncateToWidth(
    `${fittedLeft}${" ".repeat(gap)}${fittedRight}`,
    width,
  );
}

function naturalLineWidth(
  left: readonly FooterSegment[],
  right: readonly FooterSegment[],
  style: FooterStyle,
  theme: Pick<Theme, "fg">,
) {
  if (style === "plain") {
    const leftText = joinPlain(left, theme);
    const rightText = joinPlain(right, theme);
    if (!rightText) return visibleWidth(leftText);
    if (!leftText) return visibleWidth(rightText);
    return visibleWidth(leftText) + 1 + visibleWidth(rightText);
  }
  const leftText = renderPowerlineSide(left);
  const rightText = renderPowerlineSide(right);
  if (!rightText) return visibleWidth(leftText);
  if (!leftText) return visibleWidth(rightText);
  return visibleWidth(leftText) + 1 + visibleWidth(rightText);
}

/**
 * Drop lowest-priority optional segments until the line fits, keeping at least
 * one segment on each non-empty side. Final safety truncate is still applied.
 */
export function fitSegmentsToWidth(
  left: readonly FooterSegment[],
  right: readonly FooterSegment[],
  width: number,
  style: FooterStyle,
  theme: Pick<Theme, "fg">,
): { left: FooterSegment[]; right: FooterSegment[] } {
  let nextLeft = [...left];
  let nextRight = [...right];

  const fits = () =>
    naturalLineWidth(nextLeft, nextRight, style, theme) <= width;

  while (!fits()) {
    const candidates: {
      side: "left" | "right";
      index: number;
      priority: number;
    }[] = [];
    if (nextLeft.length > 1) {
      for (let index = 0; index < nextLeft.length; index += 1) {
        candidates.push({
          side: "left",
          index,
          priority: nextLeft[index]!.priority,
        });
      }
    } else if (nextLeft.length === 1 && nextRight.length === 0) {
      // Single side with one segment — stop hiding; truncate will handle it.
      break;
    }
    if (nextRight.length > 1) {
      for (let index = 0; index < nextRight.length; index += 1) {
        candidates.push({
          side: "right",
          index,
          priority: nextRight[index]!.priority,
        });
      }
    } else if (nextRight.length === 1 && nextLeft.length === 0) {
      break;
    }

    // When each side has exactly one segment, we can still drop from the
    // lower-priority side if the other side remains non-empty… but the rule
    // is "each non-empty side keeps ≥1", so with one each we stop.
    if (candidates.length === 0) break;

    candidates.sort((a, b) => a.priority - b.priority || b.index - a.index);
    const victim = candidates[0]!;
    if (victim.side === "left") nextLeft.splice(victim.index, 1);
    else nextRight.splice(victim.index, 1);
  }

  return { left: nextLeft, right: nextRight };
}

export function renderFooterLine(
  layout: readonly FooterLayoutItem[],
  catalog: ReturnType<typeof buildSegmentCatalog>,
  style: FooterStyle,
  width: number,
  theme: Pick<Theme, "fg">,
  contextPercent: number | null,
) {
  const resolved = resolveLineSegments(layout, catalog, style, contextPercent);
  const fitted = fitSegmentsToWidth(
    resolved.left,
    resolved.right,
    width,
    style,
    theme,
  );
  if (fitted.left.length === 0 && fitted.right.length === 0) return "";

  if (style === "plain") {
    return renderPlainLine(fitted.left, fitted.right, width, theme);
  }
  return renderPowerlineLine(fitted.left, fitted.right, width);
}

export function renderFooter(options: FooterRenderOptions) {
  const formatPullRequest = options.formatPullRequest ?? defaultPullRequest;
  const catalog = buildSegmentCatalog(
    options.cwd,
    options.modelInfo,
    options.gitInfo,
    formatPullRequest,
  );
  const lines: string[] = [];
  const statusLines = options.statuses
    ? Array.from(options.statuses).flatMap((status) => status.split("\n"))
    : [];
  const singleStatus = statusLines.length === 1 ? statusLines[0] : undefined;
  const separator = options.theme.fg("dim", " · ");
  const styledStatus =
    singleStatus === undefined
      ? undefined
      : options.theme.fg("dim", singleStatus);
  const statusWidth =
    styledStatus === undefined
      ? 0
      : visibleWidth(separator) + visibleWidth(styledStatus);
  let inlinedStatus = false;

  for (const layout of options.lines) {
    const resolved = resolveLineSegments(
      layout,
      catalog,
      options.style,
      options.modelInfo.contextPercent,
    );
    const fitted = fitSegmentsToWidth(
      resolved.left,
      resolved.right,
      options.width,
      options.style,
      options.theme,
    );
    const canInlineStatus =
      lines.length === 0 &&
      styledStatus !== undefined &&
      naturalLineWidth(
        fitted.left,
        fitted.right,
        options.style,
        options.theme,
      ) +
        statusWidth <=
        options.width;
    const line = renderFooterLine(
      layout,
      catalog,
      options.style,
      canInlineStatus ? options.width - statusWidth : options.width,
      options.theme,
      options.modelInfo.contextPercent,
    );
    if (!line) continue;
    lines.push(
      canInlineStatus
        ? truncateToWidth(
            `${line}${separator}${styledStatus}`,
            options.width,
            options.theme.fg("dim", "..."),
          )
        : line,
    );
    inlinedStatus ||= canInlineStatus;
  }

  if (inlinedStatus) return lines;
  for (const statusLine of statusLines) {
    lines.push(
      truncateToWidth(
        statusLine,
        options.width,
        options.theme.fg("dim", "..."),
      ),
    );
  }

  return lines;
}
