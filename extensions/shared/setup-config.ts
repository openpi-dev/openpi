import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export const FOOTER_ITEMS = [
  "cwd",
  "model",
  "thinking",
  "context",
  "cache",
  "cost",
  "throughput",
  "git",
  "pr",
] as const;

export type FooterItem = (typeof FOOTER_ITEMS)[number];

export const FOOTER_LAYOUT_ITEMS = [...FOOTER_ITEMS, "flex"] as const;
export type FooterLayoutItem = (typeof FOOTER_LAYOUT_ITEMS)[number];

export const FOOTER_STYLES = ["plain", "powerline", "powerline-mono"] as const;
export type FooterStyle = (typeof FOOTER_STYLES)[number];

export const FOOTER_PRESETS = [
  "compact",
  "powerline",
  "powerline-mono",
] as const;
export type FooterPreset = (typeof FOOTER_PRESETS)[number];

export type FooterLines = readonly (readonly FooterLayoutItem[])[];

export const DETAIL_DISPLAYS = ["full", "compact"] as const;
export type DetailDisplay = (typeof DETAIL_DISPLAYS)[number];

/** Canonical default layout: one-line Powerline dashboard with flex alignment. */
export const DEFAULT_FOOTER_LINES: FooterLines = [
  [
    "cwd",
    "model",
    "thinking",
    "context",
    "cache",
    "cost",
    "throughput",
    "flex",
    "git",
    "pr",
  ],
];

export const DEFAULT_FOOTER_STYLE: FooterStyle = "powerline";

export const DEFAULT_FOOTER_ITEMS: readonly FooterItem[] =
  flattenFooterItems(DEFAULT_FOOTER_LINES);

export interface FooterPresetDefinition {
  readonly style: FooterStyle;
  readonly lines: FooterLines;
}

export const FOOTER_PRESET_DEFINITIONS: Record<
  FooterPreset,
  FooterPresetDefinition
> = {
  compact: {
    style: "plain",
    lines: [["cwd", "model", "thinking", "context", "flex", "git", "pr"]],
  },
  powerline: {
    style: "powerline",
    lines: DEFAULT_FOOTER_LINES,
  },
  "powerline-mono": {
    style: "powerline-mono",
    lines: DEFAULT_FOOTER_LINES,
  },
};

export interface SummaryModelConfig {
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
}

export const DEFAULT_WORKFLOW_CONCURRENCY = 8;
export const DEFAULT_WORKFLOW_MAX_AGENT_CALLS = 128;
export const MAX_WORKFLOW_CONCURRENCY = 64;
export const MAX_WORKFLOW_AGENT_CALLS = 1_024;

export const SETUP_CONFIG_CHANGED_CHANNEL = "my-pi-setup:config-changed";

export interface MyPiSetupConfig {
  readonly summaries: {
    readonly enabled: boolean;
    readonly model?: SummaryModelConfig;
  };
  readonly workflows: {
    readonly concurrency: number;
    readonly maxAgentCalls: number;
  };
  readonly ui: {
    readonly showHeader: boolean;
    readonly customFooter: boolean;
    readonly footerStyle: FooterStyle;
    /** Canonical footer layout. `footerItems` is always derived from this. */
    readonly footerLines: FooterLines;
    readonly footerItems: readonly FooterItem[];
    readonly subagentResultDisplay: DetailDisplay;
    readonly fileMutationDisplay: DetailDisplay;
  };
}

export const DEFAULT_SETUP_CONFIG: MyPiSetupConfig = {
  summaries: { enabled: false },
  workflows: {
    concurrency: DEFAULT_WORKFLOW_CONCURRENCY,
    maxAgentCalls: DEFAULT_WORKFLOW_MAX_AGENT_CALLS,
  },
  ui: {
    showHeader: false,
    customFooter: true,
    footerStyle: DEFAULT_FOOTER_STYLE,
    footerLines: DEFAULT_FOOTER_LINES,
    footerItems: DEFAULT_FOOTER_ITEMS,
    subagentResultDisplay: "full",
    fileMutationDisplay: "compact",
  },
};

