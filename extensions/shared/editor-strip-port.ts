/**
 * Editor enhancement port (DDD: shared-kernel port + single installer).
 *
 * Every openpi extension used to wrap the editor itself via
 * `ctx.ui.setEditorComponent` — subagents, workflows, and suggestions each
 * stacked their own `BelowEditorNavigationEditor`-family wrapper on every
 * session_start, so the wrapping depth grew with each /resume and depended on
 * the accidental extension load order.
 *
 * This port inverts the dependency: extensions register *bindings* (data and
 * callbacks), and one installer wraps the editor exactly once, composing
 * bindings in explicit registration order:
 *
 *   base editor
 *     → render enhancements (e.g. the suggestions line) in registration order
 *     → CompositeStripEditor (keyboard routing across all strip bindings)
 *     → ctx.ui.setEditorComponent(...)   ← called once per runtime
 *
 * Strip bindings own their `BelowEditorStripState` (the focus bit widgets
 * read for their marker); the composite routes keys between them: Down from
 * an empty editor focuses the first manageable strip, Down on a focused
 * strip advances to the next manageable one, Up/Esc/Left blur, Enter/Right
 * opens. Non-navigation input blurs and falls through to the base editor.
 */

import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type AutocompleteProvider,
  type EditorComponent,
  type Focusable,
} from "@earendil-works/pi-tui";
import { BelowEditorStripState } from "./below-editor-navigation.ts";

/** A navigable management strip (subagents HUD, workflow HUD, …). */
export interface EditorStripBinding {
  readonly id: string;
  /** Focus bit shared with the strip's widget rendering. */
  readonly state: BelowEditorStripState;
  /** Whether the strip currently has something to manage. */
  canManage(): boolean;
  /** Enter on a focused strip opens its management view. */
  open(): void;
  /** Focus changed: the widget must repaint its marker. */
  requestRender(): void;
}

/** A render-layer editor enhancement (e.g. the ghost suggestions line). */
export interface EditorRenderEnhancement {
  readonly id: string;
  /** Wrap the editor for rendering; must be a stable, composable wrapper. */
  wrap(base: EditorComponent, keybindings: KeybindingsManager): EditorComponent;
}

let stripBindings: EditorStripBinding[] = [];
let renderEnhancements: EditorRenderEnhancement[] = [];
let installerInstalled = false;

export function registerEditorStrip(binding: EditorStripBinding): void {
  if (stripBindings.some((existing) => existing.id === binding.id)) return;
  stripBindings.push(binding);
}

export function registerEditorRenderEnhancement(
  enhancement: EditorRenderEnhancement,
): void {
  if (renderEnhancements.some((existing) => existing.id === enhancement.id)) {
    return;
  }
  renderEnhancements.push(enhancement);
}

export function resetEditorEnhancements(): void {
  stripBindings = [];
  renderEnhancements = [];
  installerInstalled = false;
}

export function getEditorStripBindings(): readonly EditorStripBinding[] {
  return stripBindings;
}

export function getEditorRenderEnhancements(): readonly EditorRenderEnhancement[] {
  return renderEnhancements;
}

// --- Composite strip editor ---------------------------------------------------

interface AppAwareEditor extends EditorComponent {
  actionHandlers: Map<string, () => void>;
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
 * Single keyboard wrapper over every registered strip. Replaces the old
 * nested-wrapper chain: exactly one wrapper exists per runtime, strip order
 * is the registration order, and strip count changes never restack the
 * editor. Keyboard semantics mirror the single-strip behavior:
 *
 *   - editor empty + Down  → focus first manageable strip
 *   - focused strip: Enter/Right → open; Down → next manageable strip;
 *     Up/Left/Esc → blur
 *   - anything else → blur and fall through to the base editor
 */
export class CompositeStripEditor implements EditorComponent, Focusable {
  readonly fallbackActions = new Map<string, () => void>();
  private readonly base: EditorComponent;
  private readonly getBindings: () => readonly EditorStripBinding[];
  private focusedIndex = -1;
  private fallbackEscape?: () => void;
  private fallbackCtrlD?: () => void;
  private fallbackPasteImage?: () => void;
  private fallbackExtensionShortcut?: (data: string) => boolean;
  private _focused = false;

