/**
 * ask_user — structured root-agent questions with a focused TUI.
 *
 * - 1 to 3 independent questions per call, shown one at a time
 * - 2 to 5 options per question, plus an automatic free-form option
 * - Enter records a draft answer; Tab adds optional notes to the highlighted option
 * - every call ends on an explicit review screen before answers are submitted
 * - review can reopen any question; Esc dismisses without returning draft answers
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  type Focusable,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Cause, Effect, Exit } from "effect";
import { Type, type Static } from "typebox";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import { createHumanHandoffToolDefinition } from "./handoff.ts";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  MAX_ANSWER_DRAFT_UTF8_BYTES,
  answerDraftByteLength,
  answerDraftFits,
  longerThanAnswerDraftLimit,
  prospectiveAnswerDraftFits,
  sanitizeAnswerDraftEditorInput,
} from "./limits.ts";
import {
  ASK_USER_PARAMETER_DESCRIPTIONS,
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  buildAskUserResultMessage,
} from "./prompt.ts";

const MIN_QUESTIONS = 1;
const MAX_QUESTIONS = 3;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
/** Preview lines rendered before the tail is summarized. */
const PREVIEW_MAX_LINES = 20;

export { MAX_ANSWER_DRAFT_UTF8_BYTES, answerDraftFits } from "./limits.ts";

const OptionSchema = Type.Object({
  label: Type.String({
    minLength: 1,
    maxLength: 120,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel,
  }),
  description: Type.String({
    minLength: 1,
    maxLength: 500,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription,
  }),
  preview: Type.Optional(
    Type.String({
      maxLength: 2_000,
      description: ASK_USER_PARAMETER_DESCRIPTIONS.optionPreview,
    }),
  ),
});

const QuestionSchema = Type.Object({
  id: Type.String({
    minLength: 1,
    maxLength: 80,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.id,
  }),
  header: Type.String({
    minLength: 1,
    maxLength: 80,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.header,
  }),
  question: Type.String({
    minLength: 1,
    maxLength: 2_000,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
  }),
});

const AskUserParams = Type.Object({
  questions: Type.Array(QuestionSchema, {
    minItems: MIN_QUESTIONS,
    maxItems: MAX_QUESTIONS,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.questions,
  }),
});

export type AskUserInput = Static<typeof AskUserParams>;

export interface AskUserAnswer {
  readonly id: string;
  readonly selected?: string;
  readonly note?: string;
  readonly custom?: string;
  /** The user submitted the blank free-form option to request a better question. */
  readonly rephrase?: true;
}

interface AskUserDetails {
  questions: string[];
  answers: AskUserAnswer[];
  cancelled: boolean;
}

type SelectionResult = AskUserAnswer[] | null;
type EditMode = "notes" | "custom" | undefined;
type ScreenMode = "question" | "review";

interface DisplayOption {
  label: string;
  description?: string;
  /** Optional artifact shown while this option is highlighted. */
  preview?: string;
  isOther?: boolean;
}

export function formatPreviewLine(raw: string, width: number) {
  return truncateToWidth(sanitizeTerminalText(raw), width, "…");
}

function safeSingleLine(text: string) {
  return sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
}

