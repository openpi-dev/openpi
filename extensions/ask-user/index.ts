/**
 * ask_user — structured root-agent questions with a focused TUI.
 *
 * - 1 to 3 independent questions per call, shown one at a time
 * - 2 to 5 options per question, plus an automatic free-form option
 * - Enter accepts an option; Tab adds optional notes to the highlighted option
 * - Esc returns from editing or dismisses the whole request
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  type Focusable,
} from "@earendil-works/pi-tui";
import { Cause, Effect, Exit } from "effect";
import { Type, type Static } from "typebox";
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
}

interface AskUserDetails {
  questions: string[];
  answers: AskUserAnswer[];
  cancelled: boolean;
}

type SelectionResult = AskUserAnswer[] | null;
type EditMode = "notes" | "custom" | undefined;

interface DisplayOption {
  label: string;
  description?: string;
  /** Optional artifact shown while this option is highlighted. */
  preview?: string;
  isOther?: boolean;
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > width && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

export function formatAnswers(answers: readonly AskUserAnswer[]) {
  return answers
    .map((answer) => {
      const value = answer.custom ?? answer.selected ?? "(unanswered)";
      return `${answer.id}: ${value}${answer.note ? ` — ${answer.note}` : ""}`;
    })
    .join("\n");
}

export default function askUser(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: ASK_USER_TOOL_DESCRIPTION,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
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
      }

      if (ctx.mode !== "tui") {
        return reply(buildAskUserResultMessage({ kind: "no-ui" }));
      }
      if (signal?.aborted) {
        return reply(buildAskUserResultMessage({ kind: "cancelled" }));
      }

      const showQuestions = (uiSignal: AbortSignal) =>
        ctx.ui.custom<SelectionResult>((tui, theme, _kb, done) => {
          let questionIndex = 0;
          let optionIndex = 0;
          let editMode: EditMode;
          let cachedLines: string[] | undefined;
          let settled = false;
          const answers: AskUserAnswer[] = [];

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

          const question = () => params.questions[questionIndex]!;
          const options = (): DisplayOption[] => [
            ...question().options,
            { label: "Write my own answer…", isOther: true },
          ];

          function refresh() {
            cachedLines = undefined;
            tui.requestRender();
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

          function advance(answer: AskUserAnswer) {
            answers.push(answer);
            if (questionIndex === params.questions.length - 1) {
              finish(answers);
              return;
            }
            questionIndex++;
            optionIndex = 0;
            editMode = undefined;
            editor.setText("");
            refresh();
          }

          editor.onSubmit = (value) => {
            const text = value.trim();
            if (!text) return;
            const current = question();
            if (editMode === "custom") {
              advance({ id: current.id, custom: text });
            } else {
              const selected = options()[optionIndex];
              if (!selected || selected.isOther) return;
              advance({ id: current.id, selected: selected.label, note: text });
            }
          };

          uiSignal.addEventListener("abort", cancel, { once: true });
          if (uiSignal.aborted) queueMicrotask(cancel);

          function selectOption(index: number) {
            const selected = options()[index];
            if (!selected) return;
            optionIndex = index;
            if (selected.isOther) {
              editMode = "custom";
              editor.setText("");
              refresh();
              return;
            }
            advance({ id: question().id, selected: selected.label });
          }

          function handleInput(data: string) {
            if (editMode) {
              if (matchesKey(data, Key.escape)) {
                editMode = undefined;
                editor.setText("");
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
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
              if (selected && !selected.isOther) {
                editMode = "notes";
                editor.setText("");
                refresh();
              }
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
            if (cachedLines) return cachedLines;
            const current = question();
            const currentOptions = options();
            const lines: string[] = [];
            const add = (text: string) =>
              lines.push(truncateToWidth(text, width));

            const progress = `${questionIndex + 1}/${params.questions.length}`;
            const title = ` ${current.header} · ${progress} `;
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
              const label = `${marker} ${option.label}`;
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
              for (const raw of preview.split("\n").slice(0, 20)) {
                const line =
                  raw.length > inner ? `${raw.slice(0, inner - 1)}…` : raw;
                add(` ${theme.fg("muted", "│")} ${theme.fg("text", line)}`);
              }
              add(theme.fg("muted", " └"));
            }

            if (editMode) {
              lines.push("");
              add(
                theme.fg(
                  "muted",
                  editMode === "notes"
                    ? ` Notes for “${currentOptions[optionIndex]?.label ?? ""}”:`
                    : " Your answer:",
                ),
              );
              for (const line of editor.render(Math.max(1, width - 2))) {
                add(` ${line}`);
              }
            }

            lines.push("");
            add(
              theme.fg(
                "dim",
                editMode
                  ? " Enter submit • Esc back to options"
                  : ` ↑↓ or 1-${currentOptions.length} select • Tab add notes • Enter confirm • Esc dismiss`,
              ),
            );
            add(theme.fg("accent", "─".repeat(width)));
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
        Effect.tryPromise(showQuestions),
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
          text += `\n${theme.fg("dim", `  ${question.question}`)}`;
        }
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as AskUserDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
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
}
