import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import {
  BelowEditorNavigationEditor,
  BelowEditorStripState,
} from "./below-editor-navigation.ts";

function baseEditor(inputs: string[]) {
  let text = "";
  return {
    render: () => [">"],
    invalidate() {},
    handleInput: (data: string) => inputs.push(data),
    getText: () => text,
    setText: (value: string) => {
      text = value;
    },
  } as EditorComponent;
}

const keybindings = { matches: () => false } as unknown as KeybindingsManager;

test("nested below-editor strips are reachable with repeated Down", () => {
  const inputs: string[] = [];
  const innerState = new BelowEditorStripState();
  const outerState = new BelowEditorStripState();
  let innerOpened = 0;
  let outerOpened = 0;
  const inner = new BelowEditorNavigationEditor(
    baseEditor(inputs),
    keybindings,
    innerState,
    () => true,
    () => {
      innerOpened += 1;
    },
    () => {},
  );
  const outer = new BelowEditorNavigationEditor(
    inner,
    keybindings,
    outerState,
    () => true,
    () => {
      outerOpened += 1;
    },
    () => {},
  );

  outer.handleInput("\u001b[B");
  assert.equal(outerState.focused, true);
  assert.equal(innerState.focused, false);

  outer.handleInput("\u001b[B");
  assert.equal(outerState.focused, false);
  assert.equal(innerState.focused, true);
  outer.handleInput("\r");
  assert.equal(innerOpened, 1);

  outer.handleInput("\u001b[B");
  outer.handleInput("\u001b[B");
  assert.equal(innerState.focused, true);
  outer.handleInput("\u001b[B");
  assert.equal(outerState.focused, true);
  assert.equal(innerState.focused, false);
  outer.handleInput("\r");
  assert.equal(outerOpened, 1);
  assert.deepEqual(inputs, []);
});

test("a newly available outer strip can take focus from a nested strip", () => {
  const inputs: string[] = [];
  const innerState = new BelowEditorStripState();
  const outerState = new BelowEditorStripState();
  let outerAvailable = false;
  const inner = new BelowEditorNavigationEditor(
    baseEditor(inputs),
    keybindings,
    innerState,
    () => true,
    () => {},
    () => {},
  );
  const outer = new BelowEditorNavigationEditor(
    inner,
    keybindings,
    outerState,
    () => outerAvailable,
    () => {},
    () => {},
  );

  outer.handleInput("\u001b[B");
  assert.equal(innerState.focused, true);
  outerAvailable = true;
  outer.handleInput("\u001b[B");
  assert.equal(outerState.focused, true);
  assert.equal(innerState.focused, false);
});

test("Down remains consumed when a focused strip has no nested peer", () => {
  const inputs: string[] = [];
  const state = new BelowEditorStripState();
  const editor = new BelowEditorNavigationEditor(
    baseEditor(inputs),
    keybindings,
    state,
    () => true,
    () => {},
    () => {},
  );

  editor.handleInput("\u001b[B");
  editor.handleInput("\u001b[B");
  assert.equal(state.focused, true);
  assert.deepEqual(inputs, []);
});
