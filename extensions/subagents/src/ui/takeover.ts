/**
 * Takeover UI for subagents (ported from v1, rendering from the synchronous
 * SubagentReadModel instead of live pi sessions):
 * - SubagentDashboard: compact picker docked above the input, listing all subagents.
 * - TakeoverView: full read-only view of one subagent; steering remains owned
 *   by the parent model through the subagent tools.
 */

import type {
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { AgentSessionPage } from "../../../shared/agent-session-page.ts";
import {
  hintLine,
  panelFrame,
  type ScreenHint,
} from "../../../shared/screen-chrome.ts";
import { sanitizeTerminalText } from "../../../shared/terminal-text.ts";
import { formatElapsed, type SubagentSnapshot } from "../domain.ts";
import { formatContextUtilization } from "../../../shared/context-utilization.ts";
import { SPINNER_INTERVAL_MS, spinnerFrame } from "../../../shared/spinner.ts";
import type { SubagentReadModel } from "../manager.ts";
import { subagentTranscriptDocument } from "./transcript.ts";

export function sanitizeSubagentDisplayLine(value: string) {
  return sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
}

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

/**
 * One spinner definition for the whole subagent UI: the dashboard glyph, the
 * takeover header, and the transcript's live tools must animate in step, so the
 * frames and their cadence live in `shared/spinner.ts` and are imported here.
 */
function statusGlyph(
  snap: SubagentSnapshot,
  theme: Theme,
  now = Date.now(),
  selected = false,
): string {
  // A selected row keeps its state glyph and borrows the accent tone, so the
  // list never hides what is still running behind a selection marker.
  const tone = (color: "warning" | "success" | "error") =>
    selected ? ("accent" as const) : color;
  switch (snap.status) {
    case "running":
      return theme.fg(tone("warning"), spinnerFrame(now));
    case "done":
      return theme.fg(tone("success"), "✓");
    case "error":
      return theme.fg(tone("error"), "✗");
  }
}

// --- Entry points --------------------------------------------------------------

export interface TakeoverOptions {
  readonly badge?: string;
  /** Captured from the parent UI when this child page opens. */
  readonly toolsExpanded?: boolean;
}

export async function openSubagentTakeover(
  ctx: ExtensionContext,
  view: SubagentReadModel,
  id: string,
  options?: TakeoverOptions,
) {
  if (!view.get(id)) return;
  const takeoverOptions: TakeoverOptions = {
    ...options,
    toolsExpanded: ctx.ui.getToolsExpanded(),
  };
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) =>
      new TakeoverView(
        tui,
        theme,
        keybindings,
        id,
        view,
        done,
        takeoverOptions,
      ),
    {
      overlay: true,
      overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
    },
  );
}

export async function openSubagentPicker(
  ctx: ExtensionContext,
  view: SubagentReadModel,
  initialId?: string,
) {
  const selection: DashboardSelection = { id: initialId, index: 0 };

  while (true) {
    if (view.size() === 0) {
      ctx.ui.notify("No subagents", "info");
      return;
    }

    const picked = await ctx.ui.custom<string | null>(
      (tui, theme, keybindings, done) =>
        new SubagentDashboard(tui, theme, keybindings, view, selection, done),
      {
        overlay: true,
        // Dock the picker just above the editor (editor + strip + footer ≈ 5
        // rows) like a command palette, instead of covering the conversation.
        overlayOptions: {
          anchor: "bottom-center",
          width: "100%",
          maxHeight: "60%",
          margin: { bottom: 5 },
        },
      },
    );

    if (!picked) return;
    if (!view.get(picked)) continue;

    await openSubagentTakeover(ctx, view, picked);
    // After leaving the takeover view, fall back to the dashboard.
  }
}

// --- Dashboard (picker docked above the input) ---------------------------------

/** A picker is a glance, not a workspace: cap the list window and scroll. */
const MAX_PICKER_ROWS = 10;

export interface DashboardSelection {
  id?: string;
  index: number;
}

export function reconcileDashboardSelection(
  selection: DashboardSelection,
  subs: ReadonlyArray<Pick<SubagentSnapshot, "id">>,
) {
  const stableIndex = selection.id
    ? subs.findIndex((snap) => snap.id === selection.id)
    : -1;
  selection.index =
    stableIndex >= 0
      ? stableIndex
      : Math.min(Math.max(0, selection.index), Math.max(0, subs.length - 1));
  selection.id = subs[selection.index]?.id;
}

