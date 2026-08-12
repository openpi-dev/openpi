import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type EditorComponent,
  type Focusable,
} from "@earendil-works/pi-tui";
import { BelowEditorStripState } from "./below-editor-navigation.ts";
import {
  CompositeStripEditor,
  getEditorRenderEnhancements,
  getEditorStripBindings,
  installEditorEnhancements,
  registerEditorRenderEnhancement,
  registerEditorStrip,
  resetEditorEnhancements,
  type EditorStripBinding,
} from "./editor-strip-port.ts";

/** Minimal editor double with input capture and text state. */
class StubEditor implements EditorComponent {
  text = "";
  inputLog: string[] = [];
  focused = false;
  getText() {
    return this.text;
  }
  setText(text: string) {
    this.text = text;
  }
  handleInput(data: string) {
    this.inputLog.push(data);
  }
  render() {
    return [""];
  }
  invalidate() {}
  getExpandedText() {
    return this.text;
  }
  addToHistory() {}
  insertTextAtCursor() {}
  setAutocompleteProvider() {}
  setPaddingX() {}
  setAutocompleteMaxVisible() {}
  get wantsKeyRelease() {
    return false;
  }
  get onSubmit() {
    return undefined;
  }
  set onSubmit(_value: ((text: string) => void) | undefined) {}
  get onChange() {
    return undefined;
  }
  set onChange(_value: ((text: string) => void) | undefined) {}
  get borderColor() {
    return undefined;
  }
  set borderColor(_value: ((text: string) => string) | undefined) {}
}

const keybindings = {
  matches: (data: string, binding: string) => data === `__${binding}__`,
} as unknown as KeybindingsManager;

function makeBinding(
  id: string,
  canManage: boolean,
  opened: string[],
  renders: number[],
): EditorStripBinding {
  const state = new BelowEditorStripState();
  return {
    id,
    state,
    canManage: () => canManage,
    open: () => opened.push(id),
    requestRender: () => renders.push(1),
  };
}

test("composite routes focus across multiple strips in registration order", () => {
  const opened: string[] = [];
  const renders: number[] = [];
  const a = makeBinding("subagents", true, opened, renders);
  const b = makeBinding("workflows", true, opened, renders);
  const editor = new StubEditor();
  const composite = new CompositeStripEditor(editor, keybindings, () => [a, b]);

  // Down on an empty editor focuses the first manageable strip.
  composite.handleInput("\x1b[B"); // Key.down
  assert.equal(a.state.focused, true);
  assert.equal(b.state.focused, false);

  // Down advances to the next strip.
  composite.handleInput("\x1b[B");
  assert.equal(a.state.focused, false);
  assert.equal(b.state.focused, true);

  // Enter opens the focused strip.
  composite.handleInput("\r");
  assert.deepEqual(opened, ["workflows"]);
  assert.equal(a.state.focused, false);
  assert.equal(b.state.focused, false);

  // Down focuses the first strip again; Up blurs.
  composite.handleInput("\x1b[B");
  assert.equal(a.state.focused, true);
  composite.handleInput("\x1b[A"); // Key.up
  assert.equal(a.state.focused, false);
});

test("composite skips unmanageable strips and falls through to base editor", () => {
  const opened: string[] = [];
  const renders: number[] = [];
  const a = makeBinding("subagents", false, opened, renders);
  const b = makeBinding("workflows", true, opened, renders);
  const editor = new StubEditor();
  const composite = new CompositeStripEditor(editor, keybindings, () => [a, b]);

  // Down skips the unmanageable subagents strip and focuses workflows.
  composite.handleInput("\x1b[B");
  assert.equal(a.state.focused, false);
  assert.equal(b.state.focused, true);

  // A typing key blurs and reaches the base editor.
  composite.handleInput("x");
  assert.equal(b.state.focused, false);
  assert.deepEqual(editor.inputLog, ["x"]);
});

test("installer wraps once, applies enhancements in order, and is idempotent", async () => {
  resetEditorEnhancements();
  const wraps: string[] = [];
  const ctx = {
    mode: "tui",
    ui: {
      // Provide a base factory so the installer never constructs the real
      // CustomEditor with null args in this unit test.
      getEditorComponent: () => () => new StubEditor(),
      setEditorComponent: (factory: unknown) => {
        const created = (
          factory as (tui: unknown, theme: unknown, kb: unknown) => unknown
        )(null, null, keybindings);
        wraps.push(created?.constructor?.name ?? "?");
      },
    },
  };
  registerEditorRenderEnhancement({
    id: "suggestions",
    wrap: (base) => {
      wraps.push("enh:suggestions");
      return base;
    },
  });
  registerEditorStrip({
    id: "subagents",
    state: new BelowEditorStripState(),
    canManage: () => false,
    open: () => {},
    requestRender: () => {},
  });
  installEditorEnhancements(ctx);
  // The install is deferred to a microtask so all registrations land first.
  await Promise.resolve();
  assert.equal(wraps.filter((w) => w === "enh:suggestions").length, 1);
  assert.equal(wraps.filter((w) => w === "CompositeStripEditor").length, 1);

  // A second install (e.g. a later /resume session_start) does nothing.
  const before = wraps.length;
  installEditorEnhancements(ctx);
  await Promise.resolve();
  assert.equal(wraps.length, before);
  resetEditorEnhancements();
});

test("registries dedupe by id and reset cleanly", () => {
  resetEditorEnhancements();
  const state = new BelowEditorStripState();
  registerEditorStrip({
    id: "subagents",
    state,
    canManage: () => false,
    open: () => {},
    requestRender: () => {},
  });
  registerEditorStrip({
    id: "subagents",
    state,
    canManage: () => false,
    open: () => {},
    requestRender: () => {},
  });
  assert.equal(getEditorStripBindings().length, 1);
  registerEditorRenderEnhancement({ id: "suggestions", wrap: (base) => base });
  registerEditorRenderEnhancement({ id: "suggestions", wrap: (base) => base });
  assert.equal(getEditorRenderEnhancements().length, 1);
  resetEditorEnhancements();
  assert.deepEqual(getEditorStripBindings(), []);
  assert.deepEqual(getEditorRenderEnhancements(), []);
});
