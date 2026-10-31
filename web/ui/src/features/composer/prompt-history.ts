/**
 * Up/Down recall of earlier prompts in the Composer, matching Pi's TUI editor.
 * History is read from the selected Session's loaded native entries, so it is
 * the same after a reload and never becomes a second store of user input.
 */

import type { WebSnapshot } from "../../../../protocol/types.ts";
import {
  isSetupPromptEcho,
  setupDisplayMessage,
  setupPromptParent,
} from "../../../../protocol/prompt-navigation.ts";

type SessionEntry = NonNullable<
  WebSnapshot["selectedSession"]
>["entries"][number];

export interface PromptHistoryItem {
  readonly entryId: string;
  /** The projected text; incomplete when `truncated` is set. */
  readonly text: string;
  readonly truncated: boolean;
}

/** User prompts on the loaded branch, newest first, consecutive repeats once. */
export function promptHistory(entries: readonly SessionEntry[]) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const items: PromptHistoryItem[] = [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type !== "message" || !entry.message) continue;
    const message = setupDisplayMessage(entry.message);
    if (message.role !== "user") continue;
    // A setup request echoes the command that started it; that is one input.
    const parent = setupPromptParent(entry, (id) => byId.get(id));
    if (isSetupPromptEcho(entry.message, parent)) continue;
    const text = message.content;
    if (!text.trim() || items.at(-1)?.text === text) continue;
    items.push({
      entryId: entry.id,
      text,
      truncated: message.truncation?.visibleText === true,
    });
  }
  return items;
}

export interface PromptHistoryState {
  /** -1 while not browsing; 0 is the most recent prompt. */
  index: number;
  draft?: { prompt: string; caret: number };
  /** The text history last placed in the editor. */
  applied?: string;
}

export const idlePromptHistory = (): PromptHistoryState => ({ index: -1 });

/** Browsing continues only while the editor still holds what history placed. */
export function isBrowsing(state: PromptHistoryState, prompt: string) {
  return state.index >= 0 && state.applied === prompt;
}

/**
 * Whether an arrow key belongs to history rather than caret movement, using
 * the TUI's rule on logical lines: Up from an empty editor, from the very
 * start, or anywhere on the first line while browsing; Down only on the last
 * line while browsing.
 */
export function historyKeyApplies(
  key: "ArrowUp" | "ArrowDown",
  prompt: string,
  selection: { start: number; end: number },
  browsing: boolean,
) {
  if (selection.start !== selection.end) return false;
  if (key === "ArrowUp")
    return (
      !prompt.slice(0, selection.start).includes("\n") &&
      (prompt.length === 0 || selection.start === 0 || browsing)
    );
  return browsing && !prompt.slice(selection.end).includes("\n");
}

/** The next history position, or undefined when the key does nothing. */
export function stepPromptHistory(
  state: PromptHistoryState,
  key: "ArrowUp" | "ArrowDown",
  length: number,
) {
  const next = state.index + (key === "ArrowUp" ? 1 : -1);
  if (next < -1 || next >= length) return undefined;
  return next;
}
