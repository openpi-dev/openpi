import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, type Stats, watch } from "node:fs";
import {
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Worker } from "node:worker_threads";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  isWebSearchModelSupport,
  type WebSearchConfig,
} from "../web-search/support.ts";
import {
  EXTERNAL_BROWSERS,
  type BrowserConfig,
  isBrowserId,
  isBrowserList,
} from "./browser-config.ts";
import {
  SUBAGENT_ROLE_NAMES,
  type SubagentRoleModel,
  type SubagentRoleModels,
} from "./subagent-roles.ts";

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

export const RESPONSE_VERBOSITIES = [
  "default",
  "low",
  "medium",
  "high",
] as const;
export const RESPONSE_REASONING_SUMMARIES = [
  "default",
  "auto",
  "concise",
  "detailed",
  "none",
] as const;

export type ResponseVerbosity = (typeof RESPONSE_VERBOSITIES)[number];
export type ResponseReasoningSummary =
  (typeof RESPONSE_REASONING_SUMMARIES)[number];

export function isHiddenThinkingLevels(
  value: unknown,
): value is ReasoningLevel[] {
  return (
    Array.isArray(value) &&
    value.length <= REASONING_LEVELS.length &&
    Array.from(value).every(isReasoningLevel) &&
    new Set(value).size === value.length
  );
}

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
export const isDetailDisplay = (value: unknown): value is DetailDisplay =>
  value === "full" || value === "compact";

export const WEB_THEMES = [
  "light",
  "dark",
  "mist",
  "rose",
  "pine",
  "system",
] as const;
export type WebTheme = (typeof WEB_THEMES)[number];

export const WEB_APPEARANCE_PALETTES = [
  "default",
  "mist",
  "rose",
  "pine",
] as const;
export const WEB_APPEARANCE_FONTS = [
  "codex",
  "system",
  "sans",
  "serif",
  "mono",
] as const;

export interface WebAppearancePreference {
  readonly palette: (typeof WEB_APPEARANCE_PALETTES)[number];
  readonly accent: string;
  readonly background: string;
  readonly foreground: string;
  readonly font: (typeof WEB_APPEARANCE_FONTS)[number];
}

export const DEFAULT_WEB_APPEARANCE: WebAppearancePreference = {
  palette: "default",
  accent: "",
  background: "",
  foreground: "",
  font: "codex",
};

export const DEFAULT_WEB_CHAT_WIDTH = 820;
export const MIN_WEB_CHAT_WIDTH = 820;
export const MAX_WEB_CHAT_WIDTH = 2_000;
export const DEFAULT_WEB_SIDEBAR_WIDTH = 340;
export const MIN_WEB_SIDEBAR_WIDTH = 220;
export const MAX_WEB_SIDEBAR_WIDTH = 520;
export const DEFAULT_WEB_AUXILIARY_WIDTH = 520;
export const MIN_WEB_AUXILIARY_WIDTH = 360;
export const MAX_WEB_AUXILIARY_WIDTH = 720;
export const DEFAULT_WEB_CHAT_FONT_SIZE = 14;
export const MIN_WEB_CHAT_FONT_SIZE = 12;
export const MAX_WEB_CHAT_FONT_SIZE = 24;

export const CAPABILITY_DISCOVERY_MODES = ["explicit", "adaptive"] as const;
export type CapabilityDiscoveryMode =
  (typeof CAPABILITY_DISCOVERY_MODES)[number];

/** Canonical default layout: one-line plain footer with flex alignment. */
export const DEFAULT_FOOTER_LINES: FooterLines = [
  ["model", "context", "flex", "git", "pr", "cwd"],
];

/** Stable skeleton for the legacy flat-selection adapter. */
const FLAT_FOOTER_ITEM_LINES: FooterLines = [
  [
    "model",
    "thinking",
    "context",
    "cache",
    "cost",
    "throughput",
    "flex",
    "git",
    "pr",
    "cwd",
  ],
];

/** The persisted canonical default before model/context moved to the left. */
const LEGACY_DEFAULT_FOOTER_LINES: FooterLines = [
  ["cwd", "git", "pr", "flex", "model", "context"],
];

export const DEFAULT_FOOTER_STYLE: FooterStyle = "plain";

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
    lines: DEFAULT_FOOTER_LINES,
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

export interface SuggestionModelConfig {
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
}

export const DEFAULT_WORKFLOW_CONCURRENCY = 8;
export const DEFAULT_WORKFLOW_MAX_AGENT_CALLS = 128;
export const MAX_WORKFLOW_CONCURRENCY = 64;
export const MAX_WORKFLOW_AGENT_CALLS = 1_024;
/** Opt-in session-wide limit; it deliberately does not inherit Workflow's 8. */
export const MAX_SESSION_CHILD_EXECUTION_LIMIT = 64;
/** Bound on the single post-edit command string. */
export const POST_EDIT_COMMAND_MAX_CHARS = 500;

export const SETUP_CONFIG_CHANGED_CHANNEL = "my-pi-setup:config-changed";

export interface MyPiSetupConfig {
  readonly codeMode: {
    readonly enabled: boolean;
  };
  readonly capabilities: {
    readonly discovery: CapabilityDiscoveryMode;
  };
  readonly suggestions: {
    readonly enabled: boolean;
    readonly model?: SuggestionModelConfig;
  };
  readonly workflows: {
    readonly concurrency: number;
    readonly maxAgentCalls: number;
  };
  /** Cross-entry runtime admission; omitted means preserve historical behaviour. */
  readonly childExecutions: {
    readonly maxActive?: number;
  };
  readonly browser: BrowserConfig;
  readonly webSearch: WebSearchConfig;
  readonly response: {
    readonly verbosity: ResponseVerbosity;
    readonly reasoningSummary: ResponseReasoningSummary;
  };
  readonly ui: {
    readonly webTheme: WebTheme;
    readonly webAppearance: WebAppearancePreference;
    readonly webChatWidth: number;
    readonly webSidebarWidth: number;
    readonly webAuxiliaryWidth: number;
    readonly webChatFontSize: number;
    readonly webExpandThinking: boolean;
    readonly webHiddenThinkingLevels: readonly ReasoningLevel[];
    readonly webPinnedSort: "manual" | "updated";
    readonly webSidebarGrouping: "project" | "list";
    readonly webChatsSort: "manual" | "updated";
    readonly webProjectsInRecents: boolean;
    readonly showHeader: boolean;
    readonly customFooter: boolean;
    readonly footerStyle: FooterStyle;
    readonly footerLines: FooterLines;
    readonly subagentResultDisplay: DetailDisplay;
    readonly bashToolDisplay: DetailDisplay;
    readonly fileMutationDisplay: DetailDisplay;
  };
  /**
   * One optional command run after a turn that touched files. Deliberately a
   * single command, not an event-hook engine: the trust surface stays one
   * user-typed string, and it is off (empty) by default.
   */
  readonly postEdit: {
    readonly command: string;
  };
  readonly subagents: {
    /** Per-built-in-role assignments; missing roles inherit the parent model. */
    readonly roleModels: SubagentRoleModels;
  };
}

