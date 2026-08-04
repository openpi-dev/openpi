import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { TaskItem, TaskSnapshot } from "./tasks.ts";

const STATUS_ICON: Record<TaskItem["status"], string> = {
  pending: "○",
  in_progress: "●",
  blocked: "!",
  done: "✓",
  dropped: "×",
};

const TASK_WIDGET_ORDER: Record<TaskItem["status"], number> = {
  in_progress: 0,
  blocked: 1,
  pending: 2,
  done: 3,
  dropped: 4,
};

export const TASK_WIDGET_LIMIT = 4;

/**
 * A settled item's subject reads as struck-through and dimmed, so a glance at
 * the list separates what is left from what is behind you.
 *
 * Both, not either: SGR 9 is widely but not universally supported, and a
 * terminal that drops it would otherwise render done items identically to
 * open ones. The dim color survives on its own.
 */
function subjectStyle(status: TaskItem["status"], theme: Theme) {
  if (status === "done" || status === "dropped") {
    return (text: string) => theme.strikethrough(theme.fg("dim", text));
  }
  // The one item being worked on is the only thing most glances are looking
  // for, so it is the only one rendered at full weight.
  if (status === "in_progress") {
    return (text: string) => theme.bold(theme.fg("text", text));
  }
  return (text: string) =>
    theme.fg(status === "blocked" ? "text" : "muted", text);
}

const SUMMARY_LABEL: Record<TaskItem["status"], string> = {
  done: "done",
  in_progress: "in progress",
  blocked: "blocked",
  pending: "open",
  dropped: "dropped",
};

/** Order the counts by how far along they are, not by status enum order. */
const SUMMARY_ORDER: TaskItem["status"][] = [
  "done",
  "in_progress",
  "blocked",
  "pending",
  "dropped",
];

/** Census of a whole batch, independent of which rows a view chooses to show. */
export type TaskCounts = Record<TaskItem["status"], number> & { total: number };

export function taskCounts(items: readonly TaskItem[]): TaskCounts {
  const counts: TaskCounts = {
    total: items.length,
    pending: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
    dropped: 0,
  };
  for (const item of items) counts[item.status]++;
  return counts;
}

/**
 * One-line census: `4 tasks (3 done, 1 in progress, 0 open)`.
 *
 * Counts carry the weight and the words recede, so the shape of the batch
 * reads before any individual row does. `done`, `in progress`, and `open` are
 * always listed even at zero — a stable set of three keeps the line from
 * reflowing as work moves between them. `blocked` and `dropped` are
 * exceptional and appear only when they are not zero.
 *
 * Takes counts rather than items because a view often shows a bounded subset
 * of rows; the header must describe the whole batch regardless.
 */
export function renderTaskSummary(counts: TaskCounts, theme: Theme): string {
  const number = (value: number) => theme.bold(theme.fg("text", String(value)));
  const dim = (text: string) => theme.fg("dim", text);
  // Built segment by segment rather than by wrapping the whole line: each
  // styled run emits its own reset, so an outer color would stop applying at
  // the first inner one.
  const parts = SUMMARY_ORDER.filter(
    (status) =>
      status === "done" ||
      status === "in_progress" ||
      status === "pending" ||
      counts[status] > 0,
  ).map((status) => `${number(counts[status])} ${dim(SUMMARY_LABEL[status])}`);
  return [
    number(counts.total),
    " ",
    dim(counts.total === 1 ? "task" : "tasks"),
    " ",
    dim("("),
    parts.join(dim(", ")),
    dim(")"),
  ].join("");
}

export interface TaskToolDetails {
  action: "add" | "update" | "list";
  items: TaskItem[];
  total: number;
  revision: number;
  batchClosed?: boolean;
  /** Census of the whole batch; `items` is only the rows this call touched. */
  counts?: TaskCounts;
}

export function renderTaskRows(
  items: readonly TaskItem[],
  theme: Theme,
  width: number,
) {
  if (items.length === 0) return [theme.fg("dim", "No task items.")];
  // Ids address tasks in tasks_update, so they stay — but right-aligned, so a
  // T10 appearing later never shifts every subject one column over.
  const idWidth = Math.max(...items.map((item) => `T${item.id}`.length), 2);
  return items.flatMap((item) => {
    const color =
      item.status === "done"
        ? "success"
        : item.status === "blocked"
          ? "warning"
          : item.status === "dropped"
            ? "error"
            : item.status === "in_progress"
              ? "accent"
              : "muted";
    // No `[status]` text: the icon, its color, and the subject's own weight
    // already say it, and repeating it in words crowded every row.
    const id = `T${item.id}`.padStart(idWidth);
    const rows = [
      truncateToWidth(
        `${theme.fg(color, STATUS_ICON[item.status])} ${theme.fg("dim", id)} ${subjectStyle(item.status, theme)(item.subject)}`,
        width,
      ),
    ];
    // Continuation lines hang under the subject, not the icon, so the eye
    // follows one left edge down the list.
    const indent = " ".repeat(idWidth + 3);
    if (item.detail) {
      rows.push(
        truncateToWidth(`${indent}${theme.fg("dim", item.detail)}`, width),
      );
    }
    if (item.note) {
      const label =
        item.status === "blocked"
          ? "Blocked"
          : item.status === "done"
            ? "Evidence"
            : item.status === "dropped"
              ? "Reason"
              : "Note";
      rows.push(
        truncateToWidth(
          `${indent}${theme.fg("dim", `${label}:`)} ${theme.fg("muted", item.note)}`,
          width,
        ),
      );
    }
    return rows;
  });
}

