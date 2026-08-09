import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  fitNavigationSides,
  type BelowEditorStripState,
} from "../shared/below-editor-navigation.ts";
import {
  unreadActivityCounts,
  type ActivityCounts,
} from "../shared/activity-status.ts";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import { formatElapsed, type SubagentSnapshot } from "./src/domain.ts";
import { formatContextUtilization } from "./src/format.ts";

export interface SubagentStripEntry {
  snapshot: SubagentSnapshot;
  counts: ActivityCounts;
}

function cleanLine(value: string) {
  return sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
}

/** Normalize every title before it enters snapshots, artifacts, or the TUI. */
export function normalizeSubagentTitle(value: string, fallback = "subagent") {
  return cleanLine(value).slice(0, 160) || fallback;
}

/** Prefer the newest running child, then the newest unread settled child. */
export function selectSubagentStripEntry(
  snapshots: readonly SubagentSnapshot[],
  acknowledgedAt: number,
): SubagentStripEntry | undefined {
  const counts = unreadActivityCounts(snapshots, acknowledgedAt);
  const visible = snapshots.filter(
    (snapshot) =>
      snapshot.status === "running" ||
      snapshot.settledAt === undefined ||
      snapshot.settledAt >= acknowledgedAt,
  );
  const candidates = visible.some((snapshot) => snapshot.status === "running")
    ? visible.filter((snapshot) => snapshot.status === "running")
    : visible;
  let selected: SubagentSnapshot | undefined;
  for (const snapshot of candidates) {
    const timestamp = snapshot.settledAt ?? snapshot.createdAt;
    const selectedTimestamp = selected
      ? (selected.settledAt ?? selected.createdAt)
      : -Infinity;
    if (timestamp >= selectedTimestamp) selected = snapshot;
  }
  return selected ? { snapshot: selected, counts } : undefined;
}

function statusColor(status: SubagentSnapshot["status"]) {
  if (status === "running") return "warning" as const;
  if (status === "done") return "success" as const;
  return "error" as const;
}

function statusSquare(snapshot: SubagentSnapshot, theme: Theme) {
  return theme.fg(statusColor(snapshot.status), "■");
}

/** One-line subagent manager entry with the same affordance as Workflow. */
export class SubagentStripWidget {
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly strip: BelowEditorStripState;
  private readonly getEntry: () => SubagentStripEntry | undefined;

  constructor(
    tui: TUI,
    theme: Theme,
    strip: BelowEditorStripState,
    getEntry: () => SubagentStripEntry | undefined,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.strip = strip;
    this.getEntry = getEntry;
    this.timer = setInterval(() => this.tui.requestRender(), 500);
    this.timer.unref?.();
  }

  dispose() {
    clearInterval(this.timer);
  }

  invalidate() {}

  render(width: number) {
    const entry = this.getEntry();
    if (!entry || width <= 0) return [];
    const { snapshot, counts } = entry;
    const marker = this.strip.focused
      ? this.theme.fg("accent", "❯")
      : this.theme.fg("dim", "○");
    const titleText = normalizeSubagentTitle(snapshot.title, snapshot.id);
    const title = this.strip.focused
      ? this.theme.bold(this.theme.fg("accent", titleText))
      : this.theme.fg("text", titleText);
    const model = snapshot.meta.modelLabel
      ? cleanLine(snapshot.meta.modelLabel)
      : undefined;
    const left = ` ${marker} ${statusSquare(snapshot, this.theme)} ${title}${model ? this.theme.fg("dim", ` · ${model}`) : ""}`;
    const settled = counts.done + counts.failed;
    const total = counts.running + settled;
    const metrics = [
      `${settled}/${total} agents`,
      formatElapsed(snapshot),
      formatContextUtilization(snapshot.usage),
      this.strip.focused ? "enter open · ↑ back" : "↓ to manage",
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    const right = this.theme.fg(statusColor(snapshot.status), metrics);
    return [fitNavigationSides(left, right, width)];
  }
}
