import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { readTurnTiming, WEB_TURN_TIMING_ENTRY } from "./turn-timing.ts";
import { readTurnChangesDetail, summarizeTurnChanges, WEB_TURN_CHANGES_ENTRY, type WebTurnChanges } from "./turn-changes.ts";
import { WEB_COMMAND_INPUT, WEB_COMMAND_FEEDBACK, WEB_COMMAND_HANDLED } from "../../extensions/shared/web-command-feedback.ts";
import type { WebCapabilitySnapshot } from "../../extensions/shared/web-observer-registry.ts";
import type { WebActiveTurn, WebThinkingProjection, WebSessionExecution } from "../runtime/types.ts";
import { bashReceipt, projectEvidenceArguments, isEvidenceTool, type LiveToolEvidence } from "./evidence.ts";

export const WEB_PROTOCOL_VERSION = 1;
export const WEB_MAX_EVENTS = 200;
export const WEB_MAX_EVENT_BYTES = 64 * 1024;
export const WEB_MAX_TEXT = 12_000;
export const WEB_PROMPT_MAX_TEXT_LENGTH = 12_000;
export const WEB_MAX_SESSION_PREVIEW = 500;
const WEB_MAX_METADATA_TEXT = 500;
export const WEB_MAX_ENTRIES = 250;
export const WEB_MAX_PROMPT_HISTORY_PAGE = 100;
export const WEB_MAX_PROMPT_PREVIEW_CHARS = 240;
export const WEB_MAX_MESSAGE_PARTS = 64;
export const WEB_MAX_SESSIONS = 500;
export const WEB_MAX_WORKSPACES = 250;
export const WEB_MAX_MODELS = 250;
export const WEB_MAX_ARCHIVED_SESSION_PAGE = 50;
export const WEB_MAX_ARCHIVED_SESSION_QUERY = 160;
export const WEB_MAX_ARCHIVED_SESSION_CURSOR = 512;
export const WEB_MAX_ARCHIVED_SESSION_SCAN = 5_000;
export const WEB_MAX_MODEL_SEARCH_RESULTS = 50;
export const WEB_MAX_MODEL_SEARCH_BYTES = 64 * 1024;
export const WEB_MAX_MODEL_QUERY = 200;
export const WEB_MAX_COMMANDS = 250;
export const WEB_MAX_COMMAND_BYTES = 64 * 1024;
export const WEB_MAX_COMMAND_NAME = 160;
export const WEB_MAX_COMMAND_DESCRIPTION = 500;
export const WEB_PROMPT_IMAGE_MAX_COUNT = 8;
export const WEB_PROMPT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const WEB_PROMPT_IMAGE_MAX_BASE64_CHARS = 4 * Math.ceil(WEB_PROMPT_IMAGE_MAX_BYTES / 3);
export const WEB_PROMPT_IMAGE_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export type WebPromptDelivery =
  | { streamingBehavior: "followUp"; expectedTurnCommandId?: never }
  | { streamingBehavior: "steer"; expectedTurnCommandId: string };
export const WEB_MAX_GIT_REVIEW_FILES = 200;
export const WEB_MAX_GIT_REVIEW_DIFF_BYTES = 3 * 1024 * 1024;
export const WEB_MAX_SELECTED_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
export const WEB_MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const WEB_MAX_THINKING_LEVEL = 500;
export const WEB_MAX_THINKING_LEVELS = 16;

export interface WebEvent {
  protocolVersion: typeof WEB_PROTOCOL_VERSION;
  sequence: number;
  type: string;
  timestamp: string;
  detail?: Record<string, unknown>;
}

