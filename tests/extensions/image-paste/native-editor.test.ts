import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  InteractiveMode,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  getKeybindings,
  ProcessTerminal,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import {
  ImageAttachmentEditor,
  ImageAttachmentStore,
} from "../../../extensions/image-paste/index.ts";

const files: string[] = [];
test.after(() => {
  for (const path of files) rmSync(path, { force: true });
});
function image() {
  const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  writeFileSync(
    path,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7X8AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  files.push(path);
  return path;
}
function harness() {
  const identity = (text: string) => text;
  const base = new Editor(new TuiMainScreen(new ProcessTerminal()), {
    borderColor: identity,
    selectList: {
      selectedPrefix: identity,
      selectedText: identity,
      description: identity,
      scrollInfo: identity,
      noMatch: identity,
    },
  });
  const store = new ImageAttachmentStore();
  const editor = new ImageAttachmentEditor(
    base,
    getKeybindings() as unknown as KeybindingsManager,
    store,
  );
  const submitted: string[] = [];
  editor.onSubmit = (text) => submitted.push(text);
  return { editor, store, submitted };
}
async function roundTrip(editor: ImageAttachmentEditor) {
  const queue: string[] = [];
  const host = {
    editor,
    ui: { requestRender() {} },
    session: {
      isCompacting: false,
      isStreaming: true,
      async prompt(text: string) {
        queue.push(text);
      },
    },
    updatePendingMessagesDisplay() {},
    clearAllQueues() {
      return { steering: [], followUp: queue.splice(0) };
    },
  };
  // Exercise the locked native private hooks without constructing a provider session.
  const hooks = InteractiveMode.prototype as unknown as {
    handleFollowUp(this: typeof host): Promise<void>;
    restoreQueuedMessagesToEditor(this: typeof host): number;
  };
  await hooks.handleFollowUp.call(host);
  const queued = queue[0];
  assert.equal(editor.getText(), "");
  assert.equal(hooks.restoreQueuedMessagesToEditor.call(host), 1);
  return queued;
}

test("native queue restoration preserves literal tokens and repeated image paths", async () => {
  const { editor, submitted } = harness();
  const path = image();
  editor.handleInput("[Image #1] [Image #3] ");
  editor.insertTextAtCursor(path);
  editor.handleInput(" and ");
  editor.insertTextAtCursor(path);
  const queued = await roundTrip(editor);
  assert.equal(queued, `[Image #1] [Image #3] ${path} and ${path}`);
  assert.equal(
    editor.getText(),
    "[Image #1] [Image #3] [Image #2] and [Image #4]",
  );
  editor.handleInput("\r");
  assert.equal(submitted[0], queued);
});

test("native Undo recovers a removed attachment without reusing its identity", () => {
  const { editor, submitted } = harness();
  const first = image(),
    second = image();
  editor.insertTextAtCursor(first);
  editor.handleInput("\x15"); // Ctrl+U
  assert.equal(editor.getText(), "");
  editor.insertTextAtCursor(second);
  assert.equal(editor.getText(), "[Image #2]");
  editor.handleInput("\x1f"); // Undo second insertion
  editor.handleInput("\x1f"); // Undo Ctrl+U
  assert.equal(editor.getExpandedText(), first);
  editor.handleInput("\r");
  assert.deepEqual(submitted, [first]);
});

test("typing a removed token remains literal even after native Undo", () => {
  const { editor, submitted } = harness();
  editor.insertTextAtCursor(image());
  editor.handleInput("\x15");
  editor.handleInput("[Image #1]");
  assert.equal(editor.getExpandedText(), "[Image #1]");
  editor.handleInput("\x15");
  editor.handleInput("\x1f");
  editor.handleInput("\r");
  assert.deepEqual(submitted, ["[Image #1]"]);
});

test("explicit clear and cleanup cannot resurrect attachments through native Undo", () => {
  for (const reset of ["clear", "cleanup"] as const) {
    const { editor, store, submitted } = harness();
    editor.insertTextAtCursor(image());
    if (reset === "clear") editor.setText("");
    else {
      editor.handleInput("\x15");
      store.cleanup();
    }
    editor.handleInput("\x1f");
    editor.handleInput("\r");
    assert.deepEqual(submitted, ["[Image #1]"]);
  }
});

test("submission releases removed mappings before the next native draft", () => {
  const { editor, submitted } = harness();
  editor.insertTextAtCursor(image());
  editor.handleInput("\x15");
  editor.handleInput("ordinary");
  editor.handleInput("\r");
  editor.handleInput("[Image #1]");
  editor.handleInput("\r");
  assert.deepEqual(submitted, ["ordinary", "[Image #1]"]);
});

test("attachment recovery keeps a bounded window of removed identities", () => {
  const store = new ImageAttachmentStore();
  const path = image();
  const first = store.attachClipboardPath(path, "");
  let last = first;
  for (let i = 0; i < 256; i += 1) {
    store.reconcileDraft("");
    last = store.attachClipboardPath(path, "");
  }
  store.reconcileDraft("");
  assert(first && last);
  store.reconcileDraft(`${first} ${last}`, true);
  assert.equal(
    store.expandPlaceholders(`${first} ${last}`),
    `${first} ${path}`,
  );
});

test("undoing a new insertion cannot bind an older cleared token to that image", () => {
  const { editor, submitted } = harness();
  editor.insertTextAtCursor(image());
  editor.handleInput("\x15");
  editor.setText("");
  editor.insertTextAtCursor(image());
  editor.handleInput("\x1f");
  editor.handleInput("\x1f");
  editor.handleInput("\r");
  assert.deepEqual(submitted, ["[Image #1]"]);
});
