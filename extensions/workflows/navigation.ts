import type {
  AppKeybinding,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteProvider,
  EditorComponent,
  Focusable,
  TUI,
} from "@earendil-works/pi-tui";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  aggregateUsage,
  countStates,
  formatElapsed,
  formatTokens,
  statusColor,
  statusSquare,
  type Theme,
  type WorkflowDetails,
} from "./model.ts";

/** Shared focus bit used by the terminal input handler and workflow strip. */
export class WorkflowStripState {
  focused = false;
}

export type WorkflowStripInputAction = "focus" | "blur" | "open" | "consume";

/**
 * Interpret the small navigation state that lives between the editor and the
 * full dashboard. Unrecognized input blurs the strip and falls through to the
 * editor, so focusing it never traps normal typing.
 */
export function workflowStripInput(options: {
  data: string;
  focused: boolean;
  available: boolean;
  editorEmpty: boolean;
}): WorkflowStripInputAction | undefined {
  const { data, focused, available, editorEmpty } = options;
  if (!focused) {
    return available && editorEmpty && matchesKey(data, Key.down)
      ? "focus"
      : undefined;
  }
  if (
    matchesKey(data, Key.up) ||
    matchesKey(data, Key.left) ||
    matchesKey(data, Key.escape)
  ) {
    return "blur";
  }
  if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
    return "open";
  }
  if (matchesKey(data, Key.down)) return "consume";
  return undefined;
}

interface AppAwareEditor extends EditorComponent {
  actionHandlers: Map<AppKeybinding, () => void>;
  onEscape?: () => void;
  onCtrlD?: () => void;
  onPasteImage?: () => void;
  onExtensionShortcut?: (data: string) => boolean;
}

function appAwareEditor(editor: EditorComponent): AppAwareEditor | undefined {
  const candidate = editor as EditorComponent & Partial<AppAwareEditor>;
  return candidate.actionHandlers instanceof Map
    ? (candidate as AppAwareEditor)
    : undefined;
}

/** Editor wrapper that owns keyboard focus while the visual strip is selected. */
export class WorkflowNavigationEditor implements EditorComponent, Focusable {
  private readonly fallbackActions = new Map<AppKeybinding, () => void>();
  private readonly base: EditorComponent;
  private readonly keybindings: KeybindingsManager;
  private readonly strip: WorkflowStripState;
  private readonly canManage: () => boolean;
  private readonly open: () => void;
  private readonly requestRender: () => void;
  private fallbackEscape?: () => void;
  private fallbackCtrlD?: () => void;
  private fallbackPasteImage?: () => void;
  private fallbackExtensionShortcut?: (data: string) => boolean;
  private _focused = false;

  constructor(
    base: EditorComponent,
    keybindings: KeybindingsManager,
    strip: WorkflowStripState,
    canManage: () => boolean,
    open: () => void,
    requestRender: () => void,
  ) {
    this.base = base;
    this.keybindings = keybindings;
    this.strip = strip;
    this.canManage = canManage;
    this.open = open;
    this.requestRender = requestRender;
  }

  get focused() {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    const child = this.base as EditorComponent & Partial<Focusable>;
    if (typeof child.focused === "boolean") child.focused = value;
  }

  get wantsKeyRelease() {
    return this.base.wantsKeyRelease;
  }

  // Pi uses these properties to recognize a CustomEditor-compatible component
  // and copy all app-level handlers onto it.
  get actionHandlers() {
    return appAwareEditor(this.base)?.actionHandlers ?? this.fallbackActions;
  }

  get onExtensionShortcut() {
    return (
      appAwareEditor(this.base)?.onExtensionShortcut ??
      this.fallbackExtensionShortcut
    );
  }

  set onExtensionShortcut(value: ((data: string) => boolean) | undefined) {
    const child = appAwareEditor(this.base);
    if (child) child.onExtensionShortcut = value;
    else this.fallbackExtensionShortcut = value;
  }

  get onEscape() {
    return appAwareEditor(this.base)?.onEscape ?? this.fallbackEscape;
  }

  set onEscape(value: (() => void) | undefined) {
    const child = appAwareEditor(this.base);
    if (child) child.onEscape = value;
    else this.fallbackEscape = value;
  }

  get onCtrlD() {
    return appAwareEditor(this.base)?.onCtrlD ?? this.fallbackCtrlD;
  }

  set onCtrlD(value: (() => void) | undefined) {
    const child = appAwareEditor(this.base);
    if (child) child.onCtrlD = value;
    else this.fallbackCtrlD = value;
  }

  get onPasteImage() {
    return appAwareEditor(this.base)?.onPasteImage ?? this.fallbackPasteImage;
  }

  set onPasteImage(value: (() => void) | undefined) {
    const child = appAwareEditor(this.base);
    if (child) child.onPasteImage = value;
    else this.fallbackPasteImage = value;
  }

