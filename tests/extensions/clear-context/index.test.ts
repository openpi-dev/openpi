import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { EditorLayer } from "../../../extensions/shared/editor-layers.ts";
import {
  ClearContextEditor,
  installClearContextShortcut,
  shouldClearContext,
} from "../../../extensions/clear-context/index.ts";

test("Ctrl+C clears context only for an idle empty editor", () => {
  assert.equal(shouldClearContext("\u0003", "", true), true);
  assert.equal(shouldClearContext("\u0003", "draft", true), false);
  assert.equal(shouldClearContext("\u0003", "", false), false);
  assert.equal(shouldClearContext("x", "", true), false);
});

test("whitespace-only drafts preserve the native editor behavior", () => {
  assert.equal(shouldClearContext("\u0003", "  \n", true), false);
});

test("shortcut is registered as an editor layer and preserves the existing editor", () => {
  const listeners = new Map<string, (value: unknown) => void>();
  let registeredLayer: EditorLayer | undefined;
  const pi = {
    events: {
      emit(channel: string, value: unknown) {
        if (channel === "openpi:editor-layers:register") {
          registeredLayer = (value as { layer: EditorLayer }).layer;
        }
        listeners.get(channel)?.(value);
      },
      on(channel: string, listener: (value: unknown) => void) {
        listeners.set(channel, listener);
      },
    },
  } as unknown as ExtensionAPI;
  const base: EditorComponent = {
    render: () => [],
    invalidate() {},
    handleInput(data) {
      inputs.push(data);
    },
    getText: () => text,
    setText(value) {
      text = value;
    },
  };
  const inputs: string[] = [];
  let text = "draft";
  const ctx = {
    mode: "tui",
    isIdle: () => true,
  } as unknown as ExtensionContext;

  const remove = installClearContextShortcut(pi, ctx);
  assert.equal(registeredLayer?.id, "clear-context");
  const editor = registeredLayer!.wrap(
    base,
    {} as TUI,
    {} as EditorTheme,
    { matches: () => false } as unknown as KeybindingsManager,
  );
  editor.handleInput("x");
  assert.deepEqual(inputs, ["x"]);

  remove();
});

test("layer handles Ctrl+C only for idle empty editor", () => {
  const inputs: string[] = [];
  let text = "";
  let submitted: string | undefined;
  const base: EditorComponent = {
    render: () => [],
    invalidate() {},
    handleInput(data) {
      inputs.push(data);
    },
    getText: () => text,
    setText(value) {
      text = value;
    },
    onSubmit(value) {
      submitted = value;
    },
  };
  const editor = new ClearContextEditor(
    base,
    { matches: () => false } as unknown as KeybindingsManager,
    () => true,
  );

  editor.handleInput("\u0003");
  assert.equal(submitted, "/new");
  assert.deepEqual(inputs, []);

  text = "draft";
  editor.handleInput("\u0003");
  assert.deepEqual(inputs, ["\u0003"]);
});

test("Pi's new session has no history from the cleared session", () => {
  const session = SessionManager.inMemory(process.cwd());
  session.appendCustomMessageEntry("test-history", "old context", true);
  const previousSessionId = session.getSessionId();

  session.newSession();

  assert.notEqual(session.getSessionId(), previousSessionId);
  assert.deepEqual(session.getBranch(), []);
  assert.deepEqual(session.buildSessionContext().messages, []);
});
