import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import {
  fitNavigationSides,
  renderNavigationMetrics,
  type BelowEditorStripState,
} from "../shared/below-editor-navigation.ts";
import {
  unreadActivityCounts,
  type ActivityCounts,
} from "../shared/activity-status.ts";
import { spinnerFrame } from "../shared/spinner.ts";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import { formatElapsed, type SubagentSnapshot } from "./src/domain.ts";
import { contextPercent } from "./src/format.ts";

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

/**
 * One status indicator per run state; doubles as the focus marker when
 * selected. Running spins, in step with the dashboard and takeover headers.
 */
function statusGlyph(snapshot: SubagentSnapshot, theme: Theme, now: number) {
  if (snapshot.status === "running")
    return theme.fg("warning", spinnerFrame(now));
  if (snapshot.status === "done") return theme.fg("success", "✓");
  return theme.fg("error", "x");
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
    const glyph = this.strip.focused
      ? this.theme.fg("accent", "❯")
      : statusGlyph(snapshot, this.theme, Date.now());
    const titleText = normalizeSubagentTitle(snapshot.title, snapshot.id);
    const title = this.strip.focused
      ? this.theme.bold(this.theme.fg("accent", titleText))
      : this.theme.fg("text", titleText);
    // The footer already shows the session model; the takeover view keeps the
    // per-subagent model, so the one-line strip stays title-only.
    const left = ` ${glyph} ${title}`;
    // Worded counts read at a glance; the selected run's own state comes
    // first so the emphasis colour always lands on the matching count.
    const donePart = counts.done > 0 ? `${counts.done} done` : undefined;
    const failedPart =
      counts.failed > 0 ? `${counts.failed} failed` : undefined;
    const activity =
      counts.running > 0
        ? [`${counts.running} running`]
        : snapshot.status === "error"
          ? [failedPart, donePart]
          : [donePart, failedPart];
    const percent = contextPercent(snapshot.usage);
    const right = renderNavigationMetrics(
      this.theme,
      [
        ...activity,
        formatElapsed(snapshot),
        percent === undefined ? undefined : `${percent}% ctx`,
      ],
      this.strip.focused ? "enter open · ↑ back" : "↓ to manage",
      snapshot.status === "running" ? undefined : statusColor(snapshot.status),
    );
    return [fitNavigationSides(left, right, width)];
  }
}