export const DEFAULT_SETUP_CONFIG: MyPiSetupConfig = {
  codeMode: { enabled: true },
  capabilities: { discovery: "explicit" },
  suggestions: { enabled: false },
  webSearch: { enabled: false, modelSupport: [] },
  response: { verbosity: "default", reasoningSummary: "default" },
  workflows: {
    concurrency: DEFAULT_WORKFLOW_CONCURRENCY,
    maxAgentCalls: DEFAULT_WORKFLOW_MAX_AGENT_CALLS,
  },
  childExecutions: {},
  browser: {
    control: false,
    embedded: true,
    defaultBrowser: "embedded",
    externalBrowsers: [],
  },
  ui: {
    webTheme: "system",
    webAppearance: DEFAULT_WEB_APPEARANCE,
    webChatWidth: DEFAULT_WEB_CHAT_WIDTH,
    webSidebarWidth: DEFAULT_WEB_SIDEBAR_WIDTH,
    webAuxiliaryWidth: DEFAULT_WEB_AUXILIARY_WIDTH,
    webChatFontSize: DEFAULT_WEB_CHAT_FONT_SIZE,
    webExpandThinking: false,
    webHiddenThinkingLevels: [],
    webPinnedSort: "manual",
    webSidebarGrouping: "project",
    webChatsSort: "updated",
    webProjectsInRecents: true,
    showHeader: false,
    customFooter: true,
    footerStyle: DEFAULT_FOOTER_STYLE,
    footerLines: DEFAULT_FOOTER_LINES,
    subagentResultDisplay: "compact",
    bashToolDisplay: "compact",
    fileMutationDisplay: "compact",
  },
  postEdit: { command: "" },
  subagents: { roleModels: {} },
};

export const SETUP_CONFIG_PATH = join(getAgentDir(), "my-pi-setup.json");
const SETUP_CONFIG_LOCK_PATH = `${SETUP_CONFIG_PATH}.lock`;
/**
 * The holder refreshes the lock file's mtime from a worker thread every second.
 * The lease expires five seconds after the last refresh, so one delayed tick
 * does not look like a crash. A waiter stops after five seconds when a refresh
 * was observed during the wait and another landed inside the last two seconds.
 * A waiter that sees no further refresh keeps the lease already on disk, and
 * can run one stale period past that patience bound.
 */
const SETUP_CONFIG_LOCK_HEARTBEAT_MS = 1_000;
const SETUP_CONFIG_LOCK_STALE_MS = 5_000;
const SETUP_CONFIG_LOCK_TIMEOUT_MS = 5_000;
const SETUP_CONFIG_LOCK_RECHECK_MS = 500;
const SETUP_CONFIG_LOCK_ACTIVE_MS = SETUP_CONFIG_LOCK_HEARTBEAT_MS * 2;
const SETUP_CONFIG_LOCK_VERSION = 2 as const;
/**
 * Opens the lock once and refreshes that descriptor. A replacement created at
 * the same path keeps its own timestamps. The worker has its own thread, so a
 * synchronous critical section on the holder still renews the lease.
 */
