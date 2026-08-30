import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  AgentTranscriptRenderer,
  type AgentTranscriptDocument,
} from "./agent-transcript.ts";
import { hintLine, type ScreenHint } from "./screen-chrome.ts";
import { spinnerFrame } from "./spinner.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";
import { TranscriptViewport } from "./transcript-viewport.ts";

const SCROLL_STEP = 6;

export type AgentSessionPageStatus = "running" | "done" | "error" | "uncertain";

export interface AgentSessionPageState {
  readonly id: string;
  readonly title: string;
  readonly status: AgentSessionPageStatus;
  readonly document: AgentTranscriptDocument;
  readonly metadata?: ReadonlyArray<string | undefined>;
  readonly errorText?: string;
  readonly emptyText?: string;
}

export interface AgentSessionPageSource {
  getState(): AgentSessionPageState | undefined;
  close(): void;
  abort?(): void;
}

export interface AgentSessionPageOptions {
  /** Inherited from the parent UI when the child page opens. */
  readonly toolsExpanded?: boolean;
}

function safeLine(value: string) {
  return sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
}

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

function stateGlyph(state: AgentSessionPageState, theme: Theme, now: number) {
  switch (state.status) {
    case "running":
      return theme.fg("warning", spinnerFrame(now));
    case "done":
      return theme.fg("success", "✓");
    case "error":
      return theme.fg("error", "✗");
    case "uncertain":
      return theme.fg("warning", "?");
  }
}

/**
 * One full-screen child-session page shared by Direct and Workflow adapters.
 * The source owns lifecycle facts; this module owns only page rendering,
 * reading position, and navigation back to the parent view.
 */
export class AgentSessionPage implements Component, Focusable {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private source: AgentSessionPageSource;
  private renderer = new AgentTranscriptRenderer();
  private viewport = new TranscriptViewport();
  private rowCount = 0;
  private viewportSize = 1;
  private toolsExpanded: boolean;

