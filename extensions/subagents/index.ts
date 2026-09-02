/**
 * Subagents — spawn background subagents as in-process pi sessions, behind a
 * single Effect service interface.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: fire-and-forget spawn (prompt, name, optional harness,
 *   working_dir, model, reasoning_effort, and agent_type when this environment
 *   defines any). Model-spawned subagents and user /btw asides run in separate
 *   pools (MAX_RUNNING and MAX_RUNNING_BTW).
 * - subagent_wait: block until the listed subagents settle, return results.
 * - subagent_cancel: stop one or more running subagents.
 * - subagent_check: peek at a subagent's status and recent activity.
 * - subagent_list: list all subagents.
 *
 * Unawaited subagents queue their result as a follow-up message when they
 * settle. `/subagents` opens a picker + full interactive takeover view.
 *
 * Agent types (`src/agent-types.ts`) are optional named presets that fix a
 * child's system prompt, model, and tool allowlist; see
 * `skills/subagents/REFERENCE.md`.
 *
 * Architecture: Effect v4 generators throughout (backend -> manager ->
 * runtime); this file is the async boundary where tool handlers run effects
 * against one shared ManagedRuntime.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  getAgentDir,
  getMarkdownTheme,
  keyHint,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  createStatusWriter,
  formatActivityStatus,
  hasActivity,
  unreadActivityCounts,
} from "../shared/activity-status.ts";
import { sanitizeText } from "../shared/agent-transcript.ts";
import {
  BelowEditorNavigationEditor,
  BelowEditorStripState,
} from "../shared/below-editor-navigation.ts";
import {
  effectiveChildToolAllowlist,
  resolveStandaloneChildProjectTrust,
} from "../shared/child-session.ts";
import { formatContextUtilization } from "../shared/context-utilization.ts";
import {
  registerEditorLayer,
  removeEditorLayer,
} from "../shared/editor-layers.ts";
import {
  PLAN_MODE_CHANNEL,
  type PlanModeState,
  planModeAllowsDeclaredTools,
  planModeChildTools,
} from "../shared/plan-mode-state.ts";
import {
  allocateResultBudgets,
  type ParentContextUsage,
} from "../shared/result-budget.ts";
import { type DetailDisplay, loadSetupConfig } from "../shared/setup-config.ts";
import {
  OPENPI_TOOL_SURFACE,
  patchOwnedTools,
} from "../shared/tool-surface.ts";
import {
  projectSubagentCapability,
  registerWebCapability,
} from "../shared/web-observer-registry.ts";
import {
  createWorktree,
  formatWorktreeCleanupWarning,
  reclaimWorktree,
  type Worktree,
} from "../shared/worktree.ts";
import {
  normalizeSubagentTitle,
  SubagentStripWidget,
  selectSubagentStripEntry,
  subagentStripEntryKey,
} from "./navigation.ts";
import {
  formatAgentTypeDiagnostics,
  loadAgentTypes,
  roleModelForAgentType,
  selectSubagentModel,
} from "./src/agent-types.ts";
import { deriveBtwTitle, isModelVisible } from "./src/by-the-way.ts";
import {
  BACKEND_NAMES,
  formatElapsed,
  latestText,
  type SubagentSnapshot,
} from "./src/domain.ts";
import {
  restoreSubagentIdCounters,
  SUBAGENT_ID_WATERMARK_ENTRY_TYPE,
  type SubagentIdCounters,
  subagentIdWatermark,
} from "./src/id-sequence.ts";
import { SubagentManager, type SubagentManagerShape } from "./src/manager.ts";
import {
  buildSubagentResultDisplayMessage,
  buildSubagentResultMessage,
  buildSubagentSendResult,
  buildSubagentSpawnResult,
  createSubagentSpawnToolSurface,
  SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CANCEL_TOOL_DESCRIPTION,
  SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CHECK_TOOL_DESCRIPTION,
  SUBAGENT_LIST_TOOL_DESCRIPTION,
  SUBAGENT_SEND_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SEND_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
  stripSubagentResultTransportInstruction,
} from "./src/prompt.ts";
import {
  persistResultArtifact,
  projectResult,
  type ResultProjection,
} from "./src/result-artifact.ts";
import { createSubagentResultDelivery } from "./src/result-delivery.ts";
import {
  createSubagentRuntime,
  runTool,
  type SubagentRuntime,
} from "./src/runtime.ts";
import { openSubagentPicker, openSubagentTakeover } from "./src/ui/takeover.ts";
import {
  renderWaitResult,
  renderWaitResultPreview,
  type WaitResultDetails,
} from "./src/ui/wait-result.ts";

const SUBAGENT_OUTPUT_MAX_BYTES = 24 * 1024;
const AUTOMATIC_OUTPUT_MAX_BYTES = 48 * 1024;
const AUTOMATIC_MIN_RESULT_BYTES = 2 * 1024;
const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;
const WAIT_MIN_RESULT_BYTES = 512;
const RESULT_HEADROOM_SHARE = 0.5;
const ESTIMATED_BYTES_PER_TOKEN = 4;
const AUTOMATIC_BATCH_TRUNCATION_NOTICE =
  "\n\n[Automatic subagent result batch truncated at the 48 KiB total limit.]";

interface SpawnResultDetails {
  readonly id?: string;
  readonly title?: string;
  readonly harness?: string;
  readonly model?: string;
  readonly agentType?: string;
}

interface SubagentFinishedData {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentSnapshot["status"];
  readonly elapsed: string;
}

interface SubagentResultDetails {
  readonly id?: string;
  readonly title?: string;
  readonly status?: SubagentSnapshot["status"];
  readonly outcome?: SubagentSnapshot["outcome"];
  readonly worktreeBranch?: string;
  readonly elapsed?: string;
  readonly artifactSaveFailed?: boolean;
  readonly fullResultSaved?: boolean;
  readonly count?: number;
  readonly results?: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly status: SubagentSnapshot["status"];
    readonly outcome?: SubagentSnapshot["outcome"];
    readonly worktreeBranch?: string;
    readonly elapsed?: string;
    readonly artifactSaveFailed?: boolean;
    readonly fullResultSaved?: boolean;
  }>;
  /** Display-only projection for the custom message renderer. */
  readonly displayContent?: string;
}