const LOCK_HEARTBEAT_WORKER_SOURCE = `
import { parentPort, workerData } from "node:worker_threads";
import { closeSync, futimesSync, openSync } from "node:fs";

const port = parentPort;
if (!port) throw new Error("setup lock heartbeat has no parent port");
const fd = openSync(workerData.path, "r+");
let stopped = false;
const beat = () => {
  if (stopped) return;
  try {
    const now = new Date();
    futimesSync(fd, now, now);
  } catch {
    // A failed refresh retries on the next tick. Repeated failure lets the
    // lease expire instead of touching some other file at this path.
  }
};
const timer = setInterval(beat, workerData.intervalMs);
port.on("message", (message) => {
  if (message !== "stop") return;
  stopped = true;
  clearInterval(timer);
  try {
    closeSync(fd);
  } catch {
    // The descriptor is already closed.
  }
  port.postMessage("stopped");
});
port.postMessage("ready");
`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isWebAppearancePreference(
  value: unknown,
): value is WebAppearancePreference {
  return (
    isRecord(value) &&
    Object.keys(value).length === 5 &&
    Object.keys(value).every((key) =>
      ["palette", "accent", "background", "foreground", "font"].includes(key),
    ) &&
    WEB_APPEARANCE_PALETTES.includes(
      value.palette as WebAppearancePreference["palette"],
    ) &&
    WEB_APPEARANCE_FONTS.includes(
      value.font as WebAppearancePreference["font"],
    ) &&
    [value.accent, value.background, value.foreground].every(
      (color) =>
        typeof color === "string" && /^(?:|#[0-9a-f]{6})$/iu.test(color),
    )
  );
}

const isReasoningLevel = (value: unknown): value is ReasoningLevel =>
  typeof value === "string" &&
  REASONING_LEVELS.includes(value as ReasoningLevel);

const isFooterItem = (value: unknown): value is FooterItem =>
  typeof value === "string" && FOOTER_ITEMS.includes(value as FooterItem);

const isFooterLayoutItem = (value: unknown): value is FooterLayoutItem =>
  typeof value === "string" &&
  FOOTER_LAYOUT_ITEMS.includes(value as FooterLayoutItem);

export const isFooterStyle = (value: unknown): value is FooterStyle =>
  typeof value === "string" && FOOTER_STYLES.includes(value as FooterStyle);

const isFooterPreset = (value: unknown): value is FooterPreset =>
  typeof value === "string" && FOOTER_PRESETS.includes(value as FooterPreset);

const isCapabilityDiscoveryMode = (
  value: unknown,
): value is CapabilityDiscoveryMode =>
  typeof value === "string" &&
  CAPABILITY_DISCOVERY_MODES.includes(value as CapabilityDiscoveryMode);

export const isWebTheme = (value: unknown): value is WebTheme =>
  typeof value === "string" && WEB_THEMES.includes(value as WebTheme);

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

/** Map a flat item list onto the stable one-line skeleton (legacy compat). */
export function footerLinesFromItems(
  items: readonly FooterItem[],
): FooterLines {
  const selected = new Set(items);
  return normalizeFooterLines(
    FLAT_FOOTER_ITEM_LINES.map((line) =>
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
  if (updates.preset !== undefined && !isFooterPreset(updates.preset)) {
    throw new Error(
      `Invalid ui_footer_preset. Allowed values: ${FOOTER_PRESETS.join(", ")}. No changes saved.`,
    );
  }
  if (updates.style !== undefined && !isFooterStyle(updates.style)) {
    throw new Error(
      `Invalid ui_footer_style (ui.footerStyle). Allowed values: ${FOOTER_STYLES.join(", ")}. No changes saved.`,
    );
  }
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
  };
}

function parseFooterItems(value: unknown): readonly FooterItem[] {
  if (!Array.isArray(value)) return DEFAULT_FOOTER_ITEMS;
  const items = [...new Set(value.filter(isFooterItem))];
  return items.length > 0 ? items : DEFAULT_FOOTER_ITEMS;
}

function sameFooterLines(left: FooterLines, right: FooterLines) {
  return (
    left.length === right.length &&
    left.every(
      (line, lineIndex) =>
        line.length === right[lineIndex]?.length &&
        line.every((item, itemIndex) => item === right[lineIndex]?.[itemIndex]),
    )
  );
}

function parseUiFooter(
  ui: Record<string, unknown>,
): Pick<MyPiSetupConfig["ui"], "footerStyle" | "footerLines"> {
  const style = isFooterStyle(ui.footerStyle)
    ? ui.footerStyle
    : DEFAULT_FOOTER_STYLE;

  if (ui.footerLines !== undefined) {
    const normalized = normalizeFooterLines(ui.footerLines);
    const lines = sameFooterLines(normalized, LEGACY_DEFAULT_FOOTER_LINES)
      ? DEFAULT_FOOTER_LINES
      : normalized;
    return {
      footerStyle: style,
      footerLines: lines,
    };
  }

  // Legacy: only footerItems → filter the default one-line skeleton.
  if (ui.footerItems !== undefined) {
    const items = parseFooterItems(ui.footerItems);
    const lines = footerLinesFromItems(items);
    return {
      footerStyle: style,
      footerLines: lines,
    };
  }

  return {
    footerStyle: style,
    footerLines: DEFAULT_FOOTER_LINES,
  };
}

function parseSubagentRoleModels(value: unknown): SubagentRoleModels {
  if (!isRecord(value)) return {};

  const roleModels: Partial<Record<string, SubagentRoleModel>> = {};
  for (const role of SUBAGENT_ROLE_NAMES) {
    const candidate = value[role];
    if (!isRecord(candidate)) continue;
    const provider = readString(candidate.provider);
    const model = readString(candidate.model);
    if (provider && model) roleModels[role] = { provider, model };
  }
  return roleModels;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedInteger(value: unknown, fallback: number, maximum: number) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= maximum
    ? value
    : fallback;
}

function boundedIntegerRange(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

export function parseSetupConfig(value: unknown): MyPiSetupConfig {
  if (!isRecord(value)) return DEFAULT_SETUP_CONFIG;

  const capabilities = isRecord(value.capabilities) ? value.capabilities : {};
  const codeMode = isRecord(value.codeMode) ? value.codeMode : {};

  // `summaries` is the pre-suggestion config key. Read it once as a migration
  // source; every subsequent save writes only the canonical `suggestions` key.
  const suggestions = isRecord(value.suggestions)
    ? value.suggestions
    : isRecord(value.summaries)
      ? value.summaries
      : {};
  const requestedEnabled =
    typeof suggestions.enabled === "boolean" ? suggestions.enabled : false;
  const rawModel = isRecord(suggestions.model) ? suggestions.model : undefined;
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
  const childExecutions = isRecord(value.childExecutions)
    ? value.childExecutions
    : {};
  const ui = isRecord(value.ui) ? value.ui : {};
  const browser = isRecord(value.browser) ? value.browser : {};
  const webSearch = isRecord(value.webSearch) ? value.webSearch : {};
  const response = isRecord(value.response) ? value.response : {};
  const subagents = isRecord(value.subagents) ? value.subagents : {};
  const footer = parseUiFooter(ui);
  return {
    capabilities: {
      discovery: isCapabilityDiscoveryMode(capabilities.discovery)
        ? capabilities.discovery
        : "explicit",
    },
    codeMode: { enabled: codeMode.enabled !== false },
    webSearch: {
      enabled:
        webSearch.enabled === true &&
        (webSearch.modelSupport === undefined ||
          isWebSearchModelSupport(webSearch.modelSupport)),
      modelSupport: isWebSearchModelSupport(webSearch.modelSupport)
        ? webSearch.modelSupport
        : [],
    },
    response: {
      verbosity: isResponseVerbosity(response.verbosity)
        ? response.verbosity
        : "default",
      reasoningSummary: isResponseReasoningSummary(response.reasoningSummary)
        ? response.reasoningSummary
        : "default",
    },
    suggestions: {
      enabled: requestedEnabled && Boolean(model),
      ...(model ? { model } : {}),
    },
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
    childExecutions: {
      ...(typeof childExecutions.maxActive === "number" &&
      Number.isInteger(childExecutions.maxActive) &&
      childExecutions.maxActive >= 1 &&
      childExecutions.maxActive <= MAX_SESSION_CHILD_EXECUTION_LIMIT
        ? { maxActive: childExecutions.maxActive }
        : {}),
    },
    browser: {
      control:
        browser.control === true &&
        (browser.embedded === undefined ||
          typeof browser.embedded === "boolean") &&
        (browser.defaultBrowser === undefined ||
          isBrowserId(browser.defaultBrowser)) &&
        (browser.externalBrowsers === undefined ||
          isBrowserList(browser.externalBrowsers)),
      embedded: browser.embedded === undefined || browser.embedded === true,
      defaultBrowser: isBrowserId(browser.defaultBrowser)
        ? browser.defaultBrowser
        : "embedded",
      externalBrowsers: isBrowserList(browser.externalBrowsers)
        ? [...browser.externalBrowsers]
        : [],
    },
    ui: {
      webTheme: isWebTheme(ui.webTheme) ? ui.webTheme : "system",
      webAppearance: isWebAppearancePreference(ui.webAppearance)
        ? {
            ...ui.webAppearance,
            font:
              ui.webAppearance.font === "system"
                ? "codex"
                : ui.webAppearance.font,
          }
        : { ...DEFAULT_WEB_APPEARANCE },
      webPinnedSort: ui.webPinnedSort === "updated" ? "updated" : "manual",
      webSidebarGrouping: ui.webSidebarGrouping === "list" ? "list" : "project",
      webChatsSort: ui.webChatsSort === "manual" ? "manual" : "updated",
      webProjectsInRecents: ui.webProjectsInRecents !== false,
      webChatWidth: boundedIntegerRange(
        ui.webChatWidth,
        DEFAULT_WEB_CHAT_WIDTH,
        MIN_WEB_CHAT_WIDTH,
        MAX_WEB_CHAT_WIDTH,
      ),
      webChatFontSize: boundedIntegerRange(
        ui.webChatFontSize,
        DEFAULT_WEB_CHAT_FONT_SIZE,
        MIN_WEB_CHAT_FONT_SIZE,
        MAX_WEB_CHAT_FONT_SIZE,
      ),
      webSidebarWidth: boundedIntegerRange(
        ui.webSidebarWidth,
        DEFAULT_WEB_SIDEBAR_WIDTH,
        MIN_WEB_SIDEBAR_WIDTH,
        MAX_WEB_SIDEBAR_WIDTH,
      ),
      webAuxiliaryWidth: boundedIntegerRange(
        ui.webAuxiliaryWidth,
        DEFAULT_WEB_AUXILIARY_WIDTH,
        MIN_WEB_AUXILIARY_WIDTH,
        MAX_WEB_AUXILIARY_WIDTH,
      ),
      webExpandThinking:
        typeof ui.webExpandThinking === "boolean"
          ? ui.webExpandThinking
          : false,
      webHiddenThinkingLevels: isHiddenThinkingLevels(
        ui.webHiddenThinkingLevels,
      )
        ? [...ui.webHiddenThinkingLevels]
        : [],
      showHeader: typeof ui.showHeader === "boolean" ? ui.showHeader : false,
      customFooter:
        typeof ui.customFooter === "boolean" ? ui.customFooter : true,
      ...footer,
      subagentResultDisplay: DETAIL_DISPLAYS.includes(
        ui.subagentResultDisplay as DetailDisplay,
      )
        ? (ui.subagentResultDisplay as DetailDisplay)
        : "compact",
      bashToolDisplay: DETAIL_DISPLAYS.includes(
        ui.bashToolDisplay as DetailDisplay,
      )
        ? (ui.bashToolDisplay as DetailDisplay)
        : "compact",
      fileMutationDisplay: DETAIL_DISPLAYS.includes(
        ui.fileMutationDisplay as DetailDisplay,
      )
        ? (ui.fileMutationDisplay as DetailDisplay)
        : "compact",
    },
    postEdit: { command: parsePostEditCommand(value.postEdit) },
    subagents: { roleModels: parseSubagentRoleModels(subagents.roleModels) },
  };
}

/** An empty or invalid value disables the post-edit command (the safe default). */
function parsePostEditCommand(value: unknown) {
  if (!isRecord(value)) return "";
  if (typeof value.command !== "string") return "";
  const command = value.command.trim();
  return command.length <= POST_EDIT_COMMAND_MAX_CHARS ? command : "";
}

export function hasSavedSetupConfig() {
  return existsSync(SETUP_CONFIG_PATH);
}

export function loadSetupConfig() {
  return inspectSetupConfig().config;
}

export const SETUP_CONFIG_VERSION = 1;

type ConfigShape = {
  readonly [key: string]: ConfigShape | ((value: unknown) => boolean);
};
const booleanValue = (value: unknown) => typeof value === "boolean";
const nonemptyString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0;
const oneOf = (values: readonly unknown[]) => (value: unknown) =>
  values.includes(value);
const isResponseVerbosity = (value: unknown): value is ResponseVerbosity =>
  RESPONSE_VERBOSITIES.includes(value as ResponseVerbosity);
const isResponseReasoningSummary = (
  value: unknown,
): value is ResponseReasoningSummary =>
  RESPONSE_REASONING_SUMMARIES.includes(value as ResponseReasoningSummary);
const integerBetween = (minimum: number, maximum: number) => (value: unknown) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= minimum &&
  value <= maximum;
const modelShape = {
  provider: nonemptyString,
  model: nonemptyString,
  reasoning: isReasoningLevel,
};
const suggestionShape = { enabled: booleanValue, model: modelShape };
const setupShape: ConfigShape = {
  configVersion: (value) => value === SETUP_CONFIG_VERSION,
  codeMode: { enabled: booleanValue },
  capabilities: { discovery: isCapabilityDiscoveryMode },
  suggestions: suggestionShape,
  summaries: suggestionShape,
  workflows: {
    concurrency: integerBetween(1, MAX_WORKFLOW_CONCURRENCY),
    maxAgentCalls: integerBetween(1, MAX_WORKFLOW_AGENT_CALLS),
  },
  childExecutions: {
    maxActive: integerBetween(1, MAX_SESSION_CHILD_EXECUTION_LIMIT),
  },
  browser: {
    control: booleanValue,
    embedded: booleanValue,
    defaultBrowser: isBrowserId,
    externalBrowsers: isBrowserList,
  },
  webSearch: { enabled: booleanValue, modelSupport: isWebSearchModelSupport },
  response: {
    verbosity: isResponseVerbosity,
    reasoningSummary: isResponseReasoningSummary,
  },
  ui: {
    webTheme: isWebTheme,
    webAppearance: isWebAppearancePreference,
    webChatWidth: integerBetween(MIN_WEB_CHAT_WIDTH, MAX_WEB_CHAT_WIDTH),
    webSidebarWidth: integerBetween(
      MIN_WEB_SIDEBAR_WIDTH,
      MAX_WEB_SIDEBAR_WIDTH,
    ),
    webAuxiliaryWidth: integerBetween(
      MIN_WEB_AUXILIARY_WIDTH,
      MAX_WEB_AUXILIARY_WIDTH,
    ),
    webChatFontSize: integerBetween(
      MIN_WEB_CHAT_FONT_SIZE,
      MAX_WEB_CHAT_FONT_SIZE,
    ),
    webExpandThinking: booleanValue,
    webHiddenThinkingLevels: isHiddenThinkingLevels,
    webPinnedSort: (value) => value === "manual" || value === "updated",
    webSidebarGrouping: (value) => value === "project" || value === "list",
    webChatsSort: (value) => value === "manual" || value === "updated",
    webProjectsInRecents: booleanValue,
    showHeader: booleanValue,
    customFooter: booleanValue,
    footerStyle: isFooterStyle,
    footerLines: (value) =>
      Array.isArray(value) &&
      value.every(
        (line) => Array.isArray(line) && line.every(isFooterLayoutItem),
      ),
    footerItems: (value) => Array.isArray(value) && value.every(isFooterItem),
    subagentResultDisplay: oneOf(DETAIL_DISPLAYS),
    bashToolDisplay: oneOf(DETAIL_DISPLAYS),
    fileMutationDisplay: oneOf(DETAIL_DISPLAYS),
  },
  postEdit: {
    command: (value) =>
      typeof value === "string" &&
      value.trim().length <= POST_EDIT_COMMAND_MAX_CHARS,
  },
  subagents: {
    roleModels: Object.fromEntries(
      SUBAGENT_ROLE_NAMES.map((role) => [
        role,
        { provider: nonemptyString, model: nonemptyString },
      ]),
    ),
  },
};

export interface SetupDiagnostic {
  readonly severity: "warning" | "error";
  readonly path: string;
  readonly message: string;
}

function inspectDocument(raw: unknown) {
  const diagnostics: SetupDiagnostic[] = [];
  const visit = (value: unknown, shape: ConfigShape, path: string) => {
    if (!isRecord(value)) {
      diagnostics.push({
        severity: "error",
        path,
        message: "Expected an object",
      });
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      const rule = Object.hasOwn(shape, key) ? shape[key] : undefined;
      if (!rule)
        diagnostics.push({
          severity: "warning",
          path: childPath,
          message: "Unknown field preserved",
        });
      else if (typeof rule === "function") {
        if (!rule(child))
          diagnostics.push({
            severity: "error",
            path: childPath,
            message:
              rule === isFooterStyle
                ? `Invalid or unsupported value. Allowed values: ${FOOTER_STYLES.join(", ")}`
                : "Invalid or unsupported value",
          });
      } else visit(child, rule, childPath);
    }
  };
  visit(raw, setupShape, "");
  if (isRecord(raw)) {
    for (const key of ["suggestions", "summaries"]) {
      const section = raw[key];
      if (!isRecord(section)) continue;
      if (isRecord(section.model)) {
        for (const field of Object.keys(modelShape)) {
          if (!Object.hasOwn(section.model, field))
            diagnostics.push({
              severity: "error",
              path: `${key}.model.${field}`,
              message: "Required model field missing",
            });
        }
      }
      if (
        key === "suggestions" &&
        section.enabled === true &&
        !isRecord(section.model)
      )
        diagnostics.push({
          severity: "error",
          path: "suggestions.model",
          message: "Enabled suggestions require a model",
        });
    }
    const roles =
      isRecord(raw.subagents) && isRecord(raw.subagents.roleModels)
        ? raw.subagents.roleModels
        : {};
    for (const role of SUBAGENT_ROLE_NAMES) {
      const model = roles[role];
      if (!isRecord(model)) continue;
      for (const field of ["provider", "model"]) {
        if (!Object.hasOwn(model, field))
          diagnostics.push({
            severity: "error",
            path: `subagents.roleModels.${role}.${field}`,
            message: "Required model field missing",
          });
      }
    }
    if (!Object.hasOwn(raw, "configVersion"))
      diagnostics.push({
        severity: "warning",
        path: "configVersion",
        message:
          "Legacy unversioned document; migration occurs on explicit save",
      });
  }
  return diagnostics;
}

export function inspectSetupConfig() {
  let bytes: string | undefined;
  let raw: unknown;
  let diagnostics: SetupDiagnostic[] = [];
  let source: "missing" | "disk" = "disk";
  try {
    // Reject malformed bytes before replacement decoding can hide corruption.
    // Retain a BOM so JSON parsing keeps its existing rejection semantics.
    bytes = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      readFileSync(SETUP_CONFIG_PATH),
    );
    try {
      raw = JSON.parse(bytes);
      diagnostics = inspectDocument(raw);
    } catch {
      diagnostics = [
        { severity: "error", path: "", message: "Malformed JSON" },
      ];
    }
  } catch (error) {
    if (isErrno(error, "ENOENT")) source = "missing";
    else
      diagnostics = [
        {
          severity: "error",
          path: "",
          message: "Unable to read configuration",
        },
      ];
  }
  const writable = !diagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  );
  return {
    path: SETUP_CONFIG_PATH,
    source,
    bytes,
    raw,
    diagnostics,
    writable,
    config: writable ? parseSetupConfig(raw) : DEFAULT_SETUP_CONFIG,
  };
}

export function formatSetupDiagnostics(result = inspectSetupConfig()) {
  let version: string | number = "unreadable";
  if (result.source === "missing") version = "none";
  else if (isRecord(result.raw)) {
    version = !Object.hasOwn(result.raw, "configVersion")
      ? "legacy (unversioned)"
      : typeof result.raw.configVersion === "number"
        ? result.raw.configVersion
        : "invalid";
  }
  return [
    `Configuration path: ${result.path}`,
    `Configuration source: ${result.source}`,
    `Configuration version: ${version}; supported: ${SETUP_CONFIG_VERSION}`,
    `Configuration writes: ${result.writable ? "allowed" : "blocked; safe defaults are in use"}`,
    ...result.diagnostics.map(
      (diagnostic) =>
        `${diagnostic.severity}: ${JSON.stringify(diagnostic.path)} — ${diagnostic.message}`,
    ),
    ...(!result.writable
      ? [
          "Original file preserved. Repair the file, or explicitly remove it to reset; ordinary setup changes cannot overwrite it.",
        ]
      : []),
  ].join("\n");
}

/**
 * Refuse to overwrite a file we could not read. A save always starts from
 * `loadSetupConfig()`, which degrades an unreadable document to defaults, so
 * writing anyway would silently replace every saved preference. Rendering
 * paths keep degrading; only the writer fails closed.
 */
function readDocumentForWrite() {
  const result = inspectSetupConfig();
  if (!result.writable) {
    throw new Error(
      `Refusing to overwrite unreadable config at ${SETUP_CONFIG_PATH}. ${formatSetupDiagnostics(result)} Fix the file, or explicitly delete it to start from defaults, then retry.`,
    );
  }
  return result;
}

/**
 * Known fields whose on-disk value was normalized or migrated. Absent fields
 * are not reported: only a value the user wrote and will silently lose.
 */
function replacedFields(
  raw: unknown,
  normalized: unknown,
  path = "",
): string[] {
  if (!isRecord(raw) || !isRecord(normalized)) {
    return JSON.stringify(raw) === JSON.stringify(normalized) ? [] : [path];
  }
  const paths: string[] = [];
  if (
    path === "" &&
    "summaries" in raw &&
    !("suggestions" in raw) &&
    "suggestions" in normalized
  ) {
    paths.push("summaries → suggestions");
  }
  if (path === "ui" && "footerItems" in raw && "footerLines" in normalized) {
    paths.push("ui.footerItems");
  }
  for (const [key, value] of Object.entries(normalized)) {
    if (!(key in raw)) continue;
    const here = path ? `${path}.${key}` : key;
    paths.push(...replacedFields(raw[key], value, here));
  }
  return paths;
}

/** Compare effective settings, independently of document creation/migration. */
function changedFields(before: unknown, after: unknown, path = ""): string[] {
  if (isDeepStrictEqual(before, after)) return [];
  if (!isRecord(before) || !isRecord(after)) return [path];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(
    (key) =>
      changedFields(before[key], after[key], path ? `${path}.${key}` : key),
  );
}

const isErrno = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

interface LockIdentity {
  readonly pid: number;
  readonly token: string;
}

interface LockOwnerV1 extends LockIdentity {
  readonly version: 1;
  readonly processStartedAt: number;
  readonly processStartedAtVerified: boolean;
  readonly createdAt: number;
}

interface LockOwnerV2 extends LockIdentity {
  readonly version: 2;
  readonly createdAt: number;
}

type LockOwner = LockOwnerV1 | LockOwnerV2;

type LockOwnerRead =
  | { kind: "owner"; owner: LockOwner }
  | { kind: "missing" }
  | { kind: "unknown" };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isStaleLock = (mtimeMs: number, now = Date.now()) =>
  now - mtimeMs >= SETUP_CONFIG_LOCK_STALE_MS;

function parseLockOwner(value: unknown): LockOwner | undefined {
  if (!isRecord(value)) return undefined;
  if (!isPositiveInteger(value.pid)) return undefined;
  if (!isPositiveInteger(value.createdAt)) return undefined;
  if (typeof value.token !== "string" || !UUID_PATTERN.test(value.token)) {
    return undefined;
  }
  if (value.version === SETUP_CONFIG_LOCK_VERSION) {
    return {
      version: SETUP_CONFIG_LOCK_VERSION,
      pid: value.pid,
      createdAt: value.createdAt,
      token: value.token,
    };
  }
  // Version 1 recorded a process start time and never refreshed its lease.
  // Honor it until that original timestamp goes stale, then recover it.
  if (value.version !== 1) return undefined;
  if (!isPositiveInteger(value.processStartedAt)) return undefined;
  if (typeof value.processStartedAtVerified !== "boolean") return undefined;
  return {
    version: 1,
    pid: value.pid,
    processStartedAt: value.processStartedAt,
    processStartedAtVerified: value.processStartedAtVerified,
    createdAt: value.createdAt,
    token: value.token,
  };
}

const sameOwner = (left: LockOwner, right: LockOwner) => {
  if (
    left.version !== right.version ||
    left.pid !== right.pid ||
    left.createdAt !== right.createdAt ||
    left.token !== right.token
  ) {
    return false;
  }
  if (left.version === 1 && right.version === 1) {
    return (
      left.processStartedAt === right.processStartedAt &&
      left.processStartedAtVerified === right.processStartedAtVerified
    );
  }
  return true;
};

const sameFile = (left: Stats, right: Stats) =>
  left.dev === right.dev && left.ino === right.ino;

function startLockHeartbeat(path: string) {
  const worker = new Worker(LOCK_HEARTBEAT_WORKER_SOURCE, {
    eval: true,
    workerData: {
      path,
      intervalMs: SETUP_CONFIG_LOCK_HEARTBEAT_MS,
    },
  });
  worker.unref();
  let readySettled = false;
  const ready = new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: unknown) => {
      if (readySettled) return;
      readySettled = true;
      if (timer) clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    timer = setTimeout(() => {
      fail(new Error("Setup config lock heartbeat did not start."));
    }, SETUP_CONFIG_LOCK_STALE_MS);
    worker.on("message", (message: unknown) => {
      if (message !== "ready") return;
      if (readySettled) return;
      readySettled = true;
      clearTimeout(timer);
      resolve();
    });
    worker.once("error", fail);
    worker.once("exit", (code) => {
      if (!readySettled && code !== 0) {
        fail(new Error(`Setup config lock heartbeat exited ${code}.`));
      }
    });
  });

  return {
    ready,
    async stop() {
      readySettled = true;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SETUP_CONFIG_LOCK_HEARTBEAT_MS);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        worker.on("message", (message: unknown) => {
          if (message === "stopped") done();
        });
        worker.once("exit", done);
        worker.once("error", done);
        try {
          worker.postMessage("stop");
        } catch {
          done();
        }
      });
      await worker.terminate().catch(() => undefined);
    },
  };
}

