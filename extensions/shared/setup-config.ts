import { execFile } from "node:child_process";
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
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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

export const WEB_THEMES = [
  "light",
  "dark",
  "mist",
  "rose",
  "pine",
  "system",
] as const;
export type WebTheme = (typeof WEB_THEMES)[number];

export const DEFAULT_WEB_CHAT_WIDTH = 820;
export const MIN_WEB_CHAT_WIDTH = 820;
export const MAX_WEB_CHAT_WIDTH = 2_000;
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
  readonly ui: {
    readonly webTheme: WebTheme;
    readonly webChatWidth: number;
    readonly webChatFontSize: number;
    readonly webExpandThinking: boolean;
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
  capabilities: { discovery: "explicit" },
  suggestions: { enabled: false },
  workflows: {
    concurrency: DEFAULT_WORKFLOW_CONCURRENCY,
    maxAgentCalls: DEFAULT_WORKFLOW_MAX_AGENT_CALLS,
  },
  childExecutions: {},
  ui: {
    webTheme: "system",
    webChatWidth: DEFAULT_WEB_CHAT_WIDTH,
    webChatFontSize: DEFAULT_WEB_CHAT_FONT_SIZE,
    webExpandThinking: false,
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
const SETUP_CONFIG_LOCK_TIMEOUT_MS = 5_000;
const SETUP_CONFIG_LOCK_RECHECK_MS = 500;
const SETUP_CONFIG_LOCK_VERSION = 1;
const ESTIMATED_PROCESS_STARTED_AT = Math.max(
  1,
  Math.round(Date.now() - process.uptime() * 1_000),
);

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

const isCapabilityDiscoveryMode = (
  value: unknown,
): value is CapabilityDiscoveryMode =>
  typeof value === "string" &&
  CAPABILITY_DISCOVERY_MODES.includes(value as CapabilityDiscoveryMode);

const isWebTheme = (value: unknown): value is WebTheme =>
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
  const subagents = isRecord(value.subagents) ? value.subagents : {};
  const footer = parseUiFooter(ui);
  return {
    capabilities: {
      discovery: isCapabilityDiscoveryMode(capabilities.discovery)
        ? capabilities.discovery
        : "explicit",
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
    ui: {
      webTheme: isWebTheme(ui.webTheme) ? ui.webTheme : "system",
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
      webExpandThinking:
        typeof ui.webExpandThinking === "boolean"
          ? ui.webExpandThinking
          : false,
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
  ui: {
    webTheme: isWebTheme,
    webChatWidth: integerBetween(MIN_WEB_CHAT_WIDTH, MAX_WEB_CHAT_WIDTH),
    webChatFontSize: integerBetween(
      MIN_WEB_CHAT_FONT_SIZE,
      MAX_WEB_CHAT_FONT_SIZE,
    ),
    webExpandThinking: booleanValue,
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
    bytes = readFileSync(SETUP_CONFIG_PATH, "utf8");
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
  readonly processStartedAt: number;
  readonly processStartedAtVerified: boolean;
  readonly token: string;
}

interface LockOwner extends LockIdentity {
  readonly version: typeof SETUP_CONFIG_LOCK_VERSION;
  readonly createdAt: number;
}

type LockOwnerRead =
  | { kind: "owner"; owner: LockOwner }
  | { kind: "missing" }
  | { kind: "unknown" };

type ProcessLiveness = "live" | "dead" | "unknown";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function parseLockOwner(value: unknown): LockOwner | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== SETUP_CONFIG_LOCK_VERSION) return undefined;
  if (!isPositiveInteger(value.pid)) return undefined;
  if (!isPositiveInteger(value.processStartedAt)) return undefined;
  if (typeof value.processStartedAtVerified !== "boolean") return undefined;
  if (!isPositiveInteger(value.createdAt)) return undefined;
  if (typeof value.token !== "string" || !UUID_PATTERN.test(value.token))
    return undefined;
  return {
    version: SETUP_CONFIG_LOCK_VERSION,
    pid: value.pid,
    processStartedAt: value.processStartedAt,
    processStartedAtVerified: value.processStartedAtVerified,
    createdAt: value.createdAt,
    token: value.token,
  };
}

const sameOwner = (left: LockOwner, right: LockOwner) =>
  left.version === right.version &&
  left.pid === right.pid &&
  left.processStartedAt === right.processStartedAt &&
  left.processStartedAtVerified === right.processStartedAtVerified &&
  left.createdAt === right.createdAt &&
  left.token === right.token;

const sameFile = (left: Stats, right: Stats) =>
  left.dev === right.dev && left.ino === right.ino;

const parsePowerShellProcessStartedAt = (stdout: string) => {
  const startedAt = Number(stdout.trim());
  return isPositiveInteger(startedAt) ? startedAt : undefined;
};

const parsePsProcessStartedAt = (stdout: string) => {
  const startedAt = Date.parse(stdout.trim());
  return Number.isFinite(startedAt) ? startedAt : undefined;
};

export function processStartedAtQuery(
  pid: number,
  platform = process.platform,
) {
  if (platform === "win32") {
    const script = [
      "$ErrorActionPreference='Stop'",
      `$p=Get-Process -Id ${pid}`,
      "[Console]::Out.Write(([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds())",
    ].join("; ");
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-Command", script],
      env: undefined,
      parseOutput: parsePowerShellProcessStartedAt,
    };
  }
  return {
    command: "ps",
    args: ["-o", "lstart=", "-p", String(pid)],
    env: { LC_ALL: "C" },
    parseOutput: parsePsProcessStartedAt,
  };
}

const queryProcessStartedAt = (pid: number) =>
  new Promise<number | undefined>((resolve) => {
    const query = processStartedAtQuery(pid);
    try {
      execFile(
        query.command,
        query.args,
        {
          encoding: "utf8",
          env: query.env ? { ...process.env, ...query.env } : process.env,
          timeout: 1_000,
        },
        (error, stdout) => {
          resolve(error ? undefined : query.parseOutput(stdout));
        },
      );
    } catch {
      resolve(undefined);
    }
  });

const makeLockIdentity = async (): Promise<LockIdentity> => {
  const processStartedAt = await queryProcessStartedAt(process.pid);
  return {
    pid: process.pid,
    processStartedAt: processStartedAt ?? ESTIMATED_PROCESS_STARTED_AT,
    processStartedAtVerified: processStartedAt !== undefined,
    token: randomUUID(),
  };
};

/**
 * The owner document is fully written before `link()` atomically publishes the
 * lock path. Its companion hard link remains for the whole critical section.
 * A dead-owner recovery atomically renames that companion to its own PID/token,
 * so another recovery can take over if the recovering process is also killed.
 */
const makeLockOwner = async (): Promise<LockOwner> => ({
  version: SETUP_CONFIG_LOCK_VERSION,
  ...(await makeLockIdentity()),
  createdAt: Date.now(),
});

const claimPathFor = (owner: LockOwner) =>
  `${SETUP_CONFIG_LOCK_PATH}.owner.${owner.pid}.${owner.processStartedAt}.${owner.token}`;

const recoveryPathFor = (owner: LockOwner, recovery: LockIdentity) =>
  `${claimPathFor(owner)}.recovering.${recovery.pid}.${recovery.processStartedAt}.${recovery.processStartedAtVerified ? 1 : 0}.${recovery.token}`;

const parseRecoveryIdentity = (owner: LockOwner, name: string) => {
  const prefix = `${basename(claimPathFor(owner))}.recovering.`;
  if (!name.startsWith(prefix)) return undefined;
  const [rawPid, rawStartedAt, rawVerified, token, ...extra] = name
    .slice(prefix.length)
    .split(".");
  const pid = Number(rawPid);
  const processStartedAt = Number(rawStartedAt);
  if (
    extra.length > 0 ||
    !isPositiveInteger(pid) ||
    !isPositiveInteger(processStartedAt) ||
    (rawVerified !== "0" && rawVerified !== "1") ||
    !token ||
    !UUID_PATTERN.test(token)
  ) {
    return undefined;
  }
  return {
    pid,
    processStartedAt,
    processStartedAtVerified: rawVerified === "1",
    token,
  } satisfies LockIdentity;
};

async function readLockOwner(path: string): Promise<LockOwnerRead> {
  try {
    const owner = parseLockOwner(JSON.parse(await readFile(path, "utf8")));
    return owner ? { kind: "owner", owner } : { kind: "unknown" };
  } catch (error) {
    return isErrno(error, "ENOENT") ? { kind: "missing" } : { kind: "unknown" };
  }
}

async function processLiveness(
  identity: LockIdentity,
): Promise<ProcessLiveness> {
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    return isErrno(error, "ESRCH") ? "dead" : "unknown";
  }
  if (!identity.processStartedAtVerified) return "unknown";
  const processStartedAt = await queryProcessStartedAt(identity.pid);
  if (processStartedAt === undefined) return "unknown";
  return processStartedAt === identity.processStartedAt ? "live" : "dead";
}

const lockTimeoutError = () =>
  new Error(
    `Timed out waiting for another Pi process to finish updating ${SETUP_CONFIG_PATH}.`,
  );

function waitForSetupConfigLock(deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(lockTimeoutError());

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    // A dead owner does not change the lock file, so periodically retry the
    // existing fail-closed recovery path before the shared deadline expires.
    const recheckTimer = setTimeout(
      () => finish(),
      Math.min(remaining, SETUP_CONFIG_LOCK_RECHECK_MS),
    );
    const timer = setTimeout(() => {
      // fs.watch may coalesce or drop events. Recheck the atomic lock path at
      // the deadline so a released lock cannot become a false timeout.
      if (!existsSync(SETUP_CONFIG_LOCK_PATH)) finish();
      else finish(lockTimeoutError());
    }, remaining);
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(recheckTimer);
      watcher?.close();
      if (error) reject(error);
      else resolve();
    };

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
  const recovery = await makeLockIdentity();
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
  if ((await processLiveness(existing.recovery)) !== "dead") return undefined;
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
  if (
    lockRead.kind !== "owner" ||
    (await processLiveness(lockRead.owner)) !== "dead"
  ) {
    return false;
  }

  let lockStat: Stats;
  try {
    lockStat = await stat(SETUP_CONFIG_LOCK_PATH);
  } catch (error) {
    return isErrno(error, "ENOENT");
  }

  const recoveryPath = await takeRecoveryClaim(lockRead.owner, lockStat);
  if (recoveryPath === null) return true;
  if (!recoveryPath) return false;

  const currentLock = await readLockOwner(SETUP_CONFIG_LOCK_PATH);
  const recoveryOwner = await readLockOwner(recoveryPath);
  try {
    if (
      currentLock.kind !== "owner" ||
      recoveryOwner.kind !== "owner" ||
      !sameOwner(currentLock.owner, lockRead.owner) ||
      !sameOwner(recoveryOwner.owner, lockRead.owner) ||
      (await processLiveness(currentLock.owner)) !== "dead" ||
      !sameFile(await stat(SETUP_CONFIG_LOCK_PATH), await stat(recoveryPath))
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
  const owner = await makeLockOwner();
  const claimPath = claimPathFor(owner);
  await writeFile(claimPath, `${JSON.stringify(owner)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const deadline = Date.now() + SETUP_CONFIG_LOCK_TIMEOUT_MS;
  let acquired = false;

  try {
    while (true) {
      try {
        await link(claimPath, SETUP_CONFIG_LOCK_PATH);
        acquired = true;
        break;
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        if (await recoverStaleSetupConfigLock()) continue;
        await waitForSetupConfigLock(deadline);
      }
    }

    try {
      return await action();
    } finally {
      await releaseSetupConfigLock(owner, claimPath);
      acquired = false;
    }
  } finally {
    if (!acquired) await unlink(claimPath).catch(() => undefined);
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
    `Capability discovery: ${config.capabilities.discovery}`,
    suggestions,
    `Workflows: ${config.workflows.concurrency} concurrent agents · ${config.workflows.maxAgentCalls} total calls`,
    config.childExecutions.maxActive === undefined
      ? "Session child executions: unbounded (disabled)"
      : `Session child executions: ${config.childExecutions.maxActive} active slots shared by Workflow, Direct Subagent, and BTW`,
    `UI: Web theme ${config.ui.webTheme} · chat ${config.ui.webChatWidth}px / ${config.ui.webChatFontSize}px / thinking ${config.ui.webExpandThinking ? "expanded" : "collapsed"} · large header ${config.ui.showHeader ? "on" : "off"} · custom footer ${footer}`,
    `Subagent results: ${config.ui.subagentResultDisplay === "full" ? "full by default" : "compact status summary (Ctrl+O expands full output)"}`,
    `Bash operations: ${config.ui.bashToolDisplay === "full" ? "expanded by default" : "one-line activity summary (Ctrl+O restores native evidence)"}`,
    `Write/Edit operations: ${config.ui.fileMutationDisplay === "full" ? "expanded by default" : "one-line activity summary (Ctrl+O restores native evidence)"}`,
    `Post-edit command: ${config.postEdit.command ? "configured" : "off"}`,
    `Agent role models (Subagents + Workflows): ${SUBAGENT_ROLE_NAMES.map((role) => `${role} ${config.subagents.roleModels[role] ? `${config.subagents.roleModels[role].provider}/${config.subagents.roleModels[role].model}` : "inherit"}`).join(" · ")}`,
  ].join("\n");
}

export { isFooterItem, isFooterLayoutItem, isFooterPreset, isFooterStyle };

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
