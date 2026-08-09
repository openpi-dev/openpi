import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  BelowEditorNavigationEditor,
  BelowEditorStripState,
} from "../../shared/below-editor-navigation.ts";

const FAKE_CURSOR = "\u001b[7m \u001b[0m";

export interface SuggestionToken {
  readonly generation: number;
}

/** Ephemeral latest-wins state; suggestions are never written to session history. */
export class NextActionSuggestionState {
  private generation = 0;
  private active = false;
  private suggestion?: string;

  begin(): SuggestionToken {
    this.generation += 1;
    this.active = true;
    this.suggestion = undefined;
    return { generation: this.generation };
  }

  offer(
    token: SuggestionToken,
    suggestion: string | undefined,
    editorEmpty: boolean,
  ) {
    if (!this.active || token.generation !== this.generation) return false;
    if (!suggestion || !editorEmpty) {
      this.active = false;
      this.suggestion = undefined;
      return false;
    }
    this.suggestion = suggestion;
    return true;
  }

  cancel() {
    this.generation += 1;
    this.active = false;
    this.suggestion = undefined;
  }

  isActive() {
    return this.active;
  }

  peek() {
    return this.suggestion;
  }

  revision() {
    return this.generation;
  }

  accept() {
    const suggestion = this.suggestion;
    this.cancel();
    return suggestion;
  }
}

function isStripNavigation(data: string) {
  return (
    matchesKey(data, Key.up) ||
    matchesKey(data, Key.down) ||
    matchesKey(data, Key.left) ||
    matchesKey(data, Key.right) ||
    matchesKey(data, Key.enter) ||
    matchesKey(data, Key.escape)
  );
}

function ghostGeometry(lines: readonly string[], width: number) {
  const index = lines.findIndex((line) => line.includes(FAKE_CURSOR));
  if (index === -1) return undefined;
  const line = lines[index]!;
  const cursorStart = line.indexOf(FAKE_CURSOR);
  const prefix = line.slice(0, cursorStart).replaceAll(CURSOR_MARKER, "");
  const available = Math.max(0, width - visibleWidth(prefix));
  return available > 0 ? { index, prefix, available } : undefined;
}

export function renderGhostSuggestion(
  lines: readonly string[],
  width: number,
  suggestion: string,
  dim: (text: string) => string,
) {
  const geometry = ghostGeometry(lines, width);
  if (!geometry) return [...lines];
  const { index, prefix, available } = geometry;
  const ghost = truncateToWidth(suggestion, available, "…");
  const content = `${prefix}${dim(ghost)}`;
  const ghostLine =
    content + " ".repeat(Math.max(0, width - visibleWidth(content)));
  const rendered = [...lines];
  // macOS IMEs draw uncommitted preedit text directly on the hardware-cursor
  // row, before the editor receives any input event. A same-row ghost fights
  // that terminal-owned text and flickers. Keep the suggestion inside the
  // editor, but on its own row immediately below the cursor.
  rendered.splice(index + 1, 0, ghostLine);
  return rendered;
}

/**
 * Transparent editor wrapper that shows one dim suggestion on a dedicated row
 * inside an empty editor. Right accepts without submitting; any other editor
 * interaction cancels the pending or visible suggestion. Existing management-strip
 * navigation keeps precedence while a strip is focused.
 */
export class NextActionSuggestionEditor extends BelowEditorNavigationEditor {
  private readonly editor: EditorComponent;
  private readonly state: NextActionSuggestionState;
  private readonly onInteraction: () => void;
  private readonly requestSuggestionRender: () => void;
  private readonly dim: (text: string) => string;
  private visibleRevision?: number;

  constructor(
    base: EditorComponent,
    keybindings: KeybindingsManager,
    state: NextActionSuggestionState,
    onInteraction: () => void,
    requestRender: () => void,
    dim: (text: string) => string,
  ) {
    super(
      base,
      keybindings,
      new BelowEditorStripState(),
      () => false,
      () => undefined,
      requestRender,
    );
    this.editor = base;
    this.state = state;
    this.onInteraction = onInteraction;
    this.requestSuggestionRender = requestRender;
    this.dim = dim;
  }

  override handleInput(data: string) {
    if (this.state.isActive()) {
      if (this.hasFocusedStrip() && isStripNavigation(data)) {
        super.handleInput(data);
        return;
      }
      const suggestion = this.state.peek();
      if (
        suggestion &&
        this.visibleRevision === this.state.revision() &&
        this.editor.getText().length === 0 &&
        matchesKey(data, Key.right)
      ) {
        const accepted = this.state.accept();
        this.visibleRevision = undefined;
        if (accepted) super.setText(accepted);
        this.requestSuggestionRender();
        return;
      }
      this.visibleRevision = undefined;
      this.onInteraction();
    }
    super.handleInput(data);
  }

  override render(width: number) {
    const lines = super.render(width);
    const suggestion = this.state.peek();
    if (
      suggestion &&
      this.editor.getText().length === 0 &&
      ghostGeometry(lines, width)
    ) {
      this.visibleRevision = this.state.revision();
      return renderGhostSuggestion(lines, width, suggestion, this.dim);
    }
    this.visibleRevision = undefined;
    return lines;
  }

  override setText(text: string) {
    this.visibleRevision = undefined;
    if (this.state.isActive()) this.onInteraction();
    super.setText(text);
  }

  override insertTextAtCursor(text: string) {
    this.visibleRevision = undefined;
    if (this.state.isActive()) this.onInteraction();
    super.insertTextAtCursor(text);
  }
}