  private _focused = false;
  get focused() {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
  }

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    source: AgentSessionPageSource,
    options?: AgentSessionPageOptions,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.source = source;
    this.toolsExpanded = options?.toolsExpanded === true;
  }

  handleInput(data: string) {
    const state = this.source.getState();
    if (this.keybindings.matches(data, "app.tools.expand")) {
      this.toolsExpanded = !this.toolsExpanded;
      this.tui.requestRender();
      return;
    }
    if (
      this.source.abort &&
      state?.status === "running" &&
      this.keybindings.matches(data, "app.clear")
    ) {
      this.source.abort();
      return;
    }
    if (
      this.keybindings.matches(data, "app.interrupt") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.source.close();
      return;
    }

    if (
      this.keybindings.matches(data, "tui.editor.cursorLeft") ||
      data === "h"
    ) {
      this.source.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorUp") || data === "k") {
      this.viewport.scrollBy(-SCROLL_STEP, this.rowCount, this.viewportSize);
      this.tui.requestRender();
      return;
    }
    if (
      this.keybindings.matches(data, "tui.editor.cursorDown") ||
      data === "j"
    ) {
      this.viewport.scrollBy(SCROLL_STEP, this.rowCount, this.viewportSize);
      this.tui.requestRender();
      return;
    }
    if (
      this.keybindings.matches(data, "tui.editor.pageUp") ||
      matchesKey(data, Key.ctrl("u"))
    ) {
      this.viewport.scrollBy(
        -this.viewportSize,
        this.rowCount,
        this.viewportSize,
      );
      this.tui.requestRender();
      return;
    }
    if (
      this.keybindings.matches(data, "tui.editor.pageDown") ||
      matchesKey(data, Key.ctrl("d"))
    ) {
      this.viewport.scrollBy(
        this.viewportSize,
        this.rowCount,
        this.viewportSize,
      );
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.home) || data === "g") {
      this.viewport.scrollToTop(this.rowCount, this.viewportSize);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.end) || data === "G") {
      this.viewport.scrollToEnd(this.rowCount, this.viewportSize);
      this.tui.requestRender();
      return;
    }
  }

  private rule(width: number, left = "", right = "") {
    const available = Math.max(1, width);
    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(right);
    if (!right || leftWidth + rightWidth + 2 > available) {
      return truncateToWidth(
        left + "─".repeat(Math.max(0, available - leftWidth)),
        available,
      );
    }
    return (
      left + "─".repeat(Math.max(1, available - leftWidth - rightWidth)) + right
    );
  }

  render(width: number) {
    const state = this.source.getState();
    const height = Math.max(1, this.tui.terminal.rows || 30);
    if (!state) {
      const border = this.theme.fg(
        "borderAccent",
        "─".repeat(Math.max(1, width)),
      );
      const lines = [
        border,
        this.theme.fg("dim", "child is no longer tracked"),
      ];
      while (lines.length < height - 1) lines.push("");
      lines.push(border);
      return lines;
    }

    const now = Date.now();
    const title = safeLine(state.title) || state.id;
    const headerLeft =
      this.theme.fg("borderAccent", "─ ") +
      stateGlyph(state, this.theme, now) +
      " " +
      this.theme.fg("accent", this.theme.bold(title)) +
      this.theme.fg("borderAccent", " ");
    const metadata = (state.metadata ?? [])
      .map((item) => (item ? safeLine(item) : ""))
      .filter(Boolean)
      .map((item) => this.theme.fg("muted", item));
    const dot = this.theme.fg("dim", " · ");
    while (
      metadata.length > 1 &&
      visibleWidth(headerLeft) + visibleWidth(metadata.join(dot)) + 2 > width
    ) {
      metadata.shift();
    }

    const chromeRows = 4;
    const errorRows = state.errorText ? 1 : 0;
    const bodyHeight = Math.max(1, height - chromeRows);
    const transcriptCapacity = Math.max(1, bodyHeight - errorRows);
    const transcript = this.renderer.render(state.document, width, this.theme, {
      now,
      expanded: this.toolsExpanded,
    });
    this.rowCount = transcript.length;
    this.viewportSize = transcriptCapacity;
    this.viewport.reconcile(transcript.length, transcriptCapacity);

    const lines = [
      this.rule(
        width,
        truncateToWidth(
          headerLeft,
          Math.max(1, width - visibleWidth(metadata.join(dot)) - 2),
        ),
        metadata.join(dot),
      ),
    ];
    const body: string[] = [];
    if (state.errorText) {
      body.push(
        truncateToWidth(
          this.theme.fg("error", `error: ${safeLine(state.errorText)}`),
          width,
        ),
      );
    }
    const visible = transcript.slice(
      this.viewport.scrollTop,
      this.viewport.scrollTop + transcriptCapacity,
    );
    if (visible.length === 0) {
      body.push(this.theme.fg("dim", state.emptyText ?? "waiting for output…"));
    } else {
      body.push(...visible);
    }
    while (body.length < bodyHeight) body.push("");
    lines.push(...body.slice(0, bodyHeight));

    lines.push(
      this.rule(
        width,
        this.theme.fg("borderAccent", "─"),
        this.viewport.followingEnd
          ? ""
          : this.theme.fg(
              "dim",
              `↓ ${this.viewport.linesBelow(transcript.length, transcriptCapacity)}`,
            ),
      ),
    );
    const keys = (binding: Parameters<KeybindingsManager["getKeys"]>[0]) =>
      configuredKeys(this.keybindings, binding);
    const hints: ScreenHint[] = [];
    hints.push([keys("app.interrupt"), "back"]);
    if (this.source.abort) hints.push([keys("app.clear"), "abort run"]);
    hints.push([
      keys("app.tools.expand"),
      this.toolsExpanded ? "collapse tools" : "expand tools",
    ]);
    hints.push(
      [
        `${keys("tui.editor.cursorUp")}/${keys("tui.editor.cursorDown")}`,
        "scroll",
      ],
      [`${keys("tui.editor.pageUp")}/${keys("tui.editor.pageDown")}`, "page"],
      ["g/G", "top/bottom"],
    );
    lines.push(hintLine(this.theme, hints, width));
    lines.push(this.rule(width, this.theme.fg("borderAccent", "─")));
    return lines.slice(0, height);
  }

  invalidate() {
    this.renderer.invalidate();
  }
}