const makeLockIdentity = (): LockIdentity => ({
  pid: process.pid,
  token: randomUUID(),
});

/**
 * The owner document is fully written before `link()` atomically publishes the
 * lock path. Its companion hard link remains for the whole critical section.
 * Stale-owner recovery atomically renames that companion onto the recoverer's
 * own pid and token, so another recovery can take over if this one is killed
 * before it deletes the lock.
 */
const makeLockOwner = (): LockOwnerV2 => ({
  version: SETUP_CONFIG_LOCK_VERSION,
  ...makeLockIdentity(),
  createdAt: Date.now(),
});

const claimPathFor = (owner: LockOwner) =>
  owner.version === 1
    ? `${SETUP_CONFIG_LOCK_PATH}.owner.${owner.pid}.${owner.processStartedAt}.${owner.token}`
    : `${SETUP_CONFIG_LOCK_PATH}.owner.${owner.pid}.${owner.token}`;

const recoveryPathFor = (owner: LockOwner, recovery: LockIdentity) =>
  `${claimPathFor(owner)}.recovering.${recovery.pid}.${recovery.token}`;

const parseRecoveryIdentity = (owner: LockOwner, name: string) => {
  const prefix = `${basename(claimPathFor(owner))}.recovering.`;
  if (!name.startsWith(prefix)) return undefined;
  const parts = name.slice(prefix.length).split(".");
  // Current recoveries are `pid.token`. A version 1 recovery still in progress
  // is `pid.processStartedAt.verified.token`.
  const token = parts.at(-1);
  const pid = Number(parts[0]);
  const legacy = parts.length === 4;
  if (
    (parts.length !== 2 && !legacy) ||
    !isPositiveInteger(pid) ||
    !token ||
    !UUID_PATTERN.test(token) ||
    (legacy &&
      (!isPositiveInteger(Number(parts[1])) ||
        (parts[2] !== "0" && parts[2] !== "1")))
  ) {
    return undefined;
  }
  return { pid, token } satisfies LockIdentity;
};