interface SubagentResultEntryData {
  readonly content: string;
  readonly details: SubagentResultDetails;
}

interface BtwResultData {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentSnapshot["status"];
  readonly errorText?: string;
  readonly prompt: string;
  readonly answer: string;
  readonly sessionFilePath?: string;
}

function describeSubagent(snap: SubagentSnapshot) {
  const details = [
    `${snap.backend}: ${snap.meta.modelLabel ?? "?"}`,
    formatContextUtilization(snap.usage),
    formatElapsed(snap),
    snap.cwd,
  ].filter(Boolean);
  return `${snap.id} [${snap.status}] "${snap.title}" (${details.join(", ")})`;
}

export function truncatedOutput(
  snap: SubagentSnapshot,
  maxBytes = SUBAGENT_OUTPUT_MAX_BYTES,
  writeArtifact: (content: string) => string = (content) =>
    persistResultArtifact(getAgentDir(), content),
): string {
  const output = snap.finalText || "(no output)";
  return projectResult(output, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(600, DEFAULT_MAX_LINES),
    writeArtifact,
  }).text;
}

function projectSubagentOutput(
  snap: SubagentSnapshot,
  maxBytes: number,
): ResultProjection {
  const output = snap.finalText || "(no output)";
  return projectResult(output, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(600, DEFAULT_MAX_LINES),
    writeArtifact: (content) => persistResultArtifact(getAgentDir(), content),
  });
}

type OutputProjection = Pick<
  ResultProjection,
  "text" | "artifactPath" | "artifactSaveFailed"
>;

function normalizeProjection(
  output: string | OutputProjection,
): OutputProjection {
  return typeof output === "string" ? { text: output } : output;
}

