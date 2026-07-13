import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Theme = ExtensionContext["ui"]["theme"];

interface ActivityCounts {
  running: number;
  done: number;
  failed: number;
}

const SQUARE = "■";

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