async function readLockOwner(path: string): Promise<LockOwnerRead> {
  try {
    const owner = parseLockOwner(JSON.parse(await readFile(path, "utf8")));
    return owner ? { kind: "owner", owner } : { kind: "unknown" };
  } catch (error) {
    return isErrno(error, "ENOENT") ? { kind: "missing" } : { kind: "unknown" };
  }
}

async function lockMtime(path: string) {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
}

const lockTimeoutError = () =>
  new Error(
    `Timed out waiting for another Pi process to finish updating ${SETUP_CONFIG_PATH}.`,
  );

function waitForSetupConfigLock(deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
      if (error) reject(error);
      else resolve();
    };
    // A silent owner does not change the lock file. Wake even when fs.watch
    // drops the event so a lease can be rechecked on the caller's schedule.
    timer = setTimeout(() => finish(), remaining);

    try {
      const lockName = basename(SETUP_CONFIG_LOCK_PATH);
      watcher = watch(getAgentDir(), (_event, filename) => {
        if (filename === null || filename.toString() === lockName) finish();
      });
      watcher.on("error", finish);
      // Close the race where the owner released the lock before the watcher
      // became active. The caller always retries the atomic link afterwards.
      if (!existsSync(SETUP_CONFIG_LOCK_PATH)) queueMicrotask(finish);
    } catch (error) {
      finish(error);
    }
  });
}