export interface WebSessionSummary {
  pinOrder?: number;
  id: string;
  path: string;
  cwd: string;
  /** Classification of this Web directory projection, not original creation history. */
  source: "web-session";
  origin: "web";
  /** Current runtime only; not a global ownership lock. */
  controller: "web" | "none";
  /** Existing operation admission rules still apply. */
  readOnly: false;
  name?: string;
  modified: string;
  created: string;
  messageCount: number;
  firstMessage: string;
  archived?: boolean;
  ungrouped?: boolean;
  /** Exact live ownership or a confirmed last-turn receipt; unknown never implies idle. */
  execution?: {
    status: "running" | "idle" | "unknown";
    pendingFollowUps?: number;
    pendingSteering?: number;
    waitingForInput?: boolean;
    compacting?: boolean;
    lastTurn?: { commandId: string; finishedAt: number; outcome: "completed" | "cancelled" | "failed" | "uncertain"; resultEntryId?: string };
  };
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

export interface WebModelSearchResult {
  models: WebModelSummary[];
  totalAvailable: number;
  totalMatches: number;
  truncation: {
    truncated: boolean;
    matchesOmitted: number;
    maxResults: number;
    maxBytes: number;
    bytes: number;
  };
}

export interface WebCommandSummary {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  availability: "available" | "unsupported";
  argumentHint?: string;
  action?: "terminal" | "review" | "subagents" | "runtime" | "side-conversation";
  unavailableReason?: "terminal_only" | "not_integrated";
  support?: "plan" | "setup";
}

export interface WebCommandDiscoveryResult {
  commands: WebCommandSummary[];
  totalAvailable: number;
  truncation: {
    truncated: boolean;
    commandsOmitted: number;
    maxCommands: number;
    maxBytes: number;
    bytes: number;
  };
}

export type WebThemePreference =
  | "light"
  | "dark"
  | "mist"
  | "rose"
  | "pine"
  | "system";

export interface WebSettingsSkillSummary {
  id: string;
  name: string;
  description: string;
  filePath: string;
  source: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
  disableModelInvocation: boolean;
}

export interface WebSettingsExtensionSummary {
  name: string;
  path: string;
  toolCount: number;
  commandCount: number;
}

export interface WebSettingsPluginSummary {
  id: string;
  source: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
  baseDir?: string;
  extensions: WebSettingsExtensionSummary[];
  skills: string[];
  prompts: string[];
  themes: string[];
}

export interface WebSettingsResourceCatalog {
  skills: WebSettingsSkillSummary[];
  plugins: WebSettingsPluginSummary[];
  totals: {
    extensions: number;
    skills: number;
    prompts: number;
    themes: number;
  };
  diagnostics: {
    extensionErrors: number;
    skillErrors: number;
  };
  truncation: {
    truncated: boolean;
    skillsOmitted: number;
    pluginsOmitted: number;
    resourcesOmitted: number;
  };
}

export interface WebOpenPiSetupProjection {
  capabilities: {
    discovery: "explicit" | "adaptive";
  };
  suggestions: {
    enabled: boolean;
    model?: {
      provider: string;
      model: string;
      reasoning: string;
    };
  };
  workflows: {
    concurrency: number;
    maxAgentCalls: number;
  };
  ui: {
    webTheme: WebThemePreference;
    webChatWidth: number;
    webSidebarWidth?: number;
    webAuxiliaryWidth?: number;
    webChatFontSize: number;
    webExpandThinking: boolean;
    webPinnedSort?: "manual" | "updated";
    showHeader: boolean;
    customFooter: boolean;
    footerStyle: string;
    subagentResultDisplay: "full" | "compact";
    bashToolDisplay: "full" | "compact";
    fileMutationDisplay: "full" | "compact";
  };
  postEditConfigured: boolean;
  subagents: {
    roleModels: Partial<
      Record<
        "explorer" | "implementer" | "reviewer" | "advisor",
        { provider: string; model: string }
      >
    >;
  };
}

export interface WebSettingsCatalog {
  sessionId: string;
  setup: WebOpenPiSetupProjection;
  resources: WebSettingsResourceCatalog;
}

export interface WebSettingsPreferencesPatch {
  subagentResultDisplay?: "full" | "compact";
  bashToolDisplay?: "full" | "compact";
  fileMutationDisplay?: "full" | "compact";
  customFooter?: boolean;
  footerStyle?: "plain" | "powerline" | "powerline-mono";
  pinnedSort?: "manual" | "updated";
  theme?: WebThemePreference;
  chatWidth?: number;
  sidebarWidth?: number;
  auxiliaryWidth?: number;
  chatFontSize?: number;
  expandThinking?: boolean;
}

export interface WebProjectionTruncation {
  readonly truncated: boolean;
  readonly entriesOmitted: number;
  readonly messagePartsOmitted: number;
  readonly messagesTruncated: number;
  readonly maxBytes: number;
}

export interface WebSessionProjection {
  id: string;
  path: string;
  cwd: string;
  entries: ReturnType<typeof projectEntry>[];
  bytes: number;
  truncation: WebProjectionTruncation;
  rerun?: { source: WebHistoryAnchor; mode: "edit" | "regenerate" };
  history?: {
    leafEntryId: string | null;
    beforeEntryId: string | null;
    anchorEntryId?: string;
    anchorOnBranch?: boolean;
  };
}

export interface WebHistoryAnchor {
  sessionId: string;
  sessionPath: string;
  entryId: string;
}

export interface WebSessionHistoryPage extends WebSessionProjection {
  anchorEntryId: string;
  requestedBeforeEntryId: string;
}

export interface WebSessionPromptHistoryPage {
  sessionId: string;
  sessionPath: string;
  anchorEntryId: string;
  requestedBeforeEntryId: string | null;
  entryIds: string[];
  nextBeforeEntryId: string | null;
}

export interface WebSessionPromptPreview {
  sessionId: string;
  sessionPath: string;
  anchorEntryId: string;
  entryId: string;
  prompt: string;
  response: string;
}

export interface WebSessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  context?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
}

