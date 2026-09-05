import { mkdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
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
  type WebPromptOptions,
  type WebPromptAdmissionReceipt,
  type WebRuntimeController,
  type WebRuntimeEvent,
  type WebSessionCreationOptions,
  type WebTurnCancellationOptions,
  type WebTurnCancellationResult,
  WebRuntimeRequestError,
} from "./types.ts";
import { projectMessage } from "../protocol/types.ts";
import { elapsed, traceWeb } from "../trace.ts";
import {
  applyHttpProxySettings,
  configureHttpDispatcher,
  type HttpDispatcherLease,
} from "../http-dispatcher.ts";
import {
  acquireWebHostLease,
  type WebHostLease,
} from "./web-host-lease.ts";

const STARTUP_TIMEOUT_MS = 15_000;
const TURN_CANCELLATION_SETTLEMENT_TIMEOUT_MS = 10_000;
const BOOTSTRAP_WORKSPACE_DIRECTORY = ".bootstrap-workspace";

type PromptTrace = {
  commandId: string;
  sessionId: string;
  startedAt: number;
  started: boolean;
  queued: boolean;
  userMessageObserved: boolean;
  epoch?: number;
  outcome?: "completed" | "cancelled" | "failed" | "uncertain";
};

type TurnSettlement = WebActiveTurn & {
  outcome: "completed" | "cancelled" | "failed" | "uncertain";
};

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
  private activePromptTrace?: PromptTrace;
  private readonly pendingPromptTraces: PromptTrace[] = [];
  private nextTurnEpoch = 0;
  private readonly terminalTurnKeys = new Set<string>();
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

  isIdle() {
    return !this.runtime.session.isStreaming;
  }

  getActiveTurn() {
    return this.activeTurnFromTrace(this.activePromptTrace);
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
    const current = this.runtime.session.model;
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

  setModel(
    provider: string,
    modelId: string,
    options?: WebModelSelectionOptions,
  ) {
    return this.serializeControllerMutation(() =>
      this.applyModelSelection(provider, modelId, options),
    );
  }

  private async applyModelSelection(
    provider: string,
    modelId: string,
    options?: WebModelSelectionOptions,
  ) {
    this.assertActive();
    this.assertWorkspaceSelected();
    const agentRuntime = this.runtime;
    if (
      options?.expectedSessionId !== undefined &&
      options.expectedSessionId !==
        agentRuntime.session.sessionManager.getSessionId()
    ) {
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

  async sendPrompt(content: string, options?: WebPromptOptions) {
    this.assertActive();
    this.assertWorkspaceSelected();
    const agentRuntime = this.runtime;
    const session = agentRuntime.session;
    const sessionId = session.sessionManager.getSessionId();
    if (
      options?.expectedSessionId !== undefined &&
      options.expectedSessionId !== sessionId
    ) {
      throw new WebRuntimeRequestError(
        "Only the active Web session accepts messages",
        "SESSION_CONFLICT",
        409,
      );
    }
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
      let preflightObserved = false;
      let admitted = false;
      let agentLifecycleStarted = false;
      let queuedForAgent = false;
      let unsubscribePromptLifecycle: (() => void) | undefined;
      try {
        await previousAdmission;
        this.assertActive();
        if (promptTrace && agentRuntime === this.runtime) {
          this.pendingPromptTraces.push(promptTrace);
          this.activePromptTrace ??= this.pendingPromptTraces.shift();
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
        let followUpMessages = session.getFollowUpMessages().length;
        unsubscribePromptLifecycle = session.subscribe((event) => {
          if (event.type === "agent_start") agentLifecycleStarted = true;
          if (event.type === "queue_update") {
            if (event.followUp.length > followUpMessages) {
              queuedForAgent = true;
              if (promptTrace) promptTrace.queued = true;
            }
            followUpMessages = event.followUp.length;
          }
        });
        await session.prompt(content, {
          ...(session.isStreaming
            ? { streamingBehavior: "followUp" as const }
            : {}),
          source: "rpc",
          preflightResult: (accepted) => {
            preflightObserved = true;
            admitted = accepted;
            releaseAdmission();
            if (promptTrace) {
              traceWeb(
                accepted
                  ? "prompt_preflight_accepted"
                  : "prompt_preflight_rejected",
                {
                  commandId: promptTrace.commandId,
                  sessionId,
                  elapsedMs: elapsed(startedAt),
                },
              );
            }
            if (accepted) {
              resolveRequest({
                pendingFollowUps: session.getFollowUpMessages().length,
              });
            } else {
              rejectRequest(
                new WebRuntimeRequestError(
                  "Prompt was rejected before admission",
                  "PROMPT_REJECTED",
                  422,
                ),
              );
            }
          },
        });
        unsubscribePromptLifecycle();
        unsubscribePromptLifecycle = undefined;
        if (!preflightObserved || !admitted) {
          rejectRequest(
            new WebRuntimeRequestError(
              preflightObserved
                ? "Prompt was rejected before admission"
                : "Pi completed the prompt without confirming admission",
              "PROMPT_REJECTED",
              422,
            ),
          );
        }
        if (
          admitted &&
          options?.commandId &&
          !agentLifecycleStarted &&
          !queuedForAgent
        ) {
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
          if (!promptTrace.queued && !promptTrace.started) {
            this.removePromptTrace(promptTrace);
          }
        }
      } catch (error) {
        releaseAdmission();
        if (!admitted) {
          rejectRequest(
            new WebRuntimeRequestError(
              errorText(error),
              "PROMPT_REJECTED",
              422,
            ),
          );
        } else if (admitted) {
          this.emit("prompt_failed", {
            ...(options?.commandId ? { commandId: options.commandId } : {}),
            sessionId,
            error: errorText(error),
          });
        }
        if (promptTrace) {
          promptTrace.outcome = "failed";
          traceWeb("prompt_operation_failed", {
            commandId: promptTrace.commandId,
            sessionId,
            elapsedMs: elapsed(startedAt),
            error: errorText(error),
          });
          this.removePromptTrace(promptTrace);
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

  newSession(workspacePath: string, options?: WebSessionCreationOptions) {
    return this.serializeControllerMutation(() =>
      this.createNewSession(workspacePath, options),
    );
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
    const sessionPath = this.runtime.session.sessionManager.getSessionFile();
    this.emit("session_switched", {
      ...(options?.commandId ? { commandId: options.commandId } : {}),
      ...(sessionPath ? { sessionPath } : {}),
    });
    return {
      cancelled: false,
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
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
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
      const services = await createAgentSessionServices({
        cwd: options.cwd,
        agentDir: options.agentDir,
        settingsManager,
        modelRuntimeSignal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
      });
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
        sessionManager: options.sessionManager,
        sessionStartEvent: options.sessionStartEvent,
      });
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
    await session.bindExtensions({ mode: "print" });
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
          eventDetail.errorMessage = message.errorMessage;
        }
      }
      if (event.type === "auto_retry_start") {
        eventDetail.attempt = event.attempt;
        eventDetail.maxAttempts = event.maxAttempts;
        eventDetail.delayMs = event.delayMs;
        eventDetail.errorMessage = event.errorMessage;
      }
      if (event.type === "auto_retry_end") {
        eventDetail.attempt = event.attempt;
        eventDetail.success = event.success;
        if (event.finalError) eventDetail.finalError = event.finalError;
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
      case "auto_retry_start":
        this.emit(event.type, {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
        });
        break;
      case "message_start":
        this.liveMessageKey = `live-${++this.liveMessageSequence}`;
        this.emit(event.type, {
          message: projectMessage(event.message),
          messageKey: this.liveMessageKey,
        });
        break;
      case "message_update":
      case "message_end":
        if (
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          this.activePromptTrace
        ) {
          // Preserve the terminal model result for classification, but defer
          // publication until Pi confirms the entire run is settled.
          const outcome =
            event.message.stopReason === "aborted"
              ? "cancelled"
              : event.message.stopReason === "error"
                ? "failed"
                : event.message.stopReason === "stop" ||
                    event.message.stopReason === "length"
                  ? "completed"
                  : undefined;
          // A later queued continuation must not erase proof that the
          // provider result targeted by Stop was aborted. The control remains
          // owned until agent_settled; this outcome does not claim that every
          // queued follow-up in the same Pi execution was cancelled.
          if (outcome && this.activePromptTrace.outcome !== "cancelled") {
            this.activePromptTrace.outcome = outcome;
          }
        }
        this.emit(event.type, {
          message: projectMessage(event.message),
          ...(this.liveMessageKey ? { messageKey: this.liveMessageKey } : {}),
        });
        if (event.type === "message_end") this.liveMessageKey = undefined;
        break;
      case "tool_execution_start":
      case "tool_execution_end":
        this.emit(event.type, {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          ...(event.type === "tool_execution_end"
            ? { isError: event.isError }
            : {}),
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
    };
  }

  private startPromptTrace(trace: PromptTrace) {
    if (trace.started) return;
    trace.started = true;
    trace.epoch = ++this.nextTurnEpoch;
    const activeTurn = this.activeTurnFromTrace(trace);
    if (activeTurn) this.emit("turn_started", { ...activeTurn });
  }

  private settlePromptTrace(trace: PromptTrace) {
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
    this.turnAbortOperations.delete(key);
    while (this.terminalTurnKeys.size > 64) {
      const oldest = this.terminalTurnKeys.values().next().value;
      if (typeof oldest === "string") this.terminalTurnKeys.delete(oldest);
    }
    this.emit("turn_settled", { ...settlement });
    for (const resolveSettlement of this.turnSettlementWaiters.get(key) ?? []) {
      resolveSettlement(settlement);
    }
    this.turnSettlementWaiters.delete(key);
  }

  private turnKey(turn: WebActiveTurn) {
    return `${turn.sessionId}\u0000${turn.commandId}\u0000${turn.epoch}`;
  }

  private removePromptTrace(trace: PromptTrace) {
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

  private serializeControllerMutation<T>(operation: () => Promise<T>) {
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
    const unsubscribe = runtime.session.subscribe((event) => {
      if (event.type !== "agent_settled") return;
      this.emit("session_progress", {
        sessionId: runtime.session.sessionManager.getSessionId(),
      });
      this.releaseRetainedRuntime(runtime);
    });
    this.retainedSubscriptions.set(runtime, unsubscribe);
    this.releaseRetainedRuntime(runtime);
  }

  private async promoteRetainedRuntime(runtime: AgentSessionRuntime) {
    const previous = this.runtime;
    this.retainedSubscriptions.get(runtime)?.();
    this.retainedSubscriptions.delete(runtime);
    this.retainedRuntimes.delete(runtime);
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
    this.resetPromptTraces();
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
    this.resetPromptTraces();
    this.retainRuntime(previous);
  }

  private assertActive() {
    if (this.disposed) throw new Error("Web runtime is stopped");
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

  private resetPromptTraces() {
    this.activePromptTrace = undefined;
    this.pendingPromptTraces.length = 0;
    this.turnAbortOperations.clear();
  }
}