  get onSubmit() {
    return this.base.onSubmit;
  }

  set onSubmit(value: ((text: string) => void) | undefined) {
    this.base.onSubmit = value;
  }

  get onChange() {
    return this.base.onChange;
  }

  set onChange(value: ((text: string) => void) | undefined) {
    this.base.onChange = value;
  }

  get borderColor() {
    return this.base.borderColor;
  }

  set borderColor(value: ((text: string) => string) | undefined) {
    this.base.borderColor = value;
  }

  handleInput(data: string) {
    const action = workflowStripInput({
      data,
      focused: this.strip.focused,
      available: this.canManage(),
      editorEmpty: this.base.getText().length === 0,
    });
    if (action) {
      if (action === "focus") this.strip.focused = true;
      if (action === "blur") this.strip.focused = false;
      if (action === "open") {
        this.strip.focused = false;
        this.open();
      }
      this.requestRender();
      return;
    }
    if (this.strip.focused) {
      this.strip.focused = false;
      this.requestRender();
    }

    const child = appAwareEditor(this.base);
    if (!child) {
      if (this.onExtensionShortcut?.(data)) return;
      if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
        this.fallbackPasteImage?.();
        return;
      }
      if (this.keybindings.matches(data, "app.interrupt")) {
        this.fallbackEscape?.();
        return;
      }
      if (
        this.keybindings.matches(data, "app.exit") &&
        this.base.getText().length === 0
      ) {
        this.fallbackCtrlD?.();
        return;
      }
      for (const [binding, handler] of this.fallbackActions) {
        if (!this.keybindings.matches(data, binding)) continue;
        if (binding === "app.exit" && this.base.getText().length > 0) break;
        handler();
        return;
      }
    }
    this.base.handleInput(data);
  }

  render(width: number) {
    return this.base.render(width);
  }

  invalidate() {
    this.base.invalidate();
  }

  getText() {
    return this.base.getText();
  }

  getExpandedText() {
    return this.base.getExpandedText?.() ?? this.base.getText();
  }

  setText(text: string) {
    this.strip.focused = false;
    this.base.setText(text);
  }

  addToHistory(text: string) {
    this.base.addToHistory?.(text);
  }

  insertTextAtCursor(text: string) {
    this.base.insertTextAtCursor?.(text);
  }

  setAutocompleteProvider(provider: AutocompleteProvider) {
    this.base.setAutocompleteProvider?.(provider);
  }

  setPaddingX(padding: number) {
    this.base.setPaddingX?.(padding);
  }

  setAutocompleteMaxVisible(maxVisible: number) {
    this.base.setAutocompleteMaxVisible?.(maxVisible);
  }
}

export interface WorkflowStripEntry {
  runId: string;
  details: WorkflowDetails;
}

/** Live, one-line Claude-style workflow entry rendered below the editor. */
export class WorkflowStripWidget {
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly strip: WorkflowStripState;
  private readonly getEntry: () => WorkflowStripEntry | undefined;

  constructor(
    tui: TUI,
    theme: Theme,
    strip: WorkflowStripState,
    getEntry: () => WorkflowStripEntry | undefined,
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
    const details = entry.details;
    const { done, failed } = countStates(details);
    const settled = done + failed;
    const usage = aggregateUsage(details.agents);
    const tokenCount = usage.input + usage.output;
    const marker = this.strip.focused
      ? this.theme.fg("accent", "❯")
      : this.theme.fg("dim", "○");
    const name = this.strip.focused
      ? this.theme.bold(this.theme.fg("accent", details.name ?? entry.runId))
      : this.theme.fg("text", details.name ?? entry.runId);
    const context = details.currentPhase ?? details.description;
    const left = ` ${marker} ${statusSquare(details.status, this.theme)} ${name}${context ? this.theme.fg("dim", ` · ${context}`) : ""}`;
    const metrics = [
      `${settled}/${details.agents.length} agents`,
      formatElapsed(details.startedAt, details.finishedAt),
      tokenCount > 0 ? `${formatTokens(tokenCount)} tokens` : undefined,
      this.strip.focused ? "enter open · ↑ back" : "↓ to manage",
    ]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    const right = this.theme.fg(statusColor(details.status), metrics);
    return [fitSides(left, right, width)];
  }
}

function fitSides(left: string, right: string, width: number) {
  const boundedRight = truncateToWidth(right, Math.max(0, width - 4), "…");
  const rightWidth = visibleWidth(boundedRight);
  const leftWidth = Math.max(0, width - rightWidth - 1);
  const boundedLeft = truncateToWidth(left, leftWidth, "…");
  const gap = Math.max(1, width - visibleWidth(boundedLeft) - rightWidth);
  return truncateToWidth(
    boundedLeft + " ".repeat(gap) + boundedRight,
    width,
    "",
  );
}
