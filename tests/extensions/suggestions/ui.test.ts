import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import {
  CURSOR_MARKER,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  BelowEditorNavigationEditor,
  BelowEditorStripState,
} from "../../../extensions/shared/below-editor-navigation.ts";
import {
  NextActionSuggestionEditor,
  NextActionSuggestionState,
  renderGhostSuggestion,
} from "../../../extensions/suggestions/src/ui.ts";

const FAKE_CURSOR = "\u001b[7m \u001b[0m";

class FakeEditor implements EditorComponent {
  focused = false;
  text = "";
  readonly inputs: string[] = [];
  onSubmit?: (text: string) => void;
  onEscape?: () => void;
  onCtrlD?: () => void;
  onPasteImage?: () => void;

  render(width: number) {
    return [
      "top",
      `${FAKE_CURSOR}${" ".repeat(Math.max(0, width - 1))}`,
      "bottom",
    ];
  }
  handleInput(data: string) {
    this.inputs.push(data);
    if (data.length === 1 && data >= " ") this.text += data;
  }
  setText(text: string) {
    this.text = text;
  }
  getText() {
    return this.text;
  }
  insertTextAtCursor(text: string) {
    this.text += text;
  }
  invalidate() {}
  getCursor() {
    return 0;
  }
  setCursor() {}
  getExpandedText() {
    return this.text;
  }
}

const keybindings = {
  getAction: () => undefined,
  matches: () => false,
} as unknown as KeybindingsManager;

function suggestionEditor(options?: {
  base?: EditorComponent;
  onInteraction?: () => void;
}) {
  const base = options?.base ?? new FakeEditor();
  const state = new NextActionSuggestionState();
  const editor = new NextActionSuggestionEditor(
    base,
    keybindings,
    state,
    options?.onInteraction ?? (() => state.cancel()),
    () => undefined,
    (text) => `\u001b[2m${text}\u001b[22m`,
  );
  return { base, state, editor };
}

test("latest-wins state rejects stale or non-empty-editor offers", () => {
  const state = new NextActionSuggestionState();
  const stale = state.begin();
  const latest = state.begin();
  assert.equal(state.offer(stale, "stale", true), false);
  assert.equal(state.offer(latest, "hidden", false), false);
  assert.equal(state.peek(), undefined);
  assert.equal(state.isActive(), false);
});

function editorRow(width: number) {
  return `${CURSOR_MARKER}${FAKE_CURSOR}${" ".repeat(width - 1)}`;
}

