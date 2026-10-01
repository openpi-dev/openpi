import { existsSync } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createTurnChangeRecorder } from "./turn-changes.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { controlPlan, projectPlanControl, type PlanControlRequest } from "../../extensions/plan-mode/control.ts";
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type PromptOptions,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  hasTrustRequiringProjectResources,
} from "@earendil-works/pi-coding-agent";
import {
  type WebActiveTurn,
  type WebModelSelectionOptions,
  type WebModelConfiguration,
  type WebPromptOptions,
  type WebPromptAdmissionReceipt,
  type WebProviderAuthProjection,
  type WebProviderAuthSource,
  type WebProviderConfigurationChange,
  type WebRuntimeController,
  type WebRuntimeEvent,
  type WebSessionCreationOptions,
  type WebSessionCreationResult,
  type WebSessionForkRequest,
  type WebSessionForkResult,
  type WebSessionExecution,
  type WebThinkingProjection,
  type WebThinkingSelectionOptions,
  type WebTurnCancellationOptions,
  type WebTurnCancellationResult,
  WebRuntimeRequestError,
} from "./types.ts";
import { projectMessage, projectAssistantError, jsonByteLength, boundedText, WEB_MAX_TEXT } from "../protocol/types.ts";
import { LIVE_TOOL_LIMIT, type LiveToolEvidence } from "../protocol/evidence.ts";
import { elapsed, traceWeb } from "../trace.ts";
import { WEB_TURN_TIMING_ENTRY, readTurnTiming, type WebTurnTiming } from "../protocol/turn-timing.ts";
import {
  applyHttpProxySettings,
  configureHttpDispatcher,
  type HttpDispatcherLease,
} from "../http-dispatcher.ts";
import {
  acquireWebHostLease,
  type WebHostLease,
} from "./web-host-lease.ts";
import {
  assertWebCommandSupported,
  commandsForServices,
  createCommandDiscoveryBridge,
  registerCommandDiscoveryBridge,
  submittedExtensionCommand,
} from "./command-discovery.ts";
import { WEB_COMMAND_INPUT, WEB_COMMAND_HANDLED, publishWebCommandFeedback } from "../../extensions/shared/web-command-feedback.ts";
import {
  projectWebTrustStatus,
} from "./trust-status.ts";
import { projectWebModelSearch } from "./model-discovery.ts";
import { changeProviderConfiguration, readModelConfigurations, saveModelConfigurations } from "./model-configuration.ts";
import { discoverProviderModels, type ProviderModelDiscovery } from "./provider-model-discovery.ts";
import { matchesSessionIdentity } from "./session-identity.ts";
import {
  projectWebSettingsResources,
} from "./settings-catalog.ts";

const STARTUP_TIMEOUT_MS = 15_000;
const TURN_CANCELLATION_SETTLEMENT_TIMEOUT_MS = 10_000;
const BOOTSTRAP_WORKSPACE_DIRECTORY = ".bootstrap-workspace";
const WEB_MAX_PROVIDER_AUTH_ITEMS = 250;
const WEB_MAX_PROVIDER_AUTH_SCANNED = 1_024;
const WEB_MAX_PROVIDER_ID_LENGTH = 160;
const WEB_MAX_PROVIDER_NAME_LENGTH = 160;
const WEB_MAX_QUEUED_MESSAGES = 20;
const WEB_PROVIDER_AUTH_SOURCES = new Set<WebProviderAuthSource>([
  "stored",
  "runtime",
  "environment",
  "fallback",
  "models_json_key",
  "models_json_command",
]);

type PromptDisposition = Parameters<NonNullable<PromptOptions["preflightResult"]>>[0];

type PromptTrace = {
  commandId: string;
  sessionId: string;
  startedAt: number;
  executionStartedAt?: number;
  executionClock?: number;
  sessionPath?: string;
  started: boolean;
  queued: boolean;
  userMessageObserved: boolean;
  epoch?: number;
  outcome?: "completed" | "cancelled" | "failed" | "uncertain";
  resultMessage?: Extract<AgentSessionEvent, { type: "message_end" }>["message"];
};

type TurnSettlement = WebActiveTurn & {
  outcome: "completed" | "cancelled" | "failed" | "uncertain";
};

function observePromptOutcome(trace: PromptTrace, event: AgentSessionEvent) {
  // Cancelling Pi's retry backoff emits no aborted assistant message. This
  // native terminal event is the cancellation evidence retained at settlement.
  if (event.type === "auto_retry_end" && !event.success && event.finalError === "Retry cancelled") {
    trace.outcome = "cancelled";
    trace.resultMessage = undefined;
    return;
  }
  if (event.type !== "message_end" || event.message.role !== "assistant") return;
  const outcome = event.message.stopReason === "aborted" ? "cancelled"
    : event.message.stopReason === "error" ? "failed"
      : event.message.stopReason === "stop" || event.message.stopReason === "length" ? "completed" : undefined;
  // A later continuation cannot erase native cancellation evidence. Only
  // agent_settled publishes a terminal outcome for the whole Pi run.
  if (outcome && trace.outcome !== "cancelled") trace.outcome = outcome;
  trace.resultMessage = outcome === "completed" && trace.outcome !== "cancelled" ? event.message : undefined;
}

