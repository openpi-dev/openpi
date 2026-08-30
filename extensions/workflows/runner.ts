/**
 * Workflow subagent runner.
 *
 * Each `agent()` call in a workflow script becomes one isolated in-process
 * AgentSession created here: in-memory session, normal trust-aware resources
 * and extensions, recursive orchestration/user-prompt tools denied, and an
 * optional one-shot `structured_output` tool when a schema is supplied.
 *
 * `runAgent()` never throws: every failure mode (session creation, provider
 * errors, aborts, missing structured output) settles into an `AgentOutcome`.
 */

import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { AgentToolRenderLedger } from "../shared/agent-tool-renderer.ts";
import {
  bindChildSessionExtensions,
  childToolPolicy,
  createChildResources,
  shutdownAndDisposeChildSession,
} from "../shared/child-session.ts";
import { createToolCallTimeoutGuard } from "../shared/tool-call-timeout.ts";
import { type AgentUsage, emptyUsage, type TranscriptEntry } from "./model.ts";
import {
  buildWorkflowAgentPrompt,
  STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION,
  STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
} from "./prompt.ts";
import {
  AgentProgressProjection,
  type ProgressAssistantMessage,
  transcriptFromMessages,
} from "./progress-projection.ts";
import {
  createReplayFilesystemBoundary,
  type ReplayFilesystemBoundaryOptions,
} from "./replay-safety.ts";
import { truncateUtf8 } from "./serialization.ts";
import { bindWorkflowToolRenderer } from "./tool-renderer.ts";

const AGENT_OUTPUT_MAX_BYTES = 64 * 1024;
export const MODEL_PROGRESS_TIMEOUT_MS = 45_000;

export type WorkflowModel = NonNullable<ExtensionContext["model"]>;
export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;
type AgentMessage = AgentSession["messages"][number];
type ToolTimingEvent = Extract<
  AgentSessionEvent,
  { type: "tool_execution_start" | "tool_execution_end" }
>;

export interface ToolExecutionTiming {
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface AgentOutcome {
  ok: boolean;
  /** Final assistant text (may be empty when only structured output was produced). */
  output: string;
  /** Captured structured_output payload when a schema was supplied. */
  structured?: unknown;
  error?: string;
  aborted: boolean;
  usage: AgentUsage;
  model?: string;
  contextWindow?: number;
  transcript: TranscriptEntry[];
}

export interface AgentProgress {
  preview: string;
  usage: AgentUsage;
  model?: string;
  contextWindow?: number;
  transcript: TranscriptEntry[];
}

export type WorkflowAgentSessionFactory = (
  options: Parameters<typeof createAgentSession>[0],
) => Promise<{ session: AgentSession }>;

export interface RunAgentOptions {
  prompt: string;
  schema?: unknown;
  model?: WorkflowModel;
  thinkingLevel?: ThinkingLevel;
  cwd: string;
  loader: DefaultResourceLoader;
  settingsManager: SettingsManager;
  /** Optional per-run manager reused by one logical workflow operator. */
  sessionManager?: SessionManager;
  modelRegistry: ExtensionContext["modelRegistry"];
  /** Agent Type allowlist; childToolPolicy can only narrow capabilities. */
  tools?: readonly string[];
  signal?: AbortSignal;
  onProgress?: (progress: AgentProgress) => void;
  /** Canonical repository boundary required before this call can be journaled. */
  replayFilesystemBoundary?: ReplayFilesystemBoundaryOptions;
  /** Test-only override for the per-tool execution timeout. */
  toolCallTimeoutMs?: number;
  /** Test-only override for the per-provider-turn model-progress timeout. */
  modelProgressTimeoutMs?: number;
  /** Test-only override for the end-to-end abort/shutdown deadline. */
  shutdownTimeoutMs?: number;
  /** Test seam for lifecycle races; production always uses createAgentSession. */
  sessionFactory?: WorkflowAgentSessionFactory;
}

/** Build a fresh extension runtime for each concurrent workflow child. */
export function createWorkflowResources(
  cwd: string,
  variant: "plain" | "structured",
  projectTrusted: boolean,
  agentTypePrompt?: string,
) {
  const appendSystemPrompt = [
    ...(agentTypePrompt ? [agentTypePrompt] : []),
    ...(variant === "structured" ? [STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION] : []),
  ];
  return createChildResources({
    cwd,
    projectTrusted,
    ...(appendSystemPrompt.length > 0 ? { appendSystemPrompt } : {}),
  });
}

export function workflowChildTools(
  tools: readonly string[] | undefined,
  structured: boolean,
) {
  return tools
    ? [...new Set([...tools, ...(structured ? ["structured_output"] : [])])]
    : undefined;
}

interface WorkflowToolSession {
  getAllTools(): Array<{
    name: string;
    sourceInfo?: { path: string; source: string; origin: string };
  }>;
  getToolDefinition(name: string): ToolDefinition | undefined;
  subscribe(listener: AgentSessionEventListener): () => void;
}

/** Guard current tools and tools registered by extensions at later agent starts. */
export function guardWorkflowChildTools(
  session: WorkflowToolSession,
  timeoutMs?: number,
  replayFilesystemBoundary?: ReplayFilesystemBoundaryOptions,
) {
  const boundary = replayFilesystemBoundary
    ? createReplayFilesystemBoundary(replayFilesystemBoundary)
    : undefined;
  const timeout = createToolCallTimeoutGuard(timeoutMs);
  const apply = () => {
    // Keep the replay boundary outermost: if the timeout rejects before a
    // cooperative tool finishes aborting, path revalidation still completes
    // before the child can use or journal the timeout result.
    timeout.apply(session);
    boundary?.apply(session);
  };
  apply();
  return session.subscribe((event) => {
    if (event.type === "agent_start") apply();
  });
}

function isJsonSchema(value: unknown): value is TSchema {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const seen = new WeakSet<object>();
  let nodes = 0;
  const validate = (current: unknown, depth: number): boolean => {
    if (++nodes > 10_000 || depth > 24) return false;
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return true;
    }
    if (typeof current === "number") return Number.isFinite(current);
    if (Array.isArray(current)) {
      return current.every((item) => validate(item, depth + 1));
    }
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);
    return Object.keys(current).every((key) => {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        return false;
      }
      return validate((current as Record<string, unknown>)[key], depth + 1);
    });
  };
  return validate(value, 0);
}

