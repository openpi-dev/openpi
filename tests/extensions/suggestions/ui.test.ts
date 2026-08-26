import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
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

test("renders the ghost on the first row with reserved IME preedit cells", () => {
  const width = 40;
  const lines = renderGhostSuggestion(
    ["top", `${CURSOR_MARKER}${FAKE_CURSOR}${" ".repeat(width - 1)}`, "bottom"],
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
  assert.equal(
    visibleWidth(lines[1]!.slice(markerIndex + CURSOR_MARKER.length)),
    12,
  );
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
