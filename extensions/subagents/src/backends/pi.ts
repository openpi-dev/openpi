/**
 * pi backend — real implementation over the pi SDK.
 *
 * Each subagent is an in-process `AgentSession` (a port of v1
 * subagents/manager.ts, reusing the shared child-session helpers in
 * extensions/shared/child-session.ts):
 * - real session files visible in /resume, child resources loaded per-cwd
 *   with trust gating, and the child tool denylist;
 * - `session.subscribe()` events translated to normalized SubagentEvents;
 * - send() steers a streaming run or starts a fresh prompt() when idle;
 * - interrupt clears the queue and aborts; closing the session scope emits
 *   the child session_shutdown hook and disposes the session.
 */

import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import { resolveAgentModel } from "../agent-types.ts";
import type { SubagentBackend, SubagentSession } from "../backend.ts";
import type {
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
  TranscriptPart,
} from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";
import { createToolCallTimeoutGuard } from "../../../shared/tool-call-timeout.ts";
import {
  bindChildSessionExtensions,
  CHILD_SHUTDOWN_TIMEOUT_MS,
  childToolPolicy,
  createChildResources,
  shutdownAndDisposeChildSession,
} from "../../../shared/child-session.ts";
import { reclaimWorktree } from "../../../shared/worktree.ts";
import { AgentToolRenderLedger } from "../../../shared/agent-tool-renderer.ts";

const DIRECT_WORKTREE_CLEANUP_TIMEOUT_MS = 4_000;
const PARTIAL_TEXT_MAX_LENGTH = 128 * 1_024;

// --- Model + effort resolution -----------------------------------------------

type ThinkingLevel = NonNullable<
  NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"]
>;

export type PiAgentSessionFactory = (
  options: Parameters<typeof createAgentSession>[0],
) => Promise<{ session: AgentSession }>;

export interface PiBackendOptions {
  /** Test seam for production-adapter lifecycle coverage. */
  readonly sessionFactory?: PiAgentSessionFactory;
  /** Test-only override for bounded child shutdown. */
  readonly shutdownTimeoutMs?: number;
}

// --- Event translation ----------------------------------------------------------

function messageRole(msg: unknown): Message["role"] | undefined {
  const role = (msg as { role?: string } | undefined)?.role;
  if (role === "user" || role === "assistant" || role === "toolResult")
    return role;
  return undefined;
}

function lastAssistantMessage(
  session: AgentSession,
): AssistantMessage | undefined {
  const messages = session.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (messageRole(msg) === "assistant") return msg as AssistantMessage;
  }
  return undefined;
}

function assistantText(message: AssistantMessage) {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function safeJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    return text === "{}" ? undefined : text.slice(0, 4_096);
  } catch {
    return undefined;
  }
}

/** First non-empty line of a tool result-ish value (v1 liveToolPreview). */
function toolPreview(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value
      .split("\n")
      .find((line) => line.trim())
      ?.trim();
  }
  if (!value || typeof value !== "object") return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") continue;
    const firstLine = record.text.split("\n").find((line) => line.trim());
    if (firstLine) return firstLine.trim();
  }
  return undefined;
}

function assistantParts(msg: AssistantMessage): TranscriptPart[] {
  const parts: TranscriptPart[] = [];
  for (const part of msg.content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "thinking") {
      parts.push({
        type: "thinking",
        text: part.redacted ? "" : part.thinking,
        redacted: part.redacted,
      });
    } else if (part.type === "toolCall") {
      parts.push({
        type: "toolCall",
        toolId: part.id,
        name: part.name,
        argsPreview: safeJson(part.arguments),
      });
    }
  }
  return parts;
}

