/**
 * Takeover UI for subagents (ported from v1, rendering from the synchronous
 * SubagentReadModel instead of live pi sessions):
 * - SubagentDashboard: compact picker docked above the input, listing all subagents.
 * - TakeoverView: full interactive view of one subagent with an input line
 *   to steer/continue it.
 */

import type {
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  hintLine,
  panelFrame,
  type ScreenHint,
} from "../../../shared/screen-chrome.ts";
import { sanitizeTerminalText } from "../../../shared/terminal-text.ts";
import { formatElapsed, type SubagentSnapshot } from "../domain.ts";
import { formatContextUtilization } from "../../../shared/context-utilization.ts";
import type { SubagentReadModel } from "../manager.ts";
import {
  buildTranscriptLines,
  SPINNER_INTERVAL_MS,
  spinnerFrame,
  TranscriptRenderer,
} from "./transcript.ts";

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
 * frames and their cadence live in `transcript.ts` and are imported here.
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
}

export async function openSubagentTakeover(
  ctx: ExtensionContext,
  view: SubagentReadModel,
  id: string,
  options?: TakeoverOptions,
) {
  if (!view.get(id)) return;
  await ctx.ui.custom<null>(
    (tui, theme, keybindings, done) =>
      new TakeoverView(tui, theme, keybindings, id, view, done, options),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
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

const TRANSCRIPT_SCROLL_STEP = 6;

export class TakeoverView implements Component, Focusable {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private id: string;
  private view: SubagentReadModel;
  private done: (value: null) => void;
  private options?: TakeoverOptions;

  private input = new Input();
  private transcriptRenderer = new TranscriptRenderer();
  /** Scroll offset in lines from the bottom of the transcript. 0 = pinned to bottom. */
  private scrollOffset = 0;
  private unsubscribe: () => void;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private ticker?: ReturnType<typeof setInterval>;
  private closed = false;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
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
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.id = id;
    this.view = view;
    this.done = done;
    this.options = options;
    this.unsubscribe = view.subscribeTo(id, () => {
      this.refreshTicker();
      this.scheduleRender();
    });
    this.refreshTicker();
    this.input.onSubmit = (value: string) => {
      const text = value.trim();
      if (!text) return;
      this.input.setValue("");
      this.view.requestSend(this.id, text);
      this.scrollOffset = 0;
      this.tui.requestRender();
    };
  }

  private snap(): SubagentSnapshot | undefined {
    return this.view.get(this.id);
  }

  private refreshTicker() {
    const interval =
      this.snap()?.status === "running" ? SPINNER_INTERVAL_MS : 1000;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = setInterval(() => this.tui.requestRender(), interval);
  }

  private scheduleRender() {
    if (this.renderTimer) return;
    // Streaming can emit an event per token. Limit terminal repaints so this
    // view cannot starve input handling or make the child look frozen.
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
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

  private close() {
    if (this.cleanup()) this.done(null);
  }

  dispose(): void {
    this.cleanup();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "app.clear")) {
      const snap = this.snap();
      if (snap?.status === "running") this.view.requestAbort(this.id);
      return;
    }
    if (
      this.keybindings.matches(data, "app.interrupt") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorUp")) {
      this.scrollOffset += TRANSCRIPT_SCROLL_STEP;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorDown")) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - TRANSCRIPT_SCROLL_STEP,
      );
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageUp")) {
      this.scrollOffset += this.viewportHeight();
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageDown")) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - this.viewportHeight(),
      );
      this.tui.requestRender();
      return;
    }
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  private viewportHeight(): number {
    const rows = this.tui.terminal.rows || 30;
    // Top rule, transcript rule, input, key hints, and bottom rule are five
    // chrome rows. The overlay leaves Pi's final footer row visible.
    return Math.max(1, rows - 6);
  }

  private rule(width: number, left = "", right = "") {
    const fill = "─";
    const available = Math.max(1, width);
    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    if (!right || leftWidth + rightWidth + 2 > available) {
      return truncateToWidth(
        left + fill.repeat(Math.max(0, available - leftWidth)),
        available,
      );
    }
    return (
      left +
      fill.repeat(Math.max(1, available - leftWidth - rightWidth)) +
      right
    );
  }

  render(width: number): string[] {
    const theme = this.theme;
    const now = Date.now();
    const lines: string[] = [];
    const snap = this.snap();

    if (!snap) {
      const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
      lines.push(
        border,
        theme.fg("dim", `${this.id} is no longer tracked`),
        border,
      );
      return lines;
    }

    const title = sanitizeSubagentDisplayLine(snap.title) || snap.id;
    const headerLeft =
      theme.fg("borderAccent", "─ ") +
      statusGlyph(snap, theme, now) +
      " " +
      theme.fg("accent", theme.bold(title)) +
      theme.fg("borderAccent", " ");
    const utilization = formatContextUtilization(snap.usage);
    const metadata = [
      ...(this.options?.badge
        ? [theme.fg("muted", sanitizeSubagentDisplayLine(this.options.badge))]
        : []),
      theme.fg(
        "muted",
        sanitizeSubagentDisplayLine(snap.meta.modelLabel ?? "?") || "?",
      ),
      ...(utilization ? [theme.fg("muted", utilization)] : []),
      theme.fg("muted", formatElapsed(snap)),
    ];
    const dot = theme.fg("dim", " · ");
    while (
      metadata.length > 1 &&
      visibleWidth(headerLeft) + visibleWidth(metadata.join(dot)) + 2 > width
    ) {
      metadata.shift();
    }
    lines.push(
      this.rule(
        width,
        truncateToWidth(
          headerLeft,
          Math.max(1, width - visibleWidth(metadata.join(dot)) - 2),
        ),
        metadata.join(dot),
      ),
    );

    // Fixed-height transcript viewport. Errors consume a row, but scroll state
    // is represented by the following rule so its height never changes.
    // `now` is shared with the header glyph so both spinners show one frame.
    const transcript = buildTranscriptLines(
      snap,
      width,
      theme,
      this.transcriptRenderer,
      { now },
    );
    const viewport = this.viewportHeight();
    const errorRows = snap.errorText ? 1 : 0;
    const transcriptCapacity = Math.max(1, viewport - errorRows);
    const maxOffset = Math.max(0, transcript.length - transcriptCapacity);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

    const body: string[] = [];
    if (snap.errorText) {
      body.push(
        truncateToWidth(
          theme.fg(
            "error",
            `error: ${sanitizeSubagentDisplayLine(snap.errorText)}`,
          ),
          width,
        ),
      );
    }
    const end = transcript.length - this.scrollOffset;
    const visible = transcript.slice(
      Math.max(0, end - Math.max(1, viewport - body.length)),
      end,
    );
    if (visible.length === 0) body.push(theme.fg("dim", "waiting for output…"));
    else body.push(...visible);
    while (body.length < viewport) body.push("");
    lines.push(...body.slice(0, viewport));

    lines.push(
      this.rule(
        width,
        theme.fg("borderAccent", "─"),
        this.scrollOffset > 0 ? theme.fg("dim", `↓ ${this.scrollOffset}`) : "",
      ),
    );
    lines.push(...this.input.render(width));
    const keys = (binding: Parameters<KeybindingsManager["getKeys"]>[0]) =>
      configuredKeys(this.keybindings, binding);
    const editing: ScreenHint[] = [
      [keys("tui.input.submit"), "send"],
      [keys("app.interrupt"), "back"],
      [keys("app.clear"), "abort run"],
      [
        `${keys("tui.editor.cursorUp")}/${keys("tui.editor.cursorDown")}`,
        "scroll",
      ],
    ];
    // Same drop-the-page-hint fallback as before, measured on the styled line
    // so the keys-brighter-than-labels styling cannot change what fits.
    const full = hintLine(
      theme,
      [
        ...editing,
        [`${keys("tui.editor.pageUp")}/${keys("tui.editor.pageDown")}`, "page"],
      ],
      width,
    );
    lines.push(
      visibleWidth(full) <= width ? full : hintLine(theme, editing, width),
    );
    lines.push(this.rule(width, theme.fg("borderAccent", "─")));
    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
    this.transcriptRenderer.invalidate();
  }
}