export interface WebInteractiveTerminal {
  id: string;
  sessionId: string;
  cwd: string;
  exited: boolean;
  exitCode: number | null;
  reused?: boolean;
}

export type WebInteractiveTerminalEvent =
  | { type: "output"; data: string; offset: number; reset?: boolean }
  | { type: "exit"; exitCode: number }
  | { type: "closed" };

export interface WebMessageTruncation {
  readonly truncated: true;
  readonly text?: true;
  readonly visibleText?: true;
  readonly partsOmitted?: number;
  readonly details?: true;
}

export interface WebLiveMessage {
  timestamp?: number;
  commandId?: string;
  terminalReceipt?: ReturnType<typeof bashReceipt>;
  role?: string;
  toolName?: string;
  content: string;
  parts?: WebMessagePart[];
  toolCallId?: string;
  isError?: boolean;
  stopReason?: "stop" | "length" | "toolUse" | "aborted" | "error";
  /** Bounded, redacted provider failure text; not a substitute for the terminal reason. */
  errorMessage?: string;
  customType?: string;
  display?: boolean;
  details?: unknown;
  truncation?: WebMessageTruncation;
}

export interface WebPromptImage {
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  name?: string;
}

export type WebMessagePart =
  | { type: "text"; text: string }
  | {
      type: "image";
      mimeType: string;
      name?: string;
      previewUrl?: string;
      sourcePartIndex?: number;
    }
  | { type: "thinking"; text: string }
  | { type: "toolCall"; id?: string; name: string; arguments: string; evidenceArguments?: Record<string, unknown>; evidenceTruncated?: boolean };

export interface WebSnapshotTruncation {
  truncated: boolean;
  sessionsOmitted: number;
  workspacesOmitted: number;
  modelsOmitted: number;
  maxBytes: number;
  bytes: number;
}

export interface WebThinkingState {
  readonly level: string;
  readonly available: readonly string[];
  /** false before a model is selected or for non-reasoning models. */
  readonly supported: boolean;
  /** Host-assigned monotonic value (SSE sequence); newer wins. */
  readonly revision: number;
}

export type WebGitReviewFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "unknown";

export interface WebGitReviewFile {
  statsUnavailable?: "before_unavailable" | "content_limit" | "concurrent_change";
  binary?: boolean;
  path: string;
  previousPath?: string;
  status: WebGitReviewFileStatus;
  diff: string;
  diffTruncated: boolean;
  diffLoaded?: boolean;
  additions: number;
  deletions: number;
}

export type WebGitReviewSource = "unstaged" | "staged" | "branch" | "session";

export interface WebGitReviewBranches {
  currentBranch: string | null;
  options: { ref: string; label: string }[];
  truncated: boolean;
}

export interface WebGitReviewSnapshot {
  /** Text-line totals across the entire enumerated comparison, not this page. */
  totals?: { additions: number; deletions: number; complete: boolean };
  evidenceSource?: "file-tools";
  /** Available only for a bounded, versioned summary listing. */
  totalFiles?: number;
  nextOffset?: number;
  listComplete?: boolean;
  repositoryRoot: string;
  currentBranch: string | null;
  baseBranch: string | null;
  comparison: WebGitReviewSource;
  revision: string;
  files: WebGitReviewFile[];
  additions: number;
  deletions: number;
  truncated: boolean;
}

export type WebGitReviewResult =
  | { ok: true; snapshot: WebGitReviewSnapshot; branches?: WebGitReviewBranches; summaryRevision?: string }
  | {
      ok: false;
      reason:
        | "revision_changed"
        | "not_git_repository"
        | "unborn_repository"
        | "baseline_unavailable"
        | "git_failed"
        | "base_branch_unavailable"
        | "invalid_base_branch";
      branches?: WebGitReviewBranches;
    };

