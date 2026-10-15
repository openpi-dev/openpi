import type { AskUserAnswer, AskUserInput } from "../../extensions/ask-user/index.ts";
import { answerDraftFits } from "../../extensions/ask-user/limits.ts";
import { sanitizeTerminalText } from "../../extensions/shared/terminal-text.ts";
import type { WebHandoffPresentation } from "../../extensions/ask-user/web-bridge.ts";

export type WebQuestions = AskUserInput["questions"];
export type WebQuestionAnswers = AskUserAnswer[];

export interface WebQuestionRequest {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  expiresAt: number;
  questions: WebQuestions;
  handoff?: WebHandoffPresentation;
}

export function validHandoff(handoff: WebHandoffPresentation) {
  return boundedText(handoff.title, 80) && boundedText(handoff.instructions, 2000) && boundedText(handoff.completionSignal, 500);
}

export type WebQuestionState = "answered" | "dismissed" | "cancelled" | "expired" | "stale";
export interface WebQuestionReceipt {
  state: WebQuestionState;
  replayed?: boolean;
}

export const WEB_QUESTION_BODY_BYTES = 64 * 1024;
export const WEB_QUESTION_TIMEOUT_MS = 15 * 60 * 1000;

export function isWebControllerId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function boundedText(value: unknown, max: number, empty = false): value is string {
  return typeof value === "string" && value.length <= max && (empty || value.trim().length > 0);
}

/** Revalidate the boundary even if the Pi tool schema already admitted it. */
export function validateWebQuestions(questions: WebQuestions) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 3) return false;
  return new Set(questions.map((q) => q?.id)).size === questions.length && questions.every((q) =>
    q && boundedText(q.id, 80) && boundedText(q.header, 80) && boundedText(q.question, 2000) &&
    Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 5 &&
    q.options.every((o) => o && boundedText(o.label, 120) && boundedText(o.description, 500) &&
      (o.preview === undefined || boundedText(o.preview, 2000, true))) &&
    new Set(q.options.map((o) => o.label)).size === q.options.length,
  );
}

/** Browser answers never choose arbitrary labels or manufacture question IDs. */
export function parseWebQuestionAnswers(questions: WebQuestions, input: unknown) {
  if (!Array.isArray(input) || input.length !== questions.length) return undefined;
  const answers: WebQuestionAnswers = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const raw: unknown = input[i];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const a = raw as Record<string, unknown>;
    if (a.id !== q.id || Object.keys(a).some((key) => !["id", "selected", "custom", "note", "rephrase"].includes(key))) return undefined;
    const modes = Number(a.selected !== undefined) + Number(a.custom !== undefined) + Number(a.rephrase !== undefined);
    if (modes !== 1) return undefined;
    if (a.selected !== undefined) {
      if (!q.options.some((o) => o.label === a.selected)) return undefined;
      if (a.note !== undefined && (typeof a.note !== "string" || !answerDraftFits(a.note))) return undefined;
      const note = typeof a.note === "string" ? sanitizeTerminalText(a.note).trim() : "";
      answers.push({ id: q.id, selected: a.selected as string, ...(note ? { note } : {}) });
    } else if (a.custom !== undefined) {
      if (a.note !== undefined || typeof a.custom !== "string" || !answerDraftFits(a.custom)) return undefined;
      const custom = sanitizeTerminalText(a.custom).trim();
      answers.push(custom ? { id: q.id, custom } : { id: q.id, rephrase: true });
    } else {
      if (a.rephrase !== true || a.note !== undefined) return undefined;
      answers.push({ id: q.id, rephrase: true });
    }
  }
  return answers;
}