function reservedPreeditCells(row: string) {
  const markerIndex = row.indexOf(CURSOR_MARKER);
  assert.ok(markerIndex >= 0);
  return visibleWidth(row.slice(markerIndex + CURSOR_MARKER.length));
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Same contract as Pi TUI `TuiBase.extractCursorPosition`: find CURSOR_MARKER
 * in the visible viewport, take visibleWidth(before) as the hardware-cursor
 * column, then strip the APC marker before the terminal paints.
 */
function extractHardwareCursor(lines: readonly string[], height: number) {
  const viewportTop = Math.max(0, lines.length - height);
  const next = [...lines];
  for (let row = next.length - 1; row >= viewportTop; row--) {
    const line = next[row]!;
    const markerIndex = line.indexOf(CURSOR_MARKER);
    if (markerIndex === -1) continue;
    const col = visibleWidth(line.slice(0, markerIndex));
    next[row] =
      line.slice(0, markerIndex) +
      line.slice(markerIndex + CURSOR_MARKER.length);
    return { lines: next, row, col };
  }
  return undefined;
}

function paintVisibleCells(line: string, width: number) {
  const cells = Array.from({ length: width }, () => " ");
  let col = 0;
  for (const { segment } of graphemes.segment(stripTerminalSequences(line))) {
    const w = visibleWidth(segment);
    if (w <= 0) continue;
    if (col >= width) break;
    if (col + w > width) {
      // Wide glyphs that do not fit the last columns shift left, covering the
      // preceding cell. That is how a 1-cell pad loses the ghost's last char.
      col = Math.max(0, width - w);
    }
    cells[col] = segment;
    for (let i = 1; i < w && col + i < width; i++) cells[col + i] = "";
    col += w;
  }
  return cells;
}

/**
 * Terminal compositor: park the hardware cursor where Pi TUI would, then paint
 * IME preedit from that cell. CJK graphemes occupy two cells; a glyph that
 * cannot fit at the row end clamps left and overwrites earlier cells.
 */
function composeImePreedit(
  lines: readonly string[],
  width: number,
  preedit: string,
) {
  const cursor = extractHardwareCursor(lines, lines.length);
  assert.ok(cursor);
  const row = paintVisibleCells(cursor.lines[cursor.row]!, width);
  const ghostBefore = row.slice(0, cursor.col).map((cell) => cell);
  let col = cursor.col;
  let overwrittenGhostCells = 0;
  for (const { segment } of graphemes.segment(preedit)) {
    const w = visibleWidth(segment);
    if (w <= 0) continue;
    if (col + w > width) col = Math.max(0, width - w);
    for (let i = 0; i < w && col + i < width; i++) {
      if (col + i < cursor.col && ghostBefore[col + i] !== " ") {
        overwrittenGhostCells += 1;
      }
    }
    row[col] = segment;
    for (let i = 1; i < w && col + i < width; i++) row[col + i] = "";
    col += w;
  }
  return {
    hardwareCol: cursor.col,
    ghost: ghostBefore.join(""),
    overwrittenGhostCells,
    cells: row,
  };
}

test("renders the ghost on the first row with reserved IME preedit cells", () => {
  const width = 40;
  const lines = renderGhostSuggestion(
    ["top", editorRow(width), "bottom"],
    width,
    "run the full test suite",
    (text) => `\u001b[2m${text}\u001b[22m`,
  );

  assert.equal(lines.length, 3);
  assert.match(
    lines[1]!,
    /\u001b\[7m \u001b\[0m\u001b\[2mrun the full test suite/,
  );
  assert.equal(lines[2], "bottom");

  // The visible fake cursor and ghost stay on the first editor row. The hidden
  // hardware cursor moves after them, leaving cells where terminal-owned CJK
  // IME preedit can draw without overwriting the suggestion.
  const markerIndex = lines[1]!.indexOf(CURSOR_MARKER);
  assert.ok(markerIndex > lines[1]!.indexOf("run the full test suite"));
  assert.equal(reservedPreeditCells(lines[1]!), 12);
  assert.equal(visibleWidth(lines[1]!), width);
});

test("IME preedit reservation scales with terminal width up to 32 cells", () => {
  const cases = [
    { width: 40, preedit: 12 },
    { width: 80, preedit: 24 },
    { width: 120, preedit: 32 },
    { width: 200, preedit: 32 },
  ];
  for (const { width, preedit } of cases) {
    const lines = renderGhostSuggestion(
      ["top", editorRow(width), "bottom"],
      width,
      "run the full test suite",
      (text) => text,
    );
    assert.equal(reservedPreeditCells(lines[1]!), preedit, `width ${width}`);
    assert.equal(visibleWidth(lines[1]!), width);
  }
});

test("Pi TUI parks the hardware cursor at the start of the reserved IME band", () => {
  const width = 40;
  const lines = renderGhostSuggestion(
    ["top", editorRow(width), "bottom"],
    width,
    "run tests",
    (text) => text,
  );
  const cursor = extractHardwareCursor(lines, lines.length);
  assert.ok(cursor);
  assert.equal(cursor.row, 1);
  assert.equal(cursor.col, width - 12);
  assert.equal(cursor.lines[1]!.includes(CURSOR_MARKER), false);
});

test("a long CJK IME preedit stays inside the reserved band", () => {
  const width = 80;
  const lines = renderGhostSuggestion(
    ["top", editorRow(width), "bottom"],
    width,
    "run the full test suite",
    (text) => text,
  );
  // 12 CJK syllables → 24 cells, matching width 80's 30% reservation.
  const composed = composeImePreedit(lines, width, "にほんごにほんごにほんご");
  assert.equal(composed.hardwareCol, width - 24);
  assert.equal(composed.overwrittenGhostCells, 0);
  assert.match(composed.ghost, /run the full test suite/);
  assert.equal(composed.ghost.includes("にほん"), false);
});

test("a 1-cell hardware pad lets a wide CJK preedit cover the ghost", () => {
  const width = 40;
  const ghost = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const conservative = renderGhostSuggestion(
    ["top", editorRow(width), "bottom"],
    width,
    ghost,
    (text) => text,
  );
  // Rejected 1-cell layout: fill the row except one hardware-cursor cell.
  const oneCellGhost = truncateToWidth(ghost, width - 2, "…");
  const oneCellPad = `${FAKE_CURSOR}${oneCellGhost}${CURSOR_MARKER} `;
  assert.equal(visibleWidth(oneCellPad), width);

  const preedit = "漢字"; // 4 cells; a 1-cell pad must clamp left.
  const safe = composeImePreedit(conservative, width, preedit);
  const unsafe = composeImePreedit(
    [conservative[0]!, oneCellPad, conservative[2]!],
    width,
    preedit,
  );
  assert.equal(safe.overwrittenGhostCells, 0);
  assert.ok(unsafe.overwrittenGhostCells > 0);
  assert.ok(unsafe.ghost.includes("…"));
});

test("a truncated ghost still leaves the conservative IME preedit band", () => {
  const width = 40;
  const lines = renderGhostSuggestion(
    ["top", editorRow(width), "bottom"],
    width,
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
    (text) => text,
  );

  const markerIndex = lines[1]!.indexOf(CURSOR_MARKER);
  const beforeMarker = lines[1]!.slice(0, markerIndex);
  assert.ok(beforeMarker.includes("…"));
  assert.equal(visibleWidth(beforeMarker), width - 12);
  assert.equal(reservedPreeditCells(lines[1]!), 12);
  assert.equal(visibleWidth(lines[1]!), width);
});

test("Right accepts into an empty editor without submitting", () => {
  const base = new FakeEditor();
  const { state, editor } = suggestionEditor({ base });
  const token = state.begin();
  assert.equal(state.offer(token, "run tests", true), true);
  editor.render(40);

  editor.handleInput("\u001b[C");

  assert.equal(base.getText(), "run tests");
  assert.deepEqual(base.inputs, []);
  assert.equal(state.peek(), undefined);
});

test("an invisible suggestion never steals Right from a custom editor", () => {
  const base = new FakeEditor();
  base.render = () => [">"];
  const { state, editor } = suggestionEditor({ base });
  state.offer(state.begin(), "run tests", true);
  editor.render(40);

  editor.handleInput("\u001b[C");

  assert.equal(base.getText(), "");
  assert.deepEqual(base.inputs, ["\u001b[C"]);
  assert.equal(state.peek(), undefined);
});

test("an editor too narrow to reserve an IME cell does not steal Right", () => {
  const base = new FakeEditor();
  const { state, editor } = suggestionEditor({ base });
  state.offer(state.begin(), "run tests", true);
  editor.render(9);

  editor.handleInput("\u001b[C");

  assert.equal(base.getText(), "");
  assert.deepEqual(base.inputs, ["\u001b[C"]);
  assert.equal(state.peek(), undefined);
});

test("suppresses ghost when the minimum IME band cannot fit", () => {
  const base = new FakeEditor();
  const { state, editor } = suggestionEditor({ base });
  state.offer(state.begin(), "run tests", true);

  assert.equal(editor.render(20)[1], `${FAKE_CURSOR}${" ".repeat(19)}`);
  assert.notEqual(editor.render(21)[1], base.render(21)[1]);
  assert.match(editor.render(21)[1]!, /run tes/);
});

test("supports a custom editor cursor with a selective reverse reset", () => {
  const selectiveCursor = "\u001b[7m \u001b[27m";
  const lines = renderGhostSuggestion(
    ["top", `${CURSOR_MARKER}${selectiveCursor}${" ".repeat(39)}`, "bottom"],
    40,
    "run tests",
    (text) => `\u001b[2m${text}\u001b[22m`,
  );

  assert.equal(lines.length, 3);
  assert.match(lines[1]!, /\u001b\[7m \u001b\[27m\u001b\[2mrun tests/);
  assert.ok(lines[1]!.indexOf(CURSOR_MARKER) > lines[1]!.indexOf("run tests"));
});

test("any other editor input cancels then passes through", () => {
  const base = new FakeEditor();
  let interactions = 0;
  const state = new NextActionSuggestionState();
  const editor = new NextActionSuggestionEditor(
    base,
    keybindings,
    state,
    () => {
      interactions += 1;
      state.cancel();
    },
    () => undefined,
    (text) => text,
  );
  state.offer(state.begin(), "run tests", true);

  editor.handleInput("x");

  assert.equal(interactions, 1);
  assert.equal(state.peek(), undefined);
  assert.equal(base.getText(), "x");
});

test("focused management strips keep Right navigation precedence", () => {
  const base = new FakeEditor();
  const strip = new BelowEditorStripState();
  let opens = 0;
  const inner = new BelowEditorNavigationEditor(
    base,
    keybindings,
    strip,
    () => true,
    () => {
      opens += 1;
    },
    () => undefined,
  );
  inner.handleInput("\u001b[B");
  assert.equal(strip.focused, true);

  const { state, editor } = suggestionEditor({ base: inner });
  state.offer(state.begin(), "run tests", true);
  editor.handleInput("\u001b[C");

  assert.equal(opens, 1);
  assert.equal(base.getText(), "");
  assert.equal(state.peek(), "run tests");
});
