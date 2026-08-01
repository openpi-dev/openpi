import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const MIN_CONTEXT_PIVOT_TOKENS = 30_000;
const STATUS_KEY = "context-pivot";

interface PendingPivot {
  brief: string;
  generation: number;
}

interface ContextUsage {
  tokens?: number | null;
  percent?: number | null;
  contextWindow?: number | null;
}

export function estimateContextTokens(
  usage: ContextUsage | null | undefined,
): number | null {
  if (!usage) return null;
  if (typeof usage.tokens === "number") {
    return Number.isFinite(usage.tokens) && usage.tokens >= 0
      ? usage.tokens
      : null;
  }
  if (
    typeof usage.percent !== "number" ||
    !Number.isFinite(usage.percent) ||
    usage.percent < 0 ||
    typeof usage.contextWindow !== "number" ||
    !Number.isFinite(usage.contextWindow) ||
    usage.contextWindow <= 0
  ) {
    return null;
  }
  return (usage.contextWindow * usage.percent) / 100;
}

export function buildPivotSummary(brief: string): string {
  return [
    "## Context Pivot — Continue in a Clean Context",
    "",
    "The previous phase was deliberately compressed. Continue from this brief instead of reconstructing discarded mechanics.",
    "",
    "## Next Phase",
    "",
    brief.trim(),
  ].join("\n");
}

function impossibleKeptId(entries: readonly SessionEntry[]) {
  return `${entries.at(-1)?.id ?? "context-pivot"}-context-pivot-cut`;
}

function validateBrief(brief: string, ctx: ExtensionContext) {
  if (!brief.trim())
    throw new Error("context_pivot requires a non-empty brief.");

  const tokens = estimateContextTokens(ctx.getContextUsage());
  if (tokens === null) {
    throw new Error(
      "Context usage is unavailable; context pivot was not started.",
    );
  }
  if (tokens < MIN_CONTEXT_PIVOT_TOKENS) {
    throw new Error(
      `Context is only ${Math.round(tokens).toLocaleString()} tokens; use context_pivot once context reaches at least ${MIN_CONTEXT_PIVOT_TOKENS.toLocaleString()} tokens, or /handoff for a genuinely new session.`,
    );
  }
}

export default function contextPivot(pi: ExtensionAPI) {
  let generation = 0;
  let pending: PendingPivot | undefined;
  let compacting = false;

  pi.on("session_before_compact", (event) => {
    const pivot = pending;
    if (!pivot || pivot.generation !== generation) return;

    pending = undefined;
    const summary = buildPivotSummary(pivot.brief);
    return {
      compaction: {
        summary,
        firstKeptEntryId: impossibleKeptId(event.branchEntries),
        tokensBefore: event.preparation.tokensBefore,
        details: { contextPivot: true },
      },
    };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    generation += 1;
    pending = undefined;
    compacting = false;
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.registerTool({
    name: "context_pivot",
    label: "Context Pivot",
    description:
      "Deliberately replace a long, noisy active context with a concise brief for the next phase while staying in the same Pi session. Use once context is at least 30k tokens and the work is moving between phases such as research → implementation or implementation → review; below 30k it is rejected. Use /handoff instead for a genuinely new session.",
    promptSnippet:
      "Compress a long current session into a clean brief before changing phase",
    promptGuidelines: [
      "Use context_pivot only when the current context is at least 30k tokens and the work is changing phase. Put the current state, decisions, blockers, failed paths worth avoiding, relevant artifact paths, and exact next steps in its brief.",
    ],
    parameters: Type.Object({
      brief: Type.String({
        description:
          "Self-contained next-phase brief: goal, current state, decisions and constraints, blockers, failed paths, artifact paths, and immediate next steps.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (compacting)
        throw new Error("A context pivot is already in progress.");
      validateBrief(params.brief, ctx);

      const pivotGeneration = ++generation;
      pending = { brief: params.brief.trim(), generation: pivotGeneration };
      compacting = true;
      if (ctx.hasUI) {
        ctx.ui.setStatus(
          STATUS_KEY,
          ctx.ui.theme.fg("accent", "↻ pivoting context…"),
        );
      }

      const clear = () => {
        if (pivotGeneration !== generation) return;
        compacting = false;
        if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
      };

      try {
        ctx.compact({
          onComplete: () => {
            clear();
            if (pivotGeneration !== generation) return;
            if (ctx.hasUI) {
              ctx.ui.notify(
                "Context pivot complete. Continuing from the next-phase brief.",
                "info",
              );
            }
            pi.sendUserMessage("Continue with the next phase now.");
          },
          onError: (error) => {
            if (pivotGeneration === generation) pending = undefined;
            clear();
            if (ctx.hasUI) {
              ctx.ui.notify(
                `Context pivot failed: ${error instanceof Error ? error.message : String(error)}`,
                "error",
              );
            }
          },
        });
      } catch (error) {
        pending = undefined;
        clear();
        throw error;
      }

      return {
        content: [{ type: "text", text: "Context pivot started." }],
        details: { contextPivot: true },
        terminate: true,
      };
    },
  });

  pi.registerCommand("context-pivot", {
    description:
      "Ask the agent to compact this long session into a clean next-phase brief",
    handler: async (args, ctx) => {
      const direction = args.trim();
      if (!direction) {
        if (ctx.hasUI) {
          ctx.ui.notify("Usage: /context-pivot <next phase>", "error");
        }
        return;
      }

      const tokens = estimateContextTokens(ctx.getContextUsage());
      if (tokens === null || tokens < MIN_CONTEXT_PIVOT_TOKENS) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            tokens === null
              ? "Context usage is unavailable; context pivot was not started."
              : `Context is only ${Math.round(tokens).toLocaleString()} tokens; a pivot is not useful yet.`,
            "warning",
          );
        }
        return;
      }

      pi.sendUserMessage(
        [
          `Context pivot direction: ${direction}`,
          "",
          "Prepare a concise, self-contained next-phase brief containing:",
          "- the exact next goal and current state",
          "- decisions and constraints that still matter",
          "- blockers, unresolved questions, and failed paths worth avoiding",
          "- relevant artifact, file, issue, or commit references",
          "- immediate executable next steps",
          "",
          "Then call context_pivot with that brief. Do not continue normal work first.",
        ].join("\n"),
        ctx.isIdle() ? undefined : { deliverAs: "followUp" },
      );
    },
  });
}