function userText(msg: Message): string {
  const content = (msg as { content: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

// --- The session ------------------------------------------------------------------

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    4096,
  );
}

const makePiSession = (
  task: SpawnTask,
  options: PiBackendOptions,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const registry = task.parent.modelRegistry;
    if (!registry) {
      return yield* new SpawnError({
        message: "pi backend requires the parent session's model registry.",
      });
    }

    const model = yield* Effect.try({
      try: () =>
        resolveAgentModel(registry, task.model, task.parent.inheritedModel),
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });
    // pi's thinking levels ARE the shared reasoning-effort scale.
    const thinkingLevel = (task.reasoningEffort ??
      task.parent.inheritedThinkingLevel) as ThinkingLevel | undefined;

    const session = yield* Effect.tryPromise({
      try: async () => {
        const { loader, settingsManager } = await createChildResources({
          cwd: task.cwd,
          projectTrusted: task.parent.projectTrusted,
          ...(task.appendSystemPrompt
            ? { appendSystemPrompt: [...task.appendSystemPrompt] }
            : {}),
        });
        const { session } = await (
          options.sessionFactory ?? createAgentSession
        )({
          cwd: task.cwd,
          sessionManager: SessionManager.create(task.cwd),
          settingsManager,
          resourceLoader: loader,
          model,
          thinkingLevel,
          ...childToolPolicy(task.tools),
        });
        // Start child extension session hooks/resources in headless mode.
        // A rejection here would otherwise leak the freshly created session:
        // the scope finalizer that owns cleanup is only registered later.
        try {
          await bindChildSessionExtensions(session, task.tools);
        } catch (error) {
          await shutdownAndDisposeChildSession(session, {
            timeoutMs: options.shutdownTimeoutMs,
          });
          throw error;
        }
        return session;
      },
      catch: (error) => new SpawnError({ message: boundedError(error) }),
    });

    interface ActivePrompt {
      cancelled: boolean;
      lastAssistant?: AssistantMessage;
      finalText: string;
      liveText: string;
      partialTextAtCancel?: string;
      promise: Promise<void>;
    }

    interface PendingRestart {
      cancelled: boolean;
      terminalEmitted: boolean;
    }

    const state = {
      closed: false,
      /** prompt() rejection for the active run; folded into RunSettled. */
      runError: undefined as string | undefined,
      /** One terminal event per run: lifecycle, prompt-rejection, and abort
       * fallbacks can all race to settle; the first wins. */
      settled: false,
      /** Pi events have no run identity, so the exact prompt Promise is the
       * only safe lease for deciding when another run may start. */
      activePrompt: undefined as ActivePrompt | undefined,
      pendingRestart: undefined as PendingRestart | undefined,
    };

    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const emit = (event: SubagentEvent) => {
      Queue.offerUnsafe(events, event);
    };

    const toolTimeout = createToolCallTimeoutGuard();
    toolTimeout.apply(session);
    const toolRenderer = new AgentToolRenderLedger();

    const activeModel = (): Model<any> | undefined => {
      const sessionModel = session.model;
      const last = lastAssistantMessage(session);
      if (!last) return sessionModel;
      if (
        sessionModel &&
        (last.provider !== sessionModel.provider ||
          last.model !== sessionModel.id)
      ) {
        // The session changed models after this assistant response.
        return sessionModel;
      }
      return (
        registry.find(last.provider, last.responseModel ?? last.model) ??
        sessionModel
      );
    };

    const currentMeta = (): SubagentMeta => {
      const m = activeModel();
      return {
        backend: "pi",
        modelLabel: m ? `${m.provider}/${m.id}` : undefined,
        contextWindow: m?.contextWindow,
        sessionFilePath: session.sessionFile,
      };
    };

    const emitUsage = () => {
      const usage = session.getContextUsage();
      emit({
        _tag: "UsageChanged",
        tokens: usage?.tokens ?? undefined,
        contextWindow: activeModel()?.contextWindow ?? usage?.contextWindow,
      });
    };

    const settle = () => {
      if (state.settled) return;
      state.settled = true;
      const activePrompt = state.activePrompt;
      const last = activePrompt?.lastAssistant;
      const partialText =
        activePrompt?.liveText || activePrompt?.finalText || undefined;
      if (last?.stopReason === "aborted") {
        emit({
          _tag: "RunSettled",
          outcome: { _tag: "Interrupted", partialText },
        });
        return;
      }
      const errorText =
        state.runError ??
        (last?.stopReason === "error"
          ? (last.errorMessage ?? "Run failed")
          : undefined);
      if (errorText !== undefined) {
        emit({
          _tag: "RunSettled",
          outcome: {
            _tag: "Failed",
            errorText: boundedError(errorText),
            partialText,
          },
        });
        return;
      }
      emit({
        _tag: "RunSettled",
        outcome: {
          _tag: "Completed",
          finalText: activePrompt?.finalText ?? "",
        },
      });
    };

    const handleEvent = (event: AgentSessionEvent) => {
      if (state.closed) return;
      const activePrompt = state.activePrompt;
      if (!activePrompt) return;
      if (activePrompt.cancelled) {
        if (event.type === "agent_start") {
          // abort() can return during Pi's preflight while prompt() remains
          // pending. If that preflight later enters the agent lifecycle,
          // abort again before it can reach a provider or tool. Never reopen
          // the event gate: native events carry no generation identity.
          try {
            void session.abort().catch(() => undefined);
          } catch {
            // The original interrupt still owns bounded cleanup.
          }
        }
        return;
      }
      switch (event.type) {
        case "agent_start":
          // Extensions may register tools between runs; guard new ones too.
          toolTimeout.apply(session);
          state.settled = false;
          emit({ _tag: "RunStarted" });
          break;
        case "message_update": {
          const streamEvent = event.assistantMessageEvent;
          if (streamEvent.type === "text_delta") {
            activePrompt.liveText = (
              activePrompt.liveText + streamEvent.delta
            ).slice(-PARTIAL_TEXT_MAX_LENGTH);
            emit({
              _tag: "AssistantDelta",
              kind: "text",
              delta: streamEvent.delta,
            });
          } else if (streamEvent.type === "thinking_delta") {
            emit({
              _tag: "AssistantDelta",
              kind: "thinking",
              delta: streamEvent.delta,
            });
          }
          break;
        }
        case "message_end": {
          const role = messageRole(event.message);
          if (role === "user") {
            const text = userText(event.message as Message);
            if (text.trim()) emit({ _tag: "UserMessage", text });
          } else if (role === "assistant") {
            const assistant = event.message as AssistantMessage;
            activePrompt.lastAssistant = assistant;
            const text = assistantText(assistant);
            if (text) activePrompt.finalText = text;
            activePrompt.liveText = "";
            emit({
              _tag: "AssistantMessage",
              parts: assistantParts(assistant),
            });
            emitUsage();
            emit({ _tag: "MetaChanged", meta: currentMeta() });
          }
          // toolResult messages are covered by tool_execution_end.
          break;
        }
        case "tool_execution_start":
          toolRenderer.start(
            event.toolCallId,
            event.toolName,
            event.args,
            session.getToolDefinition(event.toolName),
          );
          emit({
            _tag: "ToolStart",
            toolId: event.toolCallId,
            name: event.toolName,
            argsPreview: safeJson(event.args),
          });
          break;
        case "tool_execution_update":
          toolRenderer.update(
            event.toolCallId,
            event.toolName,
            event.args,
            event.partialResult,
          );
          emit({
            _tag: "ToolUpdate",
            toolId: event.toolCallId,
            outputPreview: toolPreview(event.partialResult),
          });
          break;
        case "tool_execution_end":
          toolRenderer.end(
            event.toolCallId,
            event.toolName,
            event.result,
            event.isError,
          );
          emit({
            _tag: "ToolEnd",
            toolId: event.toolCallId,
            name: event.toolName,
            isError: event.isError,
            outputPreview: toolPreview(event.result),
          });
          break;
        case "queue_update":
          emit({
            _tag: "QueueChanged",
            queued: [
              ...event.steering.map((text) => ({
                text,
                kind: "steer" as const,
              })),
              ...event.followUp.map((text) => ({
                text,
                kind: "follow-up" as const,
              })),
            ],
          });
          break;
        case "agent_settled":
          settle();
          break;
      }
    };
    const unsubscribe = session.subscribe(handleEvent);

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        state.closed = true;
        unsubscribe();
        try {
          session.clearQueue();
        } catch {
          // Continue with abort/dispose.
        }
        await shutdownAndDisposeChildSession(session, {
          abort: true,
          timeoutMs: options.shutdownTimeoutMs ?? CHILD_SHUTDOWN_TIMEOUT_MS,
        });
        // A direct child can run multiple turns, so its worktree lives until
        // this session scope closes. Cleanup is fail-closed and shares a hard
        // deadline; unknown/dirty/ignored/detached work is preserved.
        if (task.worktree) {
          await reclaimWorktree(task.worktree.repoCwd, task.worktree, {
            timeoutMs: DIRECT_WORKTREE_CLEANUP_TIMEOUT_MS,
          }).catch(() => {});
        }
        Queue.endUnsafe(events);
      }),
    );

    /** Start a fresh run (v1 manager.run): fire-and-forget, errors -> events. */
    const startRun = (text: string) => {
      if (state.activePrompt) {
        throw new Error(
          "Cannot start a Pi prompt while another prompt is active.",
        );
      }
      const activePrompt: ActivePrompt = {
        cancelled: false,
        finalText: "",
        liveText: "",
        promise: Promise.resolve(),
      };
      state.activePrompt = activePrompt;
      state.runError = undefined;
      state.settled = false;
      emit({ _tag: "RunStarted" });
      let prompt: Promise<void>;
      try {
        prompt = session.prompt(text, {
          preflightResult: (accepted) => {
            if (accepted && (activePrompt.cancelled || state.closed)) {
              // This callback runs immediately before Pi enters
              // _runAgentPrompt. Throwing here is the only synchronous seam
              // that prevents a cancelled preflight from reviving after the
              // adapter subscription and worktree ownership are gone.
              throw new Error(
                "Subagent prompt was cancelled during preflight.",
              );
            }
          },
        });
      } catch (error) {
        prompt = Promise.reject(error);
      }
      activePrompt.promise = prompt
        .catch((error) => {
          if (
            state.closed ||
            state.activePrompt !== activePrompt ||
            activePrompt.cancelled
          ) {
            return;
          }
          state.runError = boundedError(error);
          // Preflight failures may never start the agent lifecycle, so no
          // agent_settled will arrive for them.
          if (!session.isStreaming) settle();
        })
        .finally(() => {
          if (state.activePrompt === activePrompt) {
            state.activePrompt = undefined;
          }
        });
    };

    // Session naming is best-effort.
    const kind =
      task.origin === "btw"
        ? "btw"
        : task.agentTypeName
          ? `subagent[${task.agentTypeName}]`
          : "subagent";
    yield* Effect.try(() =>
      session.sessionManager.appendSessionInfo(`${kind}: ${task.title}`),
    ).pipe(Effect.ignore);

    emit({ _tag: "MetaChanged", meta: currentMeta() });
    startRun(task.prompt);

    return {
      toolRenderer,
      meta: Effect.sync(currentMeta),
      events: Stream.fromQueue(events),
      send: (text) =>
        Effect.suspend((): Effect.Effect<void, SendError> => {
          if (state.closed) {
            return new SendError({ message: "Subagent session is closed." });
          }
          const pendingRestart = state.pendingRestart;
          if (pendingRestart) {
            return new SendError({
              message: pendingRestart.cancelled
                ? "Subagent cancellation is still in progress."
                : "A subagent restart is already pending.",
            });
          }
          const activePrompt = state.activePrompt;
          if (activePrompt?.cancelled) {
            return new SendError({
              message: "Subagent cancellation is still in progress.",
            });
          }
          if (activePrompt && session.isStreaming) {
            // Steer the active run via the SDK's queue; queue_update events
            // render it, message_end(user) lands it in the transcript. A
            // rejected steer is a real send failure, not a diagnostic.
            return Effect.tryPromise({
              try: () => session.steer(text),
              catch: (error) => new SendError({ message: boundedError(error) }),
            }).pipe(Effect.asVoid);
          }
          if (activePrompt && !state.settled) {
            return new SendError({
              message:
                "Subagent prompt is still starting; wait for it to run or settle before sending.",
            });
          }
          if (activePrompt) {
            // Pi emits agent_settled before prompt() resolves. Preserve the
            // same-session restart contract while closing that microtask gap
            // without ever overlapping two native prompts.
            const restart: PendingRestart = {
              cancelled: false,
              terminalEmitted: false,
            };
            state.pendingRestart = restart;
            return Effect.tryPromise({
              try: async (signal) => {
                const cancelPendingRestart = () => {
                  restart.cancelled = true;
                  if (state.pendingRestart === restart) {
                    state.pendingRestart = undefined;
                  }
                };
                signal.addEventListener("abort", cancelPendingRestart, {
                  once: true,
                });
                if (signal.aborted) cancelPendingRestart();
                try {
                  await activePrompt.promise;
                  if (state.closed) {
                    throw new Error("Subagent session is closed.");
                  }
                  if (restart.cancelled) {
                    // interrupt emits the terminal event for this accepted
                    // restart. Resolve the send without starting a prompt so
                    // the manager keeps its restarting marker until that
                    // terminal event is folded.
                    return;
                  }
                  state.pendingRestart = undefined;
                  startRun(text);
                } finally {
                  signal.removeEventListener("abort", cancelPendingRestart);
                  if (state.pendingRestart === restart) {
                    state.pendingRestart = undefined;
                  }
                }
              },
              catch: (error) => new SendError({ message: boundedError(error) }),
            }).pipe(Effect.asVoid);
          }
          return Effect.sync(() => startRun(text));
        }),
      interrupt: Effect.promise(async () => {
        if (state.closed) return;
        const pendingRestart = state.pendingRestart;
        if (pendingRestart) pendingRestart.cancelled = true;
        const activePrompt = state.activePrompt;
        if (activePrompt) {
          activePrompt.cancelled = true;
          activePrompt.partialTextAtCancel = pendingRestart
            ? undefined
            : activePrompt.liveText || activePrompt.finalText || undefined;
        }
        try {
          session.clearQueue();
        } catch {
          // Abort regardless.
        }
        await session.abort().catch(() => undefined);
        // isStreaming is false during Pi preflight, so it cannot prove the
        // invocation is quiescent. Wait for the exact prompt Promise instead;
        // the manager bounds this effect at 5s and force-disposes on timeout.
        await activePrompt?.promise;
        if (
          !state.closed &&
          pendingRestart &&
          !pendingRestart.terminalEmitted
        ) {
          pendingRestart.terminalEmitted = true;
          if (state.pendingRestart === pendingRestart) {
            state.pendingRestart = undefined;
          }
          state.settled = true;
          emit({ _tag: "RunSettled", outcome: { _tag: "Interrupted" } });
          return;
        }
        if (!state.closed && !state.settled) {
          state.settled = true;
          emit({
            _tag: "RunSettled",
            outcome: {
              _tag: "Interrupted",
              partialText: activePrompt?.partialTextAtCancel,
            },
          });
        }
      }),
    } satisfies SubagentSession;
  });

export const makePiBackend = (options: PiBackendOptions = {}) =>
  ({
    name: "pi",
    spawn: (task) => makePiSession(task, options),
  }) satisfies SubagentBackend;

export const piBackend = makePiBackend();
