/** Model-facing schema descriptions for the ask_user question and answer options. */
export const ASK_USER_PARAMETER_DESCRIPTIONS = {
  optionLabel: "Short display label for this option",
  optionDescription: "Optional one-line description shown below the label",
  question: "The question to ask the user",
  options:
    "Between 2 and 5 answer options. A free-form 'write my own answer' option is always appended automatically - never include one yourself.",
};

/** Describes the ask_user tool's question shape and dismissible free-form fallback. */
export const ASK_USER_TOOL_DESCRIPTION =
  "Ask the user a single multiple-choice question (2-5 options). A free-form 'write my own answer' option is always added automatically, and the user may dismiss the question without answering. Ask exactly one question per call.";

/** Adds ask_user's multiple-choice capability to the model's available-tools prompt. */
export const ASK_USER_PROMPT_SNIPPET =
  "Ask the user a multiple-choice question (2-5 options plus a free-form answer)";

/** Guides the model to use ask_user for enumerable answers and one question at a time. */
export const ASK_USER_PROMPT_GUIDELINES = [
  "When asking the user a question whose likely answers can be enumerated, use the ask_user tool instead of asking in plain text.",
  "Ask one question per ask_user call; ask follow-up questions in subsequent calls.",
];

/** Builds the behavioral tool-result message returned to the parent model for an ask_user outcome. */
export function buildAskUserResultMessage(
  outcome:
    | { kind: "no-ui" }
    | { kind: "cancelled" }
    | { kind: "dismissed" }
    | { kind: "custom"; answer: string }
    | { kind: "selected"; answer: string; index: number | undefined },
) {
  switch (outcome.kind) {
    case "no-ui":
      return "No interactive UI is available, so the question could not be shown. Ask the user in plain text instead.";
    case "cancelled":
      return "Cancelled";
    case "dismissed":
      return "User dismissed the question without answering. Do not assume an answer; proceed accordingly or ask differently.";
    case "custom":
      return `User wrote their own answer: ${outcome.answer}`;
    case "selected":
      return `User selected option ${outcome.index}: ${outcome.answer}`;
  }
}