  constructor(
    base: EditorComponent,
    keybindings: KeybindingsManager,
    getBindings: () => readonly EditorStripBinding[],
  ) {
    this.base = base;
    this.getBindings = getBindings;
    void keybindings; // retained for the EditorComponent signature
  }

  private manageable(): readonly EditorStripBinding[] {
    return this.getBindings().filter((binding) => binding.canManage());
  }

  private setFocusedIndex(index: number) {
    const bindings = this.getBindings();
    if (this.focusedIndex >= 0 && this.focusedIndex < bindings.length) {
      bindings[this.focusedIndex]!.state.focused = false;
    }
    this.focusedIndex = index;
    if (index >= 0 && index < bindings.length) {
      bindings[index]!.state.focused = true;
      bindings[index]!.requestRender();
    }
  }

  private blurAll() {
    for (const binding of this.getBindings()) binding.state.focused = false;
    this.focusedIndex = -1;
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
    const manageable = this.manageable();
    if (this.focusedIndex < 0) {
      // No strip focused: Down on an empty editor focuses the first
      // manageable strip.
      if (
        manageable.length > 0 &&
        this.base.getText().length === 0 &&
        matchesKey(data, Key.down)
      ) {
        const first = this.getBindings().indexOf(manageable[0]!);
        this.setFocusedIndex(first);
        this._focused = true;
        return;
      }
      this.base.handleInput(data);
      return;
    }
    if (
      matchesKey(data, Key.up) ||
      matchesKey(data, Key.left) ||
      matchesKey(data, Key.escape)
    ) {
      this.setFocusedIndex(-1);
      this._focused = false;
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
      const current = this.getBindings()[this.focusedIndex];
      this.setFocusedIndex(-1);
      this._focused = false;
      current?.open();
      return;
    }
    if (matchesKey(data, Key.down)) {
      const focusedBinding = this.getBindings()[this.focusedIndex];
      const currentIndex = manageable.indexOf(focusedBinding);
      const next = manageable[(currentIndex + 1) % manageable.length];
      if (next) {
        this.setFocusedIndex(this.getBindings().indexOf(next));
        return;
      }
      return;
    }
    // Any other key: blur and fall through to the base editor.
    this.setFocusedIndex(-1);
    this._focused = false;
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
    this.blurAll();
    this._focused = false;
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

// --- Single installer ----------------------------------------------------------

/**
 * Structural subset of ExtensionContext the installer needs. Extensions pass
 * their real ExtensionContext; only these members are read.
 */
/**
 * Structural subset of ExtensionContext the installer needs. Extensions pass
 * their real ExtensionContext; only these members are read.
 */
export interface EditorInstallContext {
  mode: string;
  ui: {
    getEditorComponent(): unknown;
    setEditorComponent(factory: unknown): void;
  };
}

/**
 * Wrap the editor exactly once per runtime. Render enhancements apply in
 * registration order over the current editor, then the composite strip
 * wrapper owns keyboard routing across every registered strip. Deferred to a
 * microtask so all extensions' session_start registrations land first; the
 * install is idempotent thereafter (later /resume events never restack).
 */
export function installEditorEnhancements(ctx: EditorInstallContext): void {
  if (ctx.mode !== "tui") return;
  if (installerInstalled) return;
  installerInstalled = true;
  // Let every extension's session_start hook register its bindings before
  // the single wrap happens.
  queueMicrotask(() => {
    const previous = ctx.ui.getEditorComponent() as
      | ((
          tui: unknown,
          theme: unknown,
          keybindings: KeybindingsManager,
        ) => EditorComponent)
      | undefined;
    ctx.ui.setEditorComponent(
      (tui: unknown, theme: unknown, keybindings: KeybindingsManager) => {
        let editor: EditorComponent =
          previous?.(tui, theme, keybindings) ??
          new CustomEditor(tui as never, theme as never, keybindings);
        // Render enhancements first (suggestions line, …), registration order.
        for (const enhancement of renderEnhancements) {
          editor = enhancement.wrap(editor, keybindings);
        }
        // Then the composite keyboard router over all registered strips.
        return new CompositeStripEditor(
          editor,
          keybindings,
          () => stripBindings,
        );
      },
    );
  });
}
