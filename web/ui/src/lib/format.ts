import type { WebSessionSummary } from "../../../protocol/types.ts";

export function sessionTitle(
  session: Partial<WebSessionSummary>,
  fallback: string,
) {
  return session.name?.trim() || session.firstMessage?.trim() || fallback;
}

export function workspaceName(path: string) {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) || path;
}

export function compactSummary(value: unknown, limit = 96) {
  const text = String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function relativeTime(value: string) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return "";
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

export function formatTurnTime(timestamp?: string) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function formatElapsedMs(start?: number, end = Date.now()) {
  if (typeof start !== "number") return "";
  const totalSeconds = Math.max(0, Math.round((end - start) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m${String(seconds).padStart(2, "0")}s`
    : `${seconds}s`;
}

export function turnTitle(content: string) {
  const line =
    content
      .split("\n")
      .map((part) => part.trim())
      .find(Boolean) ?? "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}
