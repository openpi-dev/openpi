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
import type { LedgerItem, LedgerSnapshot } from "./ledger.ts";

const STATUS_ICON: Record<LedgerItem["status"], string> = {
  pending: "○",
  in_progress: "●",
  blocked: "!",
  done: "✓",
  dropped: "×",
};

export interface LedgerToolDetails {
  action: "add" | "update" | "list";
  items: LedgerItem[];
  total: number;
  revision: number;
}

export function renderLedgerRows(
  items: readonly LedgerItem[],
  theme: Theme,
  width: number,
) {
  if (items.length === 0) return [theme.fg("dim", "No ledger items.")];
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
    const rows = [
      truncateToWidth(
        `${theme.fg(color, STATUS_ICON[item.status])} ${theme.fg("accent", `T${item.id}`)} ${theme.fg("muted", `[${item.status}]`)} ${theme.fg(item.status === "done" ? "dim" : "text", item.subject)}`,
        width,
      ),
    ];
    if (item.detail) {
      rows.push(
        truncateToWidth(
          `  ${theme.fg("dim", `Detail: ${item.detail}`)}`,
          width,
        ),
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
          `  ${theme.fg("dim", `${label}:`)} ${theme.fg("muted", item.note)}`,
          width,
        ),
      );
    }
    return rows;
  });
}

export function renderToolResult(
  details: LedgerToolDetails | undefined,
  expanded: boolean,
  theme: Theme,
): Component {
  if (!details) return new Text(theme.fg("dim", "Ledger updated."), 0, 0);
  const items = expanded ? details.items : details.items.slice(0, 5);
  const rows = renderLedgerRows(items, theme, 120);
  if (!expanded && details.items.length > items.length) {
    rows.push(theme.fg("dim", `… ${details.items.length - items.length} more`));
  }
  rows.push(
    theme.fg("dim", `${details.total} total · revision ${details.revision}`),
  );
  return new Text(rows.join("\n"), 0, 0);
}

class LedgerScreen implements Component {
  private offset = 0;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly snapshot: LedgerSnapshot;
  private readonly done: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    snapshot: LedgerSnapshot,
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
    const body = renderLedgerRows(this.snapshot.items, this.theme, width - 4);
    const rows = Math.max(8, (this.tui.terminal.rows || 30) - 8);
    const maxOffset = Math.max(0, body.length - rows);
    this.offset = Math.min(this.offset, maxOffset);
    const visible = body.slice(this.offset, this.offset + rows);
    const lines = [
      truncateToWidth(
        `${this.theme.fg("accent", this.theme.bold("Session ledger"))} ${this.theme.fg("dim", `· ${this.snapshot.items.length} items · revision ${this.snapshot.revision}`)}`,
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

export async function openLedgerScreen(
  ctx: ExtensionCommandContext,
  snapshot: LedgerSnapshot,
) {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI)
      ctx.ui.notify(`${snapshot.items.length} ledger item(s)`, "info");
    return;
  }
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) =>
      new LedgerScreen(tui, theme, keybindings, snapshot, () => done()),
  );
}