async function findRecoveryClaim(owner: LockOwner) {
  const prefix = `${basename(claimPathFor(owner))}.recovering.`;
  let names: string[];
  try {
    names = (await readdir(getAgentDir())).filter((name) =>
      name.startsWith(prefix),
    );
  } catch {
    return undefined;
  }
  if (names.length !== 1) return undefined;
  const name = names[0]!;
  const recovery = parseRecoveryIdentity(owner, name);
  return recovery ? { path: join(getAgentDir(), name), recovery } : undefined;
}

async function takeRecoveryClaim(owner: LockOwner, lockStat: Stats) {
  const ownerClaimPath = claimPathFor(owner);
  const recovery = makeLockIdentity();
  const recoveryPath = recoveryPathFor(owner, recovery);
  const claimOwner = await readLockOwner(ownerClaimPath);

  if (claimOwner.kind === "owner") {
    if (!sameOwner(claimOwner.owner, owner)) return undefined;
    try {
      if (!sameFile(lockStat, await stat(ownerClaimPath))) return undefined;
      await rename(ownerClaimPath, recoveryPath);
      return recoveryPath;
    } catch (error) {
      return isErrno(error, "ENOENT") ? null : undefined;
    }
  }
  if (claimOwner.kind === "unknown") return undefined;

  const existing = await findRecoveryClaim(owner);
  if (!existing) return undefined;
  const existingMtime = await lockMtime(existing.path);
  if (existingMtime === undefined || !isStaleLock(existingMtime)) {
    return undefined;
  }
  const existingOwner = await readLockOwner(existing.path);
  if (
    existingOwner.kind !== "owner" ||
    !sameOwner(existingOwner.owner, owner)
  ) {
    return undefined;
  }
  try {
    if (!sameFile(lockStat, await stat(existing.path))) return undefined;
    await rename(existing.path, recoveryPath);
    return recoveryPath;
  } catch (error) {
    return isErrno(error, "ENOENT") ? null : undefined;
  }
}