export function renderTaskWidget(
  snapshot: TaskSnapshot,
  theme: Theme,
  width: number,
  expanded = false,
) {
  const tracked = snapshot.items.filter((item) => item.status !== "dropped");
  const actionable = tracked
    .filter((item) => item.status !== "done")
    .sort(
      (left, right) =>
        TASK_WIDGET_ORDER[left.status] - TASK_WIDGET_ORDER[right.status] ||
        left.id - right.id,
    );
  if (actionable.length === 0) return [];

  const hasOverflow = actionable.length > TASK_WIDGET_LIMIT;
  const toggleHint = hasOverflow
    ? `  ·  ctrl+shift+t ${expanded ? "collapse" : "show all"}`
    : "";
  // Same census as the full list and the /tasks screen. Counted over `tracked`
  // rather than every item, because the widget deliberately hides dropped work
  // and a total that included it would not add up against the rows shown.
  const header =
    theme.fg("accent", "◆ ") +
    theme.fg("text", theme.bold("Tasks")) +
    "  " +
    renderTaskSummary(taskCounts(tracked), theme) +
    theme.fg("dim", `  ·  /tasks${toggleHint}`);
  const visible = expanded
    ? actionable
    : actionable.slice(0, TASK_WIDGET_LIMIT);
  const hidden = actionable.length - visible.length;
  const lines = [truncateToWidth(header, width)];
  for (const [index, item] of visible.entries()) {
    const color =
      item.status === "in_progress"
        ? "warning"
        : item.status === "blocked"
          ? "error"
          : "muted";
    const branch = index === visible.length - 1 && hidden === 0 ? "╰─" : "├─";
    lines.push(
      truncateToWidth(
        // Same subject weighting as the full list, so the item in flight reads
        // the same wherever you happen to be looking.
        `${theme.fg("dim", branch)} ${theme.fg(color, STATUS_ICON[item.status])} ${theme.fg("dim", `T${item.id}`)} ${subjectStyle(item.status, theme)(item.subject)}`,
        width,
      ),
    );
  }
  if (hidden > 0) {
    lines.push(
      truncateToWidth(theme.fg("dim", `╰─ … ${hidden} more tasks`), width),
    );
  }
  return lines;
}

export function renderToolResult(
  details: TaskToolDetails | undefined,
  expanded: boolean,
  theme: Theme,
): Component {
  if (!details) return new Text(theme.fg("dim", "Tasks updated."), 0, 0);
  const items = expanded ? details.items : details.items.slice(0, 5);
  // Census first: the shape of the batch is what a glance is after, and the
  // rows below are only ever a bounded sample of it.
  const rows = [
    renderTaskSummary(details.counts ?? taskCounts(details.items), theme),
    ...renderTaskRows(items, theme, 120),
  ];
  if (!expanded && details.items.length > items.length) {
    rows.push(theme.fg("dim", `… ${details.items.length - items.length} more`));
  }
  if (details.batchClosed) {
    rows.push(
      theme.fg("success", "✓ Batch complete") +
        theme.fg("dim", " · next request starts at T1"),
    );
  }
  return new Text(rows.join("\n"), 0, 0);
}

class TasksScreen implements Component {
  private offset = 0;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly snapshot: TaskSnapshot;
  private readonly done: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    snapshot: TaskSnapshot,
    done: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.snapshot = snapshot;
    this.done = done;
  }

  handleInput(data: string) {
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      matchesKey(data, Key.escape)
    ) {
      this.done();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorUp") || data === "k") {
      this.offset = Math.max(0, this.offset - 1);
      this.tui.requestRender();
      return;
    }
    if (
      this.keybindings.matches(data, "tui.editor.cursorDown") ||
      data === "j"
    ) {
      this.offset += 1;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageUp")) {
      this.offset = Math.max(0, this.offset - 10);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageDown")) {
      this.offset += 10;
      this.tui.requestRender();
    }
  }

  render(width: number) {
    const body = renderTaskRows(this.snapshot.items, this.theme, width - 4);
    const rows = Math.max(8, (this.tui.terminal.rows || 30) - 8);
    const maxOffset = Math.max(0, body.length - rows);
    this.offset = Math.min(this.offset, maxOffset);
    const visible = body.slice(this.offset, this.offset + rows);
    const lines = [
      truncateToWidth(
        `${this.theme.fg("accent", this.theme.bold("Session tasks"))}  ${renderTaskSummary(taskCounts(this.snapshot.items), this.theme)}`,
        width,
      ),
      this.theme.fg("border", "─".repeat(Math.max(0, width))),
      ...visible.map((line) => truncateToWidth(`  ${line}`, width)),
    ];
    while (lines.length < rows + 2) lines.push("");
    lines.push(
      truncateToWidth(
        this.theme.fg("dim", "j/k or ↑/↓ scroll · pgup/pgdn page · esc close"),
        width,
      ),
    );
    return lines;
  }

  invalidate() {}
}

export async function openTasksScreen(
  ctx: ExtensionCommandContext,
  snapshot: TaskSnapshot,
) {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI)
      ctx.ui.notify(`${snapshot.items.length} task item(s)`, "info");
    return;
  }
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) =>
      new TasksScreen(tui, theme, keybindings, snapshot, () => done()),
  );
}