/**
 * Bounds a runtime thinking projection at the wire boundary. Shared by the
 * adapter snapshot and the host's GET/POST /api/thinking responses so an
 * unbounded runtime projection can never reach the client. `revision` is
 * host-assigned and deliberately excluded here.
 */
export function boundThinkingProjection(
  projection: WebThinkingProjection,
): Omit<WebThinkingState, "revision"> {
  return {
    level: projection.level.slice(0, WEB_MAX_THINKING_LEVEL),
    available: projection.available
      .slice(0, WEB_MAX_THINKING_LEVELS)
      .map((level) => level.slice(0, WEB_MAX_THINKING_LEVEL)),
    supported: projection.supported === true,
  };
}

export interface WebSnapshot {
  protocolVersion: typeof WEB_PROTOCOL_VERSION;
  generatedAt: string;
  cursor: number;
  preferences: {
    theme: WebThemePreference;
    /** Optional for compatibility with snapshots emitted before Web display preferences existed. */
    chatWidth?: number;
    sidebarWidth?: number;
    auxiliaryWidth?: number;
    chatFontSize?: number;
    expandThinking?: boolean;
    subagentResultDisplay?: "full" | "compact";
    bashToolDisplay?: "full" | "compact";
    fileMutationDisplay?: "full" | "compact";
    pinnedSort?: "manual" | "updated";
  };
  /** Absent until the browser selects or creates a real Web Session. */
  currentSessionId?: string;
  /** Pi's current file identity; copied files may share an embedded id. */
  currentSessionPath?: string;
  workspaces: WebWorkspaceSummary[];
  sessions: WebSessionSummary[];
  selectedSession?: WebSessionProjection;
  /** Facts for the selected Session; they do not transfer input control. */
  selectedExecution?: WebSessionExecution;
  /** Current Pi Session only. Historical projections do not invent live context usage. */
  usage?: WebSessionUsage;
  models: WebModelSummary[];
  /** Optional diagnostic; absent when the runtime cannot report it. */
  thinking?: WebThinkingState;
  runtime: {
    setup?: import("./setup-outcome.ts").WebSetupOutcome;
    plan?: "inactive" | "planning" | "ready" | "invalid";
    planRevision?: string | null;
    planHasPrompt?: boolean;
    liveTools?: LiveToolEvidence[];
    status: "idle" | "running" | "unknown";
    activeTurn?: WebActiveTurn;
    capabilities: WebCapabilitySnapshot;
  };
  truncation: WebSnapshotTruncation;
}

interface BoundedText {
  readonly value: string;
  readonly truncated: boolean;
}

function boundedTextProjection(value: string, maxLength: number): BoundedText {
  return value.length > maxLength
    ? {
        value: `${value.slice(0, maxLength)}\n[truncated]`,
        truncated: true,
      }
    : { value, truncated: false };
}

const assistantStopReasons = new Set(["stop", "length", "toolUse", "aborted", "error"]);

