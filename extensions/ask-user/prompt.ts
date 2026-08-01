interface AskUserAnswer {
  readonly id: string;
  readonly selected?: string;
  readonly note?: string;
  readonly custom?: string;
}

/** Model-facing schema descriptions for structured user questions. */
export const ASK_USER_PARAMETER_DESCRIPTIONS = {
  id: "Stable snake_case identifier used to map the answer",
  header: "Short UI header, ideally 12 characters or fewer",
  optionLabel:
    'Concise user-facing label. Put the recommended option first and suffix its label with "(Recommended)".',
  optionDescription:
    "One short sentence explaining the impact or tradeoff if selected",
  question: "A single-sentence question shown to the user",
  options:
    "Between 2 and 5 mutually exclusive choices. Never include an Other/custom option; the UI adds one automatically.",
  questions:
    "One to three independent questions (see the tool guidelines for when to batch more than one).",
};

export const ASK_USER_TOOL_DESCRIPTION =
  "Ask the user one to three short, independent multiple-choice questions and wait for answers. Each question gets a free-form answer option, and the user may add notes to a selected choice or dismiss the request. Prefer one question unless several independent decisions should be answered together.";

export const ASK_USER_PROMPT_SNIPPET =
  "Ask 1-3 structured user questions with recommended choices, tradeoffs, optional notes, and free-form answers";

export const ASK_USER_PROMPT_GUIDELINES = [
  "Use ask_user only for a genuine ambiguity or user preference that cannot be resolved from the code, docs, or conversation and would materially change the result. Never use it to ask whether to continue.",
  'Before calling ask_user, analyze the choice: provide mutually exclusive options, put your recommendation first, suffix its label with "(Recommended)", and explain each option\'s impact or tradeoff.',
  "Prefer one ask_user question. Include up to three only when the decisions are independent and batching them avoids unnecessary round trips.",
];

export function buildAskUserResultMessage(
  outcome:
    | { kind: "no-ui" }
    | { kind: "cancelled" }
    | { kind: "dismissed" }
    | { kind: "answered"; answers: readonly AskUserAnswer[] },
) {
  switch (outcome.kind) {
    case "no-ui":
      return "No interactive UI is available, so the questions could not be shown. Ask the user in plain text instead.";
    case "cancelled":
      return "Cancelled";
    case "dismissed":
      return "User dismissed the questions without answering. Do not assume answers; proceed accordingly or ask differently.";
    case "answered":
      return `User answered:\n${outcome.answers
        .map((answer) => {
          const value = answer.custom ?? answer.selected ?? "(unanswered)";
          return `- ${answer.id}: ${value}${answer.note ? ` — note: ${answer.note}` : ""}`;
        })
        .join("\n")}`;
  }
}