/** Preserve the caller's full JSON Schema instead of lossy keyword conversion. */
function jsonSchemaToTypebox(schema: unknown): TSchema {
  if (!isJsonSchema(schema)) {
    throw new Error("structured output schema must be a bounded JSON object");
  }
  return Type.Unsafe(schema);
}

/**
 * One-shot terminating tool injected when a schema is supplied: the subagent
 * calls it as its final action and we capture the validated object.
 */
function makeStructuredOutputTool(
  schema: unknown,
  capture: (value: unknown) => void,
): ToolDefinition {
  return defineTool({
    name: "structured_output",
    label: "Structured Output",
    description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
    parameters: jsonSchemaToTypebox(schema),
    async execute(_toolCallId, params) {
      capture(params);
      return {
        content: [{ type: "text", text: "Recorded structured result." }],
        details: params,
        terminate: true,
      };
    },
  });
}

type AssistantMessage = ProgressAssistantMessage;

export { transcriptFromMessages };

export interface AssistantSettlement {
  stopReason: AssistantMessage["stopReason"];
  errorMessage?: string;
}

/**
 * Observe assistant message_end events instead of rescanning mutable Pi state:
 * overflow recovery temporarily removes the failed assistant from that state.
 */
export function observeAssistantSettlement(
  previous: AssistantSettlement | undefined,
  message: AgentMessage | undefined,
) {
  if (message?.role !== "assistant") return previous;
  return {
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
  };
}

export function agentFailureMessage(
  settlement: AssistantSettlement | undefined,
  promptErrorMessage?: string,
) {
  if (
    settlement?.stopReason !== "error" &&
    settlement?.errorMessage === undefined &&
    promptErrorMessage === undefined
  ) {
    return undefined;
  }
  return settlement?.errorMessage ?? promptErrorMessage ?? "Agent failed";
}

/** Record lifecycle timings without inferring completion from message timestamps. */
export function recordToolExecutionTiming(
  timings: Map<string, ToolExecutionTiming>,
  event: ToolTimingEvent,
  observedAt = Date.now(),
) {
  const previous = timings.get(event.toolCallId);
  if (event.type === "tool_execution_start") {
    if (previous?.startedAt !== undefined) return;
    timings.set(event.toolCallId, { ...previous, startedAt: observedAt });
    return;
  }
  if (previous?.finishedAt !== undefined) return;
  const durationMs =
    previous?.startedAt === undefined
      ? undefined
      : Math.max(0, observedAt - previous.startedAt);
  timings.set(event.toolCallId, {
    ...previous,
    finishedAt: observedAt,
    ...(durationMs === undefined ? {} : { durationMs }),
  });
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    16 * 1024,
  );
}