export function projectAssistantError(value: string) {
  const cleaned = value
    .replace(/[\x00-\x1f\x7f-\x9f]/gu, " ")
    .replace(/https?:\/\/[^\s<>"']+/giu, "[redacted URL]")
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(/(["']?(?:api[_-]?key|authorization|access[_-]?token|token|secret|password)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, "$1[redacted]")
    .replace(/(?<![A-Za-z0-9_])[A-Za-z0-9-]{24,}(?![A-Za-z0-9_])/gu, "[redacted]")
    .trim();
  return boundedTextProjection(cleaned, WEB_MAX_METADATA_TEXT);
}

export function boundedText(value: string, maxLength = WEB_MAX_TEXT): string {
  return boundedTextProjection(value, maxLength).value;
}

const WEB_MAX_DETAILS_BYTES = 24 * 1024;
const WEB_MAX_STRUCTURED_DEPTH = 6;
const WEB_MAX_STRUCTURED_NODES = 512;
const WEB_MAX_STRUCTURED_PROPERTIES = 128;
const WEB_MAX_STRUCTURED_ARRAY_ITEMS = 128;

interface StructuredBudget {
  bytes: number;
  nodes: number;
  truncated: boolean;
  readonly seen: WeakSet<object>;
}

function consumeStructuredText(value: string, budget: StructuredBudget) {
  const candidate = value.slice(0, Math.min(value.length, budget.bytes));
  const encoded = textEncoder.encode(candidate);
  if (encoded.byteLength <= budget.bytes) {
    budget.bytes -= encoded.byteLength;
    if (candidate.length < value.length) budget.truncated = true;
    return candidate;
  }
  budget.truncated = true;
  if (budget.bytes <= 0) return "";
  const bounded = new TextDecoder().decode(encoded.slice(0, budget.bytes));
  budget.bytes = 0;
  return bounded;
}

function boundedStructuredValue(
  value: unknown,
  budget: StructuredBudget,
  depth = 0,
): unknown {
  if (budget.nodes-- <= 0 || depth > WEB_MAX_STRUCTURED_DEPTH) {
    budget.truncated = true;
    return undefined;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return consumeStructuredText(value, budget);
  if (typeof value === "bigint") return consumeStructuredText(String(value), budget);
  if (typeof value !== "object") {
    budget.truncated = true;
    return undefined;
  }
  if (budget.seen.has(value)) {
    budget.truncated = true;
    return undefined;
  }
  budget.seen.add(value);
  if (Array.isArray(value)) {
    const length = Math.min(value.length, WEB_MAX_STRUCTURED_ARRAY_ITEMS);
    if (value.length > length) budget.truncated = true;
    const projected: unknown[] = [];
    for (let index = 0; index < length; index++) {
      if (budget.nodes <= 0 || budget.bytes <= 0) {
        budget.truncated = true;
        break;
      }
      const item = boundedStructuredValue(value[index], budget, depth + 1);
      if (item !== undefined) projected.push(item);
    }
    return projected;
  }
  const projected: Record<string, unknown> = {};
  let scannedProperties = 0;
  for (const key in value) {
    if (scannedProperties++ >= WEB_MAX_STRUCTURED_PROPERTIES) {
      budget.truncated = true;
      break;
    }
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (budget.nodes <= 0 || budget.bytes <= 0) {
      budget.truncated = true;
      break;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      budget.truncated = true;
      continue;
    }
    const boundedKey = consumeStructuredText(key, budget);
    const item = boundedStructuredValue(descriptor.value, budget, depth + 1);
    if (item !== undefined) {
      Object.defineProperty(projected, boundedKey, {
        value: item,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return projected;
}

function detailsProjection(value: unknown) {
  if (value === undefined || value === null) {
    return { value: undefined, truncated: false };
  }
  const budget: StructuredBudget = {
    bytes: WEB_MAX_DETAILS_BYTES,
    nodes: WEB_MAX_STRUCTURED_NODES,
    truncated: false,
    seen: new WeakSet(),
  };
  const projected = boundedStructuredValue(value, budget);
  if (!budget.truncated && jsonByteLength(projected) > WEB_MAX_DETAILS_BYTES) {
    budget.truncated = true;
  }
  return {
    value: budget.truncated ? undefined : projected,
    truncated: budget.truncated,
  };
}

/** Keep structured tool details only when they serialize small and clean. */
export function boundedDetails(value: unknown): unknown {
  return detailsProjection(value).value;
}

function projectContent(message: Record<string, unknown>, resolvePath?: (path: string) => string | undefined) {
  const content = message.content;
  if (typeof content === "string") {
    const text = boundedTextProjection(content, WEB_MAX_TEXT);
    return {
      content: text.value,
      parts: [] as WebMessagePart[],
      partsOmitted: 0,
      textTruncated: text.truncated,
      visibleTextTruncated: text.truncated,
    };
  }
  if (!Array.isArray(content)) {
    const fallback =
      typeof message.output === "string"
        ? message.output
        : typeof message.summary === "string"
          ? message.summary
          : "";
    const text = boundedTextProjection(
      fallback,
      WEB_MAX_TEXT,
    );
    return {
      content: text.value,
      parts: [] as WebMessagePart[],
      partsOmitted: 0,
      textTruncated: text.truncated,
      visibleTextTruncated: text.truncated,
    };
  }

  const parts: WebMessagePart[] = [];
  let visibleText = "";
  let textTruncated = false;
  let visibleTextTruncated = false;
  const retainedParts = Math.min(content.length, WEB_MAX_MESSAGE_PARTS);
  for (let index = 0; index < retainedParts; index++) {
    const part = content[index];
    if (typeof part !== "object" || part === null) continue;
    const typed = part as Record<string, unknown>;
    let projected: WebMessagePart | undefined;
    if (typed.type === "text" && typeof typed.text === "string") {
      const text = boundedTextProjection(typed.text, WEB_MAX_TEXT);
      projected = { type: "text", text: text.value };
      textTruncated ||= text.truncated;
      visibleTextTruncated ||= text.truncated;
      if (visibleText.length < WEB_MAX_TEXT) {
        const separator = visibleText.length > 0 ? "\n" : "";
        const remaining = WEB_MAX_TEXT - visibleText.length - separator.length;
        if (remaining > 0) visibleText += `${separator}${text.value.slice(0, remaining)}`;
        if (text.value.length > remaining) {
          textTruncated = true;
          visibleTextTruncated = true;
        }
      } else {
        textTruncated = true;
        visibleTextTruncated = true;
      }
    } else if (
      typed.type === "image" &&
      typeof typed.mimeType === "string"
    ) {
      projected = {
        type: "image",
        mimeType: typed.mimeType,
        sourcePartIndex: index,
        ...(typeof typed.name === "string" ? { name: typed.name.slice(0, 255) } : {}),
      };
    } else if (
      typed.type === "thinking" &&
      typeof typed.thinking === "string"
    ) {
      const text = boundedTextProjection(typed.thinking, WEB_MAX_TEXT);
      projected = { type: "thinking", text: text.value };
      textTruncated ||= text.truncated;
    } else if (typed.type === "toolCall") {
      const argumentsBudget: StructuredBudget = {
        bytes: WEB_MAX_TEXT,
        nodes: WEB_MAX_STRUCTURED_NODES,
        truncated: false,
        seen: new WeakSet(),
      };
      const boundedArguments = boundedStructuredValue(
        typed.arguments ?? {},
        argumentsBudget,
      );
      const argumentsText = JSON.stringify(boundedArguments ?? {});
      const argumentsProjection = boundedTextProjection(
        argumentsText,
        WEB_MAX_TEXT,
      );
      const id =
        typeof typed.id === "string"
          ? boundedTextProjection(typed.id, WEB_MAX_METADATA_TEXT)
          : undefined;
      const name = boundedTextProjection(
        typeof typed.name === "string" ? typed.name : "tool",
        WEB_MAX_METADATA_TEXT,
      );
      const evidenceArguments = isEvidenceTool(name.value) ? projectEvidenceArguments(typed.arguments) : undefined;
      if (evidenceArguments && typeof evidenceArguments.path === "string" && !evidenceArguments.path.startsWith("~") && !evidenceArguments.path.startsWith("@")) {
        const path = resolvePath?.(evidenceArguments.path);
        if (path && path.length <= 4096) evidenceArguments.resolvedPath = path;
      }
      projected = {
        type: "toolCall",
        ...(id ? { id: id.value } : {}),
        name: name.value,
        arguments: argumentsProjection.value,
        ...(evidenceArguments ? { evidenceArguments } : {}),
        ...((argumentsProjection.truncated || argumentsBudget.truncated || id?.truncated || name.truncated) ? { evidenceTruncated: true } : {}),
      };
      textTruncated ||=
        argumentsProjection.truncated ||
        argumentsBudget.truncated ||
        id?.truncated === true ||
        name.truncated;
    }
    if (!projected) continue;
    parts.push(projected);
  }
  const contentText = boundedTextProjection(visibleText, WEB_MAX_TEXT);
  visibleTextTruncated ||= contentText.truncated;
  // Inspect only a bounded number of omitted data properties; never invoke
  // arbitrary getters while projecting an untrusted Session message.
  const inspectionEnd = Math.min(content.length, retainedParts + WEB_MAX_MESSAGE_PARTS);
  for (let index = retainedParts; !visibleTextTruncated && index < inspectionEnd; index++) {
    const part = Object.getOwnPropertyDescriptor(content, index)?.value;
    if (part && typeof part === "object" && Object.getOwnPropertyDescriptor(part, "type")?.value === "text" &&
      typeof Object.getOwnPropertyDescriptor(part, "text")?.value === "string" && Object.getOwnPropertyDescriptor(part, "text")!.value.length > 0)
      visibleTextTruncated = true;
  }
  // Beyond the inspection budget, offer full-text recovery rather than silently
  // hiding a later text part. The role gate below excludes tool results.
  if (content.length > inspectionEnd) visibleTextTruncated = true;
  return {
    content: contentText.value,
    parts,
    partsOmitted: Math.max(0, content.length - retainedParts),
    textTruncated: textTruncated || contentText.truncated,
    visibleTextTruncated,
  };
}

export function projectMessage(message: unknown, resolvePath?: (path: string) => string | undefined): WebLiveMessage {
  const value =
    message && typeof message === "object"
      ? (message as Record<string, unknown>)
      : {};
  const content = projectContent(value, resolvePath);
  const details = detailsProjection(value.details);
  const role =
    typeof value.role === "string"
      ? boundedTextProjection(value.role, WEB_MAX_METADATA_TEXT)
      : undefined;
  const toolName =
    typeof value.toolName === "string"
      ? boundedTextProjection(value.toolName, WEB_MAX_METADATA_TEXT)
      : undefined;
  const toolCallId =
    typeof value.toolCallId === "string"
      ? boundedTextProjection(value.toolCallId, WEB_MAX_METADATA_TEXT)
      : undefined;
  const customType =
    typeof value.customType === "string"
      ? boundedTextProjection(value.customType, WEB_MAX_METADATA_TEXT)
      : undefined;
  const stopReason = value.role === "assistant" && assistantStopReasons.has(String(value.stopReason))
    ? value.stopReason as WebLiveMessage["stopReason"]
    : undefined;
  const errorMessage = stopReason === "error" && typeof value.errorMessage === "string"
    ? projectAssistantError(value.errorMessage)
    : undefined;
  const metadataTruncated =
    role?.truncated === true ||
    toolName?.truncated === true ||
    toolCallId?.truncated === true ||
    customType?.truncated === true;
  const truncated =
    content.textTruncated ||
    content.partsOmitted > 0 ||
    details.truncated ||
    metadataTruncated || errorMessage?.truncated === true;
  return {
    role: role?.value,
    ...(typeof value.timestamp === "number" && Number.isFinite(value.timestamp) ? { timestamp: value.timestamp } : {}),
    ...(value.toolName === "bash" && value.isError === true ? { terminalReceipt: bashReceipt(value.content, value.isError) } : {}),
    toolName: toolName?.value,
    content: content.content,
    ...(content.parts.length > 0 ? { parts: content.parts } : {}),
    ...(toolCallId ? { toolCallId: toolCallId.value } : {}),
    ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(errorMessage ? { errorMessage: errorMessage.value } : {}),
    ...(customType ? { customType: customType.value } : {}),
    ...(typeof value.display === "boolean" ? { display: value.display } : {}),
    ...(details.value !== undefined ? { details: details.value } : {}),
    ...(truncated
      ? {
          truncation: {
            truncated: true as const,
            ...(content.textTruncated || metadataTruncated || errorMessage?.truncated
              ? { text: true as const }
              : {}),
            ...((role?.value === "user" || role?.value === "assistant") && content.visibleTextTruncated
              ? { visibleText: true as const }
              : {}),
            ...(content.partsOmitted > 0
              ? { partsOmitted: content.partsOmitted }
              : {}),
            ...(details.truncated ? { details: true as const } : {}),
          },
        }
      : {}),
  };
}

export function projectEntry(entry: SessionEntry, resolvePath?: (path: string) => string | undefined): {
  type: SessionEntry["type"];
  id: string;
  timestamp: string;
  parentId?: string | null;
  message?: WebLiveMessage;
  turnTiming?: ReturnType<typeof readTurnTiming>;
  turnChanges?: WebTurnChanges;
} {
  const metadata = { id: entry.id, timestamp: entry.timestamp, ...(entry.parentId === undefined ? {} : { parentId: entry.parentId }) };
  if (entry.type === "custom" && entry.customType === WEB_TURN_TIMING_ENTRY) {
    const turnTiming = readTurnTiming(entry.data);
    if (turnTiming) return { type: entry.type, ...metadata, turnTiming };
  }
  if (entry.type === "custom" && entry.customType === WEB_TURN_CHANGES_ENTRY) {
    const detail = readTurnChangesDetail(entry.data);
    if (detail) return { type: entry.type, ...metadata, turnChanges: summarizeTurnChanges(detail) };
  }
  if (entry.type === "custom" && entry.customType === "subagent-result") {
    // Pi persists the user-facing receipt separately from its hidden model
    // follow-up. Project the display receipt, never the transport instruction.
    const data = entry.data;
    const content = data && typeof data === "object"
      ? Object.getOwnPropertyDescriptor(data, "content")?.value
      : undefined;
    if (typeof content === "string") {
      return {
        type: "message",
        ...metadata,
        message: projectMessage({
          role: "custom",
          customType: entry.customType,
          content,
          details: Object.getOwnPropertyDescriptor(data, "details")?.value,
          display: true,
        }, resolvePath),
      };
    }
  }
  if (entry.type === "custom_message") {
    return {
      type: "message" as const,
      ...metadata,
      message: projectMessage(
        {
          role: "custom",
          customType: entry.customType,
          content: entry.content,
          details: entry.details,
          display: entry.display,
        },
        resolvePath,
      ),
    };
  }
  if (entry.type === "custom" && entry.customType === WEB_COMMAND_HANDLED) {
    const data: unknown = entry.data;
    if (data && typeof data === "object" && "inputEntryId" in data &&
      typeof data.inputEntryId === "string" && data.inputEntryId.length > 0 &&
      data.inputEntryId.length <= 128 && !/[\s\u0000-\u001f]/u.test(data.inputEntryId) &&
      "commandId" in data && typeof data.commandId === "string" &&
      data.commandId.length > 0 && data.commandId.length <= 200) {
      return { type: "message", ...metadata, message: {
        role: "custom", customType: WEB_COMMAND_HANDLED, content: "",
        details: { inputEntryId: data.inputEntryId, commandId: data.commandId },
      } satisfies WebLiveMessage };
    }
  }
  if (entry.type === "custom" && (entry.customType === WEB_COMMAND_INPUT || entry.customType === WEB_COMMAND_FEEDBACK)) {
    const data: unknown = entry.data;
    if (data && typeof data === "object" && "text" in data && typeof data.text === "string") {
      const message: WebLiveMessage = { role: entry.customType === WEB_COMMAND_INPUT ? "user" : "custom", content: data.text.slice(0, WEB_MAX_TEXT), customType: entry.customType,
        ...("commandId" in data && typeof data.commandId === "string" ? { commandId: data.commandId.slice(0, 200) } : {}),
        ...(data.text.length > WEB_MAX_TEXT || ("truncated" in data && data.truncated === true) ? { truncation: { truncated: true, text: true,
          ...(entry.customType === WEB_COMMAND_INPUT && data.text.length > WEB_MAX_TEXT ? { visibleText: true as const } : {}) } } : {}) };
      return { type: "message", ...metadata,
        message };
    }
  }
  if (entry.type !== "message") {
    return { type: entry.type, ...metadata };
  }
  return {
    type: entry.type,
    ...metadata,
    message: projectMessage(entry.message, resolvePath),
  };
}

const textEncoder = new TextEncoder();

export function jsonByteLength(value: unknown) {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

export function projectEntries(entries: readonly SessionEntry[], resolvePath?: (path: string) => string | undefined, maxBytes = WEB_MAX_SELECTED_TRANSCRIPT_BYTES) {
  const budget = Math.min(maxBytes, WEB_MAX_SELECTED_TRANSCRIPT_BYTES);
  const retained = entries.slice(-WEB_MAX_ENTRIES);
  const projected: ReturnType<typeof projectEntry>[] = [];
  let bytes = 2;
  let messagePartsOmitted = 0;
  let messagesTruncated = 0;
  for (let index = retained.length - 1; index >= 0; index--) {
    const entry = projectEntry(retained[index]!, resolvePath);
    let entryBytes = jsonByteLength(entry);
    if (entryBytes + 2 > budget && entry.message?.parts?.length) {
      const originalParts = entry.message.parts;
      const previousOmitted = entry.message.truncation?.partsOmitted ?? 0;
      const message = {
        ...entry.message,
        parts: [] as WebMessagePart[],
        truncation: { ...entry.message.truncation, truncated: true as const, partsOmitted: previousOmitted + originalParts.length },
      };
      entry.message = message;
      let retainedBytes = jsonByteLength(entry) + 2;
      for (const part of originalParts) {
        const partBytes = jsonByteLength(part) + (message.parts.length > 0 ? 1 : 0);
        if (retainedBytes + partBytes > budget) break;
        message.parts.push(part);
        retainedBytes += partBytes;
      }
      message.truncation.partsOmitted = previousOmitted + originalParts.length - message.parts.length;
      entryBytes = jsonByteLength(entry);
    }
    entryBytes += projected.length > 0 ? 1 : 0;
    if (bytes + entryBytes > budget) break;
    projected.unshift(entry);
    bytes += entryBytes;
    if (entry.type === "message" && entry.message) {
      messagePartsOmitted += entry.message.truncation?.partsOmitted ?? 0;
      if (entry.message.truncation) messagesTruncated++;
    }
  }
  const entriesOmitted = entries.length - projected.length;
  return {
    entries: projected,
    bytes,
    truncation: {
      truncated:
        entriesOmitted > 0 ||
        messagePartsOmitted > 0 ||
        messagesTruncated > 0,
      entriesOmitted,
      messagePartsOmitted,
      messagesTruncated,
      maxBytes: WEB_MAX_SELECTED_TRANSCRIPT_BYTES,
    } satisfies WebProjectionTruncation,
  };
}
