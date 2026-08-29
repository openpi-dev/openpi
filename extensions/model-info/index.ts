import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  emptyModelInfoState,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
} from "../shared/dashboard-state.ts";
import { createSessionMetricsTracker } from "./session-metrics.ts";

const CHARS_PER_ESTIMATED_TOKEN = 4;
const LIVE_UPDATE_INTERVAL_MS = 200;

function estimateContentTokens(characters: number) {
  return Math.ceil(characters / CHARS_PER_ESTIMATED_TOKEN);
}

export default function modelInfo(pi: ExtensionAPI) {
  let state = emptyModelInfoState();
  let contentStreamStart: number | null = null;
  let lastContentDeltaAt: number | null = null;
  let contentCharacters = 0;
  let firstContentDeltaCharacters = 0;
  let contentDeltaCount = 0;
  let sawToolCall = false;
  let runContentTokens = 0;
  let runContentStreamMs = 0;
  let lastLiveUpdate = 0;
  let currentContext: ExtensionContext | undefined;
  const sessionMetrics = createSessionMetricsTracker();

  const publish = () => pi.events.emit(MODEL_INFO_CHANNEL, { ...state });

  function refresh(ctx: ExtensionContext) {
    currentContext = ctx;
    const model = ctx.model;
    const usage = ctx.getContextUsage();

    state = {
      ...state,
      provider: model?.provider ?? "",
      modelId: model?.id ?? "no-model",
      modelName: model?.name ?? model?.id ?? "No model",
      thinking: model?.reasoning ? pi.getThinkingLevel() : "off",
      contextTokens: usage?.tokens ?? null,
      contextWindow: usage?.contextWindow ?? model?.contextWindow ?? 0,
      contextPercent: usage?.percent ?? null,
    };
    publish();
  }

  function syncSessionMetrics(ctx: ExtensionContext) {
    state = { ...state, ...sessionMetrics.sync(ctx.sessionManager) };
  }

  function resetMessageTracking() {
    contentStreamStart = null;
    lastContentDeltaAt = null;
    contentCharacters = 0;
    firstContentDeltaCharacters = 0;
    contentDeltaCount = 0;
    sawToolCall = false;
    lastLiveUpdate = 0;
  }

  const stopRefreshListener = pi.events.on(REFRESH_CHANNEL, () => {
    if (currentContext) refresh(currentContext);
  });

  pi.on("session_start", (_event, ctx) => {
    resetMessageTracking();
    runContentTokens = 0;
    runContentStreamMs = 0;
    state = { ...state, tokensPerSecond: null, generating: false };
    sessionMetrics.reset();
    syncSessionMetrics(ctx);
    refresh(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    state = {
      ...state,
      provider: event.model.provider,
      modelId: event.model.id,
      modelName: event.model.name,
      thinking: event.model.reasoning ? pi.getThinkingLevel() : "off",
      contextWindow: event.model.contextWindow,
    };
    refresh(ctx);
  });

  pi.on("thinking_level_select", (event) => {
    state = { ...state, thinking: event.level };
    publish();
  });

  pi.on("agent_start", (_event, ctx) => {
    runContentTokens = 0;
    runContentStreamMs = 0;
    resetMessageTracking();
    state = { ...state, tokensPerSecond: null, generating: true };
    refresh(ctx);
  });

  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") resetMessageTracking();
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;

    const streamEvent = event.assistantMessageEvent;
    if (streamEvent.type === "toolcall_delta") {
      sawToolCall = true;
      return;
    }
    if (
      streamEvent.type !== "text_delta" &&
      streamEvent.type !== "thinking_delta"
    )
      return;
    if (!streamEvent.delta) return;

    const now = Date.now();
    if (contentStreamStart === null) {
      contentStreamStart = now;
      firstContentDeltaCharacters = streamEvent.delta.length;
    }
    lastContentDeltaAt = now;
    contentCharacters += streamEvent.delta.length;
    contentDeltaCount += 1;

    const elapsedMs = now - contentStreamStart;
    const streamedCharacters = contentCharacters - firstContentDeltaCharacters;
    if (
      contentDeltaCount < 2 ||
      elapsedMs <= 0 ||
      streamedCharacters <= 0 ||
      now - lastLiveUpdate < LIVE_UPDATE_INTERVAL_MS
    ) {
      return;
    }
    lastLiveUpdate = now;

    state = {
      ...state,
      tokensPerSecond:
        estimateContentTokens(streamedCharacters) / (elapsedMs / 1000),
    };
    publish();
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;

    sawToolCall ||= event.message.content.some(
      (block) => block.type === "toolCall",
    );

    if (contentStreamStart !== null && contentCharacters > 0) {
      const streamEnd = lastContentDeltaAt ?? contentStreamStart;
      const streamMs = streamEnd - contentStreamStart;
      const estimatedFirstDeltaTokens = estimateContentTokens(
        firstContentDeltaCharacters,
      );
      // Measure tokens received after the first content event over the interval
      // from the first event to the last. This avoids counting an initial chunk
      // as if it were generated instantaneously at t=0.
      const streamedTokens =
        !sawToolCall && event.message.usage.output > 0
          ? Math.max(0, event.message.usage.output - estimatedFirstDeltaTokens)
          : Math.max(
              0,
              estimateContentTokens(contentCharacters) -
                estimatedFirstDeltaTokens,
            );

      // A single event or a sub-50ms burst has no useful observable cadence.
      if (contentDeltaCount >= 2 && streamMs >= 50 && streamedTokens > 0) {
        runContentTokens += streamedTokens;
        runContentStreamMs += streamMs;
        state = {
          ...state,
          tokensPerSecond: runContentTokens / (runContentStreamMs / 1000),
        };
      }
    }

    resetMessageTracking();
    refresh(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    syncSessionMetrics(ctx);
    refresh(ctx);
  });

  // Compaction and branch moves rewrite history, so the cached percentage is
  // stale the moment they land. Pi reports unknown occupancy until the next
  // assistant reply, which is the honest state to show.
  pi.on("session_compact", (_event, ctx) => {
    syncSessionMetrics(ctx);
    refresh(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    syncSessionMetrics(ctx);
    refresh(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    state = { ...state, generating: false };
    refresh(ctx);
  });

  pi.on("session_shutdown", () => {
    stopRefreshListener();
    currentContext = undefined;
    sessionMetrics.reset();
  });
}