async function restoreOwnerClaim(owner: LockOwner, recoveryPath: string) {
  try {
    await link(recoveryPath, claimPathFor(owner));
    await unlink(recoveryPath);
  } catch {
    // Keep every uncertain ownership artifact in place; a later writer will
    // fail closed rather than unlinking a lock it cannot prove is stale.
  }
}

async function recoverStaleSetupConfigLock() {
  const lockRead = await readLockOwner(SETUP_CONFIG_LOCK_PATH);
  if (lockRead.kind === "missing") return true;
  if (lockRead.kind !== "owner") return false;

  let lockStat: Stats;
  try {
    lockStat = await stat(SETUP_CONFIG_LOCK_PATH);
  } catch (error) {
    return isErrno(error, "ENOENT");
  }
  if (!isStaleLock(lockStat.mtimeMs)) return false;

  const recoveryPath = await takeRecoveryClaim(lockRead.owner, lockStat);
  if (recoveryPath === null) return true;
  if (!recoveryPath) return false;

  const currentLock = await readLockOwner(SETUP_CONFIG_LOCK_PATH);
  const recoveryOwner = await readLockOwner(recoveryPath);
  try {
    const currentStat = await stat(SETUP_CONFIG_LOCK_PATH);
    if (
      currentLock.kind !== "owner" ||
      recoveryOwner.kind !== "owner" ||
      !sameOwner(currentLock.owner, lockRead.owner) ||
      !sameOwner(recoveryOwner.owner, lockRead.owner) ||
      !isStaleLock(currentStat.mtimeMs) ||
      !sameFile(currentStat, await stat(recoveryPath))
    ) {
      await restoreOwnerClaim(lockRead.owner, recoveryPath);
      return false;
    }

    await unlink(SETUP_CONFIG_LOCK_PATH);
    await unlink(recoveryPath).catch(() => undefined);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      await unlink(recoveryPath).catch(() => undefined);
      return true;
    }
    await restoreOwnerClaim(lockRead.owner, recoveryPath);
    throw error;
  }
}

async function releaseSetupConfigLock(owner: LockOwner, claimPath: string) {
  const lockRead = await readLockOwner(SETUP_CONFIG_LOCK_PATH);
  const claimRead = await readLockOwner(claimPath);
  if (
    lockRead.kind !== "owner" ||
    claimRead.kind !== "owner" ||
    !sameOwner(lockRead.owner, owner) ||
    !sameOwner(claimRead.owner, owner) ||
    !sameFile(await stat(SETUP_CONFIG_LOCK_PATH), await stat(claimPath))
  ) {
    throw new Error(
      `Refusing to release setup config lock with uncertain ownership at ${SETUP_CONFIG_LOCK_PATH}.`,
    );
  }
  await unlink(SETUP_CONFIG_LOCK_PATH);
  await unlink(claimPath).catch(() => undefined);
}

