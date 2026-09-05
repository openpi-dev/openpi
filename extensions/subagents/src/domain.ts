/**
 * Domain model for subagents.
 *
 * Everything downstream of a backend (manager, tools, UI) speaks only these
 * types. A backend translates its native stream (pi session events) into the
 * normalized `SubagentEvent` union.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Data } from "effect";

export const BACKEND_NAMES = ["pi"] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];

/** Who initiated the session. User asides stay out of model-facing tooling. */
export type SubagentOrigin = "model" | "btw";

/**
 * Reasoning-effort scale; these are pi's thinking levels, used directly as the
 * level. Omitted = inherit the parent session's level.
 */
export const REASONING_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type SubagentStatus = "running" | "done" | "error";
export type SubagentOutcome = "completed" | "failed" | "interrupted";

/** Parent-session context resolved by the tool layer and passed opaquely. */
export interface ParentContext {
  readonly parentCwd: string;
  readonly projectTrusted: boolean;
  /** Parent pi model, for the pi backend's "inherit" default. */
  readonly inheritedModel?: { readonly provider: string; readonly id: string };
  readonly inheritedThinkingLevel?: string;
  /** Parent model registry; required by the pi backend to resolve models. */
  readonly modelRegistry?: ModelRegistry;
}

export interface SpawnTask {
  /** Omitted for normal tool-driven spawns. */
  readonly origin?: SubagentOrigin;
  readonly prompt: string;
  readonly title: string;
  readonly cwd: string;
  /**
   * Model hint: "provider/model-id", or a bare model id resolved against the
   * parent's provider. Omitted = inherit the parent model.
   */
  readonly model?: string;
  /** Thinking level for the child; omitted inherits the parent level. */
  readonly reasoningEffort?: ReasoningEffort;
  /**
   * Agent-type fields, resolved by the tool layer. The backend applies them
   * verbatim; it does not know where they came from.
   */
  readonly appendSystemPrompt?: readonly string[];
  /**
   * Tool allowlist for the child. Composed with (never replacing) the child
   * denylist, so this can only narrow. Omitted = the normal child tool set.
   */
  readonly tools?: readonly string[];
  /** Agent type that supplied the above, for the session label. */
  readonly agentTypeName?: string;
  /** Optional JSON Schema for one terminating, validated child result. */
  readonly outputSchema?: unknown;
  /**
   * Isolated git worktree this child runs in, created by the tool layer. The
   * backend only reclaims it when the session scope closes; it does not know
   * how it was made.
   */
  readonly worktree?: {
    readonly path: string;
    readonly branch: string;
    /** Repository the worktree belongs to, for the reclaim call. */
    readonly repoCwd: string;
    /** Creation-time commit; reclaim measures "produced nothing" against it. */
    readonly baseSha?: string;
  };
  readonly parent: ParentContext;
}

export interface SubagentMeta {
  readonly backend: BackendName;
  /** Display label, e.g. "seal/kimi-k3". */
  readonly modelLabel?: string;
  /** Context window capacity for utilization display, when known. */
  readonly contextWindow?: number;
  /** Child session file on disk. */
  readonly sessionFilePath?: string;
}

// --- Transcript ------------------------------------------------------------

export type TranscriptPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "thinking";
      readonly text: string;
      readonly redacted?: boolean;
    }
  | {
      readonly type: "toolCall";
      readonly toolId: string;
      readonly name: string;
      readonly argsPreview?: string;
    };

export type TranscriptItem =
  | { readonly kind: "user"; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly parts: ReadonlyArray<TranscriptPart>;
    }
  | {
      readonly kind: "toolResult";
      readonly toolId: string;
      readonly name: string;
      readonly isError: boolean;
      readonly outputPreview?: string;
    };

export interface LiveToolState {
  readonly toolId: string;
  readonly name: string;
  readonly argsPreview?: string;
  readonly outputPreview?: string;
  readonly done?: boolean;
  readonly isError?: boolean;
}

export interface QueuedMessage {
  readonly text: string;
  readonly kind: "steer" | "follow-up";
}

// --- Events ------------------------------------------------------------------

export type RunOutcome =
  | {
      readonly _tag: "Completed";
      readonly finalText: string;
      readonly structuredResult?: StructuredSubagentResult;
    }
  | {
      readonly _tag: "Failed";
      readonly errorText: string;
      readonly partialText?: string;
    }
  | { readonly _tag: "Interrupted"; readonly partialText?: string };