function formatTimeout(timeoutMs: number) {
  return timeoutMs % 1_000 === 0
    ? `${timeoutMs / 1_000} seconds`
    : `${timeoutMs} ms`;
}

export function resolveModelProgressTimeoutMs(
  settingsManager: SettingsManager,
  override?: number,
) {
  if (override !== undefined) return override;
  const configured =
    settingsManager.getProjectSettings().httpIdleTimeoutMs ??
    settingsManager.getGlobalSettings().httpIdleTimeoutMs;
  return typeof configured === "number" && Number.isFinite(configured)
    ? Math.max(MODEL_PROGRESS_TIMEOUT_MS, Math.floor(configured))
    : MODEL_PROGRESS_TIMEOUT_MS;
}

/** Abort any provider turn that stops producing model-visible progress. */
export function createModelProgressWatchdog(
  onTimeout: (error: Error) => Promise<unknown>,
  options: { timeoutMs?: number; model?: string } = {},
) {
  const timeoutMs = options.timeoutMs ?? MODEL_PROGRESS_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeTurn = false;
  let closed = false;
  let rejectTimeout!: (error: Error) => void;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    clear();
    if (!activeTurn || closed) return;
    // This timer owns the awaited watchdog outcome. Keep it referenced so a
    // short-lived Node 22 process cannot exit with the promise still pending.
    timer = setTimeout(() => {
      timer = undefined;
      activeTurn = false;
      closed = true;
      const model = options.model ? ` for ${options.model}` : "";
      const error = new Error(
        `Agent provider turn${model} produced no model-visible progress for ${formatTimeout(timeoutMs)}; the provider request may be stalled. Retry the workflow.`,
      );
      rejectTimeout(error);
      try {
        void onTimeout(error).catch(() => {});
      } catch {
        // The timeout result remains authoritative even if abort throws before
        // returning its promise; bounded shutdown below gets another chance.
      }
    }, timeoutMs);
  };
  const armTurn = () => {
    if (closed) return;
    activeTurn = true;
    schedule();
  };
  const markProgress = () => {
    if (!activeTurn || closed) return;
    schedule();
  };
  const completeTurn = () => {
    activeTurn = false;
    clear();
  };
  const cancel = () => {
    closed = true;
    activeTurn = false;
    clear();
  };

  return {
    armTurn,
    markProgress,
    completeTurn,
    cancel,
    async waitFor<T>(operation: Promise<T>) {
      try {
        return await Promise.race([operation, timeout]);
      } finally {
        cancel();
      }
    },
  };
}

function isModelVisibleProgress(event: AgentSessionEvent) {
  if (event.type !== "message_update" || event.message.role !== "assistant") {
    return false;
  }
  // Raw transport heartbeats never become AgentSession events. Empty stream,
  // text, and thinking starts likewise cannot keep a provider turn alive.
  const update = event.assistantMessageEvent;
  if (
    update.type === "text_delta" ||
    update.type === "thinking_delta" ||
    update.type === "toolcall_delta"
  ) {
    return update.delta.length > 0;
  }
  if (update.type === "text_end" || update.type === "thinking_end") {
    return update.content.length > 0;
  }
  return update.type === "toolcall_start" || update.type === "toolcall_end";
}

