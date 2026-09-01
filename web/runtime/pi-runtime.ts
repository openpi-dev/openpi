import { realpath, stat } from "node:fs/promises";
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
import type { WebRuntimeController, WebRuntimeEvent } from "./types.ts";
import { projectMessage } from "../protocol/types.ts";
import { elapsed, traceWeb } from "../trace.ts";
import {
  applyHttpProxySettings,
  configureHttpDispatcher,
  type HttpDispatcherLease,
} from "../http-dispatcher.ts";

const STARTUP_TIMEOUT_MS = 15_000;

type PromptTrace = {
  commandId: string;
  sessionId: string;
  startedAt: number;
  started: boolean;
  queued: boolean;
};

const runtimeDispatcherLeases = new WeakMap<AgentSessionRuntime, HttpDispatcherLease>();

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
  private readonly inFlightRuntimes = new Set<AgentSessionRuntime>();
  private promptAdmission: Promise<void> = Promise.resolve();
  private activePromptTrace?: PromptTrace;
  private readonly pendingPromptTraces: PromptTrace[] = [];
  private liveMessageKey?: string;
  private liveMessageSequence = 0;
  private readonly webSessionDirectory: string;
  private disposed = false;

  private constructor(runtime: AgentSessionRuntime, webSessionDirectory: string) {
    this.runtime = runtime;
    this.webSessionDirectory = webSessionDirectory;
  }

  static async create(cwd: string) {
    const canonicalCwd = await canonicalDirectory(cwd);
    const webSessionDirectory = join(getAgentDir(), "web-sessions");
    const runtime = new PiWebRuntime(
      await PiWebRuntime.createRuntime(
        canonicalCwd,
        SessionManager.create(canonicalCwd, webSessionDirectory),
      ),
      webSessionDirectory,
    );
    await runtime.bindSession();
    return runtime;
  }

  get cwd() {
    return this.runtime.cwd;
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

  async setModel(provider: string, modelId: string) {
    const model = this.runtime.services.modelRuntime.getModel(provider, modelId);
    if (
      !model ||
      !this.runtime.services.modelRuntime
        .getAvailableSnapshot()
        .some((item) => item.provider === provider && item.id === modelId)
    ) {
      throw new Error("Model is not available");
    }
    await this.runtime.session.setModel(model);
    const selected = this.listModels().find((item) => item.current);
    if (!selected) throw new Error("Model selection was not confirmed");
    this.emit("model_select", { provider, modelId });
    return selected;
  }

  subscribe(listener: (event: WebRuntimeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async sendPrompt(
    content: string,
    trace?: { commandId: string; sessionId: string },
    expectedSessionId?: string,
  ) {
    this.assertActive();
    const requestedRuntime = this.runtime;
    const requestedSession = requestedRuntime.session;
    const requestedSessionId = requestedSession.sessionManager.getSessionId();
    if (
      expectedSessionId !== undefined &&
      expectedSessionId !== requestedSessionId
    ) {
      throw new Error("Web session is no longer active");
    }
    const previousAdmission = this.promptAdmission;
    let releaseAdmission: () => void = () => undefined;
    this.promptAdmission = new Promise<void>((resolveAdmission) => {
      releaseAdmission = resolveAdmission;
    });
    await previousAdmission.catch(() => undefined);
    try {
      this.assertActive();
      if (
        this.runtime !== requestedRuntime ||
        requestedSession.sessionManager.getSessionId() !== requestedSessionId
      ) {
        throw new Error("Web session changed before prompt admission");
      }
    } catch (error) {
      releaseAdmission();
      throw error;
    }
    const agentRuntime = requestedRuntime;
    const session = requestedSession;
    const startedAt = performance.now();
    const queued = session.isStreaming;
    const promptTrace: PromptTrace | undefined = trace
      ? { ...trace, startedAt, started: false, queued }
      : undefined;
    if (trace) {
      if (!promptTrace) throw new Error("Prompt trace was not created");
      this.pendingPromptTraces.push(promptTrace);
      this.activePromptTrace ??= this.pendingPromptTraces.shift();
      traceWeb("prompt_dispatch_started", {
        ...trace,
        chars: content.length,
        provider: session.model?.provider,
        modelId: session.model?.id,
      });
      traceWeb("prompt_preflight_started", {
        ...trace,
        elapsedMs: elapsed(startedAt),
      });
    }
    this.inFlightRuntimes.add(agentRuntime);
    await new Promise<void>((resolveAdmission, rejectAdmission) => {
      let admitted = false;
      let preflightReported = false;
      const operation = session.prompt(content, {
        ...(session.isStreaming
          ? { streamingBehavior: "followUp" as const }
          : {}),
        source: "rpc",
        preflightResult: (accepted) => {
          preflightReported = true;
          admitted = accepted;
          releaseAdmission();
          if (trace) {
            traceWeb(accepted ? "prompt_preflight_accepted" : "prompt_preflight_rejected", {
              ...trace,
              elapsedMs: elapsed(startedAt),
            });
          }
          if (accepted) resolveAdmission();
          else rejectAdmission(new Error("Prompt was rejected before admission"));
        },
      });
      void operation.then(
        () => {
          releaseAdmission();
          this.inFlightRuntimes.delete(agentRuntime);
          this.releaseRetainedRuntime(agentRuntime);
          if (trace) {
            traceWeb("prompt_operation_settled", {
              ...trace,
              elapsedMs: elapsed(startedAt),
            });
            if (promptTrace) {
              promptTrace.started =
                this.activePromptTrace?.commandId === trace.commandId
                  ? this.activePromptTrace.started
                  : promptTrace.started;
              if (!promptTrace.queued && !promptTrace.started) {
                this.removePromptTrace(promptTrace);
              }
            }
          }
          if (!preflightReported) {
            rejectAdmission(
              new Error("Prompt settled without preflight admission evidence"),
            );
          }
        },
        (error) => {
          releaseAdmission();
          this.inFlightRuntimes.delete(agentRuntime);
          this.releaseRetainedRuntime(agentRuntime);
          if (trace) {
            traceWeb("prompt_operation_failed", {
              ...trace,
              elapsedMs: elapsed(startedAt),
              error: errorText(error),
            });
            if (promptTrace) this.removePromptTrace(promptTrace);
          }
          if (!preflightReported) rejectAdmission(error);
          else if (admitted)
            this.emit("prompt_failed", { error: errorText(error) });
        },
      );
    });
  }

  async newSession(workspacePath: string) {
    this.assertActive();
    const cwd = await canonicalDirectory(workspacePath);
    const replacement = await PiWebRuntime.createRuntime(
      cwd,
      SessionManager.create(cwd, this.webSessionDirectory),
    );
    await this.replaceRuntime(replacement);
    return { cancelled: false };
  }

  async switchSession(sessionPath: string) {
    this.assertActive();
    if (this.runtime.session.sessionManager.getSessionFile() === sessionPath) {
      return { cancelled: false };
    }
    const retained = [...this.retainedRuntimes].find(
      (candidate) =>
        candidate.session.sessionManager.getSessionFile() === sessionPath,
    );
    if (retained) {
      await this.promoteRetainedRuntime(retained);
      this.emit("session_switched", { sessionPath });
      return { cancelled: false };
    }
    const sessionManager = SessionManager.open(
      sessionPath,
      this.webSessionDirectory,
    );
    const cwd = await canonicalDirectory(sessionManager.getCwd());
    const replacement = await PiWebRuntime.createRuntime(
      cwd,
      sessionManager,
    );
    await this.replaceRuntime(replacement);
    this.emit("session_switched", { sessionPath });
    return { cancelled: false };
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
    await this.runtime.session.abort();
    await this.disposeAgentRuntime(this.runtime);
    for (const retained of this.retainedRuntimes) {
      this.retainedSubscriptions.get(retained)?.();
      await retained.session.abort();
      await this.disposeAgentRuntime(retained);
    }
    this.retainedRuntimes.clear();
    this.retainedSubscriptions.clear();
    this.listeners.clear();
  }

  private static async createRuntime(
    cwd: string,
    sessionManager: SessionManager,
  ) {
    const agentDir = getAgentDir();
    const dispatcherLeases: HttpDispatcherLease[] = [];
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
      const dispatcherLease = configureHttpDispatcher(
        settingsManager.getHttpIdleTimeoutMs(),
      );
      dispatcherLeases.push(dispatcherLease);
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
        httpIdleTimeoutMs: dispatcherLease.timeoutMs,
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
      const dispatcherLease = dispatcherLeases.shift();
      if (!dispatcherLease) {
        throw new Error("HTTP dispatcher lease was not created");
      }
      runtimeDispatcherLeases.set(runtime, dispatcherLease);
      return runtime;
    } catch (error) {
      await Promise.all(dispatcherLeases.map((lease) => lease.release()));
      throw error;
    }
  }

  private async bindSession() {
    const session = this.runtime.session;
    const startedAt = performance.now();
    traceWeb("extensions_bind_started", {
      sessionId: session.sessionManager.getSessionId(),
      cwd: this.runtime.cwd,
    });
    await session.bindExtensions({ mode: "print" });
    traceWeb("extensions_bind_finished", {
      sessionId: session.sessionManager.getSessionId(),
      elapsedMs: elapsed(startedAt),
    });
    this.unsubscribeSession = session.subscribe((event) =>
      this.projectEvent(session, event),
    );
    this.runtime.setRebindSession(async (replacement) => {
      this.unsubscribeSession?.();
      await replacement.bindExtensions({ mode: "print" });
      this.unsubscribeSession = replacement.subscribe((event) =>
        this.projectEvent(replacement, event),
      );
    });
  }

  private projectEvent(session: AgentSession, event: AgentSessionEvent) {
    if (session !== this.runtime.session) return;
    if (event.type === "message_start" && event.message.role === "user") {
      if (!this.activePromptTrace) {
        this.activePromptTrace = this.pendingPromptTraces.shift();
      } else if (this.activePromptTrace.started && this.pendingPromptTraces.length > 0) {
        this.activePromptTrace = this.pendingPromptTraces.shift();
      }
      if (this.activePromptTrace) this.activePromptTrace.started = true;
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
      case "agent_settled":
        this.emit(event.type);
        if (
          event.type === "agent_settled" &&
          this.activePromptTrace?.started &&
          this.pendingPromptTraces.length === 0
        ) {
          this.activePromptTrace = undefined;
        }
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

  private removePromptTrace(trace: PromptTrace) {
    const pendingIndex = this.pendingPromptTraces.indexOf(trace);
    if (pendingIndex !== -1) this.pendingPromptTraces.splice(pendingIndex, 1);
    if (this.activePromptTrace !== trace) return;
    this.activePromptTrace = this.pendingPromptTraces.shift();
  }

  private async disposeAgentRuntime(runtime: AgentSessionRuntime) {
    try {
      await runtime.dispose();
    } finally {
      const dispatcherLease = runtimeDispatcherLeases.get(runtime);
      runtimeDispatcherLeases.delete(runtime);
      await dispatcherLease?.release();
    }
  }

  private retainRuntime(runtime: AgentSessionRuntime) {
    this.retainedRuntimes.add(runtime);
    const unsubscribe = runtime.session.subscribe((event) => {
      if (event.type !== "agent_settled") return;
      this.emit("session_progress", {
        sessionId: runtime.session.sessionManager.getSessionId(),
      });
      unsubscribe();
      this.retainedSubscriptions.delete(runtime);
      this.retainedRuntimes.delete(runtime);
      void this.disposeAgentRuntime(runtime);
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
    await this.bindSession();
  }

  private releaseRetainedRuntime(runtime: AgentSessionRuntime) {
    if (!this.retainedRuntimes.has(runtime)) return;
    if (runtime.session.isStreaming || this.inFlightRuntimes.has(runtime)) return;
    this.retainedSubscriptions.get(runtime)?.();
    this.retainedSubscriptions.delete(runtime);
    this.retainedRuntimes.delete(runtime);
    void this.disposeAgentRuntime(runtime);
  }

  private async replaceRuntime(replacement: AgentSessionRuntime) {
    const previous = this.runtime;
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
    this.resetPromptTraces();
    this.retainRuntime(previous);
    this.runtime = replacement;
    await this.bindSession();
  }

  private assertActive() {
    if (this.disposed) throw new Error("Web runtime is stopped");
  }

  private resetPromptTraces() {
    this.activePromptTrace = undefined;
    this.pendingPromptTraces.length = 0;
  }
}