async function withSetupConfigLock<A>(action: () => Promise<A>) {
  await mkdir(getAgentDir(), { recursive: true });
  const owner = makeLockOwner();
  const claimPath = claimPathFor(owner);
  await writeFile(claimPath, `${JSON.stringify(owner)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const started = Date.now();
  const patienceDeadline = started + SETUP_CONFIG_LOCK_TIMEOUT_MS;
  const hardDeadline = patienceDeadline + SETUP_CONFIG_LOCK_STALE_MS;
  let acquired = false;
  let heartbeat: ReturnType<typeof startLockHeartbeat> | undefined;
  let observedMtime: number | undefined;
  let lastRenewedAt = 0;

  try {
    while (true) {
      try {
        await link(claimPath, SETUP_CONFIG_LOCK_PATH);
        acquired = true;
        break;
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        if (await recoverStaleSetupConfigLock()) continue;

        const now = Date.now();
        if (now >= hardDeadline) throw lockTimeoutError();
        const lockRead = await readLockOwner(SETUP_CONFIG_LOCK_PATH);
        if (lockRead.kind === "missing") continue;
        if (lockRead.kind !== "owner") {
          if (now >= patienceDeadline) throw lockTimeoutError();
        } else {
          const mtimeMs = await lockMtime(SETUP_CONFIG_LOCK_PATH);
          if (mtimeMs === undefined) continue;
          if (
            observedMtime !== undefined &&
            mtimeMs > observedMtime + SETUP_CONFIG_LOCK_HEARTBEAT_MS / 2
          ) {
            lastRenewedAt = now;
          }
          observedMtime = mtimeMs;
          if (now >= patienceDeadline) {
            const holderStillRefreshing =
              lastRenewedAt > 0 &&
              now - lastRenewedAt < SETUP_CONFIG_LOCK_ACTIVE_MS;
            // A quiet owner keeps the lease it already published. A holder
            // that refreshed during this wait is still working. A stale lock
            // we could not prove from its companion stops here too.
            if (holderStillRefreshing || isStaleLock(mtimeMs, now)) {
              throw lockTimeoutError();
            }
          }
        }
        await waitForSetupConfigLock(
          Math.min(hardDeadline, now + SETUP_CONFIG_LOCK_RECHECK_MS),
        );
      }
    }

    heartbeat = startLockHeartbeat(SETUP_CONFIG_LOCK_PATH);
    await heartbeat.ready;
    return await action();
  } finally {
    await heartbeat?.stop();
    if (acquired) await releaseSetupConfigLock(owner, claimPath);
    else await unlink(claimPath).catch(() => undefined);
  }
}

function preserveUnknown(
  raw: unknown,
  canonical: unknown,
  shape: ConfigShape,
): Record<string, unknown> {
  const result: Record<string, unknown> = isRecord(canonical)
    ? { ...canonical }
    : {};
  if (!isRecord(raw)) return result;
  for (const [key, value] of Object.entries(raw)) {
    const rule = Object.hasOwn(shape, key) ? shape[key] : undefined;
    if (!rule)
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    else if (typeof rule !== "function" && Object.hasOwn(result, key)) {
      result[key] = preserveUnknown(value, result[key], rule);
    }
  }
  // Retired keys may contain future fields: keep only those unknown remnants.
  for (const key of ["summaries"]) {
    if (
      shape === setupShape &&
      !Object.hasOwn(result, key) &&
      isRecord(raw[key])
    ) {
      const unknown = preserveUnknown(raw[key], {}, suggestionShape);
      if (Object.keys(unknown).length) result[key] = unknown;
    }
  }
  return result;
}

async function writeSetupBytes(bytes: string) {
  const tempPath = `${SETUP_CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, bytes, {
      encoding: "utf8",
      mode: 0o600,
    });
    const identity = await stat(tempPath);
    await rename(tempPath, SETUP_CONFIG_PATH);
    return identity;
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function saveSetupConfig(config: MyPiSetupConfig) {
  await updateSetupConfig(() => config);
}

export function formatSetupConfig(config = loadSetupConfig()) {
  const suggestionModel = config.suggestions.model;
  const suggestions =
    !config.suggestions.enabled || !suggestionModel
      ? "Next-action suggestions: disabled"
      : `Next-action suggestions: ${suggestionModel.provider}/${suggestionModel.model} · ${suggestionModel.reasoning} · Right accepts`;
  const footer = config.ui.customFooter
    ? `on · ${config.ui.footerStyle} · ${formatFooterLines(config.ui.footerLines)}`
    : "off";
  return [
    `Code Mode default: ${config.codeMode.enabled ? "on" : "off"} · Pi native codemode in CLI and Web parents · native tool selections take precedence · children retain inherited tool limits`,
    `Capability discovery: ${config.capabilities.discovery}`,
    suggestions,
    `Browser control: ${config.browser.control ? "on" : "off"} · default ${config.browser.defaultBrowser} · embedded ${config.browser.embedded ? "allowed" : "blocked"} · external ${config.browser.externalBrowsers.join(", ") || "none"}`,
    `Browser choices: embedded (Chromium host), ${EXTERNAL_BROWSERS.join(", ")}; Safari/Firefox use native tabs.`,
    `Web search: ${config.webSearch.enabled ? "on" : "off"} · current Session model and Pi credentials · unsupported or unknown connections receive no search tool · ${config.webSearch.modelSupport.length} explicit model support declarations · no search-provider fallback`,
    `Response preferences: verbosity ${config.response.verbosity} · reasoning summary ${config.response.reasoningSummary} · Responses APIs only; default preserves Pi's request`,
    `Hidden Web thinking levels: ${config.ui.webHiddenThinkingLevels.join(", ") || "none"} · presentation only; native support and current effort are unchanged`,
    `Workflows: ${config.workflows.concurrency} concurrent agents · ${config.workflows.maxAgentCalls} total calls`,
    config.childExecutions.maxActive === undefined
      ? "Session child executions: unbounded (disabled)"
      : `Session child executions: ${config.childExecutions.maxActive} active slots shared by Workflow, Direct Subagent, and BTW`,
    `UI: Web theme ${config.ui.webTheme} · palette ${config.ui.webAppearance.palette} · accent ${config.ui.webAppearance.accent || "theme default"} / background ${config.ui.webAppearance.background || "theme default"} / foreground ${config.ui.webAppearance.foreground || "theme default"} · font ${config.ui.webAppearance.font} · chat ${config.ui.webChatWidth}px / ${config.ui.webChatFontSize}px / thinking ${config.ui.webExpandThinking ? "expanded" : "collapsed"} · panes ${config.ui.webSidebarWidth}px / ${config.ui.webAuxiliaryWidth}px · sidebar ${config.ui.webSidebarGrouping} / chats ${config.ui.webChatsSort} / pinned ${config.ui.webPinnedSort} / projects in recents ${config.ui.webProjectsInRecents ? "on" : "off"} · large header ${config.ui.showHeader ? "on" : "off"} · custom footer ${footer}`,
    `Subagent results: ${config.ui.subagentResultDisplay === "full" ? "full by default" : "compact status summary (Ctrl+O expands full output)"}`,
    `Bash operations: ${config.ui.bashToolDisplay === "full" ? "expanded by default" : "one-line activity summary (Ctrl+O restores native evidence)"}`,
    `Write/Edit operations: ${config.ui.fileMutationDisplay === "full" ? "expanded by default" : "one-line activity summary (Ctrl+O restores native evidence)"}`,
    `Post-edit command: ${config.postEdit.command ? "configured" : "off"}`,
    "Pi Skills and packages: native configuration · Web setup requests review changes · explicit idle Session reload",
    `Agent role models (Subagents + Workflows): ${SUBAGENT_ROLE_NAMES.map((role) => `${role} ${config.subagents.roleModels[role] ? `${config.subagents.roleModels[role].provider}/${config.subagents.roleModels[role].model}` : "inherit"}`).join(" · ")}`,
  ].join("\n");
}

export { isFooterItem, isFooterLayoutItem, isFooterPreset };

/**
 * Read-modify-write against the document as it is on disk right now, so a
 * config changed by another session since this one loaded it is patched
 * rather than replaced wholesale. Returns the fields whose stored value was
 * normalized or migrated, so the caller can say so out loud.
 */
export async function updateSetupConfig(
  mutate: (current: MyPiSetupConfig) => MyPiSetupConfig,
  apply?: (config: MyPiSetupConfig) => Promise<void>,
  signal?: AbortSignal,
) {
  return withSetupConfigLock(async () => {
    const previous = readDocumentForWrite();
    signal?.throwIfAborted();
    const current = previous.config;
    const candidate = mutate(current);
    const invalid = inspectDocument(candidate).filter(
      (item) => item.severity === "error",
    );
    if (invalid.length)
      throw new Error(
        `Invalid configuration fields: ${invalid.map((item) => item.path).join(", ")}`,
      );
    const config = parseSetupConfig(candidate);
    const document = preserveUnknown(previous.raw, config, setupShape);
    document.configVersion = SETUP_CONFIG_VERSION;
    const remainingUnknown = new Set(
      inspectDocument(document)
        .filter((item) => item.message === "Unknown field preserved")
        .map((item) => item.path),
    );
    const removedUnknown = previous.diagnostics.filter(
      (item) =>
        item.message === "Unknown field preserved" &&
        !remainingUnknown.has(item.path),
    );
    if (removedUnknown.length)
      throw new Error(
        `Change would remove unknown fields; repair them explicitly before retrying: ${removedUnknown.map((item) => JSON.stringify(item.path)).join(", ")}`,
      );
    const bytes = `${JSON.stringify(document, null, 2)}\n`;
    const candidateIdentity = await writeSetupBytes(bytes);
    try {
      signal?.throwIfAborted();
      await apply?.(config);
      signal?.throwIfAborted();
    } catch (error) {
      try {
        if (
          !sameFile(candidateIdentity, await stat(SETUP_CONFIG_PATH)) ||
          (await readFile(SETUP_CONFIG_PATH, "utf8")) !== bytes
        ) {
          throw new Error(
            "Configuration changed externally; refusing to overwrite it during rollback",
          );
        }
        if (previous.bytes === undefined) await unlink(SETUP_CONFIG_PATH);
        else await writeSetupBytes(previous.bytes);
        await apply?.(current);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Configuration apply failed; recovery incomplete. Inspect /openpi-setup before retrying.",
        );
      }
      throw new Error(
        "Configuration apply failed; previous file and configuration restored.",
        { cause: error },
      );
    }
    return {
      config,
      changed: changedFields(current, config),
      replaced:
        previous.source === "missing"
          ? []
          : replacedFields(previous.raw, current),
      diagnostics: previous.diagnostics,
    };
  });
}