export const SETUP_CONFIG_PATH = join(getAgentDir(), "my-pi-setup.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isReasoningLevel = (value: unknown): value is ReasoningLevel =>
  typeof value === "string" &&
  REASONING_LEVELS.includes(value as ReasoningLevel);

const isFooterItem = (value: unknown): value is FooterItem =>
  typeof value === "string" && FOOTER_ITEMS.includes(value as FooterItem);

const isFooterLayoutItem = (value: unknown): value is FooterLayoutItem =>
  typeof value === "string" &&
  FOOTER_LAYOUT_ITEMS.includes(value as FooterLayoutItem);

const isFooterStyle = (value: unknown): value is FooterStyle =>
  typeof value === "string" && FOOTER_STYLES.includes(value as FooterStyle);

const isFooterPreset = (value: unknown): value is FooterPreset =>
  typeof value === "string" && FOOTER_PRESETS.includes(value as FooterPreset);

export function flattenFooterItems(lines: FooterLines): readonly FooterItem[] {
  const items: FooterItem[] = [];
  const seen = new Set<FooterItem>();
  for (const line of lines) {
    for (const item of line) {
      if (item === "flex" || seen.has(item)) continue;
      seen.add(item);
      items.push(item);
    }
  }
  return items;
}

/**
 * Normalize a candidate footer layout:
 * unknown items removed, at most one flex per line, first metric wins across
 * lines, empty lines dropped. Falls back to the default when nothing remains.
 */
export function normalizeFooterLines(value: unknown): FooterLines {
  if (!Array.isArray(value)) return DEFAULT_FOOTER_LINES;

  const seen = new Set<FooterItem>();
  const lines: FooterLayoutItem[][] = [];

  for (const rawLine of value) {
    if (!Array.isArray(rawLine)) continue;
    const line: FooterLayoutItem[] = [];
    let hasFlex = false;
    for (const raw of rawLine) {
      if (!isFooterLayoutItem(raw)) continue;
      if (raw === "flex") {
        if (hasFlex) continue;
        hasFlex = true;
        line.push("flex");
        continue;
      }
      if (seen.has(raw)) continue;
      seen.add(raw);
      line.push(raw);
    }
    if (line.length > 0 && !(line.length === 1 && line[0] === "flex")) {
      lines.push(line);
    }
  }

  return lines.length > 0 ? lines : DEFAULT_FOOTER_LINES;
}

/** Map a flat item list onto the default one-line skeleton (legacy compat). */
export function footerLinesFromItems(
  items: readonly FooterItem[],
): FooterLines {
  const selected = new Set(items);
  return normalizeFooterLines(
    DEFAULT_FOOTER_LINES.map((line) =>
      line.filter((item) => item === "flex" || selected.has(item)),
    ),
  );
}

export function resolveFooterPreset(
  preset: FooterPreset,
): FooterPresetDefinition {
  return FOOTER_PRESET_DEFINITIONS[preset];
}

export function formatFooterLines(lines: FooterLines) {
  return lines
    .map((line) =>
      line
        .map((item) => (item === "flex" ? "|flex|" : item))
        .join(" ")
        .replace(/ \|flex\| /g, " |flex| "),
    )
    .join(" / ");
}

export interface FooterConfigUpdates {
  readonly preset?: FooterPreset;
  readonly style?: FooterStyle;
  readonly lines?: FooterLines;
  readonly items?: readonly FooterItem[];
}

/**
 * Apply footer updates: current → preset → style/lines overrides.
 * `items` is the legacy flat override (mapped onto the default skeleton).
 * Providing both `items` and `lines` is an error.
 */
export function applyFooterConfig(
  current: Pick<MyPiSetupConfig["ui"], "footerStyle" | "footerLines">,
  updates: FooterConfigUpdates,
) {
  if (updates.items !== undefined && updates.lines !== undefined) {
    throw new Error(
      "ui_footer_items and ui_footer_lines cannot be provided together; use ui_footer_lines for multi-line layouts, or ui_footer_items for the legacy flat selection.",
    );
  }

  let style = current.footerStyle;
  let lines = current.footerLines;

  if (updates.preset !== undefined) {
    const resolved = resolveFooterPreset(updates.preset);
    style = resolved.style;
    lines = resolved.lines;
  }
  if (updates.style !== undefined) style = updates.style;
  if (updates.lines !== undefined) lines = normalizeFooterLines(updates.lines);
  if (updates.items !== undefined) {
    const items = [
      ...new Set(updates.items.filter(isFooterItem)),
    ] as FooterItem[];
    lines = footerLinesFromItems(
      items.length > 0 ? items : DEFAULT_FOOTER_ITEMS,
    );
  }

  const normalized = normalizeFooterLines(lines);
  return {
    footerStyle: style,
    footerLines: normalized,
    footerItems: flattenFooterItems(normalized),
  };
}

function parseFooterItems(value: unknown): readonly FooterItem[] {
  if (!Array.isArray(value)) return DEFAULT_FOOTER_ITEMS;
  const items = [...new Set(value.filter(isFooterItem))];
  return items.length > 0 ? items : DEFAULT_FOOTER_ITEMS;
}

function parseUiFooter(
  ui: Record<string, unknown>,
): Pick<MyPiSetupConfig["ui"], "footerStyle" | "footerLines" | "footerItems"> {
  const style = isFooterStyle(ui.footerStyle)
    ? ui.footerStyle
    : DEFAULT_FOOTER_STYLE;

  if (ui.footerLines !== undefined) {
    const lines = normalizeFooterLines(ui.footerLines);
    return {
      footerStyle: style,
      footerLines: lines,
      footerItems: flattenFooterItems(lines),
    };
  }

  // Legacy: only footerItems → filter the default one-line skeleton.
  if (ui.footerItems !== undefined) {
    const items = parseFooterItems(ui.footerItems);
    const lines = footerLinesFromItems(items);
    return {
      footerStyle: style,
      footerLines: lines,
      footerItems: flattenFooterItems(lines),
    };
  }

  return {
    footerStyle: style,
    footerLines: DEFAULT_FOOTER_LINES,
    footerItems: DEFAULT_FOOTER_ITEMS,
  };
}

function boundedInteger(value: unknown, fallback: number, maximum: number) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= maximum
    ? value
    : fallback;
}

