import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installClearContextShortcut } from "../../../extensions/clear-context/index.ts";

function harness(text: string) {
  const listeners: Array<(data: string) => unknown> = [];
  let editorText = text;
  const ctx = {
    mode: "tui",
    ui: {
      getEditorText: () => editorText,
      setEditorText: (value: string) => {
        editorText = value;
      },
      onTerminalInput: (listener: (data: string) => unknown) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
    },
  } as unknown as ExtensionContext;
  const remove = installClearContextShortcut(ctx);
  return { ctx, editorText: () => editorText, listeners, remove };
}

test("Ctrl+C preserves the native clear-editor behavior when input has content", () => {
  const h = harness("draft");
  assert.deepEqual(h.listeners[0]?.("\u0003"), undefined);
  assert.equal(h.editorText(), "draft");
  h.remove();
});

test("Ctrl+C submits Pi's built-in /new command when the editor is empty", () => {
  const h = harness("  \n");
  assert.deepEqual(h.listeners[0]?.("\u0003"), { data: "\r" });
  assert.equal(h.editorText(), "/new");
  h.remove();
});