function boundedUtf8PrefixEnd(
  value: string,
  start: number,
  end: number,
  maximumBytes: number,
) {
  let bytes = 0;
  let index = start;
  while (index < end) {
    const codePoint = value.codePointAt(index)!;
    const size =
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    if (bytes + size > maximumBytes) {
      return { end: index, exceeded: true } as const;
    }
    bytes += size;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return { end: index, exceeded: false } as const;
}

const optionLabelIdentity = (label: string) =>
  safeSingleLine(label)
    // ZWNJ/ZWJ are preserved in displayed text for legitimate shaping, but
    // cannot serve as option identity because many terminals render them
    // invisibly. Normalize after removal because an inserted joiner can block
    // composition of the characters on either side.
    .replace(/\p{Cf}/gu, "")
    .normalize("NFC");

function wrapText(text: string, width: number): string[] {
  const safe = sanitizeTerminalText(text);
  const renderWidth = Math.max(1, width);
  return safe
    .split("\n")
    .flatMap((paragraph) =>
      paragraph ? wrapTextWithAnsi(paragraph, renderWidth) : [""],
    );
}

export function formatAnswers(answers: readonly AskUserAnswer[]) {
  return answers
    .map((answer) => {
      const id = sanitizeTerminalText(answer.id).replace(/\s+/g, " ").trim();
      return `${id}: ${formatReviewAnswer(answer, 512)}`;
    })
    .join("\n");
}

export function formatReviewAnswer(
  answer: AskUserAnswer | undefined,
  maxCharacters = 240,
) {
  if (!answer) return "(unanswered)";
  const value = answer.rephrase
    ? "Rephrase or split this question"
    : (answer.custom ?? answer.selected ?? "(unanswered)");
  const combined = `${value}${answer.note ? ` — ${answer.note}` : ""}`;
  const plain = sanitizeTerminalText(combined).replace(/\s+/g, " ").trim();
  const characters = [...plain];
  if (characters.length <= maxCharacters) return plain;
  return `${characters.slice(0, Math.max(0, maxCharacters - 1)).join("")}…`;
}

type AskUserQuestion = AskUserInput["questions"][number];

function dialogOptions(signal: AbortSignal | undefined) {
  return signal ? { signal } : undefined;
}

async function boundedDialogInput(
  ctx: ExtensionContext,
  title: string,
  placeholder: string,
  signal: AbortSignal | undefined,
) {
  while (!signal?.aborted) {
    const value = await ctx.ui.input(title, placeholder, dialogOptions(signal));
    if (value === undefined) return undefined;
    if (answerDraftFits(value)) return value;
    ctx.ui.notify(
      `Answer drafts are limited to ${MAX_ANSWER_DRAFT_UTF8_BYTES} UTF-8 bytes.`,
      "error",
    );
  }
  return undefined;
}

function dialogChoiceLabels(question: AskUserQuestion) {
  return [
    ...question.options.map(
      (option, index) =>
        `${index + 1}. ${safeSingleLine(option.label)} — ${safeSingleLine(option.description)}`,
    ),
    `${question.options.length + 1}. Write my own answer…`,
  ];
}

async function collectDialogAnswer(
  ctx: ExtensionContext,
  question: AskUserQuestion,
  signal: AbortSignal | undefined,
): Promise<AskUserAnswer | undefined> {
  const choices = dialogChoiceLabels(question);
  const title = `${safeSingleLine(question.header)} — ${safeSingleLine(question.question)}`;

  while (!signal?.aborted) {
    const choice = await ctx.ui.select(title, choices, dialogOptions(signal));
    if (!choice || signal?.aborted) return undefined;
    const choiceIndex = choices.indexOf(choice);
    if (choiceIndex < 0) continue;

    if (choiceIndex < question.options.length) {
      const selected = question.options[choiceIndex]!;
      if (selected.preview) {
        const accepted = await ctx.ui.confirm(
          `Review preview for ${safeSingleLine(selected.label)}`,
          sanitizeTerminalText(selected.preview),
          dialogOptions(signal),
        );
        if (signal?.aborted) return undefined;
        if (!accepted) continue;
      }
      const note = await boundedDialogInput(
        ctx,
        `Optional note for ${safeSingleLine(selected.label)}`,
        "Leave blank to continue without a note",
        signal,
      );
      if (signal?.aborted) return undefined;
      const normalizedNote = note?.trim();
      return {
        id: question.id,
        selected: selected.label,
        ...(normalizedNote ? { note: normalizedNote } : {}),
      };
    }

    const custom = await boundedDialogInput(
      ctx,
      "Your answer",
      "Leave blank to ask the agent to rephrase or split the question",
      signal,
    );
    if (signal?.aborted) return undefined;
    if (custom === undefined) continue;
    const normalizedCustom = custom.trim();
    if (normalizedCustom) {
      return { id: question.id, custom: normalizedCustom };
    }

    const note = await boundedDialogInput(
      ctx,
      "Optional rephrase guidance",
      "What should be clearer or split apart?",
      signal,
    );
    if (signal?.aborted) return undefined;
    const normalizedNote = note?.trim();
    return {
      id: question.id,
      rephrase: true,
      ...(normalizedNote ? { note: normalizedNote } : {}),
    };
  }
  return undefined;
}

export async function showQuestionsWithDialogs(
  ctx: ExtensionContext,
  questions: readonly AskUserQuestion[],
  signal: AbortSignal | undefined,
): Promise<SelectionResult> {
  const answers: AskUserAnswer[] = [];
  for (const question of questions) {
    const answer = await collectDialogAnswer(ctx, question, signal);
    if (!answer) return null;
    answers.push(answer);
  }

  while (!signal?.aborted) {
    const editLabels = questions.map(
      (question, index) =>
        `${index + 1}. ${safeSingleLine(question.header)} — ${formatReviewAnswer(answers[index])}`,
    );
    const submit = "✓ Submit answers";
    const dismiss = "Dismiss without submitting";
    const choice = await ctx.ui.select(
      "Review answers",
      [...editLabels, submit, dismiss],
      dialogOptions(signal),
    );
    if (!choice || choice === dismiss || signal?.aborted) return null;
    if (choice === submit) return answers;

    const editIndex = editLabels.indexOf(choice);
    if (editIndex < 0) continue;
    const revised = await collectDialogAnswer(
      ctx,
      questions[editIndex]!,
      signal,
    );
    if (signal?.aborted) return null;
    if (revised) answers[editIndex] = revised;
  }
  return null;
}

export default function askUser(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: ASK_USER_TOOL_DESCRIPTION,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
    executionMode: "sequential",
    parameters: AskUserParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const reply = (text: string, answers: AskUserAnswer[] = []) => ({
        content: [{ type: "text" as const, text }],
        details: {
          questions: params.questions.map((question) => question.id),
          answers,
          cancelled: answers.length === 0,
        } satisfies AskUserDetails,
      });

      if (
        params.questions.length < MIN_QUESTIONS ||
        params.questions.length > MAX_QUESTIONS
      ) {
        throw new Error(
          `ask_user requires between ${MIN_QUESTIONS} and ${MAX_QUESTIONS} questions.`,
        );
      }
      const ids = params.questions.map((question) => question.id);
      if (new Set(ids).size !== ids.length) {
        throw new Error("ask_user question ids must be unique.");
      }
      for (const question of params.questions) {
        if (
          question.options.length < MIN_OPTIONS ||
          question.options.length > MAX_OPTIONS
        ) {
          throw new Error(
            `ask_user question "${question.id}" requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options.`,
          );
        }
        const labels = question.options.map((option) =>
          optionLabelIdentity(option.label),
        );
        if (new Set(labels).size !== labels.length) {
          throw new Error(
            `ask_user question "${question.id}" option labels must be unique.`,
          );
        }
      }

      if (!ctx.hasUI) {
        return reply(buildAskUserResultMessage({ kind: "no-ui" }));
      }
      if (signal?.aborted) {
        return reply(buildAskUserResultMessage({ kind: "cancelled" }));
      }

      const showQuestionsInTui = (uiSignal: AbortSignal) =>
        ctx.ui.custom<SelectionResult>((tui, theme, _kb, done) => {
          let screen: ScreenMode = "question";
          let questionIndex = 0;
          let optionIndex = 0;
          let reviewIndex = params.questions.length;
          let returnToReview = false;
          let editMode: EditMode;
          let editError: string | undefined;
          let cachedWidth: number | undefined;
          let cachedLines: string[] | undefined;
          let settled = false;
          const answers: Array<AskUserAnswer | undefined> = Array.from({
            length: params.questions.length,
          });
          const customDrafts = new Map<string, string>();
          const noteDrafts = new Map<string, string>();

          const editorTheme: EditorTheme = {
            borderColor: (text) => theme.fg("accent", text),
            selectList: {
              selectedPrefix: (text) => theme.fg("accent", text),
              selectedText: (text) => theme.fg("accent", text),
              description: (text) => theme.fg("muted", text),
              scrollInfo: (text) => theme.fg("dim", text),
              noMatch: (text) => theme.fg("warning", text),
            },
          };
          const editor = new Editor(tui, editorTheme);
          let pendingPaste:
            | { mode: "collecting"; buffer: string; baseBytes: number }
            | { mode: "discarding"; tail: string }
            | undefined;

          const question = () => params.questions[questionIndex]!;
          const options = (): DisplayOption[] => [
            ...question().options,
            {
              label: "Write my own answer…",
              description:
                "Submit it blank to ask for a clearer or split question.",
              isOther: true,
            },
          ];
          const noteDraftKey = (questionId: string, optionLabel: string) =>
            `${questionId}\u0000${optionLabel}`;

          function refresh() {
            cachedWidth = undefined;
            cachedLines = undefined;
            tui.requestRender();
          }

          function showDraftLimitError() {
            editError = `Answer drafts are limited to ${MAX_ANSWER_DRAFT_UTF8_BYTES} UTF-8 bytes.`;
          }

          function applyEditorInput(data: string) {
            const previous = editor.getExpandedText();
            if (!prospectiveAnswerDraftFits(previous, data)) {
              showDraftLimitError();
              return;
            }
            editor.handleInput(sanitizeAnswerDraftEditorInput(data));
            const next = editor.getExpandedText();
            if (!answerDraftFits(next)) {
              if (longerThanAnswerDraftLimit(next, previous)) {
                editor.setText(previous);
              }
              showDraftLimitError();
              return;
            }
            const safeNext = sanitizeTerminalText(next);
            if (safeNext !== next) editor.setText(safeNext);
            editError = undefined;
          }

          function applyEditorInputRange(
            source: string,
            start: number,
            end: number,
          ) {
            if (start >= end) return;
            const remainingBytes =
              MAX_ANSWER_DRAFT_UTF8_BYTES -
              answerDraftByteLength(editor.getExpandedText());
            const prefix = boundedUtf8PrefixEnd(
              source,
              start,
              end,
              Math.max(0, remainingBytes),
            );
            if (remainingBytes < 0 || prefix.exceeded) {
              showDraftLimitError();
              return;
            }
            applyEditorInput(source.slice(start, end));
          }

          function handleEditorInput(data: string) {
            let offset = 0;
            while (offset < data.length || pendingPaste) {
              if (pendingPaste?.mode === "collecting") {
                const state = pendingPaste;
                const available =
                  MAX_ANSWER_DRAFT_UTF8_BYTES -
                  state.baseBytes -
                  answerDraftByteLength(state.buffer);
                const prefix = boundedUtf8PrefixEnd(
                  data,
                  offset,
                  data.length,
                  Math.max(0, available),
                );
                // Include only a marker-sized lookahead. The probe stays
                // bounded even when this input event carries megabytes.
                const probeEnd = Math.min(
                  data.length,
                  prefix.end + BRACKETED_PASTE_END.length,
                );
                const probe = state.buffer + data.slice(offset, probeEnd);
                const endIndex = probe.indexOf(BRACKETED_PASTE_END);
                if (endIndex >= 0) {
                  const content = probe.slice(0, endIndex);
                  const consumed =
                    endIndex + BRACKETED_PASTE_END.length - state.buffer.length;
                  offset += Math.max(0, consumed);
                  pendingPaste = undefined;
                  if (
                    state.baseBytes + answerDraftByteLength(content) >
                    MAX_ANSWER_DRAFT_UTF8_BYTES
                  ) {
                    showDraftLimitError();
                  } else {
                    applyEditorInput(
                      `${BRACKETED_PASTE_START}${content}${BRACKETED_PASTE_END}`,
                    );
                  }
                  continue;
                }

                if (available < 0 || prefix.exceeded) {
                  showDraftLimitError();
                  const endInChunk = data.indexOf(BRACKETED_PASTE_END, offset);
                  if (endInChunk >= 0) {
                    pendingPaste = undefined;
                    offset = endInChunk + BRACKETED_PASTE_END.length;
                    continue;
                  }
                  pendingPaste = {
                    mode: "discarding",
                    tail: data.slice(
                      Math.max(
                        offset,
                        data.length - (BRACKETED_PASTE_END.length - 1),
                      ),
                    ),
                  };
                  return;
                }

                // The entire remainder fits; append only this bounded slice.
                state.buffer += data.slice(offset);
                return;
              }

              if (pendingPaste?.mode === "discarding") {
                const state = pendingPaste;
                const headEnd = Math.min(
                  data.length,
                  offset + BRACKETED_PASTE_END.length - 1,
                );
                const boundary = state.tail + data.slice(offset, headEnd);
                const boundaryEnd = boundary.indexOf(BRACKETED_PASTE_END);
                if (boundaryEnd >= 0) {
                  offset += Math.max(
                    0,
                    boundaryEnd +
                      BRACKETED_PASTE_END.length -
                      state.tail.length,
                  );
                  pendingPaste = undefined;
                  continue;
                }

                const endInChunk = data.indexOf(BRACKETED_PASTE_END, offset);
                if (endInChunk >= 0) {
                  offset = endInChunk + BRACKETED_PASTE_END.length;
                  pendingPaste = undefined;
                  continue;
                }
                state.tail = data.slice(
                  Math.max(
                    offset,
                    data.length - (BRACKETED_PASTE_END.length - 1),
                  ),
                );
                return;
              }

              const startIndex = data.indexOf(BRACKETED_PASTE_START, offset);
              if (startIndex < 0) {
                applyEditorInputRange(data, offset, data.length);
                return;
              }
              applyEditorInputRange(data, offset, startIndex);
              pendingPaste = {
                mode: "collecting",
                buffer: "",
                baseBytes: answerDraftByteLength(editor.getExpandedText()),
              };
              offset = startIndex + BRACKETED_PASTE_START.length;
            }
          }

          function finish(result: SelectionResult) {
            if (settled) return;
            settled = true;
            uiSignal.removeEventListener("abort", cancel);
            done(result);
          }

          function cancel() {
            finish(null);
          }

          function completeAnswers() {
            if (answers.some((answer) => !answer)) return;
            finish(answers.filter((answer) => answer !== undefined));
          }

          function showReview() {
            pendingPaste = undefined;
            screen = "review";
            reviewIndex = params.questions.length;
            returnToReview = false;
            editMode = undefined;
            editError = undefined;
            editor.setText("");
            refresh();
          }

          function editQuestion(index: number) {
            screen = "question";
            questionIndex = index;
            returnToReview = true;
            editMode = undefined;
            editError = undefined;
            editor.setText("");
            const answer = answers[index];
            const currentOptions = options();
            if (answer?.custom !== undefined || answer?.rephrase) {
              optionIndex = currentOptions.length - 1;
            } else if (answer?.selected) {
              const selectedIndex = question().options.findIndex(
                (option) => option.label === answer.selected,
              );
              optionIndex = Math.max(0, selectedIndex);
            } else {
              optionIndex = 0;
            }
            refresh();
          }

          function advance(answer: AskUserAnswer) {
            answers[questionIndex] = answer;
            if (
              returnToReview ||
              questionIndex === params.questions.length - 1
            ) {
              showReview();
              return;
            }
            questionIndex++;
            optionIndex = 0;
            editMode = undefined;
            editor.setText("");
            refresh();
          }

          function rememberEditorDraft() {
            if (!editMode) return;
            const current = question();
            const selected = options()[optionIndex];
            const text = sanitizeTerminalText(editor.getExpandedText());
            if (editMode === "custom") {
              customDrafts.set(current.id, text);
            } else if (selected && !selected.isOther) {
              noteDrafts.set(noteDraftKey(current.id, selected.label), text);
            }
          }

          function startEditing(mode: Exclude<EditMode, undefined>) {
            pendingPaste = undefined;
            const current = question();
            const selected = options()[optionIndex];
            if (!selected) return;
            editMode = mode;
            editError = undefined;
            if (mode === "custom") {
              editor.setText(
                customDrafts.get(current.id) ??
                  answers[questionIndex]?.custom ??
                  "",
              );
            } else if (!selected.isOther) {
              const existing = answers[questionIndex];
              editor.setText(
                noteDrafts.get(noteDraftKey(current.id, selected.label)) ??
                  (existing?.selected === selected.label
                    ? (existing.note ?? "")
                    : ""),
              );
            }
            refresh();
          }

          editor.onSubmit = (value) => {
            const safeValue = sanitizeTerminalText(value);
            if (!answerDraftFits(value)) {
              // Normal input is rejected before Editor stores an oversized
              // paste. Fail closed for alternate editor paths too, without
              // putting raw or over-limit text back into the renderer.
              editor.setText(answerDraftFits(safeValue) ? safeValue : "");
              editError = `Answer drafts are limited to ${MAX_ANSWER_DRAFT_UTF8_BYTES} UTF-8 bytes.`;
              refresh();
              return;
            }
            const text = safeValue.trim();
            const current = question();
            const selected = options()[optionIndex];
            if (editMode === "custom") {
              customDrafts.set(current.id, safeValue);
              advance(
                text
                  ? { id: current.id, custom: text }
                  : { id: current.id, rephrase: true },
              );
            } else if (selected && !selected.isOther) {
              noteDrafts.set(
                noteDraftKey(current.id, selected.label),
                safeValue,
              );
              advance({
                id: current.id,
                selected: selected.label,
                ...(text ? { note: text } : {}),
              });
            }
          };

          uiSignal.addEventListener("abort", cancel, { once: true });
          if (uiSignal.aborted) queueMicrotask(cancel);

          function selectOption(index: number) {
            const selected = options()[index];
            if (!selected) return;
            optionIndex = index;
            if (selected.isOther) {
              startEditing("custom");
              return;
            }
            const existing = answers[questionIndex];
            advance({
              id: question().id,
              selected: selected.label,
              ...(existing?.selected === selected.label && existing.note
                ? { note: existing.note }
                : {}),
            });
          }

          function handleReviewInput(data: string) {
            const rowCount = params.questions.length + 1;
            if (matchesKey(data, Key.up)) {
              reviewIndex = (reviewIndex - 1 + rowCount) % rowCount;
              refresh();
              return;
            }
            if (matchesKey(data, Key.down)) {
              reviewIndex = (reviewIndex + 1) % rowCount;
              refresh();
              return;
            }
            if (
              data.length === 1 &&
              data >= "1" &&
              data <= String(params.questions.length)
            ) {
              editQuestion(Number(data) - 1);
              return;
            }
            if (matchesKey(data, Key.enter)) {
              if (reviewIndex === params.questions.length) {
                completeAnswers();
              } else {
                editQuestion(reviewIndex);
              }
              return;
            }
            if (matchesKey(data, Key.escape)) finish(null);
          }

          function handleInput(data: string) {
            if (editMode) {
              if (matchesKey(data, Key.escape)) {
                pendingPaste = undefined;
                rememberEditorDraft();
                editMode = undefined;
                editError = undefined;
                editor.setText("");
                refresh();
                return;
              }
              // Route bracketed paste ourselves so split chunks are bounded
              // before Pi's Editor can accumulate an unbounded pasteBuffer.
              handleEditorInput(data);
              refresh();
              return;
            }

            if (screen === "review") {
              handleReviewInput(data);
              return;
            }

            const currentOptions = options();
            if (matchesKey(data, Key.up)) {
              optionIndex =
                (optionIndex - 1 + currentOptions.length) %
                currentOptions.length;
              refresh();
              return;
            }
            if (matchesKey(data, Key.down)) {
              optionIndex = (optionIndex + 1) % currentOptions.length;
              refresh();
              return;
            }
            if (matchesKey(data, Key.tab)) {
              const selected = currentOptions[optionIndex];
              if (selected && !selected.isOther) startEditing("notes");
              return;
            }
            if (
              data.length === 1 &&
              data >= "1" &&
              data <= String(currentOptions.length)
            ) {
              selectOption(Number(data) - 1);
              return;
            }
            if (matchesKey(data, Key.enter)) {
              selectOption(optionIndex);
              return;
            }
            if (matchesKey(data, Key.escape)) finish(null);
          }

          function render(width: number): string[] {
            if (cachedLines && cachedWidth === width) return cachedLines;
            const lines: string[] = [];
            const add = (text: string) =>
              lines.push(truncateToWidth(text, width));

            if (screen === "review") {
              const title = " Review answers ";
              add(
                theme.fg(
                  "accent",
                  `─${title}${"─".repeat(Math.max(0, width - title.length - 1))}`,
                ),
              );
              add(
                ` ${theme.fg("text", theme.bold("Check every answer before submitting"))}`,
              );
              lines.push("");
              for (let index = 0; index < params.questions.length; index++) {
                const selected = reviewIndex === index;
                const prefix = selected ? theme.fg("accent", " ❯ ") : "   ";
                const current = params.questions[index]!;
                const header = safeSingleLine(current.header);
                add(
                  `${prefix}${theme.fg(selected ? "accent" : "text", `${index + 1}. ${header}`)}${theme.fg("muted", ` — ${formatReviewAnswer(answers[index])}`)}`,
                );
              }
              lines.push("");
              const submitSelected = reviewIndex === params.questions.length;
              add(
                `${submitSelected ? theme.fg("accent", " ❯ ") : "   "}${theme.fg(submitSelected ? "accent" : "success", "✓ Submit answers")}`,
              );
              lines.push("");
              add(
                theme.fg(
                  "dim",
                  ` ↑↓ choose • 1-${params.questions.length} edit answer • Enter open/submit • Esc dismiss`,
                ),
              );
              add(theme.fg("accent", "─".repeat(width)));
              cachedWidth = width;
              cachedLines = lines;
              return lines;
            }

            const current = question();
            const currentOptions = options();
            const progress = `${questionIndex + 1}/${params.questions.length}`;
            const title = ` ${safeSingleLine(current.header)} · ${progress} `;
            add(
              theme.fg(
                "accent",
                `─${title}${"─".repeat(Math.max(0, width - title.length - 1))}`,
              ),
            );
            for (const line of wrapText(
              current.question,
              Math.max(10, width - 2),
            )) {
              add(` ${theme.fg("text", theme.bold(line))}`);
            }
            lines.push("");

            for (let i = 0; i < currentOptions.length; i++) {
              const option = currentOptions[i]!;
              const selected = i === optionIndex;
              const prefix = selected ? theme.fg("accent", " ❯ ") : "   ";
              const marker = option.isOther ? "✎" : `${i + 1}.`;
              const label = `${marker} ${safeSingleLine(option.label)}`;
              add(
                prefix +
                  theme.fg(
                    selected ? "accent" : option.isOther ? "muted" : "text",
                    label,
                  ),
              );
              if (option.description) {
                for (const line of wrapText(
                  option.description,
                  Math.max(10, width - 7),
                )) {
                  add(`      ${theme.fg("muted", line)}`);
                }
              }
            }

            // Preview for the highlighted option: a concrete artifact the
            // user compares against the other options. Rendered verbatim
            // (indentation preserved, hard-truncated) because re-wrapping
            // would destroy code and ASCII layouts.
            const preview = currentOptions[optionIndex]?.preview;
            if (preview) {
              lines.push("");
              add(theme.fg("muted", " ┌ preview"));
              const inner = Math.max(10, width - 4);
              const previewLines = sanitizeTerminalText(preview).split("\n");
              const shown = previewLines.slice(0, PREVIEW_MAX_LINES);
              for (const raw of shown) {
                const line = formatPreviewLine(raw, inner);
                add(` ${theme.fg("muted", "│")} ${theme.fg("text", line)}`);
              }
              const hidden = previewLines.length - shown.length;
              if (hidden > 0) {
                add(
                  ` ${theme.fg("muted", "│")} ${theme.fg("dim", `… ${hidden} more line${hidden === 1 ? "" : "s"}`)}`,
                );
              }
              add(theme.fg("muted", " └"));
            }

            if (editMode) {
              lines.push("");
              add(
                theme.fg(
                  "muted",
                  editMode === "notes"
                    ? ` Notes for “${safeSingleLine(currentOptions[optionIndex]?.label ?? "")}”:`
                    : " Your answer:",
                ),
              );
              for (const line of editor.render(Math.max(1, width - 2))) {
                add(` ${line}`);
              }
              if (editError) add(` ${theme.fg("error", editError)}`);
            }

            lines.push("");
            add(
              theme.fg(
                "dim",
                editMode
                  ? " Enter save answer • Esc keep draft and return"
                  : ` ↑↓ or 1-${currentOptions.length} select • Tab add notes • Enter save draft answer • Esc dismiss`,
              ),
            );
            add(theme.fg("accent", "─".repeat(width)));
            cachedWidth = width;
            cachedLines = lines;
            return lines;
          }

          const component: Focusable & {
            render(width: number): string[];
            invalidate(): void;
            handleInput(data: string): void;
            dispose(): void;
          } = {
            get focused() {
              return editor.focused;
            },
            set focused(value: boolean) {
              editor.focused = value;
            },
            render,
            invalidate: () => {
              cachedWidth = undefined;
              cachedLines = undefined;
              editor.invalidate();
            },
            handleInput,
            dispose: () => {
              uiSignal.removeEventListener("abort", cancel);
            },
          };
          return component;
        });

      const uiExit = await Effect.runPromiseExit(
        Effect.tryPromise((uiSignal) =>
          ctx.mode === "tui"
            ? showQuestionsInTui(uiSignal)
            : showQuestionsWithDialogs(ctx, params.questions, uiSignal),
        ),
        signal ? { signal } : undefined,
      );
      if (Exit.isFailure(uiExit)) {
        if (Cause.hasInterruptsOnly(uiExit.cause)) {
          return reply(buildAskUserResultMessage({ kind: "cancelled" }));
        }
        const [first] = Cause.prettyErrors(uiExit.cause);
        throw new Error(first?.message ?? Cause.pretty(uiExit.cause));
      }

      const answers = uiExit.value;
      if (!answers) {
        return reply(buildAskUserResultMessage({ kind: "dismissed" }));
      }
      return reply(
        buildAskUserResultMessage({ kind: "answered", answers }),
        answers,
      );
    },

    renderCall(args, theme) {
      const questions = Array.isArray(args.questions) ? args.questions : [];
      let text = theme.fg("toolTitle", theme.bold("ask_user "));
      text += theme.fg(
        "muted",
        `${questions.length} question${questions.length === 1 ? "" : "s"}`,
      );
      for (const question of questions.slice(0, MAX_QUESTIONS)) {
        if (
          question &&
          typeof question === "object" &&
          "question" in question &&
          typeof question.question === "string"
        ) {
          text += `\n${theme.fg("dim", `  ${safeSingleLine(question.question)}`)}`;
        }
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as AskUserDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(
          first?.type === "text" ? sanitizeTerminalText(first.text) : "",
          0,
          0,
        );
      }
      if (details.cancelled) {
        return new Text(theme.fg("warning", "✗ dismissed"), 0, 0);
      }
      return new Text(
        theme.fg("success", "✓ answered") +
          `\n${theme.fg("muted", formatAnswers(details.answers))}`,
        0,
        0,
      );
    },
  });

  pi.registerTool(createHumanHandoffToolDefinition());
}
