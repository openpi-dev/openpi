import { sanitizeTerminalText } from "../shared/terminal-text.ts";

export const MAX_ANSWER_DRAFT_UTF8_BYTES = 8_000;

function utf8BytesAtMost(value: string, maximum: number) {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
    if (bytes > maximum) return undefined;
  }
  return bytes;
}

export function answerDraftByteLength(value: string) {
  return utf8BytesAtMost(value, Number.POSITIVE_INFINITY)!;
}

export function answerDraftFits(value: string) {
  return utf8BytesAtMost(value, MAX_ANSWER_DRAFT_UTF8_BYTES) !== undefined;
}

export function longerThanAnswerDraftLimit(next: string, previous: string) {
  return answerDraftByteLength(next) > answerDraftByteLength(previous);
}

export const BRACKETED_PASTE_START = "\u001b[200~";
export const BRACKETED_PASTE_END = "\u001b[201~";
// eslint-disable-next-line no-control-regex
const INPUT_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;

function textBearingEditorInput(input: string) {
  if (
    input.startsWith(BRACKETED_PASTE_START) &&
    input.endsWith(BRACKETED_PASTE_END)
  ) {
    return {
      bracketed: true,
      text: input.slice(
        BRACKETED_PASTE_START.length,
        -BRACKETED_PASTE_END.length,
      ),
    };
  }
  // Escape-prefixed values and one-byte controls are editor commands. Other
  // values are text, including non-bracketed multi-line/IME commits.
  if (
    input.startsWith("\u001b") ||
    (input.length === 1 && INPUT_CONTROL_PATTERN.test(input))
  ) {
    return undefined;
  }
  return { bracketed: false, text: input };
}

/** Strip terminal/bidi controls before text-bearing input reaches Editor. */
export function sanitizeAnswerDraftEditorInput(input: string) {
  const insertion = textBearingEditorInput(input);
  if (!insertion) return input;
  const safe = sanitizeTerminalText(insertion.text);
  return insertion.bracketed
    ? `${BRACKETED_PASTE_START}${safe}${BRACKETED_PASTE_END}`
    : safe;
}

/**
 * Reject text-bearing input before Editor stores a bracketed or bulk paste.
 * Small control-key sequences are left to Editor and checked after handling.
 */
export function prospectiveAnswerDraftFits(current: string, input: string) {
  const insertion = textBearingEditorInput(input);
  if (!insertion && !answerDraftFits(input)) {
    // Unknown large control-bearing input must not reach Editor's paste map.
    return false;
  }
  if (!insertion) return true;
  const remaining =
    MAX_ANSWER_DRAFT_UTF8_BYTES - answerDraftByteLength(current);
  return (
    remaining >= 0 && utf8BytesAtMost(insertion.text, remaining) !== undefined
  );
}
