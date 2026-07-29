import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Theme = ExtensionContext["ui"]["theme"];

interface ActivityCounts {
  running: number;
  done: number;
  failed: number;
}

const SQUARE = "■";

/**
 * Settled work is an unread notice, not a session tally: `done`/`failed` stay
 * visible until the user's next explicit request acknowledges them, while
 * running work is always reported. `acknowledgedAt` is the timestamp of that
 * last explicit request. A settled item without a timestamp stays unread
 * rather than being silently swallowed.
 */
export function unreadActivityCounts(
  items: readonly {
    readonly status: "running" | "done" | "error";
    readonly settledAt?: number;
  }[],
  acknowledgedAt: number,
): ActivityCounts {
  let running = 0;
  let done = 0;
  let failed = 0;
  for (const item of items) {
    if (item.status === "running") {
      running += 1;
      continue;
    }
    if (item.settledAt !== undefined && item.settledAt <= acknowledgedAt)
      continue;
    if (item.status === "error") failed += 1;
    else done += 1;
  }
  return { running, done, failed };
}

export function hasActivity(counts: ActivityCounts) {
  return counts.running + counts.done + counts.failed > 0;
}

export function formatActivityStatus(
  theme: Theme,
  label: "subagents" | "workflows",
  counts: ActivityCounts,
) {
  const parts: string[] = [];
  if (counts.running > 0) {
    parts.push(theme.fg("warning", `${SQUARE} ${counts.running} running`));
  }
  if (counts.done > 0) {
    parts.push(theme.fg("success", `${SQUARE} ${counts.done} done`));
  }
  if (counts.failed > 0) {
    parts.push(theme.fg("error", `${SQUARE} ${counts.failed} failed`));
  }
  parts.push(theme.fg("accent", `/${label}`) + theme.fg("dim", " to view"));

  return `${theme.fg("muted", `${label}:`)} ${parts.join(theme.fg("dim", " · "))}`;
}