function executingTools(session: AgentSession) {
  const pending = session.state.pendingToolCalls;
  if (!pending.size) return { liveTools: [], liveToolsOmitted: 0 };
  const messages = session.messages;
  const liveTools: LiveToolEvidence[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  outer: for (let index = messages.length - 1; index >= Math.max(0, messages.length - 128); index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    for (let partIndex = message.content.length - 1; partIndex >= Math.max(0, message.content.length - 64); partIndex--) {
      const part = message.content[partIndex];
      if (part?.type !== "toolCall" || !pending.has(part.id) || seen.has(part.id)) continue;
      const call = projectMessage({ role: "assistant", content: [part] }, path => resolve(session.sessionManager.getCwd(), path)).parts?.[0];
      if (call?.type !== "toolCall") continue;
      const item: LiveToolEvidence = { call, state: "running" };
      bytes += jsonByteLength(item);
      if (bytes > 512 * 1024) break outer;
      liveTools.push(item);
      seen.add(part.id);
      if (liveTools.length >= LIVE_TOOL_LIMIT) break outer;
    }
    if (seen.size === pending.size) break;
  }
  return { liveTools, liveToolsOmitted: Math.max(0, pending.size - liveTools.length) };
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function safeProviderId(value: string) {
  return value.length > 0 &&
    value.length <= WEB_MAX_PROVIDER_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function boundedProviderName(value: string) {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/gu, " ");
  return sanitized.length <= WEB_MAX_PROVIDER_NAME_LENGTH
    ? { value: sanitized, truncated: false }
    : {
        value: `${sanitized.slice(0, WEB_MAX_PROVIDER_NAME_LENGTH - 1)}…`,
        truncated: true,
      };
}

async function canonicalDirectory(path: string) {
  const canonical = await realpath(resolve(path));
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error("Workspace path is not a directory");
  }
  return canonical;
}

export class PiWebRuntime implements WebRuntimeController {
  private runtime: AgentSessionRuntime;
  private unsubscribeSession?: () => void;
  private readonly listeners = new Set<(event: WebRuntimeEvent) => void>();
  private readonly retainedRuntimes = new Set<AgentSessionRuntime>();
  private readonly retainedSubscriptions = new Map<AgentSessionRuntime, () => void>();
  private readonly inFlightRuntimes = new Map<AgentSessionRuntime, number>();
  private readonly promptOperations = new Set<Promise<void>>();
  private readonly runtimeOperations = new Set<Promise<void>>();
  private readonly candidateRuntimes = new Set<AgentSessionRuntime>();
  private readonly runtimeDisposals = new Set<Promise<void>>();
  private runtimeDisposalFailure?: unknown;
  private readonly runtimeDisposalPromises = new WeakMap<
    AgentSessionRuntime,
    Promise<void>
  >();
  private controllerMutation: Promise<void> = Promise.resolve();
  private promptAdmission: Promise<void> = Promise.resolve();
  private thinkingMutationInFlight = false;
  private thinkingMutationPending?: {
    waiters: Array<{
      level: string;
      resolve: (projection: WebThinkingProjection) => void;
      reject: (error: unknown) => void;
      expectedSessionId?: string;
      expectedSessionPath?: string;
    }>;
  };
  private activePromptTrace?: PromptTrace;
  private promptOrigins?: AsyncLocalStorage<PromptTrace | undefined>;
  private endingSessions?: WeakSet<AgentSession>;
  private readonly pendingPromptTraces: PromptTrace[] = [];
  private suspendedPromptTraces?: WeakMap<AgentSession, { active?: PromptTrace; pending: PromptTrace[] }>;
  private compactionObservations?: WeakMap<AgentSession, {
    sessionId: string;
    sessionPath: string;
    state: NonNullable<WebSessionExecution["compaction"]>["state"];
    startedAt?: number;
    clock?: number;
  }>;
  private compactionQueues?: Map<AgentSessionRuntime, {
    items: Array<{ content: string; options: WebPromptOptions }>;
    draining: boolean;
    blocked: boolean;
  }>;
  private manualCompactionOwner?: AgentSessionRuntime;
  private nextTurnEpoch = 0;
  private readonly terminalTurnKeys = new Set<string>();
  // Presentation receipts outlive released native Sessions; they never imply idle.
  private completedSessionTurns?: Map<string, NonNullable<WebSessionExecution["lastTurn"]>>;
  private readonly turnSettlementWaiters = new Map<
    string,
    Set<(settlement: TurnSettlement) => void>
  >();
  /** Native aborts remain owned by Pi until its agent_settled event arrives. */
  private readonly turnAbortOperations = new Map<string, Promise<unknown>>();
  private liveMessageKey?: string;
  private liveMessageSequence = 0;
  private readonly webSessionDirectory: string;
  private readonly dispatcherLease: HttpDispatcherLease;
  private readonly webHostLease: WebHostLease;
  private disposed = false;
  private disposePromise?: Promise<void>;
  private hasSelectedWorkspace: boolean;
  private historyForkPending = false;
  private readonly historyForkReceipts = new Map<string, {
    request: WebSessionForkRequest;
    result: Promise<WebSessionForkResult>;
  }>();

  private constructor(
    runtime: AgentSessionRuntime,
    webSessionDirectory: string,
    dispatcherLease: HttpDispatcherLease,
    webHostLease: WebHostLease,
    workspaceSelected: boolean,
  ) {
    this.runtime = runtime;
    this.webSessionDirectory = webSessionDirectory;
    this.dispatcherLease = dispatcherLease;
    this.webHostLease = webHostLease;
    this.hasSelectedWorkspace = workspaceSelected;
  }

  static async create(cwd: string) {
    const canonicalCwd = await canonicalDirectory(cwd);
    return PiWebRuntime.createForWorkspace(canonicalCwd, true);
  }

  static async createWithoutWorkspace() {
    const webSessionDirectory = join(getAgentDir(), "web-sessions");
    await mkdir(webSessionDirectory, { recursive: true, mode: 0o700 });
    const bootstrapDirectory = join(
      webSessionDirectory,
      BOOTSTRAP_WORKSPACE_DIRECTORY,
    );
    await mkdir(bootstrapDirectory, { recursive: true, mode: 0o700 });
    const canonicalCwd = await canonicalDirectory(bootstrapDirectory);
    return PiWebRuntime.createForWorkspace(canonicalCwd, false);
  }

  private static async createForWorkspace(
    canonicalCwd: string,
    workspaceSelected: boolean,
  ) {
    const webSessionDirectory = join(getAgentDir(), "web-sessions");
    const webHostLease = await acquireWebHostLease(webSessionDirectory);
    let runtime: PiWebRuntime | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const created = await PiWebRuntime.createRuntime(
        canonicalCwd,
        workspaceSelected
          ? SessionManager.create(canonicalCwd, webSessionDirectory)
          : SessionManager.inMemory(canonicalCwd),
      );
      runtime = new PiWebRuntime(
        created.runtime,
        webSessionDirectory,
        created.dispatcherLease,
        webHostLease,
        workspaceSelected,
      );
      if (workspaceSelected) await runtime.startRuntimeSession();
      return runtime;
    } catch (error) {
      try {
        if (runtime) await runtime.dispose();
        else await webHostLease.release();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Failed to start and clean up the Web runtime",
        );
      }
      throw error;
    }
  }

  get cwd() {
    return this.runtime.cwd;
  }

  get workspaceSelected() {
    return this.hasSelectedWorkspace;
  }

  get sessionDirectory() {
    return this.webSessionDirectory;
  }

  get sessionManager() {
    return this.runtime.session.sessionManager;
  }

  getProjectTrustStatus() {
    if (!this.hasSelectedWorkspace) return projectWebTrustStatus({});
    const workspace = this.cwd;
    try {
      const storedDecision = new ProjectTrustStore(getAgentDir()).get(workspace);
      return projectWebTrustStatus({
        workspace,
        storedDecision,
        projectResources: hasTrustRequiringProjectResources(workspace),
        sessionTrusted:
          this.runtime.session.settingsManager.isProjectTrusted(),
      });
    } catch {
      return projectWebTrustStatus({ workspace });
    }
  }

  isIdle() {
    return !this.runtime.session.isStreaming && !this.runtime.session.isCompacting;
  }

  getActiveTurn() {
    return this.activeTurnFromTrace(this.activePromptTrace);
  }

  getSessionExecution(sessionId: string, sessionPath: string): WebSessionExecution {
    const unknown: WebSessionExecution = { sessionId, sessionPath, status: "unknown", liveTools: [], liveToolsOmitted: 0 };
    const owner = this.sessionRuntimeForRead(sessionId, sessionPath);
    if (!owner) {
      const lastTurn = this.completedSessionTurns?.get(JSON.stringify([sessionPath, sessionId]));
      return lastTurn ? { ...unknown, lastTurn } : unknown;
    }
    const session = owner.session;
    const followUps = session.getFollowUpMessages();
    const steering = session.getSteeringMessages?.();
    const held = this.compactionQueues?.get(owner);
    const queued = [...followUps, ...(held?.items.map((item) => item.content) ?? [])];
    const trace = owner === this.runtime ? this.activePromptTrace : this.suspendedPromptTraces?.get(session)?.active;
    const activeTurn = this.activeTurnFromTrace(trace);
    const compaction = this.getCompaction(session);
    const branch = session.sessionManager.getBranch();
    const terminalEntry = branch.slice().reverse().find((entry) => entry.type === "custom" && entry.customType === WEB_TURN_TIMING_ENTRY);
    const timing = terminalEntry?.type === "custom" ? readTurnTiming(terminalEntry.data) : undefined;
    // Legacy timing has no result id. Its nearest preceding native message is
    // proof only when it is a terminal assistant on this exact current branch.
    const preceding = terminalEntry ? branch.slice(0, branch.indexOf(terminalEntry)).reverse().find((entry) => entry.type === "message" || entry.type === "custom" && entry.customType === WEB_TURN_TIMING_ENTRY) : undefined;
    const resultEntryId = timing?.outcome === "completed" && preceding?.type === "message" && preceding.message.role === "assistant" && ["stop", "length"].includes(preceding.message.stopReason) && (!timing.resultEntryId || timing.resultEntryId === preceding.id) ? preceding.id : undefined;
    return {
      sessionId, sessionPath,
      ...(timing?.sessionId === sessionId ? { lastTurn: { commandId: timing.commandId, finishedAt: timing.finishedAt, outcome: timing.outcome, ...(resultEntryId ? { resultEntryId } : {}) } } : {}),
      status: session.isIdle ? "idle" : "running",
      pendingFollowUps: queued.length,
      queuedMessages: queued.slice(0, WEB_MAX_QUEUED_MESSAGES).map((message) => boundedText(message, WEB_MAX_TEXT)),
      ...(steering ? {
        pendingSteering: steering.length,
        steeringMessages: steering.slice(0, WEB_MAX_QUEUED_MESSAGES).map((message) => boundedText(message, WEB_MAX_TEXT)),
      } : {}),
      ...(held?.blocked ? { promptQueueBlocked: true } : {}),
      ...executingTools(session),
      ...(activeTurn ? { activeTurn } : {}),
      ...(compaction ? { compaction } : {}),
    };
  }

  private getCompaction(session: AgentSession) {
    const observed = this.compactionObservations?.get(session);
    if (observed && matchesSessionIdentity(session.sessionManager, {
      expectedSessionId: observed.sessionId, expectedSessionPath: observed.sessionPath,
    })) {
      return {
        state: observed.state,
        ...(observed.startedAt === undefined ? {} : { startedAt: observed.startedAt }),
        ...(observed.clock === undefined ? {} : {
          elapsedMs: elapsed(observed.clock),
        }),
      };
    }
    // An already-running native compaction may predate the Web subscription.
    // Its start time is unknown; do not start a fresh timer on reconnect.
    return session.isCompacting ? { state: "running" as const } : undefined;
  }

  private observeCompaction(session: AgentSession, event: AgentSessionEvent) {
    if (event.type !== "compaction_start" && event.type !== "compaction_end") return;
    this.compactionObservations ??= new WeakMap();
    const identity = {
      sessionId: session.sessionManager.getSessionId(),
      sessionPath: session.sessionManager.getSessionFile() ?? `current:${session.sessionManager.getSessionId()}`,
    };
    if (event.type === "compaction_start") {
      this.compactionObservations.set(session, { ...identity, state: "running", startedAt: Date.now(), clock: performance.now() });
    } else {
      this.compactionObservations.set(session, {
        ...identity,
        state: event.aborted ? "cancelled" : event.errorMessage ? "failed" : event.result ? "completed" : "unchanged",
      });
    }
    if (event.type === "compaction_end") {
      for (const [owner, queue] of this.compactionQueues ?? []) {
        if (owner.session !== session) continue;
        if (event.aborted || event.errorMessage) queue.blocked = true;
        else queueMicrotask(() => void this.drainCompactionQueue(owner));
      }
    }
    this.emit("session_progress", identity);
  }

  private holdCompactionPrompt(owner: AgentSessionRuntime, content: string, options?: WebPromptOptions) {
    assertWebCommandSupported(owner.services, content);
    const queues = this.compactionQueues ??= new Map();
    const queue = queues.get(owner) ?? { items: [], draining: false, blocked: false };
    // Bound retained text and image payloads as well as message count.
    const item = { content, options: { ...options } };
    if (queue.items.length >= 16 || Buffer.byteLength(JSON.stringify([...queue.items, item])) > 16 * 1024 * 1024)
      throw new WebRuntimeRequestError("The pending-message queue is full. Keep your draft and retry after it drains.", "PROMPT_REJECTED", 422);
    if (!queues.has(owner)) {
      queues.set(owner, queue);
      this.retainRuntimeReference(owner);
    }
    queue.items.push(item);
    this.emit("session_progress", { sessionId: owner.session.sessionManager.getSessionId() });
    if (!owner.session.isCompacting) queueMicrotask(() => void this.drainCompactionQueue(owner));
    return { pendingFollowUps: owner.session.getFollowUpMessages().length + queue.items.length };
  }

  private async drainCompactionQueue(owner: AgentSessionRuntime) {
    const queue = this.compactionQueues?.get(owner);
    if (!queue || queue.draining || queue.blocked || this.disposed || owner.session.isCompacting || this.manualCompactionOwner === owner) return;
    queue.draining = true;
    try {
      while (queue.items.length && !this.disposed && !queue.blocked && !owner.session.isCompacting) {
        const item = queue.items[0]!;
        try {
          await this.dispatchPrompt(owner, item.content, item.options, true);
        } catch {
          // Acceptance into this queue is not model admission. Retain the
          // original text/images for explicit retry after a delivery failure.
          queue.blocked = true;
          break;
        }
        if (queue.items[0] === item) queue.items.shift();
      }
    } finally {
      queue.draining = false;
      if (!queue.items.length) {
        this.compactionQueues?.delete(owner);
        this.releaseRuntimeReference(owner);
      }
      this.emit("session_progress", { sessionId: owner.session.sessionManager.getSessionId() });
    }
  }

  updatePromptQueue(request: { sessionId: string; sessionPath: string; action: "retry" | "clear" }) {
    this.assertActive();
    if (!matchesSessionIdentity(this.runtime.session.sessionManager, { expectedSessionId: request.sessionId, expectedSessionPath: request.sessionPath }))
      throw new WebRuntimeRequestError("Only the active Web session accepts queue changes", "SESSION_CONFLICT", 409);
    const owner = this.runtime;
    const queue = this.compactionQueues?.get(owner);
    if (queue?.draining) throw new WebRuntimeRequestError("A queued message is being admitted. Retry shortly.", "SESSION_CONFLICT", 409);
    if (request.action === "retry") {
      if (queue) queue.blocked = false;
      queueMicrotask(() => void this.drainCompactionQueue(owner));
    } else {
      for (const item of queue?.items ?? [])
        this.emit("prompt_discarded", { commandId: item.options.commandId, sessionId: request.sessionId });
      if (queue) {
        this.compactionQueues?.delete(owner);
        this.releaseRuntimeReference(owner);
      }
      owner.session.clearQueue();
      for (const trace of [this.activePromptTrace, ...this.pendingPromptTraces]) {
        if (!trace) continue;
        if (trace.queued && !trace.started) {
          this.emit("prompt_discarded", { commandId: trace.commandId, sessionId: request.sessionId });
          this.removePromptTrace(trace);
        }
      }
    }
    this.emit("session_progress", { sessionId: request.sessionId });
  }

  compactSession(request: { sessionId: string; sessionPath: string }) {
    return this.serializeControllerMutation(async () => {
      this.assertWorkspaceSelected();
      const owner = this.runtime;
      if (!matchesSessionIdentity(owner.session.sessionManager, { expectedSessionId: request.sessionId, expectedSessionPath: request.sessionPath }))
        throw new WebRuntimeRequestError("Only the active Web session can compact history", "SESSION_CONFLICT", 409);
      if (!owner.session.isIdle || this.compactionQueues?.has(owner) || this.promptOperations.size > 0)
        throw new WebRuntimeRequestError("Wait for current work and queued messages before compacting history", "SESSION_CONFLICT", 409);
      this.retainRuntimeReference(owner);
      this.manualCompactionOwner = owner;
      try {
        await owner.session.compact();
      } finally {
        this.manualCompactionOwner = undefined;
        queueMicrotask(() => void this.drainCompactionQueue(owner));
        this.releaseRuntimeReference(owner);
      }
    });
  }

  getSessionManagerForRead(sessionId: string, sessionPath: string) {
    return this.sessionRuntimeForRead(sessionId, sessionPath)?.session.sessionManager;
  }

  private sessionRuntimeForRead(sessionId: string, sessionPath: string) {
    if (this.disposed || !this.hasSelectedWorkspace) return undefined;
    const expected = { expectedSessionId: sessionId, expectedSessionPath: sessionPath };
    if (matchesSessionIdentity(this.runtime.session.sessionManager, expected)) return this.runtime;
    for (const retained of this.retainedRuntimes) {
      if (matchesSessionIdentity(retained.session.sessionManager, expected)) return retained;
    }
    return undefined;
  }

  cancelTurn(options: WebTurnCancellationOptions) {
    return this.serializeControllerMutation(() =>
      this.cancelActiveTurn(options),
    );
  }

  private async cancelActiveTurn(
    options: WebTurnCancellationOptions,
  ): Promise<WebTurnCancellationResult> {
    this.assertActive();
    this.assertWorkspaceSelected();
    const activeSessionId = this.runtime.session.sessionManager.getSessionId();
    if (options.sessionId !== activeSessionId) {
      return { ...options, state: "stale-session" };
    }
    const key = this.turnKey(options);
    if (this.terminalTurnKeys.has(key)) {
      return { ...options, state: "already-settled" };
    }
    const activeTurn = this.getActiveTurn();
    if (
      !activeTurn ||
      activeTurn.commandId !== options.commandId ||
      activeTurn.epoch !== options.epoch
    ) {
      return { ...options, state: "stale-turn" };
    }
    if (this.turnAbortOperations.has(key)) {
      return {
        ...options,
        state: "failed",
        error: "Cancellation is already waiting for Pi to settle this turn",
      };
    }

    let ownWaiter: ((settlement: TurnSettlement) => void) | undefined;
    const settlement = new Promise<TurnSettlement>((resolveSettlement) => {
      ownWaiter = resolveSettlement;
      const waiters = this.turnSettlementWaiters.get(key) ?? new Set();
      waiters.add(resolveSettlement);
      this.turnSettlementWaiters.set(key, waiters);
    });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const held = this.compactionQueues?.get(this.runtime);
      if (held) held.blocked = true;
      const abortOperation = this.runtime.session.abort();
      this.turnAbortOperations.set(key, abortOperation);
      void abortOperation.catch(() => {
        if (this.turnAbortOperations.get(key) === abortOperation) {
          this.turnAbortOperations.delete(key);
        }
      });
      const abortFailure = new Promise<never>((_, reject) => {
        void abortOperation.catch(reject);
      });
      const settlementTimeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () =>
            reject(
              new Error(
                "Cancellation did not settle within the bounded wait window",
              ),
            ),
          TURN_CANCELLATION_SETTLEMENT_TIMEOUT_MS,
        );
      });
      const terminal = await Promise.race([
        settlement,
        abortFailure,
        settlementTimeout,
      ]);
      return {
        ...options,
        state:
          terminal.outcome === "cancelled"
            ? "accepted"
            : terminal.outcome === "completed"
              ? "already-settled"
              : "failed",
        ...(terminal.outcome === "failed"
          ? { error: "The active turn failed while cancellation was requested" }
          : terminal.outcome === "uncertain"
            ? {
                error:
                  "Pi settled without a terminal assistant outcome for this cancellation",
              }
            : {}),
      };
    } catch (error) {
      return { ...options, state: "failed", error: errorText(error) };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const waiters = this.turnSettlementWaiters.get(key);
      if (waiters && ownWaiter) {
        waiters.delete(ownWaiter);
        if (waiters.size === 0) this.turnSettlementWaiters.delete(key);
      }
    }
  }

  listModels() {
    const nativeCurrent = this.runtime.session.model;
    // Recognize Pi Agent's unselected sentinel, not a custom model's validity.
    const current =
      nativeCurrent?.provider === "unknown" &&
      nativeCurrent.id === "unknown" &&
      nativeCurrent.name === "unknown" &&
      nativeCurrent.api === "unknown" &&
      nativeCurrent.baseUrl === "" &&
      nativeCurrent.reasoning === false &&
      nativeCurrent.input.length === 0 &&
      nativeCurrent.contextWindow === 0 &&
      nativeCurrent.maxTokens === 0 &&
      nativeCurrent.cost.input === 0 &&
      nativeCurrent.cost.output === 0 &&
      nativeCurrent.cost.cacheRead === 0 &&
      nativeCurrent.cost.cacheWrite === 0
        ? undefined
        : nativeCurrent;
    const available = [...this.runtime.services.modelRuntime.getAvailableSnapshot()];
    if (
      current &&
      !available.some(
        (model) => model.provider === current.provider && model.id === current.id,
      )
    ) {
      available.unshift(current);
    }
    return available.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      label: model.name || `${model.provider}/${model.id}`,
      current: current?.provider === model.provider && current.id === model.id,
    }));
  }

  searchModels(query: string, limit?: number) {
    return projectWebModelSearch(this.listModels(), query, limit);
  }

  listCommands() {
    this.assertActive();
    this.assertWorkspaceSelected();
    return commandsForServices(this.runtime.services);
  }

  listSettingsResources() {
    this.assertActive();
    this.assertWorkspaceSelected();
    return projectWebSettingsResources(this.runtime.services.resourceLoader);
  }

  listProviderAuth(): WebProviderAuthProjection {
    const modelRuntime = this.runtime.services.modelRuntime;
    const allProviders = modelRuntime.getProviders();
    const providers = allProviders.slice(0, WEB_MAX_PROVIDER_AUTH_SCANNED);
    const builtinProviders = new Set<string>(getBuiltinProviders());
    const projection: WebProviderAuthProjection["providers"][number][] = [];
    let omitted = Math.max(
      0,
      allProviders.length - WEB_MAX_PROVIDER_AUTH_SCANNED,
    );
    let namesTruncated = 0;
    for (const provider of providers) {
      if (projection.length >= WEB_MAX_PROVIDER_AUTH_ITEMS) {
        omitted++;
        continue;
      }
      try {
        const id = safeProviderId(provider.id);
        if (!id) {
          omitted++;
          continue;
        }
        const name = boundedProviderName(provider.name || id);
        if (name.truncated) namesTruncated++;
        const status = modelRuntime.getProviderAuthStatus(id);
        const model = modelRuntime.getModels(id)[0];
        const endpoint = model?.baseUrl ? URL.parse(model.baseUrl) : null;
        const api = model?.api === "openai-responses" ? "openai-responses" as const : model?.api === "openai-completions" ? "openai-completions" as const : model?.api === "anthropic-messages" ? "anthropic-messages" as const : undefined;
        const source =
          status.source && WEB_PROVIDER_AUTH_SOURCES.has(status.source)
            ? status.source
            : undefined;
        projection.push({
          id,
          name: name.value,
          authMethods: [
            ...(provider.auth.apiKey ? (["api_key"] as const) : []),
            ...(provider.auth.oauth ? (["oauth"] as const) : []),
          ],
          configured: status.configured,
          ...(source ? { source } : {}),
          subscription: modelRuntime.isUsingSubscription(id),
          nameTruncated: name.truncated,
          custom: !builtinProviders.has(id) && !modelRuntime.getRegisteredProviderIds().includes(id),
          ...(endpoint && ["http:", "https:"].includes(endpoint.protocol) && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash ? { baseUrl: endpoint.href } : {}),
          ...(api ? { api } : {}),
        });
      } catch {
        omitted++;
      }
    }
    return {
      providers: projection,
      truncation: {
        truncated: omitted > 0 || namesTruncated > 0,
        providersOmitted: omitted,
        namesTruncated,
        maxProviders: WEB_MAX_PROVIDER_AUTH_ITEMS,
      },
    };
  }

  private assertSettingsWritable(sessionId: string) {
    this.assertActive();
    this.assertWorkspaceSelected();
    if (sessionId !== this.sessionManager.getSessionId() || !this.isIdle()) {
      throw new WebRuntimeRequestError("Wait for the active Session to become idle before saving settings", "SESSION_CONFLICT", 409);
    }
  }

  private async mutateSettings(sessionId: string, operation: () => Promise<void>) {
    // Reuse prompt admission: a second tab cannot begin a turn halfway through
    // a configuration write, and already-admitted turns are checked for idle.
    const previousAdmission = this.promptAdmission;
    let release = () => {};
    this.promptAdmission = new Promise<void>((resolve) => { release = resolve; });
    try {
      await previousAdmission;
      this.assertSettingsWritable(sessionId);
      await operation();
    } finally { release(); }
  }

  saveProviderKey(sessionId: string, provider: string, apiKey: string) {
    return this.serializeControllerMutation(() => this.mutateSettings(sessionId, async () => {
      const models = this.runtime.services.modelRuntime;
      if (!models.getProvider(provider)?.auth.apiKey?.login) throw new Error("API key login is unavailable for this provider");
      let submitted = false;
      await models.login(provider, "api_key", {
        signal: AbortSignal.timeout(10_000),
        notify: () => undefined,
        prompt: async (prompt) => {
          if (prompt.type === "select") {
            const option = prompt.options.find((item) => item.id === "api-key" || item.id === "bearer-token");
            if (option) return option.id;
          }
          if (prompt.type === "secret" && !submitted) {
            submitted = true;
            return apiKey;
          }
          throw new Error("This provider needs additional authentication settings");
        },
      });
    }));
  }

  readModelConfigurations() {
    return readModelConfigurations(this.runtime.services.agentDir);
  }

  saveModelConfiguration(sessionId: string, revision: string, model: WebModelConfiguration) {
    return this.saveModelConfigurations(sessionId, revision, [model]);
  }

  saveModelConfigurations(sessionId: string, revision: string, models: WebModelConfiguration[]) {
    return this.serializeControllerMutation(() => this.mutateSettings(sessionId, async () => {
      await saveModelConfigurations(this.runtime.services.agentDir, revision, models);
      await this.runtime.services.modelRuntime.refresh({ allowNetwork: false, signal: AbortSignal.timeout(10_000) });
      for (const model of models) {
      const updated = this.runtime.services.modelRuntime.getModel(model.provider, model.id);
      if (!updated) throw new Error("Saved model was not loaded by Pi");
      const current = this.runtime.session.model;
      if (current?.provider === model.provider && current.id === model.id) {
        await this.runtime.session.setModel(updated);
      }
      }
    }));
  }

  changeProviderConfiguration(sessionId: string, revision: string, change: WebProviderConfigurationChange) {
    return this.serializeControllerMutation(() => this.mutateSettings(sessionId, async () => {
      const current = this.runtime.session.model;
      const provider = change.action === "remove" ? change.provider : change.configuration.provider;
      if (current?.provider === provider && !getBuiltinProviders().some((id) => id === provider) && (change.action === "remove" || !change.configuration.models.some((model) => model.id === current.id))) {
        throw new WebRuntimeRequestError("Select another model before removing the current model", "MODEL_NOT_AVAILABLE", 409);
      }
      await changeProviderConfiguration(this.runtime.services.agentDir, revision, change);
      await this.runtime.services.modelRuntime.refresh({ allowNetwork: false, signal: AbortSignal.timeout(10_000) });
      if (current) {
        const updated = this.runtime.services.modelRuntime.getModel(current.provider, current.id);
        if (updated) await this.runtime.session.setModel(updated);
      }
    }));
  }

  async discoverProviderModels(sessionId: string, request: ProviderModelDiscovery, signal: AbortSignal) {
    if (this.sessionManager.getSessionId() !== sessionId) throw new WebRuntimeRequestError("Session changed", "SESSION_CONFLICT", 409);
    const headers: Record<string, string> = { Accept: "application/json" };
    let key = request.apiKey;
    if (!key) {
      // Reuse native auth only for the exact registered connection, including built-in providers.
      const native = this.runtime.services.modelRuntime.getModels(request.provider).find((model) => URL.parse(model.baseUrl)?.href === URL.parse(request.baseUrl)?.href && model.api === request.api);
      if (native) {
        const auth = await this.runtime.services.modelRuntime.getAuth(native, { signal });
        if (auth?.auth.baseUrl && URL.parse(auth.auth.baseUrl)?.href !== URL.parse(request.baseUrl)?.href) throw new Error("Connection endpoint changed");
        key = auth?.auth.apiKey;
        Object.assign(headers, auth?.auth.headers);
      }
    }
    if (key) {
      if (request.api === "anthropic-messages") headers["x-api-key"] = key;
      else headers.Authorization = `Bearer ${key}`;
    }
    if (request.api === "anthropic-messages") headers["anthropic-version"] = "2023-06-01";
    return discoverProviderModels(request, headers, signal);
  }

  getSessionUsage() {
    const stats = this.runtime.session.getSessionStats();
    return {
      input: stats.tokens.input,
      output: stats.tokens.output,
      cacheRead: stats.tokens.cacheRead,
      cacheWrite: stats.tokens.cacheWrite,
      total: stats.tokens.total,
      ...(stats.contextUsage
        ? {
            context: {
              tokens: stats.contextUsage.tokens,
              contextWindow: stats.contextUsage.contextWindow,
              percent: stats.contextUsage.percent,
            },
          }
        : {}),
    };
  }

  setModel(
    provider: string,
    modelId: string,
    options?: WebModelSelectionOptions,
  ) {
    return this.serializeControllerMutation(() =>
      this.applyModelSelection(provider, modelId, options),
    );
  }

  setPlanMode(
    request: {
      enabled: boolean;
      expectedRevision: string | null;
      sessionId: string;
      sessionPath: string;
    },
  ) {
    return this.applyPlanControl({ ...request, action: "mode" });
  }

  private invokePlanControl(
    session: AgentSession["sessionManager"],
    request: PlanControlRequest,
  ) {
    try {
      return controlPlan(session, request);
    } catch (error) {
      // Extension-loader module copies need not share constructor identity.
      if (error && typeof error === "object" && "code" in error &&
        "statusCode" in error && "message" in error && typeof error.message === "string" &&
        (error.code === "PLAN_BUSY" || error.code === "PLAN_CONFLICT" || error.code === "PLAN_CONTROL_UNAVAILABLE"))
        throw new WebRuntimeRequestError(error.message, error.code, error.statusCode === 501 ? 501 : 409);
      throw error;
    }
  }

  async preparePlanImplementation(request: {
    sessionId: string;
    sessionPath: string;
    expectedRevision: string | null;
  }) {
    const result = await this.applyPlanControl({ ...request, action: "prepare" });
    if (typeof result.prompt !== "string")
      throw new Error("Plan control did not return an implementation prompt");
    return { ...result, prompt: result.prompt };
  }

  private applyPlanControl(
    request: PlanControlRequest & { sessionId: string; sessionPath: string },
  ) {
    return this.serializeControllerMutation(async () => {
      this.assertActive();
      this.assertWorkspaceSelected();
      const session = this.runtime.session;
      if (!matchesSessionIdentity(session.sessionManager, { expectedSessionId: request.sessionId, expectedSessionPath: request.sessionPath }))
        throw new WebRuntimeRequestError("The active Session changed", "SESSION_CONFLICT", 409);
      // Include preflight/queued work, not just provider streaming. The owner
      // callback below is synchronous: no prompt can enter mid-transition.
      if (!this.isIdle() || this.activePromptTrace || this.promptOperations.size || session.pendingMessageCount)
        throw new WebRuntimeRequestError("Stop the current turn before changing Plan mode", "PLAN_BUSY", 409);
      if (!this.listCommands().commands.some((command) => command.support === "plan"))
        throw new WebRuntimeRequestError("The owned Plan extension is unavailable", "PLAN_CONTROL_UNAVAILABLE", 501);
      const result = this.invokePlanControl(session.sessionManager, request);
      if (request.action !== "prepare")
        this.emit("plan_mode_changed", { sessionId: request.sessionId });
      return result;
    });
  }

  private consumePlanApproval(
    session: AgentSession["sessionManager"],
    sessionId: string,
    expectedRevision: string,
  ) {
    const result = this.invokePlanControl(session, {
      action: "implement",
      expectedRevision,
    });
    if (result.status !== "inactive")
      throw new WebRuntimeRequestError(
        "The approved Plan was not released",
        "PLAN_CONFLICT",
        409,
      );
    this.emit("plan_mode_changed", { sessionId });
  }

  private authorizePlanApproval(
    session: AgentSession["sessionManager"],
    expectedRevision: string,
    prompt: string,
  ) {
    const result = this.invokePlanControl(session, {
      action: "authorize",
      expectedRevision,
      prompt,
    });
    if (result.status !== "ready" || result.revision !== expectedRevision)
      throw new WebRuntimeRequestError(
        "The approved Plan changed before prompt admission",
        "PLAN_CONFLICT",
        409,
      );
  }

  private cancelPlanApproval(
    session: AgentSession["sessionManager"],
    expectedRevision: string,
  ) {
    this.invokePlanControl(session, {
      action: "cancel",
      expectedRevision,
    });
  }

  private async applyModelSelection(
    provider: string,
    modelId: string,
    options?: WebModelSelectionOptions,
  ) {
    this.assertActive();
    this.assertWorkspaceSelected();
    const agentRuntime = this.runtime;
    if (!matchesSessionIdentity(agentRuntime.session.sessionManager, options)) {
      throw new WebRuntimeRequestError(
        "Only the active Web session accepts model selection",
        "SESSION_CONFLICT",
        409,
      );
    }
    const { modelRuntime } = agentRuntime.services;
    const model = modelRuntime.getModel(provider, modelId);
    if (
      !model ||
      !modelRuntime
        .getAvailableSnapshot()
        .some((item) => item.provider === provider && item.id === modelId)
    ) {
      throw new WebRuntimeRequestError(
        "Model is not available",
        "MODEL_NOT_AVAILABLE",
        400,
      );
    }
    this.retainRuntimeReference(agentRuntime);
    try {
      await agentRuntime.session.setModel(model);
      const current = agentRuntime.session.model;
      const selected = modelRuntime
        .getAvailableSnapshot()
        .map((item) => ({
          provider: item.provider,
          id: item.id,
          name: item.name,
          label: item.name || `${item.provider}/${item.id}`,
          current:
            current?.provider === item.provider && current.id === item.id,
        }))
        .find((item) => item.current);
      if (!selected) throw new Error("Model selection was not confirmed");
      this.emit("model_select", { provider, modelId });
      return selected;
    } finally {
      this.releaseRuntimeReference(agentRuntime);
    }
  }

  subscribe(listener: (event: WebRuntimeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getThinkingState() {
    this.assertActive();
    const session = this.runtime.session;
    return {
      level: session.thinkingLevel,
      available: session.getAvailableThinkingLevels(),
      supported: session.supportsThinking(),
    };
  }

  setThinkingLevel(level: string, options?: WebThinkingSelectionOptions) {
    const expectedSessionId = options?.expectedSessionId;
    const expectedSessionPath = options?.expectedSessionPath;
    // Validate each caller at enqueue so a stale Session cannot influence, or
    // be silently resolved through, another Session's merged write.
    if (!matchesSessionIdentity(this.runtime.session.sessionManager, options)) {
      return Promise.reject(this.thinkingSessionConflictError());
    }
    return new Promise<WebThinkingProjection>((resolve, reject) => {
      const waiter = {
        level,
        resolve,
        reject,
        expectedSessionId,
        expectedSessionPath,
      };
      const pending = this.thinkingMutationPending;
      if (pending) {
        // Coalesce to the latest caller that still owns the active Session
        // when the serialized write executes.
        pending.waiters.push(waiter);
        return;
      }
      this.thinkingMutationPending = { waiters: [waiter] };
      void this.drainThinkingMutations();
    });
  }

  private thinkingSessionConflictError() {
    return new WebRuntimeRequestError(
      "Only the active Web session accepts thinking changes",
      "SESSION_CONFLICT",
      409,
    );
  }

  private async drainThinkingMutations() {
    if (this.thinkingMutationInFlight) return;
    this.thinkingMutationInFlight = true;
    try {
      while (this.thinkingMutationPending) {
        const pending = this.thinkingMutationPending;
        this.thinkingMutationPending = undefined;
        try {
          // Validate every merged caller against the active Session inside the
          // serialized mutation, so a caller whose Session changed after
          // enqueue gets its own 409 instead of another Session's result.
          const outcome = await this.serializeControllerMutation(async () => {
            this.assertActive();
            this.assertWorkspaceSelected();
            const accepted = pending.waiters.filter((waiter) =>
              matchesSessionIdentity(this.runtime.session.sessionManager, waiter),
            );
            const latest = accepted.at(-1);
            if (!latest) return undefined;
            return {
              accepted,
              projection: await this.applyThinkingSelection(latest.level),
            };
          });
          if (!outcome) {
            const conflict = this.thinkingSessionConflictError();
            for (const waiter of pending.waiters) waiter.reject(conflict);
            continue;
          }
          for (const waiter of pending.waiters) {
            if (outcome.accepted.includes(waiter)) {
              waiter.resolve(outcome.projection);
            } else {
              waiter.reject(this.thinkingSessionConflictError());
            }
          }
        } catch (error) {
          traceWeb("thinking_selection_failed", {
            level: pending.waiters.at(-1)?.level,
            error: errorText(error),
          });
          for (const waiter of pending.waiters) waiter.reject(error);
        }
      }
    } finally {
      this.thinkingMutationInFlight = false;
    }
  }

  private async applyThinkingSelection(level: string) {
    const agentRuntime = this.runtime;
    const available = agentRuntime.session.getAvailableThinkingLevels();
    const match = available.find((item) => item === level);
    if (!match || !agentRuntime.session.supportsThinking()) {
      throw new WebRuntimeRequestError(
        "Thinking level is not available for the current model",
        "THINKING_LEVEL_NOT_AVAILABLE",
        400,
      );
    }
    // Pi's setThinkingLevel is synchronous and clamps only to available
    // levels, which were matched above. No retainRuntimeReference is needed.
    agentRuntime.session.setThinkingLevel(match);
    if (agentRuntime.session.thinkingLevel !== level) {
      throw new Error("Thinking level selection was not confirmed");
    }
    return this.getThinkingState();
  }

  async sendPrompt(content: string, options?: WebPromptOptions) {
    this.assertActive();
    this.assertWorkspaceSelected();
    this.assertNoHistoryFork();
    const owner = this.runtime;
    if (!matchesSessionIdentity(owner.session.sessionManager, options)) {
      throw new WebRuntimeRequestError(
        "Only the active Web session accepts messages",
        "SESSION_CONFLICT",
        409,
      );
    }
    this.assertSteeringTarget(owner.session, options);
    const sessionId = owner.session.sessionManager.getSessionId();
    const exact = { ...options, expectedSessionId: sessionId, expectedSessionPath: owner.session.sessionManager.getSessionFile() ?? `current:${sessionId}` };
    if (options?.streamingBehavior !== "steer" && (owner.session.isCompacting || this.manualCompactionOwner === owner || this.compactionQueues?.has(owner)))
      return this.holdCompactionPrompt(owner, content, exact);
    return this.dispatchPrompt(owner, content, exact);
  }

  private assertSteeringTarget(session: AgentSession, options?: WebPromptOptions) {
    if (options?.streamingBehavior !== "steer") return;
    const turn = this.getActiveTurn();
    if (
      options.planRevision !== undefined ||
      !session.isStreaming ||
      session.isCompacting ||
      this.manualCompactionOwner?.session === session ||
      !turn ||
      turn.sessionId !== session.sessionManager.getSessionId() ||
      turn.commandId !== options.expectedTurnCommandId ||
      this.turnAbortOperations?.has(this.turnKey(turn))
    )
      throw new WebRuntimeRequestError(
        "The targeted turn has ended or is stopping. Keep your draft and choose how to send it.",
        "TURN_CONFLICT",
        409,
      );
  }

  private async dispatchPrompt(agentRuntime: AgentSessionRuntime, content: string, options?: WebPromptOptions, fromCompactionQueue = false) {
    const session = agentRuntime.session;
    const sessionId = session.sessionManager.getSessionId();
    const previousAdmission = this.promptAdmission;
    let releaseAdmission: () => void = () => undefined;
    this.promptAdmission = new Promise<void>((resolveAdmission) => {
      releaseAdmission = resolveAdmission;
    });
    const startedAt = performance.now();
    const promptTrace: PromptTrace | undefined = options?.commandId
      ? {
          commandId: options.commandId,
          sessionId,
          sessionPath: session.sessionManager.getSessionFile() ?? `current:${sessionId}`,
          startedAt,
          started: false,
          queued: false,
          userMessageObserved: false,
        }
      : undefined;
    this.retainRuntimeReference(agentRuntime);
    let resolveRequest: (receipt: WebPromptAdmissionReceipt) => void = () => undefined;
    let rejectRequest: (error: unknown) => void = () => undefined;
    const requestAdmission = new Promise<WebPromptAdmissionReceipt>(
      (resolveRequestAdmission, reject) => {
        resolveRequest = resolveRequestAdmission;
        rejectRequest = reject;
      },
    );
    const operation = (async () => {
      let admissionDisposition: PromptDisposition | undefined;
      let planApprovalAuthorized = false;
      let agentLifecycleStarted = false;
      let commandInputEntryId: string | undefined;
      let unsubscribePromptLifecycle: (() => void) | undefined;
      try {
        await previousAdmission;
        // Pi reports idle while its asynchronous agent_settled handlers still
        // run. A prompt there returns before admission and schedules detached
        // work; wait for the public boundary before submitting this request.
        if (session.isIdle && this.endingSessions?.has(session)) {
          await new Promise<void>((resolveSettlement) => {
            const unsubscribe = session.subscribe((event) => {
              if (event.type !== "agent_settled") return;
              unsubscribe();
              resolveSettlement();
            });
          });
        }
        this.assertActive();
        this.assertWorkspaceSelected();
        this.assertNoHistoryFork();
        if (
          (agentRuntime !== this.runtime && !(fromCompactionQueue && this.retainedRuntimes.has(agentRuntime))) ||
          session !== agentRuntime.session ||
          !matchesSessionIdentity(session.sessionManager, {
            expectedSessionId: sessionId,
            expectedSessionPath: options?.expectedSessionPath,
          })
        ) {
          throw new WebRuntimeRequestError(
            "Only the active Web session accepts messages",
            "SESSION_CONFLICT",
            409,
          );
        }
        this.assertSteeringTarget(session, options);
        assertWebCommandSupported(agentRuntime.services, content);
        if (agentRuntime !== this.runtime && submittedExtensionCommand(agentRuntime.services, content)) {
          throw new WebRuntimeRequestError("Return to this Session to retry its queued command.", "SESSION_CONFLICT", 409);
        }
        if (session.isCompacting) {
          throw new WebRuntimeRequestError("Context compaction is in progress. Keep your draft and retry when it finishes.", "SESSION_CONFLICT", 409);
        }
        this.compactionObservations?.delete(session);
        if (promptTrace && agentRuntime === this.runtime) {
          this.pendingPromptTraces.push(promptTrace);
          this.activePromptTrace ??= this.pendingPromptTraces.shift();
        } else if (promptTrace) {
          this.suspendedPromptTraces ??= new WeakMap();
          const traces = this.suspendedPromptTraces.get(session) ?? { pending: [] };
          traces.pending.push(promptTrace);
          traces.active ??= traces.pending.shift();
          this.suspendedPromptTraces.set(session, traces);
        }
        if (promptTrace) {
          traceWeb("prompt_dispatch_started", {
            commandId: promptTrace.commandId,
            sessionId,
            chars: content.length,
            provider: session.model?.provider,
            modelId: session.model?.id,
          });
          traceWeb("prompt_preflight_started", {
            commandId: promptTrace.commandId,
            sessionId,
            elapsedMs: elapsed(startedAt),
          });
        }
        unsubscribePromptLifecycle = session.subscribe((event) => {
          if (event.type === "agent_start") agentLifecycleStarted = true;
        });
        this.promptOrigins ??= new AsyncLocalStorage<PromptTrace | undefined>();
        const extensionCommand = submittedExtensionCommand(agentRuntime.services, content);
        if (options?.streamingBehavior === "steer" && extensionCommand)
          throw new WebRuntimeRequestError("Extension commands cannot steer a running turn.", "PROMPT_REJECTED", 422);
        if (options?.planRevision !== undefined && extensionCommand)
          throw new WebRuntimeRequestError(
            "A Plan approval must be submitted as a prompt, not an extension command",
            "PLAN_CONFLICT",
            409,
          );
        if (extensionCommand) {
          const projected = commandsForServices(agentRuntime.services).commands.find((command) => command.name === extensionCommand.name);
          // Check the owned command before Pi's admission callback: command
          // handlers may reject after the HTTP request has already been accepted.
          if (projected?.support === "setup" && projectPlanControl(session.sessionManager.getBranch()).status !== "inactive") {
            throw new WebRuntimeRequestError("Exit Plan mode before changing OpenPI settings, then retry /openpi-setup.", "PLAN_CONFLICT", 409);
          }
          commandInputEntryId = session.sessionManager.appendCustomEntry(WEB_COMMAND_INPUT, { text: content, commandId: options?.commandId });
          this.emit("command_submitted", { sessionId });
          if (projected?.availability !== "available") publishWebCommandFeedback(session.sessionManager,
            "This extension has not been adapted for Web. Pi will handle the command, but dialogs or results may require the TUI.", "warning");
        }
        if (options?.planRevision !== undefined) {
          if (!options.expectedSessionPath)
            throw new WebRuntimeRequestError(
              "A Plan approval must target the exact active Session",
              "SESSION_CONFLICT",
              409,
            );
          if (
            session.isStreaming ||
            session.pendingMessageCount > 0 ||
            session.getFollowUpMessages().length > 0
          )
            throw new WebRuntimeRequestError(
              "Stop the current turn before submitting an approved Plan",
              "PLAN_BUSY",
              409,
            );
          planApprovalAuthorized = true;
          this.authorizePlanApproval(
            session.sessionManager,
            options.planRevision,
            content,
          );
        }
        const promptImages = options?.images?.length
          ? options.images.map(({ data, mimeType, name }) => ({
                  type: "image" as const,
                  data,
                  mimeType,
                  ...(name ? { name } : {}),
                }))
          : undefined;
        const delivery = options?.streamingBehavior === "steer" ? "steer" : session.isStreaming && !extensionCommand ? "followUp" : "prompt";
        const preflightResult = (disposition: PromptDisposition) => {
            if (options?.planRevision !== undefined) {
              if (disposition !== "handled") {
                this.consumePlanApproval(
                  session.sessionManager,
                  sessionId,
                  options.planRevision,
                );
                planApprovalAuthorized = false;
              } else if (planApprovalAuthorized) {
                this.cancelPlanApproval(
                  session.sessionManager,
                  options.planRevision,
                );
                planApprovalAuthorized = false;
              }
            }
            admissionDisposition = disposition;
            if (promptTrace && disposition === "queued") promptTrace.queued = true;
            releaseAdmission();
            if (promptTrace) {
              traceWeb(
                "prompt_preflight_accepted",
                {
                  commandId: promptTrace.commandId,
                  sessionId,
                  disposition,
                  elapsedMs: elapsed(startedAt),
                },
              );
            }
            resolveRequest({
              pendingFollowUps: session.getFollowUpMessages().length,
              ...(options?.streamingBehavior || (session.getSteeringMessages?.().length ?? 0) > 0 ? {
                pendingSteering: session.getSteeringMessages?.().length ?? 0,
                delivery,
              } : {}),
            });
          };
        if (options?.streamingBehavior === "steer") {
          // Native steer never starts a fresh prompt. Pi 0.99 also runs input
          // hooks here, so preserve its handled/queued admission disposition.
          const disposition = await this.promptOrigins.run(promptTrace, () => session.steer(content, promptImages, { source: "rpc" }));
          preflightResult(disposition);
        } else {
          await this.promptOrigins.run(promptTrace, () => session.prompt(content, {
            ...(promptImages ? { images: promptImages } : {}),
            ...(session.isStreaming ? { streamingBehavior: "followUp" as const } : {}),
            source: "rpc",
            preflightResult,
          }));
        }
        unsubscribePromptLifecycle();
        unsubscribePromptLifecycle = undefined;
        if (admissionDisposition === undefined) {
          if (planApprovalAuthorized && options?.planRevision !== undefined) {
            this.cancelPlanApproval(
              session.sessionManager,
              options.planRevision,
            );
            planApprovalAuthorized = false;
          }
          rejectRequest(
            new WebRuntimeRequestError(
              "Pi completed the prompt without confirming admission",
              "PROMPT_REJECTED",
              422,
            ),
          );
        }
        if (
          admissionDisposition === "handled" &&
          options?.commandId &&
          !agentLifecycleStarted &&
          session.isIdle
        ) {
          if (commandInputEntryId) {
            // Persist the same handler-return fact as prompt_settled. Feedback
            // can be progress, and is never evidence that a handler returned.
            session.sessionManager.appendCustomEntry(WEB_COMMAND_HANDLED, {
              inputEntryId: commandInputEntryId,
              commandId: options.commandId,
            });
          }
          this.emit("prompt_settled", {
            commandId: options.commandId,
            sessionId,
            outcome: "handled",
          });
        }
        if (promptTrace) {
          traceWeb("prompt_operation_settled", {
            commandId: promptTrace.commandId,
            sessionId,
            elapsedMs: elapsed(startedAt),
          });
          promptTrace.started =
            this.activePromptTrace?.commandId === promptTrace.commandId
              ? this.activePromptTrace.started
              : promptTrace.started;
          // Native extension commands may start a triggerTurn asynchronously:
          // their handler returns before the delayed agent_start is projected.
          // Pi already reports an active run, so keep its admitted identity.
          if (admissionDisposition === undefined || (!promptTrace.queued && !promptTrace.started && session.isIdle)) {
            this.removePromptTrace(promptTrace, session);
          }
        }
      } catch (error) {
        if (planApprovalAuthorized && options?.planRevision !== undefined) {
          try {
            this.cancelPlanApproval(
              session.sessionManager,
              options.planRevision,
            );
          } catch {
            // Keep the admission error; a disposed Session drops its transient approval on shutdown.
          }
          planApprovalAuthorized = false;
        }
        releaseAdmission();
        if (admissionDisposition === undefined) {
          rejectRequest(
            error instanceof WebRuntimeRequestError
              ? error
              : new WebRuntimeRequestError(
                  errorText(error),
                  "PROMPT_REJECTED",
                  422,
                ),
          );
        } else {
          this.emit("prompt_failed", {
            ...(options?.commandId ? { commandId: options.commandId } : {}),
            sessionId,
            error: projectAssistantError(errorText(error)).value,
          });
        }
        if (promptTrace) {
          promptTrace.outcome = "failed";
          traceWeb("prompt_operation_failed", {
            commandId: promptTrace.commandId,
            sessionId,
            elapsedMs: elapsed(startedAt),
            error: projectAssistantError(errorText(error)).value,
          });
          this.removePromptTrace(promptTrace, session);
        }
      } finally {
        unsubscribePromptLifecycle?.();
        releaseAdmission();
        this.releaseRuntimeReference(agentRuntime);
      }
    })();
    this.promptOperations.add(operation);
    void operation.then(
      () => this.promptOperations.delete(operation),
      () => this.promptOperations.delete(operation),
    );
    return await requestAdmission;
  }

  private sessionCreationReceipts?: Map<string, { workspacePath: string; result: WebSessionCreationResult }>;

  forkSession(request: WebSessionForkRequest) {
    if (!request.commandId || request.commandId.length > 128 || /[\u0000-\u001f\u007f]/u.test(request.commandId))
      return Promise.reject(new WebRuntimeRequestError("A bounded fork command is required", "SESSION_FORK_UNAVAILABLE", 400));
    const receipts = this.historyForkReceipts;
    const previous = receipts.get(request.commandId);
    if (previous) {
      const original = previous.request;
      if (original.sessionId !== request.sessionId || original.sessionPath !== request.sessionPath || original.entryId !== request.entryId)
        return Promise.reject(new WebRuntimeRequestError("Fork command belongs to another message", "SESSION_CONFLICT", 409));
      return previous.result.then((result) => ({ ...result, replayed: true }));
    }
    if (receipts.size >= 1024)
      return Promise.reject(new WebRuntimeRequestError("Fork receipt capacity reached", "SESSION_FORK_CAPACITY", 409));
    if (this.historyForkPending)
      return Promise.reject(new WebRuntimeRequestError("Another Session fork is in progress", "SESSION_CONFLICT", 409));
    const exact = { ...request };
    const source = { sessionId: exact.sessionId, sessionPath: exact.sessionPath, entryId: exact.entryId };
    const result = this.serializeControllerMutation(async () => {
      this.assertActive();
      this.assertWorkspaceSelected();
      const owner = this.runtime;
      const session = owner.session;
      const manager = session.sessionManager;
      if (!matchesSessionIdentity(manager, { expectedSessionId: exact.sessionId, expectedSessionPath: exact.sessionPath }))
        throw new WebRuntimeRequestError("Only the active Web Session can fork", "SESSION_CONFLICT", 409);
      const entry = manager.getBranch().find((entry) => entry.id === exact.entryId);
      if (!entry || entry.type !== "message" || !manager.isPersisted() || !existsSync(exact.sessionPath) || dirname(resolve(exact.sessionPath)) !== resolve(this.webSessionDirectory))
        throw new WebRuntimeRequestError("A saved message on the current Web branch is required", "SESSION_FORK_UNAVAILABLE", 409);
      if (!session.isIdle || session.isStreaming || session.isCompacting || session.pendingMessageCount || session.getFollowUpMessages().length || session.getSteeringMessages().length || this.inFlightRuntimes.has(owner) || this.activePromptTrace || this.pendingPromptTraces.length || this.compactionQueues?.has(owner) || this.manualCompactionOwner === owner)
        throw new WebRuntimeRequestError("Wait for current work and queued messages before forking", "SESSION_FORK_UNAVAILABLE", 409);
      try {
        const fork = await owner.fork(exact.entryId, { position: "at" });
        this.assertActiveRuntime(owner);
        if (fork.cancelled) return { state: "cancelled", commandId: exact.commandId, source } satisfies WebSessionForkResult;
        const child = owner.session.sessionManager;
        const sessionId = child.getSessionId();
        const sessionPath = child.getSessionFile();
        if (!sessionPath || sessionId === exact.sessionId || sessionPath === exact.sessionPath || child.getHeader()?.parentSession !== exact.sessionPath || !child.getBranch().some((entry) => entry.id === exact.entryId))
          throw new Error("Native fork identity was not confirmed");
        this.emit("session_switched", { sessionId, sessionPath, commandId: exact.commandId });
        return { state: "forked", commandId: exact.commandId, source, sessionId, sessionPath } satisfies WebSessionForkResult;
      } catch {
        // Native fork can persist its new file before replacement fails. Keep
        // this command terminal and never repeat that irreversible creation.
        this.hasSelectedWorkspace = false;
        this.emit("runtime_changed", { forkState: "uncertain", commandId: exact.commandId });
        return { state: "uncertain", commandId: exact.commandId, source } satisfies WebSessionForkResult;
      }
    }, true);
    this.historyForkPending = true;
    const settled = result.finally(() => { this.historyForkPending = false; });
    receipts.set(exact.commandId, { request: exact, result: settled });
    return settled;
  }

  newSession(workspacePath: string, options?: WebSessionCreationOptions) {
    return this.serializeControllerMutation(async () => {
      this.assertActive();
      const commandId = options?.commandId;
      const receipts = this.sessionCreationReceipts ??= new Map();
      const previous = commandId ? receipts.get(commandId) : undefined;
      if (previous) {
        if (previous.workspacePath !== workspacePath) throw new Error("Session creation command belongs to another workspace");
        return { ...previous.result, replayed: true };
      }
      // Do not evict receipts: forgetting a command would permit duplicate creation.
      if (commandId && receipts.size >= 1024) throw new Error("Session creation receipt limit reached; select an existing Session or restart the Web host");
      const result = await this.createNewSession(workspacePath, options);
      if (commandId) receipts.set(commandId, { workspacePath, result: { ...result } });
      return result;
    });
  }

  private async createNewSession(
    workspacePath: string,
    options?: WebSessionCreationOptions,
  ) {
    const cwd = await canonicalDirectory(workspacePath);
    this.assertActive();
    const replacement = await PiWebRuntime.createRuntime(
      cwd,
      SessionManager.create(cwd, this.webSessionDirectory),
      this.dispatcherLease,
    );
    await this.activateCandidate(replacement.runtime);
    this.hasSelectedWorkspace = true;
    const sessionId = this.runtime.session.sessionManager.getSessionId();
    const sessionPath = this.runtime.session.sessionManager.getSessionFile();
    this.emit("session_switched", {
      sessionId,
      ...(options?.commandId ? { commandId: options.commandId } : {}),
      ...(sessionPath ? { sessionPath } : {}),
    });
    return {
      cancelled: false,
      sessionId,
      ...(options?.commandId ? { commandId: options.commandId } : {}),
      ...(sessionPath ? { sessionPath } : {}),
    };
  }

  switchSession(sessionPath: string) {
    return this.serializeControllerMutation(() =>
      this.switchActiveSession(sessionPath),
    );
  }

  private async switchActiveSession(sessionPath: string) {
    if (this.runtime.session.sessionManager.getSessionFile() === sessionPath) {
      return { cancelled: false };
    }
    const retained = [...this.retainedRuntimes].find(
      (candidate) =>
        candidate.session.sessionManager.getSessionFile() === sessionPath,
    );
    if (retained) {
      await this.promoteRetainedRuntime(retained);
      this.hasSelectedWorkspace = true;
      this.emit("session_switched", { sessionPath });
      return { cancelled: false };
    }
    const sessionManager = SessionManager.open(
      sessionPath,
      this.webSessionDirectory,
    );
    const cwd = await canonicalDirectory(sessionManager.getCwd());
    this.assertActive();
    const replacement = await PiWebRuntime.createRuntime(
      cwd,
      sessionManager,
      this.dispatcherLease,
    );
    await this.activateCandidate(replacement.runtime);
    this.hasSelectedWorkspace = true;
    this.emit("session_switched", { sessionPath });
    return { cancelled: false };
  }

  dispose() {
    this.disposePromise ??= this.disposeInternal();
    return this.disposePromise;
  }

  private async disposeInternal() {
    this.disposed = true;
    this.compactionQueues?.clear();
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
    this.promptOrigins?.disable();
    const runtimes = new Set([
      this.runtime,
      ...this.retainedRuntimes,
      ...this.candidateRuntimes,
    ]);
    for (const retained of this.retainedRuntimes) {
      this.retainedSubscriptions.get(retained)?.();
    }
    const failures: unknown[] = [];
    try {
      const aborts = await Promise.allSettled(
        [...runtimes].map((runtime) => runtime.session.abort()),
      );
      failures.push(
        ...aborts
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason),
      );
      await Promise.all([...this.promptOperations]);
      await Promise.all([...this.runtimeOperations]);
      const finalRuntimes = new Set([
        ...runtimes,
        this.runtime,
        ...this.retainedRuntimes,
        ...this.candidateRuntimes,
      ]);
      const lateRuntimes = [...finalRuntimes].filter(
        (runtime) => !runtimes.has(runtime),
      );
      const lateAborts = await Promise.allSettled(
        lateRuntimes.map((runtime) => runtime.session.abort()),
      );
      failures.push(
        ...lateAborts
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason),
      );
      await Promise.allSettled(
        [...finalRuntimes].map((runtime) => this.disposeAgentRuntime(runtime)),
      );
      await Promise.allSettled([...this.runtimeDisposals]);
      if (this.runtimeDisposalFailure !== undefined) {
        failures.push(this.runtimeDisposalFailure);
        this.runtimeDisposalFailure = undefined;
      }
    } finally {
      try {
        await this.dispatcherLease.release();
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.webHostLease.release();
      } catch (error) {
        failures.push(error);
      }
      this.retainedRuntimes.clear();
      this.retainedSubscriptions.clear();
      this.candidateRuntimes.clear();
      this.runtimeOperations.clear();
      this.inFlightRuntimes.clear();
      this.listeners.clear();
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to dispose the Web runtime");
    }
  }

  private static async createRuntime(
    cwd: string,
    sessionManager: SessionManager,
    dispatcherLease?: HttpDispatcherLease,
  ) {
    const agentDir = getAgentDir();
    let sharedDispatcherLease = dispatcherLease;
    let ownsDispatcherLease = false;
    const trustStore = new ProjectTrustStore(agentDir);
    const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
      const projectTrusted =
        !hasTrustRequiringProjectResources(options.cwd) ||
        trustStore.get(options.cwd) === true;
      const settingsManager = SettingsManager.create(
        options.cwd,
        options.agentDir,
        { projectTrusted },
      );
      const httpProxyConfigured = applyHttpProxySettings(
        settingsManager.getGlobalSettings().httpProxy,
      );
      if (!sharedDispatcherLease) {
        sharedDispatcherLease = configureHttpDispatcher(
          settingsManager.getHttpIdleTimeoutMs(),
        );
        ownsDispatcherLease = true;
      }
      const commandDiscovery = createCommandDiscoveryBridge();
      const turnChanges = createTurnChangeRecorder(options.sessionManager, options.cwd);
      const services = await createAgentSessionServices({
        cwd: options.cwd,
        agentDir: options.agentDir,
        settingsManager,
        modelRuntimeSignal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
        resourceLoaderOptions: {
          extensionFactories: [commandDiscovery.extension, turnChanges.extension],
        },
      });
      registerCommandDiscoveryBridge(services, commandDiscovery);
      const extensionErrors = services.resourceLoader
        .getExtensions()
        .errors.map(({ path, error }) => `Failed to load extension "${path}": ${error}`);
      const errors = [
        ...services.diagnostics
          .filter((diagnostic) => diagnostic.type === "error")
          .map((diagnostic) => diagnostic.message),
        ...extensionErrors,
      ];
      if (errors.length > 0) throw new Error(errors.join("; "));
      const created = await createAgentSessionFromServices({
        services,
        customTools: [turnChanges.writeTool, turnChanges.editTool],
        sessionManager: options.sessionManager,
        sessionStartEvent: options.sessionStartEvent,
      });
      const nativeStream = created.session.agent.streamFunction;
      created.session.agent.streamFunction = (model, context, streamOptions) => {
        // A cancelled tool can return before Pi attempts its next model step.
        // Let Agent's native run lifecycle classify the aborted signal, before
        // model auth setup can flatten that AbortError into stopReason: error.
        streamOptions?.signal?.throwIfAborted();
        return nativeStream(model, context, streamOptions);
      };
      const model = created.session.model;
      traceWeb("provider_config", {
        provider: model?.provider,
        modelId: model?.id,
        api: model?.api,
        baseOrigin: model?.baseUrl ? new URL(model.baseUrl).origin : undefined,
        httpIdleTimeoutMs: sharedDispatcherLease.timeoutMs,
        providerRetry: settingsManager.getProviderRetrySettings(),
        httpProxyConfigured,
      });
      return {
        ...created,
        services,
        diagnostics: services.diagnostics,
      };
    };
    try {
      const runtime = await createAgentSessionRuntime(createRuntime, {
        cwd,
        agentDir,
        sessionManager,
      });
      if (!sharedDispatcherLease) {
        throw new Error("HTTP dispatcher lease was not created");
      }
      return { runtime, dispatcherLease: sharedDispatcherLease };
    } catch (error) {
      if (ownsDispatcherLease) await sharedDispatcherLease?.release();
      throw error;
    }
  }

  private async startRuntimeSession() {
    const runtime = this.runtime;
    await this.initializeRuntimeSession(runtime);
    this.attachActiveSession(runtime, runtime.session);
  }

  private async initializeRuntimeSession(runtime: AgentSessionRuntime) {
    await this.bindExtensions(runtime, runtime.session);
    runtime.setRebindSession(async (replacement) => {
      this.assertActiveRuntime(runtime);
      await this.bindExtensions(runtime, replacement);
      this.assertActiveRuntime(runtime);
      this.attachActiveSession(runtime, replacement);
    });
  }

  private async bindExtensions(
    runtime: AgentSessionRuntime,
    session: AgentSession,
  ) {
    const startedAt = performance.now();
    traceWeb("extensions_bind_started", {
      sessionId: session.sessionManager.getSessionId(),
      cwd: runtime.cwd,
    });
    // Startup hooks can run the model before Web's projection is attached.
    // Keep this native phase observer for the Session lifetime; Pi's dispose
    // clears its subscriptions, including those of retained Sessions.
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_end") {
        (this.endingSessions ??= new WeakSet()).add(session);
      } else if (event.type === "agent_start" || event.type === "agent_settled") {
        this.endingSessions?.delete(session);
      }
    });
    try {
      await session.bindExtensions({ mode: "print", onError: (error) => {
        publishWebCommandFeedback(session.sessionManager, error.error, "error");
      } });
    } catch (error) {
      unsubscribe();
      throw error;
    }
    traceWeb("extensions_bind_finished", {
      sessionId: session.sessionManager.getSessionId(),
      elapsedMs: elapsed(startedAt),
    });
  }

  private attachActiveSession(
    runtime: AgentSessionRuntime,
    session: AgentSession,
  ) {
    this.assertActiveRuntime(runtime);
    const unsubscribe = session.subscribe((event) =>
      this.projectEvent(session, event),
    );
    const previous = this.unsubscribeSession;
    this.unsubscribeSession = unsubscribe;
    previous?.();
  }

  private projectEvent(session: AgentSession, event: AgentSessionEvent) {
    if (session !== this.runtime.session) return;
    this.observeCompaction(session, event);
    // A command can return before its native triggerTurn continuation starts.
    // Recover only that async invocation's unused origin, never the last HTTP
    // request or an unrelated run. This also retains its controlling Web tab.
    if (event.type === "agent_start" && !this.activePromptTrace) {
      const origin = this.promptOrigins?.getStore();
      if (origin && !origin.started && matchesSessionIdentity(session.sessionManager, { expectedSessionId: origin.sessionId, expectedSessionPath: origin.sessionPath })) {
        this.activePromptTrace = origin;
      }
    }
    if (this.activePromptTrace) observePromptOutcome(this.activePromptTrace, event);
    if (event.type === "agent_start" && this.activePromptTrace) {
      this.startPromptTrace(this.activePromptTrace);
    }
    if (event.type === "message_start" && event.message.role === "user") {
      if (!this.activePromptTrace) {
        this.activePromptTrace = this.pendingPromptTraces.shift();
      }
      if (this.activePromptTrace) {
        this.startPromptTrace(this.activePromptTrace);
        this.activePromptTrace.userMessageObserved = true;
      }
    }
    const promptTrace = this.activePromptTrace;
    if (promptTrace) {
      const eventDetail: Record<string, unknown> = {
        commandId: promptTrace.commandId,
        sessionId: promptTrace.sessionId,
        type: event.type,
        elapsedMs: elapsed(promptTrace.startedAt),
      };
      if (event.type === "message_update") {
        eventDetail.contentChars = projectMessage(event.message).content.length;
      }
      if (event.type === "message_start" || event.type === "message_end") {
        eventDetail.role = event.message.role;
        const message = event.message as { stopReason?: unknown; errorMessage?: unknown };
        if (typeof message.stopReason === "string") {
          eventDetail.stopReason = message.stopReason;
        }
        if (typeof message.errorMessage === "string") {
          eventDetail.errorMessage = projectAssistantError(message.errorMessage).value;
        }
      }
      if (event.type === "auto_retry_start") {
        eventDetail.attempt = event.attempt;
        eventDetail.maxAttempts = event.maxAttempts;
        eventDetail.delayMs = event.delayMs;
        eventDetail.errorMessage = projectAssistantError(event.errorMessage).value;
      }
      if (event.type === "auto_retry_end") {
        eventDetail.attempt = event.attempt;
        eventDetail.success = event.success;
        if (event.finalError) eventDetail.finalError = projectAssistantError(event.finalError).value;
      }
      if (event.type === "agent_end") eventDetail.willRetry = event.willRetry;
      traceWeb("agent_event", eventDetail);
    }
    switch (event.type) {
      case "agent_start":
        this.emit(event.type, {
          sessionId: session.sessionManager.getSessionId(),
          ...(this.getActiveTurn()
            ? { activeTurn: this.getActiveTurn() }
            : {}),
        });
        break;
      case "agent_settled":
        // Pi emits this only after the whole agent run (including tool loops
        // and admitted follow-ups) has reached a terminal state. A
        // message_end is only one model response and must not settle a turn.
        if (this.activePromptTrace?.started) {
          this.settlePromptTrace(this.activePromptTrace);
        }
        this.activePromptTrace = undefined;
        this.pendingPromptTraces.length = 0;
        this.emit(event.type, {
          sessionId: session.sessionManager.getSessionId(),
        });
        break;
      case "thinking_level_changed":
        this.emit(event.type, {
          sessionId: session.sessionManager.getSessionId(),
          level: event.level,
        });
        break;
      case "queue_update":
        this.emit(event.type, { sessionId: session.sessionManager.getSessionId() });
        break;
      case "auto_retry_start":
        this.emit(event.type, {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
        });
        break;
      case "auto_retry_end":
        this.emit(event.type, {
          attempt: event.attempt,
          success: event.success,
        });
        break;
      case "message_start":
        this.liveMessageKey = `live-${++this.liveMessageSequence}`;
        this.emit(event.type, {
          message: projectMessage(event.message, (path) => resolve(this.cwd, path)),
          messageKey: this.liveMessageKey,
        });
        break;
      case "message_update":
      case "message_end":
        this.emit(event.type, {
          message: projectMessage(event.message, (path) => resolve(this.cwd, path)),
          ...(this.liveMessageKey ? { messageKey: this.liveMessageKey } : {}),
        });
        if (event.type === "message_end") this.liveMessageKey = undefined;
        break;
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        this.emit(event.type, {
          sessionId: session.sessionManager.getSessionId(),
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          ...(event.type === "tool_execution_end"
            ? { isError: event.isError, result: projectMessage({ ...event.result, role: "toolResult", toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError }) }
            : { call: projectMessage({ content: [{ type: "toolCall", id: event.toolCallId, name: event.toolName, arguments: event.args }] }).parts?.[0],
                ...(event.type === "tool_execution_update" ? { result: projectMessage({ ...event.partialResult, role: "toolResult", toolName: event.toolName, toolCallId: event.toolCallId }) } : {}) }),
        });
        break;
    }
  }

  private emit(type: string, detail?: Record<string, unknown>) {
    for (const listener of this.listeners) listener({ type, detail });
  }

  private activeTurnFromTrace(trace?: PromptTrace): WebActiveTurn | undefined {
    if (!trace?.started || trace.epoch === undefined) return undefined;
    return {
      sessionId: trace.sessionId,
      commandId: trace.commandId,
      epoch: trace.epoch,
      ...(trace.executionStartedAt !== undefined && trace.executionClock !== undefined
        ? {
            startedAt: trace.executionStartedAt,
            elapsedMs: Math.max(0, Math.floor(performance.now() - trace.executionClock)),
            sessionPath: trace.sessionPath,
          }
        : {}),
    };
  }

  private startPromptTrace(trace: PromptTrace, sessionManager = this.sessionManager, publish = true) {
    if (trace.started) return;
    trace.started = true;
    trace.executionStartedAt = Date.now();
    trace.executionClock = performance.now();
    trace.sessionPath = sessionManager.getSessionFile?.() ?? `current:${trace.sessionId}`;
    this.completedSessionTurns?.delete(JSON.stringify([trace.sessionPath, trace.sessionId]));
    trace.epoch = ++this.nextTurnEpoch;
    const activeTurn = this.activeTurnFromTrace(trace);
    if (activeTurn && publish) this.emit("turn_started", { ...activeTurn });
  }

  private settlePromptTrace(trace: PromptTrace, sessionManager = this.sessionManager, publish = true) {
    const activeTurn = this.activeTurnFromTrace(trace);
    if (!activeTurn) return;
    const settlement: TurnSettlement = {
      ...activeTurn,
      outcome:
        trace.outcome ?? "uncertain",
    };
    const key = this.turnKey(activeTurn);
    if (this.terminalTurnKeys.has(key)) return;
    this.terminalTurnKeys.add(key);
    if (activeTurn.startedAt !== undefined && activeTurn.elapsedMs !== undefined) {
      const timing: WebTurnTiming = {
        version: 1,
        sessionId: activeTurn.sessionId,
        commandId: activeTurn.commandId,
        epoch: activeTurn.epoch,
        startedAt: activeTurn.startedAt,
        finishedAt: Date.now(),
        elapsedMs: activeTurn.elapsedMs,
        outcome: settlement.outcome,
      };
      const result = settlement.outcome === "completed" && trace.resultMessage ? sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message === trace.resultMessage) : undefined;
      if (result) timing.resultEntryId = result.id;
      const receipts = this.completedSessionTurns ??= new Map();
      const identity = JSON.stringify([trace.sessionPath, trace.sessionId]);
      receipts.delete(identity);
      receipts.set(identity, { commandId: timing.commandId, finishedAt: timing.finishedAt, outcome: timing.outcome, ...(timing.resultEntryId ? { resultEntryId: timing.resultEntryId } : {}) });
      while (receipts.size > 500) receipts.delete(receipts.keys().next().value!);
      try {
        sessionManager.appendCustomEntry(WEB_TURN_TIMING_ENTRY, timing);
      } catch {
        // Optional display evidence must never change Pi's terminal outcome.
        traceWeb("turn_timing_persistence_failed", { commandId: activeTurn.commandId });
      }
    }
    this.turnAbortOperations.delete(key);
    while (this.terminalTurnKeys.size > 64) {
      const oldest = this.terminalTurnKeys.values().next().value;
      if (typeof oldest === "string") this.terminalTurnKeys.delete(oldest);
    }
    if (publish) this.emit("turn_settled", { ...settlement });
    for (const resolveSettlement of this.turnSettlementWaiters.get(key) ?? []) {
      resolveSettlement(settlement);
    }
    this.turnSettlementWaiters.delete(key);
  }

  private turnKey(turn: WebActiveTurn) {
    return `${turn.sessionId}\u0000${turn.commandId}\u0000${turn.epoch}`;
  }

  private removePromptTrace(trace: PromptTrace, session = this.runtime.session) {
    if (session !== this.runtime.session) {
      const traces = this.suspendedPromptTraces?.get(session);
      if (!traces) return;
      const index = traces.pending.indexOf(trace);
      if (index !== -1) traces.pending.splice(index, 1);
      if (traces.active === trace && !trace.started) traces.active = traces.pending.shift();
      return;
    }
    const pendingIndex = this.pendingPromptTraces.indexOf(trace);
    if (pendingIndex !== -1) this.pendingPromptTraces.splice(pendingIndex, 1);
    if (this.activePromptTrace !== trace) return;
    // A started trace can only be terminally projected by agent_settled.
    if (trace.started) return;
    this.activePromptTrace = this.pendingPromptTraces.shift();
  }

  private retainRuntimeReference(runtime: AgentSessionRuntime) {
    this.inFlightRuntimes.set(
      runtime,
      (this.inFlightRuntimes.get(runtime) ?? 0) + 1,
    );
  }

  private releaseRuntimeReference(runtime: AgentSessionRuntime) {
    const remaining = (this.inFlightRuntimes.get(runtime) ?? 1) - 1;
    if (remaining > 0) this.inFlightRuntimes.set(runtime, remaining);
    else this.inFlightRuntimes.delete(runtime);
    this.releaseRetainedRuntime(runtime);
  }

  private trackRuntimeOperation<T>(operation: Promise<T>) {
    const settlement = operation.then(
      () => undefined,
      () => undefined,
    );
    this.runtimeOperations.add(settlement);
    void settlement.then(() => this.runtimeOperations.delete(settlement));
    return operation;
  }

  private serializeControllerMutation<T>(operation: () => Promise<T>, historyFork = false) {
    if (!historyFork && this.historyForkPending)
      return Promise.reject(new WebRuntimeRequestError("Session fork is in progress. Keep your draft.", "SESSION_CONFLICT", 409));
    const result = (this.controllerMutation ?? Promise.resolve()).then(() => {
      this.assertActive();
      return operation();
    });
    this.controllerMutation = result.then(
      () => undefined,
      () => undefined,
    );
    return this.trackRuntimeOperation(result);
  }

  private disposeAgentRuntime(runtime: AgentSessionRuntime) {
    const existing = this.runtimeDisposalPromises.get(runtime);
    if (existing) return existing;
    const disposal = Promise.resolve().then(() => runtime.dispose());
    this.runtimeDisposalPromises.set(runtime, disposal);
    this.runtimeDisposals.add(disposal);
    void disposal.catch(() => undefined);
    void disposal.then(
      () => this.runtimeDisposals.delete(disposal),
      (error) => {
        this.runtimeDisposals.delete(disposal);
        this.runtimeDisposalFailure ??= error;
        this.emit("runtime_dispose_failed", { error: errorText(error) });
      },
    );
    return disposal;
  }

  private retainRuntime(runtime: AgentSessionRuntime) {
    this.retainedRuntimes.add(runtime);
    const session = runtime.session;
    let progressTimer: ReturnType<typeof setTimeout> | undefined;
    const progress = () => {
      progressTimer = undefined;
      if (!this.retainedRuntimes.has(runtime)) return;
      this.emit("session_progress", {
        sessionId: session.sessionManager.getSessionId(),
        sessionPath: session.sessionManager.getSessionFile() ?? `current:${session.sessionManager.getSessionId()}`,
      });
    };
    const unsubscribe = session.subscribe((event) => {
      this.observeCompaction(session, event);
      const traces = this.suspendedPromptTraces?.get(session);
      if (traces) {
        if (event.type === "agent_start" || (event.type === "message_start" && event.message.role === "user")) {
          traces.active ??= traces.pending.shift();
          if (traces.active) this.startPromptTrace(traces.active, session.sessionManager, false);
        }
        if (traces.active) observePromptOutcome(traces.active, event);
        if (event.type === "agent_settled") {
          if (traces.active?.started) this.settlePromptTrace(traces.active, session.sessionManager, false);
          this.suspendedPromptTraces?.delete(session);
        }
      }
      if (event.type === "agent_settled") {
        clearTimeout(progressTimer);
        progress();
        this.releaseRetainedRuntime(runtime);
      } else if (["agent_start", "message_start", "message_end", "tool_execution_start", "tool_execution_end", "queue_update"].includes(event.type) && !progressTimer) {
        progressTimer = setTimeout(progress, 100);
        progressTimer.unref();
      }
    });
    this.retainedSubscriptions.set(runtime, () => { clearTimeout(progressTimer); unsubscribe(); });
    this.releaseRetainedRuntime(runtime);
  }

  private async promoteRetainedRuntime(runtime: AgentSessionRuntime) {
    const previous = this.runtime;
    this.retainedSubscriptions.get(runtime)?.();
    this.retainedSubscriptions.delete(runtime);
    this.retainedRuntimes.delete(runtime);
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
    this.switchPromptTraceOwner(previous.session, runtime.session);
    this.retainRuntime(previous);
    this.runtime = runtime;
    this.attachActiveSession(runtime, runtime.session);
  }

  private releaseRetainedRuntime(runtime: AgentSessionRuntime) {
    if (!this.retainedRuntimes.has(runtime)) return;
    if (runtime.session.isStreaming || this.inFlightRuntimes.has(runtime)) return;
    this.retainedSubscriptions.get(runtime)?.();
    this.retainedSubscriptions.delete(runtime);
    this.retainedRuntimes.delete(runtime);
    void this.disposeAgentRuntime(runtime);
  }

  private async activateCandidate(runtime: AgentSessionRuntime) {
    this.candidateRuntimes.add(runtime);
    try {
      await this.replaceRuntime(runtime);
    } finally {
      this.candidateRuntimes.delete(runtime);
    }
  }

  private async replaceRuntime(replacement: AgentSessionRuntime) {
    const previous = this.runtime;
    try {
      this.assertActive();
      await this.initializeRuntimeSession(replacement);
      this.assertActive();
      if (this.runtime !== previous) {
        throw new Error("The active Web runtime changed during replacement");
      }
    } catch (error) {
      try {
        await this.disposeAgentRuntime(replacement);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Failed to activate and dispose the replacement Web runtime",
        );
      }
      throw error;
    }
    this.runtime = replacement;
    try {
      this.attachActiveSession(replacement, replacement.session);
    } catch (error) {
      this.runtime = previous;
      try {
        await this.disposeAgentRuntime(replacement);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Failed to attach and dispose the replacement Web runtime",
        );
      }
      throw error;
    }
    this.switchPromptTraceOwner(previous.session, replacement.session);
    this.retainRuntime(previous);
  }

  private assertActive() {
    if (this.disposed) throw new Error("Web runtime is stopped");
  }

  private assertNoHistoryFork() {
    if (this.historyForkPending)
      throw new WebRuntimeRequestError("Session fork is in progress. Keep your draft.", "SESSION_CONFLICT", 409);
  }

  private assertWorkspaceSelected() {
    if (this.hasSelectedWorkspace) return;
    throw new WebRuntimeRequestError(
      "Choose a workspace before using the Web runtime",
      "WORKSPACE_REQUIRED",
      409,
    );
  }

  private assertActiveRuntime(runtime: AgentSessionRuntime) {
    this.assertActive();
    if (runtime !== this.runtime) {
      this.releaseRetainedRuntime(runtime);
      throw new Error("A retained Web runtime cannot replace its Session");
    }
  }

  private switchPromptTraceOwner(previous: AgentSession, next: AgentSession) {
    const owners = this.suspendedPromptTraces ??= new WeakMap();
    if (this.activePromptTrace || this.pendingPromptTraces.length) owners.set(previous, { active: this.activePromptTrace, pending: [...this.pendingPromptTraces] });
    else owners.delete(previous);
    const incoming = owners.get(next);
    this.activePromptTrace = incoming?.active;
    this.pendingPromptTraces.splice(0, this.pendingPromptTraces.length, ...(incoming?.pending ?? []));
    owners.delete(next);
  }
}