export async function runAgent(
  options: RunAgentOptions,
): Promise<AgentOutcome> {
  let structured: unknown;
  let settled = false;
  let customTools: ToolDefinition[] | undefined;
  let session: AgentSession | undefined;
  let unsubscribeToolGuards: (() => void) | undefined;
  let aborted = false;
  let terminalCause: "abort" | "model-progress-timeout" | undefined;
  let modelProgressTimeoutMessage: string | undefined;
  let abortOperation: Promise<unknown> | undefined;
  let rejectForAbort: ((error: Error) => void) | undefined;
  let rejectForProjectionFailure: ((error: Error) => void) | undefined;
  const abortRace = new Promise<never>((_resolve, reject) => {
    rejectForAbort = reject;
  });
  const projectionFailureRace = new Promise<never>((_resolve, reject) => {
    rejectForProjectionFailure = reject;
  });
  // The same promise covers startup and prompting. Keep it observed even when
  // a pre-aborted run returns before either race is installed.
  void abortRace.catch(() => {});
  void projectionFailureRace.catch(() => {});
  const abortError = () =>
    options.signal?.reason instanceof Error
      ? options.signal.reason
      : new Error("Agent was aborted");
  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    terminalCause ??= "abort";
    if (session) {
      try {
        abortOperation ??= session.abort();
        void abortOperation.catch(() => {});
      } catch (error) {
        abortOperation = Promise.reject(error);
        void abortOperation.catch(() => {});
      }
    }
    rejectForAbort?.(abortError());
  };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    customTools =
      options.schema !== undefined
        ? [
            makeStructuredOutputTool(options.schema, (value) => {
              if (!settled) structured = value;
            }),
          ]
        : undefined;
    const childTools = workflowChildTools(
      options.tools,
      customTools !== undefined,
    );
    if (aborted) throw abortError();
    const sessionCreation = (options.sessionFactory ?? createAgentSession)({
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.thinkingLevel
        ? { thinkingLevel: options.thinkingLevel }
        : {}),
      resourceLoader: options.loader,
      settingsManager: options.settingsManager,
      sessionManager:
        options.sessionManager ?? SessionManager.inMemory(options.cwd),
      ...(customTools ? { customTools } : {}),
      ...childToolPolicy(childTools),
    });
    // Promise.race cannot cancel the factory. If cancellation wins, retain
    // ownership of a late session and dispose it without re-entering startup.
    void sessionCreation
      .then(
        ({ session: lateSession }) => {
          if (!aborted) return;
          return shutdownAndDisposeChildSession(lateSession, {
            abort: true,
            timeoutMs: options.shutdownTimeoutMs,
          });
        },
        () => undefined,
      )
      .catch(() => {});
    ({ session } = await Promise.race([sessionCreation, abortRace]));
    if (aborted) throw abortError();
    await Promise.race([
      bindChildSessionExtensions(session, childTools),
      abortRace,
    ]);
    if (aborted) throw abortError();
    unsubscribeToolGuards = guardWorkflowChildTools(
      session,
      options.toolCallTimeoutMs,
      options.replayFilesystemBoundary,
    );
  } catch (error) {
    settled = true;
    unsubscribeToolGuards?.();
    options.signal?.removeEventListener("abort", onAbort);
    const cleanup = session
      ? await shutdownAndDisposeChildSession(session, {
          abort: true,
          abortOperation,
          timeoutMs: options.shutdownTimeoutMs,
        })
      : undefined;
    const cleanupError = cleanup?.errors.join("; ");
    if (aborted) {
      return {
        ok: false,
        output: "",
        error: cleanupError
          ? `Agent was aborted; Cleanup failed: ${cleanupError}`
          : "Agent was aborted",
        aborted: true,
        usage: emptyUsage(),
        model: options.model?.id,
        contextWindow: options.model?.contextWindow,
        transcript: [],
      };
    }
    return {
      ok: false,
      output: "",
      error: `Failed to create agent session: ${errorText(error)}${cleanupError ? `; cleanup failed: ${cleanupError}` : ""}`,
      aborted: false,
      usage: emptyUsage(),
      model: options.model?.id,
      contextWindow: options.model?.contextWindow,
      transcript: [],
    };
  }

  const childSession = session;
  const toolRenderer = new AgentToolRenderLedger();
  let usage = emptyUsage();
  let modelId = childSession.model?.id ?? options.model?.id;
  let contextWindow = childSession.model?.contextWindow;
  let assistantSettlement: AssistantSettlement | undefined;
  let promptErrorMessage: string | undefined;
  const toolTimings = new Map<string, ToolExecutionTiming>();

  const captureToolRenderData = (messages: readonly AgentMessage[]) => {
    for (const message of messages) {
      if (message.role === "assistant") {
        for (const part of message.content) {
          if (part.type !== "toolCall") continue;
          toolRenderer.start(
            part.id,
            part.name,
            part.arguments,
            childSession.getToolDefinition(part.name),
          );
        }
      } else if (message.role === "toolResult") {
        toolRenderer.end(
          message.toolCallId,
          message.toolName,
          message,
          message.isError,
        );
      }
    }
  };

  const refreshModel = (latestAssistant?: AssistantMessage) => {
    const sessionModel = childSession.model;
    modelId = sessionModel?.id ?? modelId;
    contextWindow = sessionModel?.contextWindow ?? contextWindow;
    if (!latestAssistant) return;
    const responseMatchesSession =
      !sessionModel ||
      (latestAssistant.provider === sessionModel.provider &&
        latestAssistant.model === sessionModel.id);
    const reportedId = latestAssistant.responseModel ?? latestAssistant.model;
    const reportedModel = responseMatchesSession
      ? options.modelRegistry.find(latestAssistant.provider, reportedId)
      : undefined;
    if (reportedModel) {
      modelId = reportedModel.id;
      contextWindow = reportedModel.contextWindow;
    }
  };

  const sampleContextTokens = () => {
    const context = childSession.getContextUsage();
    if (
      typeof context?.contextWindow === "number" &&
      Number.isFinite(context.contextWindow) &&
      context.contextWindow > 0
    ) {
      contextWindow = context.contextWindow;
    }
    if (
      typeof context?.tokens === "number" &&
      Number.isFinite(context.tokens) &&
      context.tokens >= 0
    ) {
      return context.tokens;
    }
    return context?.tokens === null ? null : undefined;
  };

  const projection = new AgentProgressProjection();
  let lastProjection = projection.snapshot(toolTimings);

  const snapshotProjection = () => {
    const snapshot = projection.snapshot(toolTimings);
    usage = snapshot.usage;
    refreshModel(snapshot.latestAssistant);
    lastProjection = snapshot;
    return snapshot;
  };

  const reconcileProjection = () => {
    projection.replace(childSession.messages, sampleContextTokens());
    return snapshotProjection();
  };

  const emitProgress = () => {
    const snapshot = snapshotProjection();
    options.onProgress?.({
      preview: snapshot.preview,
      usage,
      model: modelId,
      contextWindow,
      transcript: bindWorkflowToolRenderer(snapshot.transcript, toolRenderer),
    });
  };

  let armModelProgress = () => {};
  let markModelProgress = () => {};
  let completeModelTurn = () => {};
  let cancelModelProgressWatchdog = () => {};
  let compactionReconcileQueued = false;
  const queueCompactionReconcile = () => {
    if (compactionReconcileQueued) return;
    compactionReconcileQueued = true;
    queueMicrotask(() => {
      compactionReconcileQueued = false;
      if (settled) return;
      // Pi may synchronously remove a restored overflow assistant immediately
      // after compaction_end. Read canonical state after that mutation.
      try {
        reconcileProjection();
        emitProgress();
      } catch (error) {
        promptErrorMessage ??= `Failed to reconcile agent progress after compaction: ${errorText(error)}`;
        rejectForProjectionFailure?.(new Error(promptErrorMessage));
        try {
          abortOperation ??= childSession.abort();
          void abortOperation.catch(() => {});
        } catch {
          // The projection failure remains authoritative; bounded cleanup gets
          // another chance to abort and dispose the child below.
        }
      }
    });
  };
  const unsubscribe = childSession.subscribe((event) => {
    if (settled) return;
    if (event.type === "turn_start") armModelProgress();
    if (event.type === "tool_execution_start") {
      toolRenderer.start(
        event.toolCallId,
        event.toolName,
        event.args,
        childSession.getToolDefinition(event.toolName),
      );
    } else if (event.type === "tool_execution_update") {
      toolRenderer.update(
        event.toolCallId,
        event.toolName,
        event.args,
        event.partialResult,
      );
    } else if (event.type === "tool_execution_end") {
      toolRenderer.end(
        event.toolCallId,
        event.toolName,
        event.result,
        event.isError,
      );
    }
    if (isModelVisibleProgress(event)) markModelProgress();
    if (event.type === "message_end" && event.message.role === "assistant") {
      completeModelTurn();
    }
    if (event.type === "message_end") {
      assistantSettlement = observeAssistantSettlement(
        assistantSettlement,
        event.message,
      );
      // Pi publishes the finalized message before tool lifecycle delivery.
      // Hydrate native rendering from this one message without reading history.
      captureToolRenderData([event.message]);
      projection.append(event.message);
    }
    if (
      event.type === "tool_execution_start" ||
      event.type === "tool_execution_end"
    ) {
      recordToolExecutionTiming(toolTimings, event);
    } else if (event.type === "compaction_end") {
      queueCompactionReconcile();
      return;
    } else if (event.type !== "message_end") {
      return;
    }
    emitProgress();
  });

  let output = "";
  let transcript: TranscriptEntry[] = [];
  let cleanupErrors: string[] = [];
  try {
    // Operator reuse may restore messages before this activation subscribes.
    // Hydrate both bounded projections once; ordinary progress never rescans it.
    projection.replace(childSession.messages, sampleContextTokens());
    captureToolRenderData(childSession.messages);
    snapshotProjection();
    if (!aborted) {
      const watchdog = createModelProgressWatchdog(
        (error) => {
          terminalCause ??= "model-progress-timeout";
          if (terminalCause === "model-progress-timeout") {
            modelProgressTimeoutMessage ??= error.message;
          }
          abortOperation ??= childSession.abort();
          void abortOperation.catch(() => {});
          return abortOperation;
        },
        {
          timeoutMs: resolveModelProgressTimeoutMs(
            options.settingsManager,
            options.modelProgressTimeoutMs,
          ),
          model: modelId,
        },
      );
      armModelProgress = watchdog.armTurn;
      markModelProgress = watchdog.markProgress;
      completeModelTurn = watchdog.completeTurn;
      cancelModelProgressWatchdog = watchdog.cancel;
      await Promise.race([
        watchdog.waitFor(
          childSession.prompt(buildWorkflowAgentPrompt(options.prompt)),
        ),
        abortRace,
        projectionFailureRace,
      ]);
    }
  } catch (error) {
    promptErrorMessage ??= errorText(error);
  } finally {
    cancelModelProgressWatchdog();
    options.signal?.removeEventListener("abort", onAbort);
    settled = true;
    unsubscribe();
    unsubscribeToolGuards?.();
    try {
      const finalProjection = reconcileProjection();
      output = truncateUtf8(finalProjection.preview, AGENT_OUTPUT_MAX_BYTES);
      transcript = bindWorkflowToolRenderer(
        finalProjection.transcript,
        toolRenderer,
      );
    } catch (error) {
      promptErrorMessage ??= `Failed to reconcile final agent progress: ${errorText(error)}`;
      // A broken canonical accessor must not prevent owned-session cleanup.
      // Preserve the last projection that was fully observed instead.
      try {
        output = truncateUtf8(lastProjection.preview, AGENT_OUTPUT_MAX_BYTES);
        transcript = bindWorkflowToolRenderer(
          lastProjection.transcript,
          toolRenderer,
        );
      } catch (fallbackError) {
        promptErrorMessage += `; failed to render last progress: ${errorText(fallbackError)}`;
      }
    }
    const cleanup = await shutdownAndDisposeChildSession(childSession, {
      abort: aborted || promptErrorMessage !== undefined,
      abortOperation,
      timeoutMs: options.shutdownTimeoutMs,
    });
    cleanupErrors = cleanup.errors;
  }

  const cleanupError =
    cleanupErrors.length > 0
      ? `Cleanup failed: ${cleanupErrors.join("; ")}`
      : undefined;

  if (
    terminalCause === "abort" ||
    (terminalCause === undefined &&
      assistantSettlement?.stopReason === "aborted")
  ) {
    return {
      ok: false,
      output,
      structured,
      error: cleanupError
        ? `Agent was aborted; ${cleanupError}`
        : "Agent was aborted",
      aborted: true,
      usage,
      model: modelId,
      contextWindow,
      transcript,
    };
  }

  const failureMessage =
    (terminalCause === "model-progress-timeout"
      ? modelProgressTimeoutMessage
      : agentFailureMessage(assistantSettlement, promptErrorMessage)) ??
    cleanupError;
  if (failureMessage !== undefined) {
    return {
      ok: false,
      output,
      structured,
      error: failureMessage,
      aborted: false,
      usage,
      model: modelId,
      contextWindow,
      transcript,
    };
  }

  if (options.schema !== undefined && structured === undefined) {
    return {
      ok: false,
      output,
      error:
        "Agent finished without calling structured_output; no structured result matching the schema was produced.",
      aborted: false,
      usage,
      model: modelId,
      contextWindow,
      transcript,
    };
  }

  if (options.schema === undefined && assistantSettlement === undefined) {
    return {
      ok: false,
      output,
      structured,
      error: "Agent finished without an assistant response.",
      aborted: false,
      usage,
      model: modelId,
      contextWindow,
      transcript,
    };
  }

  return {
    ok: true,
    output,
    structured,
    aborted: false,
    usage,
    model: modelId,
    contextWindow,
    transcript,
  };
}