function boundAutomaticResultBatch(content: string) {
  const probe = truncateHead(content, {
    maxBytes: AUTOMATIC_OUTPUT_MAX_BYTES,
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  if (!probe.truncated) return content;

  const noticeBytes = Buffer.byteLength(
    AUTOMATIC_BATCH_TRUNCATION_NOTICE,
    "utf8",
  );
  const bounded = truncateHead(content, {
    maxBytes: Math.max(0, AUTOMATIC_OUTPUT_MAX_BYTES - noticeBytes),
    maxLines: Number.MAX_SAFE_INTEGER,
  });
  return `${bounded.content}${AUTOMATIC_BATCH_TRUNCATION_NOTICE}`;
}

export function createSubagentResultDispatcher(
  pi: ExtensionAPI,
  outputFor: (
    snap: SubagentSnapshot,
    maxBytes: number,
  ) => string | OutputProjection = projectSubagentOutput,
  getContextUsage: () => ParentContextUsage | undefined = () => undefined,
) {
  return (snaps: readonly SubagentSnapshot[]) => {
    if (snaps.length === 0) return;
    const emptyMessages = snaps.map((snap) =>
      buildSubagentResultMessage({
        id: snap.id,
        title: snap.title,
        status: snap.status,
        errorText: snap.errorText,
        output: "",
      }),
    );
    const wrapperBytes =
      emptyMessages.reduce(
        (sum, message) => sum + Buffer.byteLength(message, "utf8"),
        0,
      ) +
      Math.max(0, snaps.length - 1) * 2;
    const projectionBatchBytes = Math.max(
      0,
      AUTOMATIC_OUTPUT_MAX_BYTES - wrapperBytes,
    );
    const allocation = allocateResultBudgets(
      snaps.map((snap) =>
        Buffer.byteLength(snap.finalText || "(no output)", "utf8"),
      ),
      getContextUsage(),
      {
        maxBatchBytes: projectionBatchBytes,
        maxResultBytes: SUBAGENT_OUTPUT_MAX_BYTES,
        minResultBytes: AUTOMATIC_MIN_RESULT_BYTES,
        headroomShare: RESULT_HEADROOM_SHARE,
        estimatedBytesPerToken: ESTIMATED_BYTES_PER_TOKEN,
        fixedBytes: wrapperBytes,
      },
    );
    const projections = snaps.map((snap, index) =>
      normalizeProjection(outputFor(snap, allocation.budgets[index]!)),
    );
    const outputs = projections.map((projection) => projection.text);
    const displayContent = boundAutomaticResultBatch(
      snaps
        .map((snap, index) =>
          buildSubagentResultDisplayMessage({
            id: snap.id,
            title: snap.title,
            status: snap.status,
            errorText: snap.errorText,
            output: outputs[index]!,
          }),
        )
        .join("\n\n"),
    );
    const content = boundAutomaticResultBatch(
      snaps
        .map((snap, index) =>
          buildSubagentResultMessage({
            id: snap.id,
            title: snap.title,
            status: snap.status,
            errorText: snap.errorText,
            output: outputs[index]!,
          }),
        )
        .join("\n\n"),
    );
    const details: SubagentResultDetails =
      snaps.length === 1
        ? {
            id: snaps[0]!.id,
            title: snaps[0]!.title,
            status: snaps[0]!.status,
            ...(snaps[0]!.outcome ? { outcome: snaps[0]!.outcome } : {}),
            ...(snaps[0]!.worktreeBranch
              ? { worktreeBranch: snaps[0]!.worktreeBranch }
              : {}),
            elapsed: formatElapsed(snaps[0]!),
            ...(projections[0]!.artifactPath ? { fullResultSaved: true } : {}),
            ...(projections[0]!.artifactSaveFailed
              ? { artifactSaveFailed: true }
              : {}),
          }
        : {
            count: snaps.length,
            results: snaps.map((snap, index) => ({
              id: snap.id,
              title: snap.title,
              status: snap.status,
              ...(snap.outcome ? { outcome: snap.outcome } : {}),
              ...(snap.worktreeBranch
                ? { worktreeBranch: snap.worktreeBranch }
                : {}),
              elapsed: formatElapsed(snap),
              ...(projections[index]!.artifactPath
                ? { fullResultSaved: true }
                : {}),
              ...(projections[index]!.artifactSaveFailed
                ? { artifactSaveFailed: true }
                : {}),
            })),
          };
    pi.appendEntry<SubagentResultEntryData>("subagent-result", {
      content: displayContent,
      details,
    });
    pi.sendMessage(
      {
        customType: "subagent-result",
        content,
        display: false,
        details: { ...details, displayContent },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };
}

type SubagentResultTheme = Parameters<MessageRenderer>[2];

function renderSubagentResult(
  content: string,
  details: SubagentResultDetails,
  expanded: boolean,
  resultDisplay: DetailDisplay,
  theme: SubagentResultTheme,
) {
  const displayContent = sanitizeText(
    details.displayContent ?? stripSubagentResultTransportInstruction(content),
  );
  const results = details.results?.length
    ? details.results
    : details.id
      ? [
          {
            id: details.id,
            title: details.title,
            status: details.status,
            outcome: details.outcome,
            worktreeBranch: details.worktreeBranch,
            elapsed: details.elapsed,
            artifactSaveFailed: details.artifactSaveFailed,
            fullResultSaved: details.fullResultSaved,
          },
        ]
      : [];
  if (!expanded && resultDisplay === "compact") {
    return renderWaitResultPreview(displayContent, { results }, theme);
  }

  const failed = results.some((result) => result.status === "error");
  const batched = results.length > 1;
  const icon = failed ? theme.fg("error", "x") : theme.fg("success", "✓");
  const header = batched
    ? `${icon} ${theme.fg("accent", theme.bold(`${results.length} subagents`))}${theme.fg("muted", ` · ${failed ? `${results.filter((result) => result.status === "error").length} failed` : "finished"}`)}`
    : `${icon} ` +
      theme.fg(
        "accent",
        theme.bold(`subagent ${sanitizeText(details.id ?? "?")}`),
      ) +
      theme.fg(
        "muted",
        ` · ${sanitizeText(details.title ?? "")} · ${failed ? "failed" : "finished"}${details.elapsed ? ` · ${sanitizeText(details.elapsed)}` : ""}`,
      );

  // Remove only the single-result summary line. Error lines and batched result
  // summaries are part of the display projection and must remain visible.
  const body = batched
    ? displayContent.trim()
    : displayContent.split("\n").slice(1).join("\n").trim();
  const md = new Markdown(body, 0, 0, getMarkdownTheme());
  const container = new Text(header, 0, 0);
  return {
    render: (width: number) => [
      ...container.render(width),
      ...md.render(width),
    ],
    invalidate: () => {
      container.invalidate();
      md.invalidate();
    },
  };
}

interface SubagentExtensionOptions {
  readonly getResultDisplay?: () => DetailDisplay;
}

export default function (
  pi: ExtensionAPI,
  options: SubagentExtensionOptions = {},
) {
  const getResultDisplay =
    options.getResultDisplay ??
    (() => loadSetupConfig().ui.subagentResultDisplay);
  let runtime: SubagentRuntime | undefined;
  let managerPromise: Promise<SubagentManagerShape> | undefined;
  let restoredIdCounters: SubagentIdCounters = {
    modelCounter: 0,
    btwCounter: 0,
  };
  let sessionContext: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubStatus: (() => void) | undefined;
  /**
   * Settled subagents are an unread notice: the user's next explicit request
   * acknowledges everything that had already finished.
   */
  let settledAcknowledgedAt = 0;
  const stripState = new BelowEditorStripState();
  const statusWriter = createStatusWriter("subagents");
  const widgetKey = "subagent-navigation";
  let navigationManager: SubagentManagerShape | undefined;
  let unregisterWebCapability: (() => void) | undefined;
  let widgetVisible = false;
  let widgetEntryKey: string | undefined;
  let requestWidgetRender: (() => void) | undefined;
  let navigationLayerRegistered = false;
  let dashboardOpen = false;
  const dispatchResults = createSubagentResultDispatcher(
    pi,
    projectSubagentOutput,
    () => sessionContext?.getContextUsage(),
  );
  const resultDelivery = createSubagentResultDelivery<SubagentSnapshot>({
    isIdle: () => sessionContext?.isIdle() === true,
    // Every unconsumed fire-and-forget result must reach the parent. The
    // delivery coordinator batches results that settled while it was busy.
    deliver: dispatchResults,
  });
  pi.on("agent_settled", () => resultDelivery.parentSettled());
  const registerStableToolFamily = () =>
    patchOwnedTools(pi, "subagents", {
      enable: OPENPI_TOOL_SURFACE.subagents.entry,
    });

  const getRuntime = () =>
    (runtime ??= createSubagentRuntime({
      initialModelCounter: restoredIdCounters.modelCounter,
      initialBtwCounter: restoredIdCounters.btwCounter,
    }));

  const persistId = (id: string) =>
    pi.appendEntry(SUBAGENT_ID_WATERMARK_ENTRY_TYPE, subagentIdWatermark(id));

  /** Resolve the manager service once per runtime and wire the extension hooks. */
  const getManager = () => {
    const scope = sessionContext?.sessionManager;
    managerPromise ??= getRuntime()
      .runPromise(SubagentManager)
      .then((manager) => {
        navigationManager = manager;
        unregisterWebCapability?.();
        unregisterWebCapability =
          scope && sessionContext?.sessionManager === scope
            ? registerWebCapability(scope, {
                kind: "subagents",
                snapshot: () => projectSubagentCapability(manager.view.list()),
                subscribe: (listener) => manager.view.subscribe(listener),
              })
            : undefined;
        manager.view.setOnSettled(onSettled);
        unsubStatus?.();
        unsubStatus = manager.view.subscribe(() => updateStatus(manager));
        updateStatus(manager);
        return manager;
      });
    return managerPromise;
  };

  const stripEntry = () =>
    navigationManager
      ? selectSubagentStripEntry(
          navigationManager.view.list(),
          settledAcknowledgedAt,
        )
      : undefined;

  const updateSubagentWidget = () => {
    const ctx = sessionContext;
    if (!ctx || ctx.mode !== "tui") return;
    const entry = stripEntry();
    const visible = Boolean(entry);
    const entryKey = subagentStripEntryKey(entry);
    if (visible === widgetVisible) {
      if (visible && entryKey !== widgetEntryKey) {
        widgetEntryKey = entryKey;
        requestWidgetRender?.();
      }
      return;
    }
    if (!visible) {
      stripState.focused = false;
      widgetEntryKey = undefined;
      requestWidgetRender = undefined;
      ctx.ui.setWidget(widgetKey, undefined);
      widgetVisible = false;
      return;
    }
    ctx.ui.setWidget(
      widgetKey,
      (tui, theme) => {
        requestWidgetRender = () => tui.requestRender();
        return new SubagentStripWidget(tui, theme, stripState, stripEntry);
      },
      { placement: "belowEditor" },
    );
    widgetVisible = true;
    widgetEntryKey = entryKey;
  };

  const updateStatus = (manager: SubagentManagerShape) => {
    if (!ui) return;
    const counts = unreadActivityCounts(
      manager.view.list(),
      settledAcknowledgedAt,
    );
    // In the TUI the below-editor strip already reports the same activity and
    // carries the manage affordance, so a footer status line would repeat it.
    const tui = sessionContext?.mode === "tui";
    statusWriter.write(
      ui,
      !tui && hasActivity(counts)
        ? formatActivityStatus(ui.theme, "subagents", counts)
        : undefined,
    );
    updateSubagentWidget();
  };

  const openDashboard = async (ctx: ExtensionContext, initialId?: string) => {
    if (dashboardOpen || ctx.mode !== "tui") return;
    dashboardOpen = true;
    stripState.focused = false;
    let manager: SubagentManagerShape | undefined;
    try {
      manager = await getManager();
      if (manager.view.size() === 0) return;
      await openSubagentPicker(ctx, manager.view, initialId);
      settledAcknowledgedAt = Date.now();
    } finally {
      dashboardOpen = false;
      if (manager) updateStatus(manager);
    }
  };

  const installSubagentNavigation = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    registerEditorLayer(pi, ctx, {
      id: "subagents",
      order: 100,
      wrap: (base, tui, _theme, keybindings) =>
        new BelowEditorNavigationEditor(
          base,
          keybindings,
          stripState,
          () => Boolean(stripEntry()),
          () => {
            const entry = stripEntry();
            if (entry) void openDashboard(ctx, entry.snapshot.id);
          },
          () => {
            requestWidgetRender?.();
            tui.requestRender();
          },
        ),
    });
    navigationLayerRegistered = true;
  };

  const deliverBtwResult = (snap: SubagentSnapshot) => {
    // appendEntry is a synchronous SessionManager operation and emits an
    // entry_appended event, so it is safe while the parent is streaming and
    // never enters the model's context or follow-up queue.
    pi.appendEntry<BtwResultData>("btw-result", {
      id: snap.id,
      title: snap.title,
      status: snap.status,
      errorText: snap.errorText,
      prompt: snap.prompt,
      answer: truncatedOutput(snap),
      sessionFilePath: snap.meta.sessionFilePath,
    });
    ui?.notify(
      snap.status === "error"
        ? `by the way “${snap.title}” failed — reopen it with /subagents`
        : `by the way “${snap.title}” answered — reopen it with /subagents`,
      snap.status === "error" ? "error" : "info",
    );
  };

  const onSettled = (snap: SubagentSnapshot, consumed: boolean) => {
    // A shutdown can settle children while disposing their scopes. Never
    // append into a session whose extension runtime is already closing.
    if (!sessionContext) return;
    if (snap.origin === "btw") {
      deliverBtwResult({ ...snap, meta: { ...snap.meta } });
      return;
    }
    // Mark the finish in the transcript. The result itself reaches the model
    // separately; this line is for the reader watching the run.
    pi.appendEntry<SubagentFinishedData>("subagent-finished", {
      id: snap.id,
      title: snap.title,
      status: snap.status,
      elapsed: formatElapsed(snap),
    });
    if (consumed) {
      resultDelivery.consume([snap.id]);
      return;
    }
    // Keep the result retractable while the parent is working. A later
    // subagent_wait can consume it before agent_settled flushes follow-ups.
    // Defer a copy: the live snapshot keeps mutating if the subagent is
    // restarted before the deferred result flushes.
    // The delivery coordinator closes both sides of the wake-up race: it
    // flushes now if the parent is already idle, otherwise the parent's next
    // agent_settled edge rechecks this same pending Map.
    resultDelivery.defer({ ...snap, meta: { ...snap.meta } });
  };

  pi.on("session_start", (_event, ctx) => {
    restoredIdCounters = restoreSubagentIdCounters(
      ctx.sessionManager.getBranch(),
    );
    refreshAgentTypes(ctx.cwd, ctx.isProjectTrusted());
    registerStableToolFamily();
    sessionContext = ctx;
    settledAcknowledgedAt = 0;
    if (ctx.hasUI) ui = ctx.ui;
    installSubagentNavigation(ctx);
    updateSubagentWidget();
    // A malformed agent type is silently missing from the roster otherwise, so
    // report it once. Never fatal: the rest still loaded. Non-UI modes receive
    // stderr rather than a model-context message.
    const notice = formatAgentTypeDiagnostics(agentTypeDiagnostics);
    if (notice && ctx.hasUI) ctx.ui.notify(notice, "warning");
    else if (notice) process.stderr.write(`${notice}\n`);
  });

  // A new explicit request starts a fresh unread window: previously finished
  // subagents stop being reported, running ones keep reporting.
  pi.on("input", (event) => {
    if (event.source === "extension") return;
    settledAcknowledgedAt = Date.now();
    managerPromise?.then(updateStatus).catch(() => undefined);
  });

  pi.on("session_shutdown", async () => {
    if (navigationLayerRegistered) {
      removeEditorLayer(pi, "subagents");
      navigationLayerRegistered = false;
    }
    resultDelivery.clear();
    unsubStatus?.();
    unsubStatus = undefined;
    unregisterWebCapability?.();
    unregisterWebCapability = undefined;
    try {
      ui?.setStatus("subagents", undefined);
      sessionContext?.ui.setWidget(widgetKey, undefined);
    } catch {
      // UI may already be disposed.
    }
    statusWriter.reset();
    sessionContext = undefined;
    ui = undefined;
    navigationManager = undefined;
    widgetVisible = false;
    widgetEntryKey = undefined;
    requestWidgetRender = undefined;
    stripState.focused = false;
    dashboardOpen = false;
    const closing = runtime;
    runtime = undefined;
    managerPromise = undefined;
    // Disposing the runtime runs the manager finalizer, which tears down all
    // subagent scopes (and, later, their real child processes).
    await closing?.dispose();
  });

  // --- Agent types ---------------------------------------------------------

  /**
   * Register a safe initial roster before Pi gives us a session context. It
   * includes only built-ins and global types; session_start immediately
   * refreshes it with ctx.cwd and ctx.isProjectTrusted(), including temporary
   * trust decisions and cross-cwd session replacements.
   */
  let { agentTypes, diagnostics: agentTypeDiagnostics } = loadAgentTypes({
    agentDir: getAgentDir(),
    cwd: process.cwd(),
    projectTrusted: false,
  });
  let agentTypeList = [...agentTypes.values()];
  /**
   * Disambiguates worktree directory/branch names. The subagent id is only
   * assigned inside the manager, after the worktree already has to exist, and
   * two children with the same title would otherwise collide on the branch.
   */
  let worktreeCounter = 0;

  /**
   * Mirror of the session's `/plan` stance, published by plan-mode. Kept here
   * rather than queried because spawning must not depend on that extension
   * being loaded: absent it, this stays false and behaviour is unchanged.
   */
  let planning = false;
  pi.events.on(PLAN_MODE_CHANNEL, (state: unknown) => {
    planning =
      typeof state === "object" &&
      state !== null &&
      (state as PlanModeState).planning === true;
  });
  /**
   * Session trust is not just persisted trust: Pi may grant it for this
   * session only. Re-registering refreshes both the agent_type enum and its
   * model-facing roster before the parent can call subagent_spawn.
   */
  const refreshAgentTypes = (cwd: string, projectTrusted: boolean) => {
    const loaded = loadAgentTypes({
      agentDir: getAgentDir(),
      cwd,
      projectTrusted,
    });
    agentTypes = loaded.agentTypes;
    agentTypeDiagnostics = loaded.diagnostics;
    agentTypeList = [...agentTypes.values()];
    const surface = createSubagentSpawnToolSurface(agentTypeList);
    subagentSpawnTool.description = surface.description;
    subagentSpawnTool.parameters = surface.parameters;
    registerSubagentSpawnTool();
  };

  // --- Tools -------------------------------------------------------------

  const initialSpawnSurface = createSubagentSpawnToolSurface(agentTypeList);

  const subagentSpawnTool = defineTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    ...initialSpawnSurface,
    promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // Only one backend exists; harness is optional and defaults to it.
      const harness = params.harness ?? BACKEND_NAMES[0];

      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }

      // The enum always includes built-in roles and any loaded overrides.
      const requestedType = (params as { agent_type?: string }).agent_type;
      const agentType = requestedType
        ? agentTypes.get(requestedType)
        : undefined;

      const title = normalizeSubagentTitle(params.name);
      const declaredChildTools = effectiveChildToolAllowlist(agentType?.tools);

      // A worktree creation mutates git metadata, so reject before attempting
      // it. Plan-mode children are investigation-only and never need one.
      if (planning && params.isolation === "worktree") {
        throw new Error(
          'Plan mode is active: isolation: "worktree" creates a checkout and is unavailable while planning. Omit isolation and use an explorer, reviewer, advisor, or no incompatible agent type for read-only investigation.',
        );
      }
      if (
        planning &&
        agentType &&
        !planModeAllowsDeclaredTools(declaredChildTools)
      ) {
        throw new Error(
          `Plan mode is active: agent type "${agentType.name}" would be narrowed to capabilities that contradict its unchanged prompt. Use explorer, reviewer, advisor, or omit agent_type for read-only investigation.`,
        );
      }

      /**
       * Isolation is requested, not best-effort: a caller asks for a worktree
       * precisely because a shared checkout would let this child collide with
       * its siblings, so quietly falling back to `cwd` would deliver the
       * hazard they were avoiding. Fail loudly with git's own reason instead.
       */
      let worktree: Worktree | undefined;
      if (params.isolation === "worktree") {
        const created = await createWorktree({
          cwd,
          label: title,
          id: String(++worktreeCounter),
        });
        if (!created.ok) {
          throw new Error(
            `isolation: "worktree" requested but could not be created (${created.reason}). Omit isolation to run in ${cwd}.`,
          );
        }
        worktree = created.worktree;
      }
      const childCwd = worktree?.path ?? cwd;

      /**
       * Trust follows the directory the worktree was branched from, not the
       * worktree path. It is the same project at the same commit, so a live
       * "trusted" decision that was never persisted must not be downgraded
       * just because the checkout moved into `.git/`.
       */
      const projectTrusted = resolveStandaloneChildProjectTrust({
        parentCwd: ctx.cwd,
        childCwd: cwd,
        parentTrusted: ctx.isProjectTrusted(),
      });

      // Planning narrows the child to investigation tools. This is what makes
      // delegation safe during `/plan`: the allowlist is enforced by the
      // harness, so the child has no write/edit/bash to call, where a
      // tool_call handler in this session could never have reached it.
      const requestedChildTools = planning
        ? planModeChildTools(declaredChildTools)
        : declaredChildTools;
      const childTools = effectiveChildToolAllowlist(requestedChildTools);
      // Read at spawn time so `/openpi-setup` changes affect the next child
      // without reloading this extension. Undefined preserves parent-model
      // inheritance in the backend.
      const model = selectSubagentModel(
        params.model,
        agentType,
        roleModelForAgentType(
          agentType,
          loadSetupConfig().subagents.roleModels,
        ),
      );

      const manager = await getManager();
      const spawn = manager.spawn(harness, {
        prompt: params.prompt,
        title,
        cwd: childCwd,
        // Explicit spawn > role file > package role assignment > parent.
        model,
        reasoningEffort: params.reasoning_effort ?? agentType?.reasoningEffort,
        ...(agentType?.body ? { appendSystemPrompt: [agentType.body] } : {}),
        ...(childTools ? { tools: childTools } : {}),
        ...(agentType ? { agentTypeName: agentType.name } : {}),
        ...(worktree ? { worktree: { ...worktree, repoCwd: cwd } } : {}),
        parent: {
          parentCwd: ctx.cwd,
          projectTrusted,
          inheritedModel: ctx.model
            ? { provider: ctx.model.provider, id: ctx.model.id }
            : undefined,
          inheritedThinkingLevel: pi.getThinkingLevel(),
          modelRegistry: ctx.modelRegistry,
        },
      });

      let snap;
      try {
        snap = await runTool(getRuntime(), spawn, {
          signal,
          interruptMessage: "Subagent spawn aborted.",
        });
      } catch (error) {
        // The session scope owns reclamation, but it never opened, so this
        // worktree would otherwise be orphaned on disk.
        if (worktree) {
          const spawnError =
            error instanceof Error ? error.message : String(error);
          let cleanupWarning: string | undefined;
          let cleanupError: unknown;
          try {
            const cleanup = await reclaimWorktree(cwd, worktree);
            cleanupWarning = formatWorktreeCleanupWarning(
              cleanup,
              worktree.path,
            );
          } catch (failure) {
            cleanupError = failure;
          }
          if (cleanupError) {
            const reason =
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError);
            throw new Error(
              `${spawnError}; worktree cleanup failed: ${reason}; checkout preserved at ${worktree.path}`,
              { cause: error },
            );
          }
          if (cleanupWarning) {
            throw new Error(
              `${spawnError}; worktree cleanup warning: ${cleanupWarning}`,
              { cause: error },
            );
          }
        }
        throw error;
      }
      persistId(snap.id);

      return {
        content: [
          {
            type: "text",
            text: buildSubagentSpawnResult({
              id: snap.id,
              title: snap.title,
              harness,
              modelLabel: snap.meta.modelLabel ?? "?",
              cwd: childCwd,
              ...(worktree ? { worktreeBranch: worktree.branch } : {}),
              ...(agentType ? { agentTypeName: agentType.name } : {}),
              ...(childTools ? { tools: childTools } : {}),
            }),
          },
        ],
        details: {
          id: snap.id,
          title: snap.title,
          cwd: childCwd,
          harness,
          model: snap.meta.modelLabel,
          ...(agentType ? { agentType: agentType.name } : {}),
        },
      };
    },
    renderCall() {
      // The result line already names the agent; a bare tool header adds nothing.
      return new Text("");
    },
    renderResult(result, _options, theme) {
      const details = result.details as SpawnResultDetails | undefined;
      if (!details?.id) {
        const first = result.content[0];
        return new Text(
          first?.type === "text" ? first.text : "(no output)",
          0,
          0,
        );
      }
      const meta = [details.harness, details.model]
        .filter(Boolean)
        .join(" \u00b7 ");
      // A spawn is an event, not a state, so it speaks in the activity rows'
      // verb language ("Wrote" / "Ran" / "Spawned") rather than a glyph; the
      // strip's spinner carries the running state from here on.
      return new Text(
        `${theme.fg("toolTitle", "Spawned")}  ${theme.bold(details.title ?? details.id)} ${theme.fg("dim", meta)}`,
        0,
        0,
      );
    },
  });

  const registerSubagentSpawnTool = () => pi.registerTool(subagentSpawnTool);
  registerSubagentSpawnTool();

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagents",
    description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        maxItems: 64,
        description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");
      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      await runTool(
        getRuntime(),
        manager.waitFor(ids, (pending) => {
          onUpdate?.({
            content: [
              { type: "text", text: `Waiting for ${pending.join(", ")}...` },
            ],
            details: { pending },
          });
        }),
        { signal, interruptMessage: "Wait aborted. Subagents keep running." },
      );

      // Settlement may have happened before this wait began. Remove any
      // deferred automatic delivery now that the tool is returning the result.
      resultDelivery.consume(ids);

      const entries: Array<
        | { readonly id: string; readonly section: string }
        | {
            readonly id: string;
            readonly snap: SubagentSnapshot;
            readonly header: string;
          }
      > = ids.map((id) => {
        const snap = manager.view.get(id);
        if (!snap) return { id, section: `## ${id}\n\n(no longer tracked)` };
        const verb = snap.status === "error" ? "failed" : "finished";
        let header = `## ${snap.id} "${snap.title}" ${verb}`;
        if (snap.errorText) header += `\nError: ${snap.errorText}`;
        return { id, snap, header };
      });
      const separatorsBytes = Math.max(0, entries.length - 1) * 7;
      const fixedBytes =
        separatorsBytes +
        entries.reduce(
          (sum, entry) =>
            sum +
            Buffer.byteLength(
              "section" in entry ? entry.section : `${entry.header}\n\n`,
              "utf8",
            ),
          0,
        );
      const resultEntries = entries.filter(
        (
          entry,
        ): entry is {
          readonly id: string;
          readonly snap: SubagentSnapshot;
          readonly header: string;
        } => "snap" in entry,
      );
      const projectionBatchBytes = Math.max(
        WAIT_MIN_RESULT_BYTES * resultEntries.length,
        WAIT_OUTPUT_MAX_BYTES - fixedBytes,
      );
      const allocation = allocateResultBudgets(
        resultEntries.map(({ snap }) =>
          Buffer.byteLength(snap.finalText || "(no output)", "utf8"),
        ),
        ctx.getContextUsage(),
        {
          maxBatchBytes: projectionBatchBytes,
          maxResultBytes: WAIT_PER_AGENT_MAX_BYTES,
          minResultBytes: WAIT_MIN_RESULT_BYTES,
          headroomShare: RESULT_HEADROOM_SHARE,
          estimatedBytesPerToken: ESTIMATED_BYTES_PER_TOKEN,
          fixedBytes,
        },
      );
      let resultIndex = 0;
      const artifactSaveFailures = new Set<string>();
      const fullResultsSaved = new Set<string>();
      const sections = entries.map((entry) => {
        if ("section" in entry) return entry.section;
        const outputBudget = allocation.budgets[resultIndex++]!;
        const projection = projectSubagentOutput(entry.snap, outputBudget);
        if (projection.artifactSaveFailed) artifactSaveFailures.add(entry.id);
        if (projection.artifactPath) fullResultsSaved.add(entry.id);
        return `${entry.header}\n\n${projection.text}`;
      });

      const combined = sections.join("\n\n---\n\n");
      const bounded = truncateHead(combined, {
        maxBytes: WAIT_OUTPUT_MAX_BYTES - 128,
        maxLines: DEFAULT_MAX_LINES,
      });
      const text = bounded.truncated
        ? `${bounded.content}\n\n[wait output truncated at the total output limit]`
        : bounded.content;
      return {
        content: [{ type: "text", text }],
        details: {
          results: ids.map((id) => {
            const snap = manager.view.get(id);
            return {
              id,
              title: snap?.title,
              status: snap?.status,
              ...(snap?.outcome ? { outcome: snap.outcome } : {}),
              ...(snap?.worktreeBranch
                ? { worktreeBranch: snap.worktreeBranch }
                : {}),
              ...(snap ? { elapsed: formatElapsed(snap) } : {}),
              ...(fullResultsSaved.has(id) ? { fullResultSaved: true } : {}),
              ...(artifactSaveFailures.has(id)
                ? { artifactSaveFailed: true }
                : {}),
            };
          }),
        },
      };
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const first = result.content[0];
      const content = first?.type === "text" ? first.text : "(no output)";
      if (isPartial) {
        const pending = (result.details as { pending?: string[] } | undefined)
          ?.pending?.length;
        return new Text(
          theme.fg(
            "warning",
            pending
              ? `\u273b Waiting for ${pending} subagent${pending === 1 ? "" : "s"} to finish`
              : content,
          ),
          0,
          0,
        );
      }
      return renderWaitResult(
        content,
        result.details as WaitResultDetails | undefined,
        expanded || getResultDisplay() === "full",
        theme,
      );
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagents",
    description: SUBAGENT_CANCEL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");

      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const report = await runTool(getRuntime(), manager.cancel(ids), {
        signal,
        interruptMessage: "Subagent cancellation aborted.",
      });

      const lines = report.map((entry) =>
        entry.cancelled
          ? `Cancelled ${entry.id} "${entry.title}".`
          : `${entry.id} "${entry.title}" was already ${entry.status}.`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            title: entry.title,
            status: entry.status,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_send",
    label: "Send to Subagent",
    description: SUBAGENT_SEND_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.id,
      }),
      text: Type.String({
        description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.text,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap || !isModelVisible(snap)) {
        const known = manager.view
          .list()
          .filter(isModelVisible)
          .map((s) => s.id);
        throw new Error(
          `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }
      const text = params.text.trim();
      if (!text) throw new Error("Provide a non-empty message.");

      // Captured before the send: a settled subagent restarts, a running one
      // is steered, and the result message must say which happened.
      const wasRunning = snap.status === "running";
      await runTool(getRuntime(), manager.send(params.id, text), {
        signal,
        interruptMessage: "Subagent send aborted.",
      });
      // A settled subagent may already have an undelivered result buffered;
      // the restart supersedes it, so drop it and let the new run deliver.
      resultDelivery.consume([params.id]);

      return {
        content: [
          {
            type: "text",
            text: buildSubagentSendResult({
              id: snap.id,
              title: snap.title,
              wasRunning,
            }),
          },
        ],
        details: {
          id: snap.id,
          title: snap.title,
          status: manager.view.get(params.id)?.status ?? snap.status,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap || !isModelVisible(snap)) {
        const known = manager.view
          .list()
          .filter(isModelVisible)
          .map((s) => s.id);
        throw new Error(
          `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }

      let text = `${describeSubagent(snap)}\nTurns: ${snap.turns}`;
      if (snap.errorText) text += `\nError: ${snap.errorText}`;

      const output = latestText(snap);
      if (output) {
        const preview = truncateHead(output, { maxBytes: 2048, maxLines: 20 });
        text += `\n\nLatest output:\n${preview.content}`;
        if (preview.truncated) text += "\n[...]";
      } else if (snap.status === "running") {
        text += "\n\n(no text output yet)";
      }

      return {
        content: [{ type: "text", text }],
        details: { id: snap.id, status: snap.status, turns: snap.turns },
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: SUBAGENT_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const manager = await getManager();
      const subs = manager.view.list().filter(isModelVisible);
      const text =
        subs.length === 0
          ? "No subagents."
          : subs.map((snap) => describeSubagent(snap)).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          subagents: subs.map((snap) => ({
            id: snap.id,
            title: snap.title,
            harness: snap.backend,
            status: snap.status,
          })),
        },
      };
    },
  });

  // --- Result message rendering ------------------------------------------

  pi.registerMessageRenderer(
    "subagent-result",
    (message, { expanded }, theme) => {
      const content =
        typeof message.content === "string" ? message.content : "";
      return renderSubagentResult(
        content,
        (message.details ?? {}) as SubagentResultDetails,
        expanded,
        getResultDisplay(),
        theme,
      );
    },
  );

  pi.registerEntryRenderer<SubagentResultEntryData>(
    "subagent-result",
    (entry, { expanded }, theme) =>
      renderSubagentResult(
        entry.data?.content ?? "",
        entry.data?.details ?? {},
        expanded,
        getResultDisplay(),
        theme,
      ),
  );

  pi.registerEntryRenderer<SubagentFinishedData>(
    "subagent-finished",
    (entry, _options, theme) => {
      const data = entry.data;
      const failed = data?.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "✓");
      return new Text(
        `${icon} ${theme.fg("accent", data?.title ?? "?")}` +
          theme.fg(
            "dim",
            ` ${failed ? "failed" : "finished"} · ${data?.elapsed ?? "?"}`,
          ),
        1,
        0,
      );
    },
  );

  pi.registerEntryRenderer<BtwResultData>(
    "btw-result",
    (entry, { expanded }, theme) => {
      const data = entry.data;
      const failed = data?.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "✓");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`by the way · ${data?.title ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${failed ? "failed" : "answered"} · ${data?.id ?? "?"}`,
        );
      const body = [
        data?.errorText ? `Error: ${data.errorText}` : "",
        data?.answer ?? "(no answer)",
      ]
        .filter(Boolean)
        .join("\n\n");

      if (expanded || getResultDisplay() === "full") {
        const md = new Markdown(body, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const lines = body.split("\n");
      let text = header;
      for (const line of lines.slice(0, 8))
        text += `\n${theme.fg("toolOutput", line)}`;
      if (lines.length > 8)
        text += `\n${theme.fg("dim", `... (${keyHint("app.tools.expand", "to expand")})`)}`;
      return new Text(text, 0, 0);
    },
  );

  // --- Commands -----------------------------------------------------------

  const runByTheWay = async (rawArgs: string, ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI)
        ctx.ui.notify("by the way is only available in the TUI", "error");
      return;
    }

    let prompt = rawArgs.trim();
    if (!prompt) {
      const input = await ctx.ui.input("by the way", "Ask a one-off question…");
      prompt = input?.trim() ?? "";
      if (!prompt) return;
    }

    const manager = await getManager();
    let snap: SubagentSnapshot;
    try {
      snap = await runTool(
        getRuntime(),
        manager.spawn("pi", {
          origin: "btw",
          prompt,
          title: normalizeSubagentTitle(deriveBtwTitle(prompt), "by the way"),
          cwd: ctx.cwd,
          parent: {
            parentCwd: ctx.cwd,
            projectTrusted: ctx.isProjectTrusted(),
            inheritedModel: ctx.model
              ? { provider: ctx.model.provider, id: ctx.model.id }
              : undefined,
            inheritedThinkingLevel: pi.getThinkingLevel(),
            modelRegistry: ctx.modelRegistry,
          },
        }),
      );
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
      return;
    }
    persistId(snap.id);

    await openSubagentTakeover(ctx, manager.view, snap.id, {
      badge: "by the way",
    });
  };

  pi.registerCommand("btw", {
    description:
      "Ask a one-off side question while the main agent keeps working",
    handler: runByTheWay,
  });

  pi.registerCommand("subagents", {
    description: "List, inspect, and take over subagents",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Subagent takeover is only available in the TUI",
            "error",
          );
        return;
      }
      const manager = await getManager();
      if (manager.view.size() === 0) {
        ctx.ui.notify(
          "No subagents yet. The agent spawns them with subagent_spawn.",
          "info",
        );
        return;
      }
      await openDashboard(ctx);
    },
  });
}
