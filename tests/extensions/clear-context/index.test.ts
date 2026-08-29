import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
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

test("shortcut is installed on the focused editor layer and restores the previous editor", () => {
  const previousEditor = () => undefined;
  let configuredEditor = previousEditor;
  let terminalInputInstalled = false;
  const ctx = {
    mode: "tui",
    isIdle: () => true,
    ui: {
      getEditorComponent: () => configuredEditor,
      setEditorComponent: (factory: typeof previousEditor | undefined) => {
        configuredEditor = factory ?? previousEditor;
      },
      onTerminalInput: () => {
        terminalInputInstalled = true;
        return () => {};
      },
    },
  } as unknown as ExtensionContext;

  const remove = installClearContextShortcut(ctx);
  assert.notEqual(configuredEditor, previousEditor);
  assert.equal(terminalInputInstalled, false);

  remove();
  assert.equal(configuredEditor, previousEditor);
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
