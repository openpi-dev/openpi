// Match the manager's existing transcript text limit; canonical Pi tool results
// remain intact. Only the normalized event's single-line preview is bounded.
const TOOL_PREVIEW_MAX_LENGTH = 64 * 1_024;

function firstMeaningfulLine(text: string) {
  // Search only until the first non-whitespace character. Unlike splitting the
  // entire log, this preserves blank-line behavior without visiting its tail.
  const start = text.search(/\S/);
  if (start < 0) return undefined;
  const prefix = text.slice(start, start + TOOL_PREVIEW_MAX_LENGTH);
  const newline = prefix.indexOf("\n");
  return (newline < 0 ? prefix : prefix.slice(0, newline)).trimEnd();
}

/** First meaningful line of a tool result, without splitting accumulated logs. */
export function toolPreview(value: unknown) {
  if (typeof value === "string") return firstMeaningfulLine(value);
  if (!value || typeof value !== "object") return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") continue;
    const firstLine = firstMeaningfulLine(record.text);
    if (firstLine) return firstLine;
  }
  return undefined;
}
