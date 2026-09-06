import { createHash } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";

export const CACHE_DIAGNOSTICS_CHANNEL = "model-info:cache-diagnostics";

export const CACHE_WARM_MINIMUM_TOKENS = 2_048;

export type CacheSemantics =
  | "explicit-prefix"
  | "implicit-best-effort"
  | "unknown";

export type CacheObservationKind =
  | "first-turn"
  | "cold"
  | "warm"
  | "partial-hit"
  | "miss-after-warm-prefix"
  | "unknown";

export type CacheCorrelation =
  | "model-change"
  | "thinking-change"
  | "tool-surface-change"
  | "system-prompt-change"
  | "compaction"
  | "branch-change";

export interface CacheTurnIdentity {
  provider: string;
  modelId: string;
  thinking: string;
  toolSurfaceFingerprint: string;
  systemPromptFingerprint: string;
}

export interface CacheTurnObservation {
  turnIndex: number;
  provider: string;
  semantics: CacheSemantics;
  kind: CacheObservationKind;
  usage: {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    promptTokens: number;
  };
  previousCacheRead: number | null;
  reprocessedTokens: number | null;
  correlations: CacheCorrelation[];
  evidence: "observation";
  verifiedCause: null;
  explanation: string;
}

type TurnSample = {
  identity: CacheTurnIdentity;
  usage: CacheTurnObservation["usage"];
};

const IMPLICIT_CACHE_PROVIDERS = new Set([
  "azure-openai-responses",
  "google",
  "google-antigravity",
  "google-gemini-cli",
  "openai",
  "openai-codex",
  "openai-responses",
]);

export function cacheSemanticsForProvider(provider: string): CacheSemantics {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "anthropic") return "explicit-prefix";
  if (IMPLICIT_CACHE_PROVIDERS.has(normalized)) return "implicit-best-effort";
  return "unknown";
}

export function fingerprintCacheSurface(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function finiteUsage(value: number) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function promptUsage(usage: Usage): CacheTurnObservation["usage"] {
  const input = finiteUsage(usage.input);
  const cacheRead = finiteUsage(usage.cacheRead);
  const cacheWrite = finiteUsage(usage.cacheWrite);
  return {
    input,
    cacheRead,
    cacheWrite,
    promptTokens: input + cacheRead + cacheWrite,
  };
}

function identityCorrelations(
  previous: CacheTurnIdentity,
  current: CacheTurnIdentity,
) {
  const correlations: CacheCorrelation[] = [];
  if (
    previous.provider !== current.provider ||
    previous.modelId !== current.modelId
  ) {
    correlations.push("model-change");
  }
  if (previous.thinking !== current.thinking) {
    correlations.push("thinking-change");
  }
  if (previous.toolSurfaceFingerprint !== current.toolSurfaceFingerprint) {
    correlations.push("tool-surface-change");
  }
  if (previous.systemPromptFingerprint !== current.systemPromptFingerprint) {
    correlations.push("system-prompt-change");
  }
  return correlations;
}

function classify(
  semantics: CacheSemantics,
  current: CacheTurnObservation["usage"],
  previous: TurnSample | undefined,
): Pick<CacheTurnObservation, "kind" | "reprocessedTokens" | "explanation"> {
  if (!previous) {
    return {
      kind: "first-turn",
      reprocessedTokens: null,
      explanation:
        "No prior turn exists, so cache continuity cannot be inferred.",
    };
  }

  const previousWarm = previous.usage.cacheRead >= CACHE_WARM_MINIMUM_TOKENS;
  if (current.cacheRead > 0) {
    return {
      kind:
        current.cacheRead < previous.usage.cacheRead ? "partial-hit" : "warm",
      reprocessedTokens: null,
      explanation:
        current.cacheRead < previous.usage.cacheRead
          ? "The provider reported a smaller cache read than on the prior turn."
          : "The provider reported cached prompt tokens on this turn.",
    };
  }
  if (!previousWarm) {
    return {
      kind: "cold",
      reprocessedTokens: null,
      explanation:
        "The prior turn had no sufficiently warm prefix, so this cold turn is not an invalidation signal.",
    };
  }
  if (semantics !== "explicit-prefix") {
    return {
      kind: "unknown",
      reprocessedTokens: null,
      explanation:
        semantics === "implicit-best-effort"
          ? "A warm-to-cold transition was observed, but this provider exposes only best-effort cache usage."
          : "A warm-to-cold transition was observed, but the provider cache contract is unknown.",
    };
  }
  return {
    kind: "miss-after-warm-prefix",
    reprocessedTokens: current.input,
    explanation:
      "An explicit-prefix provider reported a warm prior turn and zero cache read now; local boundaries are correlations, not verified causes.",
  };
}

export function createCacheDiagnosticsTracker() {
  let previous: TurnSample | undefined;
  let pendingCorrelations = new Set<CacheCorrelation>();

  const reset = () => {
    previous = undefined;
    pendingCorrelations = new Set();
  };

  const mark = (correlation: CacheCorrelation) => {
    pendingCorrelations.add(correlation);
  };

  const observe = (options: {
    turnIndex: number;
    identity: CacheTurnIdentity;
    usage: Usage;
  }) => {
    const usage = promptUsage(options.usage);
    const semantics = cacheSemanticsForProvider(options.identity.provider);
    const classification = classify(semantics, usage, previous);
    const correlations = previous
      ? identityCorrelations(previous.identity, options.identity)
      : [];
    for (const pending of pendingCorrelations) correlations.push(pending);
    const uniqueCorrelations = [...new Set(correlations)];

    const observation: CacheTurnObservation = {
      turnIndex: options.turnIndex,
      provider: options.identity.provider,
      semantics,
      kind: classification.kind,
      usage,
      previousCacheRead: previous?.usage.cacheRead ?? null,
      reprocessedTokens: classification.reprocessedTokens,
      correlations: uniqueCorrelations,
      evidence: "observation",
      verifiedCause: null,
      explanation: classification.explanation,
    };

    previous = { identity: options.identity, usage };
    pendingCorrelations.clear();
    return observation;
  };

  return { mark, observe, reset };
}