export function parseSetupConfig(value: unknown): MyPiSetupConfig {
  if (!isRecord(value)) return DEFAULT_SETUP_CONFIG;

  const summaries = isRecord(value.summaries) ? value.summaries : {};
  const enabled =
    typeof summaries.enabled === "boolean" ? summaries.enabled : false;
  const rawModel = isRecord(summaries.model) ? summaries.model : undefined;
  const model =
    rawModel &&
    typeof rawModel.provider === "string" &&
    rawModel.provider.trim() &&
    typeof rawModel.model === "string" &&
    rawModel.model.trim() &&
    isReasoningLevel(rawModel.reasoning)
      ? {
          provider: rawModel.provider.trim(),
          model: rawModel.model.trim(),
          reasoning: rawModel.reasoning,
        }
      : undefined;

  const workflows = isRecord(value.workflows) ? value.workflows : {};
  const ui = isRecord(value.ui) ? value.ui : {};
  const footer = parseUiFooter(ui);
  return {
    summaries: { enabled, ...(model ? { model } : {}) },
    workflows: {
      concurrency: boundedInteger(
        workflows.concurrency,
        DEFAULT_WORKFLOW_CONCURRENCY,
        MAX_WORKFLOW_CONCURRENCY,
      ),
      maxAgentCalls: boundedInteger(
        workflows.maxAgentCalls,
        DEFAULT_WORKFLOW_MAX_AGENT_CALLS,
        MAX_WORKFLOW_AGENT_CALLS,
      ),
    },
    ui: {
      showHeader: typeof ui.showHeader === "boolean" ? ui.showHeader : false,
      customFooter:
        typeof ui.customFooter === "boolean" ? ui.customFooter : true,
      ...footer,
      subagentResultDisplay: DETAIL_DISPLAYS.includes(
        ui.subagentResultDisplay as DetailDisplay,
      )
        ? (ui.subagentResultDisplay as DetailDisplay)
        : "full",
      fileMutationDisplay: DETAIL_DISPLAYS.includes(
        ui.fileMutationDisplay as DetailDisplay,
      )
        ? (ui.fileMutationDisplay as DetailDisplay)
        : "compact",
    },
  };
}

export function hasSavedSetupConfig() {
  return existsSync(SETUP_CONFIG_PATH);
}

export function loadSetupConfig() {
  try {
    return parseSetupConfig(
      JSON.parse(readFileSync(SETUP_CONFIG_PATH, "utf8")),
    );
  } catch {
    return DEFAULT_SETUP_CONFIG;
  }
}

export async function saveSetupConfig(config: MyPiSetupConfig) {
  const tempPath = `${SETUP_CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(getAgentDir(), { recursive: true });
  try {
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, SETUP_CONFIG_PATH);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export function formatSetupConfig(config = loadSetupConfig()) {
  const summary = !config.summaries.enabled
    ? "Run recaps: disabled"
    : config.summaries.model
      ? `Run recaps: ${config.summaries.model.provider}/${config.summaries.model.model} · ${config.summaries.model.reasoning}`
      : "Run recaps: local fallback (no model calls)";
  const footer = config.ui.customFooter
    ? `on · ${config.ui.footerStyle} · ${formatFooterLines(config.ui.footerLines)}`
    : "off";
  return [
    summary,
    `Workflows: ${config.workflows.concurrency} concurrent agents · ${config.workflows.maxAgentCalls} total calls`,
    `UI: large header ${config.ui.showHeader ? "on" : "off"} · custom footer ${footer}`,
    `Subagent results: ${config.ui.subagentResultDisplay === "full" ? "full by default" : "compact preview (expand for full output)"}`,
    `Write/Edit details: ${config.ui.fileMutationDisplay === "full" ? "full by default" : "compact preview (expand for full diff/content)"}`,
  ].join("\n");
}

export { isFooterItem, isFooterLayoutItem, isFooterStyle, isFooterPreset };