export class SubagentDashboard implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private view: SubagentReadModel;
  private selection: DashboardSelection;
  private done: (value: string | null) => void;

  private closed = false;
  private ticker?: ReturnType<typeof setInterval>;
  private unsubChange: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    view: SubagentReadModel,
    selection: DashboardSelection,
    done: (value: string | null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.view = view;
    this.selection = selection;
    this.done = done;
    this.refreshTicker();
    this.unsubChange = view.subscribe(() => {
      this.refreshTicker();
      this.tui.requestRender();
    });
  }

  private subs(): ReadonlyArray<SubagentSnapshot> {
    return this.view.list();
  }

  private refreshTicker() {
    const interval = this.subs().some((snap) => snap.status === "running")
      ? SPINNER_INTERVAL_MS
      : 1000;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = setInterval(() => this.tui.requestRender(), interval);
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    if (this.ticker) clearInterval(this.ticker);
    this.unsubChange();
    return true;
  }

  private close(result: string | null) {
    if (this.cleanup()) this.done(result);
  }

  dispose(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    const subs = this.subs();
    reconcileDashboardSelection(this.selection, subs);

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close(null);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const snap = subs[this.selection.index];
      if (snap) this.close(snap.id);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (subs.length > 0) {
        this.selection.index =
          (this.selection.index - 1 + subs.length) % subs.length;
        this.selection.id = subs[this.selection.index]?.id;
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      if (subs.length > 0) {
        this.selection.index = (this.selection.index + 1) % subs.length;
        this.selection.id = subs[this.selection.index]?.id;
        this.tui.requestRender();
      }
      return;
    }
    if (data === "x") {
      const snap = subs[this.selection.index];
      if (snap && snap.status === "running") this.view.requestAbort(snap.id);
      return;
    }
  }

  render(width: number): string[] {
    const theme = this.theme;
    const subs = this.subs();
    reconcileDashboardSelection(this.selection, subs);

    // One timestamp per frame so every row's spinner shows the same frame.
    const now = Date.now();
    // Docked above the editor, the panel borrows conversation space: cap the
    // list window and scroll instead of growing toward the top of the screen.
    const rows = this.tui.terminal.rows || 30;
    const maxBodyHeight = Math.min(Math.max(1, rows - 5), MAX_PICKER_ROWS);
    const bodyHeight =
      subs.length > maxBodyHeight ? maxBodyHeight : Math.max(1, subs.length);
    const innerWidth = Math.max(0, width - 2);

    const running = subs.filter((snap) => snap.status === "running").length;
    const done = subs.filter((snap) => snap.status === "done").length;
    const failed = subs.filter((snap) => snap.status === "error").length;
    const summary =
      [
        running > 0 ? `${running} running` : "",
        done > 0 ? `${done} done` : "",
        failed > 0 ? `${failed} failed` : "",
      ]
        .filter(Boolean)
        .join(" · ") || "no agents";
    const rowLines = this.renderRows(subs, innerWidth, bodyHeight, now);
    const keys = (binding: Parameters<KeybindingsManager["getKeys"]>[0]) =>
      configuredKeys(this.keybindings, binding);
    // Shared chrome, so this panel and its hints read the same as /ps and
    // /workflows. The frame is padded to the rows it was given, which keeps
    // this view's content-fit height rather than reintroducing a fixed one.
    return [
      // One empty row of air between the conversation and the docked panel.
      "",
      ...panelFrame(theme, {
        label: `Subagents · ${summary}`,
        rows: rowLines,
        width,
        height: rowLines.length + 2,
      }),
      hintLine(
        theme,
        [
          [`${keys("tui.select.up")}/${keys("tui.select.down")}/jk`, "select"],
          [keys("tui.select.confirm"), "take over"],
          ["x", "abort"],
          [keys("tui.select.cancel"), "close"],
        ],
        width,
      ),
    ];
  }

  private renderRows(
    subs: ReadonlyArray<SubagentSnapshot>,
    width: number,
    height: number,
    now: number,
  ): string[] {
    const theme = this.theme;
    const out: string[] = [];

    const needsMore = subs.length > height && height > 1;
    const visibleHeight = needsMore ? height - 1 : height;

    // Scroll window around selection. The more indicator gets its own row, so
    // it never replaces a selectable subagent.
    let start = 0;
    if (subs.length > visibleHeight) {
      start = Math.min(
        Math.max(0, this.selection.index - Math.floor(visibleHeight / 2)),
        Math.max(0, subs.length - visibleHeight),
      );
    }
    const visible = subs.slice(start, start + visibleHeight);

    for (let i = 0; i < visible.length; i++) {
      const snap = visible[i];
      const index = start + i;
      const isSelected = index === this.selection.index;

      // One glyph column: a selected row tints its status glyph with the
      // accent tone instead of stacking a second marker. The live tool name
      // is deliberately absent: it flickers with every tool call and says
      // nothing the user acts on.
      const glyph = statusGlyph(snap, theme, now, isSelected);
      const safeTitle = sanitizeSubagentDisplayLine(snap.title) || snap.id;
      const title = isSelected
        ? theme.fg("accent", safeTitle)
        : theme.fg("text", safeTitle);
      const prefix = ` ${glyph} `;

      const utilization = formatContextUtilization(snap.usage);
      const metadata = [
        theme.fg("muted", snap.backend),
        theme.fg(
          "muted",
          sanitizeSubagentDisplayLine(snap.meta.modelLabel ?? "?") || "?",
        ),
        ...(utilization ? [theme.fg("muted", utilization)] : []),
        theme.fg("muted", formatElapsed(snap)),
      ];
      const dot = theme.fg("dim", " · ");
      // Preserve elapsed and the activity-bearing left side longest. Shed the
      // least useful metadata as a segment instead of clipping a joined tail.
      while (
        metadata.length > 1 &&
        visibleWidth(metadata.join(dot)) > Math.max(0, width - 16)
      ) {
        metadata.shift();
      }
      const right = metadata.join(dot);
      const rightWidth = visibleWidth(right);
      const leftMax = Math.max(0, width - rightWidth - (right ? 2 : 0));
      const left =
        prefix +
        truncateToWidth(title, Math.max(0, leftMax - visibleWidth(prefix)));
      const gap = right
        ? Math.max(1, width - visibleWidth(left) - rightWidth)
        : 0;
      out.push(truncateToWidth(left + " ".repeat(gap) + right, width));
    }

    if (needsMore) {
      out.push(
        truncateToWidth(
          theme.fg("dim", `   … ${subs.length - visible.length} more`),
          width,
        ),
      );
    }
    return out;
  }

  invalidate(): void {}
}

