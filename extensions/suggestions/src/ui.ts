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

const FAKE_CURSOR_PATTERN = /\u001b\[7m \u001b\[(?:0|27)m/;
/**
 * Cells kept after the ghost for the hidden hardware cursor. The terminal owns
 * that column and CJK IME preedit is drawn there, so a composition can briefly
 * cover the ghost's last cell. Reserving a wide fixed preedit band instead
 * costs 16-31% of every idle row, and Pi's editor contract exposes only
 * committed input, never an IME composition event, so a wider reservation
 * cannot be limited to frames that actually need it.
 */
const HARDWARE_CURSOR_CELLS = 1;

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
  const index = lines.findIndex((line) => FAKE_CURSOR_PATTERN.test(line));
  if (index === -1) return undefined;
  const line = lines[index]!;
  const cursor = line.match(FAKE_CURSOR_PATTERN);
  if (!cursor || cursor.index === undefined) return undefined;
  const beforeCursor = line
    .slice(0, cursor.index)
    .replaceAll(CURSOR_MARKER, "");
  const prefix = `${beforeCursor}${cursor[0]}`;
  const remaining = Math.max(0, width - visibleWidth(prefix));
  // One terminal cell must remain after the hidden hardware cursor. At
  // narrower widths, suppress the ghost rather than placing the cursor at the
  // terminal's out-of-range column width.
  if (remaining <= HARDWARE_CURSOR_CELLS) return undefined;

  return {
    index,
    prefix,
    available: remaining - HARDWARE_CURSOR_CELLS,
    preedit: HARDWARE_CURSOR_CELLS,
  };
}

export function renderGhostSuggestion(
  lines: readonly string[],
  width: number,
  suggestion: string,
  dim: (text: string) => string,
) {
  const geometry = ghostGeometry(lines, width);
  if (!geometry) return [...lines];
  const { index, prefix, available, preedit } = geometry;
  const ghost = truncateToWidth(suggestion, available, "…");
  const content = `${prefix}${dim(ghost)}`;
  const padding = " ".repeat(
    Math.max(0, width - preedit - visibleWidth(content)),
  );
  const rendered = [...lines];
  // Keep the visible fake cursor and ghost inline, then park the hidden
  // hardware cursor in the single reserved cell at the row end. Terminal-owned
  // CJK IME preedit paints from that anchor, so an active composition can
  // cover the ghost's final cell until the next editor input dismisses it.
  rendered[index] =
    `${content}${padding}${CURSOR_MARKER}${" ".repeat(preedit)}`;
  return rendered;
}

/**
 * Transparent editor wrapper that shows one dim inline suggestion in an empty
 * editor. Right accepts without submitting; any other editor interaction
 * cancels the pending or visible suggestion. Existing management-strip
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