/**
 * Normalized activity stream. Previews (`argsPreview`, `outputPreview`) stay
 * bounded, pre-flattened strings; the UI may compact known argument fields but
 * never retains arbitrary raw tool payloads.
 */
export type SubagentEvent =
  // lifecycle (a session can run multiple turns via send())
  | { readonly _tag: "RunStarted" }
  | { readonly _tag: "RunSettled"; readonly outcome: RunOutcome }
  // transcript building blocks
  | { readonly _tag: "UserMessage"; readonly text: string }
  | {
      readonly _tag: "AssistantDelta";
      readonly kind: "text" | "thinking";
      readonly delta: string;
    }
  | {
      readonly _tag: "AssistantMessage";
      readonly parts: ReadonlyArray<TranscriptPart>;
    }
  | {
      readonly _tag: "ToolStart";
      readonly toolId: string;
      readonly name: string;
      readonly argsPreview?: string;
    }
  | {
      readonly _tag: "ToolUpdate";
      readonly toolId: string;
      readonly outputPreview?: string;
    }
  | {
      readonly _tag: "ToolEnd";
      readonly toolId: string;
      readonly name: string;
      readonly isError: boolean;
      readonly outputPreview?: string;
    }
  // bookkeeping
  | {
      readonly _tag: "QueueChanged";
      readonly queued: ReadonlyArray<QueuedMessage>;
    }
  | {
      readonly _tag: "UsageChanged";
      readonly tokens?: number;
      readonly contextWindow?: number;
    }
  | { readonly _tag: "MetaChanged"; readonly meta: Partial<SubagentMeta> }
  /** Non-fatal diagnostics. Fatal failures arrive as a RunSettled outcome. */
  | { readonly _tag: "BackendError"; readonly message: string };

// --- Snapshot ---------------------------------------------------------------

/**
 * The manager folds `SubagentEvent`s into one snapshot per subagent. This is
 * everything the tools, footer status, and both TUI views read.
 */
export interface SubagentSnapshot {
  readonly id: string;
  readonly origin: SubagentOrigin;
  readonly backend: BackendName;
  readonly title: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly status: SubagentStatus;
  readonly outcome?: SubagentOutcome;
  readonly worktreeBranch?: string;
  readonly createdAt: number;
  readonly settledAt?: number;
  readonly errorText?: string;
  readonly meta: SubagentMeta;
  readonly usage: { readonly tokens?: number; readonly contextWindow?: number };
  readonly transcript: ReadonlyArray<TranscriptItem>;
  /** Monotonic version bumped on every transcript mutation (see manager). */
  readonly transcriptVersion: number;
  /** Streaming assistant buffers, cleared when the finalized message lands. */
  readonly liveAssistant?: { readonly text: string; readonly thinking: string };
  readonly liveTools: ReadonlyArray<LiveToolState>;
  readonly queued: ReadonlyArray<QueuedMessage>;
  /** Final text of the most recent completed run (v1 `finalOutput`). */
  readonly finalText: string;
  /** Present only when this run supplied and satisfied output_schema. */
  readonly structuredResult?: StructuredSubagentResult;
  /** Count of finalized assistant messages (for subagent_check). */
  readonly turns: number;
}

export interface StructuredSubagentResult {
  readonly value: unknown;
  readonly json: string;
  readonly byteLength: number;
  readonly artifactPath: string;
}

/** Final text, or the live streaming buffer while a run is active (v1 `latestOutput`). */
export function latestText(snap: SubagentSnapshot) {
  const live = snap.liveAssistant?.text.trim();
  if (live) return live;
  return snap.finalText;
}

export function formatElapsed(snap: SubagentSnapshot) {
  const end = snap.settledAt ?? Date.now();
  const totalSeconds = Math.max(0, Math.round((end - snap.createdAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}

// --- Errors -------------------------------------------------------------------

export class SpawnError extends Data.TaggedError("SpawnError")<{
  readonly message: string;
}> {}

export class BackendUnavailableError extends Data.TaggedError(
  "BackendUnavailableError",
)<{
  readonly message: string;
}> {}

export class ConcurrencyLimitError extends Data.TaggedError(
  "ConcurrencyLimitError",
)<{
  readonly message: string;
}> {}

export class SendError extends Data.TaggedError("SendError")<{
  readonly message: string;
}> {}
