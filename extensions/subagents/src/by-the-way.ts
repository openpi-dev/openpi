import type { SubagentOrigin } from "./domain.ts";

export const BTW_TITLE_MAX_LENGTH = 60;

/** Build a compact dashboard title from the first non-empty prompt line. */
export function deriveBtwTitle(prompt: string) {
  const firstLine = prompt
    .split("\n")
    .find((line) => line.trim())
    ?.trim();
  const title = firstLine?.replace(/\s+/g, " ") ?? "";
  if (!title) return "by the way";
  if (title.length <= BTW_TITLE_MAX_LENGTH) return title;
  return `${title.slice(0, BTW_TITLE_MAX_LENGTH - 1)}…`;
}

/** User asides remain visible in the dashboard but hidden from model tools. */
export function isModelVisible(snap: { readonly origin: SubagentOrigin }) {
  return snap.origin === "model";
}

