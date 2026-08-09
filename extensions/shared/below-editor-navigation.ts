import type {
  AppKeybinding,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteProvider,
  EditorComponent,
  Focusable,
} from "@earendil-works/pi-tui";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

/** Shared focus bit used by an editor wrapper and its below-editor strip. */
export class BelowEditorStripState {
  focused = false;
}

export type BelowEditorStripInputAction = "focus" | "blur" | "open" | "next";

/**
 * Interpret the navigation state between the editor and one management strip.
 * Unrecognized input blurs the strip and falls through to the editor, so the
 * interaction never traps normal typing.
 */
export function belowEditorStripInput(options: {
  data: string;
  focused: boolean;
  available: boolean;
  editorEmpty: boolean;
}): BelowEditorStripInputAction | undefined {
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
  if (matchesKey(data, Key.down)) return "next";
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

/**
 * Editor wrapper that owns keyboard focus while one below-editor strip is
 * selected. Wrappers compose: Down on a focused outer strip advances to the
 * next available nested strip, while Down on the final strip stays consumed.
 */
export class BelowEditorNavigationEditor implements EditorComponent, Focusable {
  private readonly fallbackActions = new Map<AppKeybinding, () => void>();
  private readonly base: EditorComponent;
  private readonly keybindings: KeybindingsManager;
  private readonly strip: BelowEditorStripState;
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
    strip: BelowEditorStripState,
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

  // Pi recognizes these properties as CustomEditor-compatible and copies all
  // app-level handlers onto the outermost wrapper.
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

  hasFocusedStrip(): boolean {
    return (
      this.strip.focused ||
      (this.nestedNavigation()?.hasFocusedStrip() ?? false)
    );
  }

  blurAllStrips() {
    this.strip.focused = false;
    this.nestedNavigation()?.blurAllStrips();
  }

  /** Focus this strip, or the first available nested strip when it is hidden. */
  focusAvailableStrip(): boolean {
    if (this.canManage()) {
      this.strip.focused = true;
      return true;
    }
    return this.nestedNavigation()?.focusAvailableStrip() ?? false;
  }

  private nestedNavigation() {
    return this.base instanceof BelowEditorNavigationEditor
      ? this.base
      : undefined;
  }

  handleInput(data: string) {
    const nested = this.nestedNavigation();
    if (!this.strip.focused && nested?.hasFocusedStrip()) {
      // Availability is dynamic: if an outer strip appears after a nested one
      // gained focus, Down cycles to the newly visible peer instead of being
      // consumed forever by the old focus owner.
      if (this.canManage() && matchesKey(data, Key.down)) {
        nested.blurAllStrips();
        this.strip.focused = true;
        this.requestRender();
        return;
      }
      this.base.handleInput(data);
      return;
    }
    const action = belowEditorStripInput({
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
      if (action === "next") {
        this.strip.focused = false;
        if (!this.nestedNavigation()?.focusAvailableStrip()) {
          this.strip.focused = true;
        }
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

/** Fit a left label and right metrics into exactly one bounded terminal row. */
export function fitNavigationSides(left: string, right: string, width: number) {
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