// --- Takeover view ------------------------------------------------------------

export class TakeoverView implements Component, Focusable {
  private page: AgentSessionPage;
  private unsubscribe: () => void;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private ticker?: ReturnType<typeof setInterval>;
  private closed = false;

  get focused() {
    return this.page.focused;
  }
  set focused(value: boolean) {
    this.page.focused = value;
  }

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    id: string,
    view: SubagentReadModel,
    done: (value: null) => void,
    options?: TakeoverOptions,
  ) {
    this.page = new AgentSessionPage(
      tui,
      theme,
      keybindings,
      {
        getState: () => {
          const snap = view.get(id);
          if (!snap) return undefined;
          return {
            id: snap.id,
            title: snap.title,
            status: snap.status,
            document: subagentTranscriptDocument(
              snap,
              view.getToolRenderer?.(id),
            ),
            metadata: [
              options?.badge,
              snap.meta.modelLabel,
              formatContextUtilization(snap.usage),
              formatElapsed(snap),
            ],
            errorText: snap.errorText,
          };
        },
        close: () => this.close(done),
        abort: () => view.requestAbort(id),
      },
      { toolsExpanded: options?.toolsExpanded },
    );
    this.unsubscribe = view.subscribeTo(id, () => {
      this.refreshTicker(view.get(id), tui);
      this.scheduleRender(tui);
    });
    this.refreshTicker(view.get(id), tui);
  }

  private refreshTicker(snap: SubagentSnapshot | undefined, tui: TUI) {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    if (snap?.status === "running") {
      this.ticker = setInterval(() => tui.requestRender(), SPINNER_INTERVAL_MS);
    }
  }

  private scheduleRender(tui: TUI) {
    if (this.renderTimer) return;
    // Streaming can emit an event per token. Limit terminal repaints so this
    // view cannot starve input handling or make the child look frozen.
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) tui.requestRender();
    }, 50);
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    this.unsubscribe();
    if (this.ticker) clearInterval(this.ticker);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    return true;
  }

  private close(done: (value: null) => void) {
    if (this.cleanup()) done(null);
  }

  dispose(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    this.page.handleInput(data);
  }

  render(width: number): string[] {
    return this.page.render(width);
  }

  invalidate(): void {
    this.page.invalidate();
  }
}
