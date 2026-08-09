import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import { MAX_ANSWER_DRAFT_UTF8_BYTES, answerDraftFits } from "./limits.ts";

const COMPLETE = "Done — resume and verify";
const UNABLE = "Unable to complete";
const DISMISS = "Dismiss without a status";

const HumanHandoffParams = Type.Object({
  title: Type.String({
    minLength: 1,
    maxLength: 80,
    description: "Short name for the manual action",
  }),
  instructions: Type.String({
    minLength: 1,
    maxLength: 2_000,
    description:
      "Concrete steps only the user can perform, such as signing in, approving access, or touching hardware",
  }),
  completionSignal: Type.String({
    minLength: 1,
    maxLength: 500,
    description:
      "Observable condition the agent should verify after the user marks the action done",
  }),
});

export type HumanHandoffInput = Static<typeof HumanHandoffParams>;
export type HumanHandoffStatus =
  "completed" | "unable" | "dismissed" | "cancelled" | "unavailable";

export interface HumanHandoffDetails {
  status: HumanHandoffStatus;
  note?: string;
}

function safeText(value: string) {
  return sanitizeTerminalText(value).trim();
}

function safeSingleLine(value: string) {
  return safeText(value).replace(/\s+/g, " ");
}

function resultMessage(
  status: HumanHandoffStatus,
  completionSignal: string,
  note?: string,
) {
  const safeSignal = safeSingleLine(completionSignal);
  const safeNote = note ? safeSingleLine(note) : undefined;
  switch (status) {
    case "completed":
      return `User marked the manual action done. This is not proof of completion. Verify the expected signal with available tools before relying on it: ${safeSignal}.${safeNote ? ` User note: ${safeNote}` : ""}`;
    case "unable":
      return `User could not complete the manual action. Do not claim it succeeded or continue down a path that requires it.${safeNote ? ` User note: ${safeNote}` : ""}`;
    case "dismissed":
      return "User dismissed the handoff without reporting a status. Do not assume the manual action was completed.";
    case "cancelled":
      return "The handoff was cancelled. Do not assume the manual action was completed.";
    case "unavailable":
      return "No dialog-capable UI is available for the handoff. Explain the required manual action in plain text and end the turn without claiming completion.";
  }
}

async function optionalBoundedNote(
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  status: "completed" | "unable",
) {
  const options = signal ? { signal } : undefined;
  while (!signal?.aborted) {
    const note = await ctx.ui.input(
      status === "completed" ? "Optional completion note" : "What blocked you?",
      status === "completed"
        ? "Optional detail for the agent"
        : "Optional error or missing access",
      options,
    );
    if (note === undefined) return undefined;
    if (answerDraftFits(note)) return note.trim() || undefined;
    ctx.ui.notify(
      `Handoff notes are limited to ${MAX_ANSWER_DRAFT_UTF8_BYTES} UTF-8 bytes.`,
      "error",
    );
  }
  return undefined;
}

export function createHumanHandoffToolDefinition(): ToolDefinition<
  typeof HumanHandoffParams,
  HumanHandoffDetails
> {
  return {
    name: "human_handoff",
    label: "Human Handoff",
    description:
      "Pause for one concrete action only the user can perform, then collect a reviewed Done or Unable status. Completion remains untrusted until the agent verifies the supplied completion signal.",
    promptSnippet:
      "Wait for a user-only manual action, then verify its observable completion signal",
    promptGuidelines: [
      "Use human_handoff only for an action the user must perform outside the available tools, such as sign-in, authorization, physical hardware, or a third-party approval. Do not use it for questions, preferences, or permission to continue.",
      "Give short concrete instructions and an observable completion signal. After a Done result, verify that signal with available tools whenever possible; the user's status alone is not proof.",
      "Do not call human_handoff from a child or workflow agent, and do not poll while waiting; the tool itself waits for the reviewed user status.",
    ],
    executionMode: "sequential",
    parameters: HumanHandoffParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const reply = (status: HumanHandoffStatus, note?: string) => ({
        content: [
          {
            type: "text" as const,
            text: resultMessage(status, params.completionSignal, note),
          },
        ],
        details: {
          status,
          ...(note ? { note } : {}),
        } satisfies HumanHandoffDetails,
      });

      if (!ctx.hasUI) return reply("unavailable");
      if (signal?.aborted) return reply("cancelled");

      const title = safeSingleLine(params.title);
      const instructions = safeText(params.instructions);
      const completionSignal = safeText(params.completionSignal);
      if (!title || !instructions || !completionSignal) {
        throw new Error(
          "human_handoff title, instructions, and completionSignal must contain visible text.",
        );
      }

      const options = signal ? { signal } : undefined;
      const dialogTitle = `${title}\n\n${instructions}\n\nDone when: ${completionSignal}`;

      try {
        while (!signal?.aborted) {
          const choice = await ctx.ui.select(
            dialogTitle,
            [COMPLETE, UNABLE, DISMISS],
            options,
          );
          if (signal?.aborted) return reply("cancelled");
          if (!choice || choice === DISMISS) return reply("dismissed");
          if (choice !== COMPLETE && choice !== UNABLE) continue;

          const status = choice === COMPLETE ? "completed" : "unable";
          const note = await optionalBoundedNote(ctx, signal, status);
          if (signal?.aborted) return reply("cancelled");

          const confirmed = await ctx.ui.confirm(
            "Review handoff status",
            `${status === "completed" ? "Done" : "Unable"}\n\nExpected completion signal: ${completionSignal}${note ? `\n\nNote: ${safeText(note)}` : ""}`,
            options,
          );
          if (signal?.aborted) return reply("cancelled");
          if (confirmed) return reply(status, note);
        }
      } catch (error) {
        if (signal?.aborted) return reply("cancelled");
        throw error;
      }

      return reply("cancelled");
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("human_handoff ")) +
          theme.fg("muted", safeSingleLine(args.title)),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as HumanHandoffDetails | undefined;
      const status = details?.status;
      const label =
        status === "completed"
          ? "✓ marked done — verification required"
          : status === "unable"
            ? "! unable"
            : status === "unavailable"
              ? "! unavailable"
              : "✗ dismissed";
      return new Text(
        theme.fg(status === "completed" ? "success" : "warning", label) +
          (details?.note
            ? `\n${theme.fg("muted", safeSingleLine(details.note))}`
            : ""),
        0,
        0,
      );
    },
  };
}
