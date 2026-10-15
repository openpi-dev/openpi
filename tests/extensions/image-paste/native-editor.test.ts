import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
  InteractiveMode,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  getKeybindings,
  ProcessTerminal,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import imagePaste, {
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
  const bytes = readFileSync(first);
  editor.insertTextAtCursor(first);
  editor.handleInput("\x15"); // Ctrl+U
  assert.equal(editor.getText(), "");
  assert.deepEqual(readFileSync(first), bytes);
  editor.insertTextAtCursor(second);
  assert.equal(editor.getText(), "[Image #2]");
  editor.handleInput("\x1f"); // Undo second insertion
  assert.equal(existsSync(second), false);
  editor.handleInput("\x1f"); // Undo Ctrl+U
  assert.equal(editor.getExpandedText(), first);
  assert.deepEqual(readFileSync(first), bytes);
  editor.handleInput("\r");
  assert.deepEqual(submitted, [first]);
  assert.deepEqual(readFileSync(first), bytes);
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
    const path = image();
    editor.insertTextAtCursor(path);
    if (reset === "clear") editor.setText("");
    else {
      editor.handleInput("\x15");
      store.cleanup();
    }
    // Native setText("") can also mean queue handoff; only the proven
    // removed-only cleanup window permits unlinking the file here.
    assert.equal(existsSync(path), reset === "clear");
    editor.handleInput("\x1f");
    editor.handleInput("\r");
    assert.deepEqual(submitted, ["[Image #1]"]);
  }
});

test("native Undo cannot revive a removed PNG across extension Session boundaries", () => {
  for (const boundary of ["session_start", "session_shutdown"]) {
    const { editor, store, submitted } = harness();
    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    imagePaste(
      {
        registerMarkdownTransformer() {},
        on(event: string, handler: (...args: unknown[]) => unknown) {
          hooks.set(event, handler);
        },
        events: { emit() {} },
      } as unknown as ExtensionAPI,
      store,
    );
    const path = image();
    const bytes = readFileSync(path);
    editor.insertTextAtCursor(path);
    editor.handleInput("\x15");
    assert.deepEqual(readFileSync(path), bytes);
    hooks.get(boundary)?.({}, { mode: "rpc" } as ExtensionContext);
    assert.equal(existsSync(path), false);
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

test("querying expanded text does not hand off a native insertion undone before delivery", () => {
  const { editor } = harness();
  const path = image();
  editor.insertTextAtCursor(path);
  assert.equal(editor.getExpandedText(), path);
  assert.equal(editor.getExpandedText(), path);
  editor.handleInput("\x1f");
  assert.equal(existsSync(path), false);
});

test("128 removed references retain PNG bytes and eviction reclaims only the oldest file", () => {
  const store = new ImageAttachmentStore();
  const paths = Array.from({ length: 129 }, () => image());
  const bytes = readFileSync(paths[0]!);
  const tokens: string[] = [];
  for (const path of paths) {
    tokens.push(store.attachClipboardPath(path, "")!);
    store.reconcileDraft("");
  }
  assert.equal(existsSync(paths[0]!), false);
  for (const path of paths.slice(1))
    assert.deepEqual(readFileSync(path), bytes);
  store.reconcileDraft(`${tokens[0]} ${tokens.at(-1)}`, true);
  assert.equal(
    store.expandPlaceholders(`${tokens[0]} ${tokens.at(-1)}`),
    `${tokens[0]} ${paths.at(-1)}`,
  );
  store.clearDraft();
  assert.equal(existsSync(paths[1]!), false);
  assert.deepEqual(readFileSync(paths.at(-1)!), bytes);
});

test("shared physical paths survive until their last eligible removed reference is revoked", () => {
  const store = new ImageAttachmentStore();
  const path = image();
  const bytes = readFileSync(path);
  const first = store.attachClipboardPath(path, "")!;
  const second = store.attachClipboardPath(path, first)!;
  store.reconcileDraft(second);
  store.reconcileDraft(`${first} ${second}`);
  assert.deepEqual(readFileSync(path), bytes);
  store.reconcileDraft("");
  assert.deepEqual(readFileSync(path), bytes);
  store.reconcileDraft(`${second} ${second}`);
  assert.equal(existsSync(path), false);
});

test("plain Enter transfers snapshot paths before reclaiming the old Undo window", () => {
  const { editor, submitted } = harness();
  const abandoned = image();
  const delivered = image();
  const bytes = readFileSync(delivered);
  editor.insertTextAtCursor(abandoned);
  editor.handleInput("\x15");
  editor.insertTextAtCursor(delivered);
  editor.handleInput("\r");
  assert.deepEqual(submitted, [delivered]);
  assert.deepEqual(readFileSync(delivered), bytes);
  assert.equal(existsSync(abandoned), false);
});

test("native queue and history adoption preserve handed-off PNGs and reclaim unrelated removed files", async () => {
  const { editor } = harness();
  const abandoned = image();
  const path = image();
  const bytes = readFileSync(path);
  editor.insertTextAtCursor(abandoned);
  editor.handleInput("\x15");
  editor.insertTextAtCursor(path);
  assert.equal(await roundTrip(editor), path);
  assert.equal(existsSync(abandoned), false);
  assert.deepEqual(readFileSync(path), bytes);
  editor.handleInput("\x15");
  editor.handleInput("[Image #1]");
  assert.deepEqual(readFileSync(path), bytes);
  editor.setText(path);
  editor.addToHistory(path);
  editor.setText("");
  editor.handleInput("\x1b[A");
  assert.equal(editor.getExpandedText(), path);
  editor.handleInput("\x15");
  editor.handleInput("[Image #1]");
  assert.deepEqual(readFileSync(path), bytes);
});

test("adoption protects an incoming path still referenced by the old removed window", () => {
  const { editor } = harness();
  const path = image();
  const bytes = readFileSync(path);
  editor.insertTextAtCursor(path);
  editor.handleInput("\x15");
  editor.setText(path);
  editor.insertTextAtCursor(path);
  editor.handleInput("\x15");
  editor.setText("");
  assert.deepEqual(readFileSync(path), bytes);
});

test("native typed and duplicate tokens revoke file ownership without Undo revival", () => {
  for (const duplicate of [false, true]) {
    const { editor } = harness();
    const path = image();
    editor.insertTextAtCursor(path);
    if (!duplicate) editor.handleInput("\x15");
    editor.handleInput("[Image #1]");
    assert.equal(existsSync(path), false);
    editor.handleInput("\x1f");
    assert.doesNotMatch(editor.getExpandedText(), /pi-clipboard-/);
  }
});

test("normalized aliases of the same physical PNG share direct-file ownership", () => {
  const store = new ImageAttachmentStore();
  const path = image();
  const bytes = readFileSync(path);
  const alias = path.replace(/([\\/])([^\\/]+)$/, "$1.$1$2");
  const first = store.attachClipboardPath(path, "")!;
  const second = store.attachClipboardPath(alias, first)!;
  store.reconcileDraft(`${first}${first} ${second}`);
  assert.deepEqual(readFileSync(alias), bytes);
  store.reconcileDraft(`${second}${second}`);
  assert.equal(existsSync(path), false);
});

test("native Enter hands off every active PNG even when the draft exceeds the Undo window", () => {
  const { editor, submitted } = harness();
  const paths = Array.from({ length: 129 }, () => image());
  const bytes = readFileSync(paths[0]!);
  for (const path of paths) editor.insertTextAtCursor(path);
  editor.handleInput("\r");
  assert.deepEqual(submitted, [paths.join("")]);
  for (const path of paths) assert.deepEqual(readFileSync(path), bytes);
});

test("native non-submit clearing still retires references beyond the 128 Undo window", () => {
  const { editor } = harness();
  const paths = Array.from({ length: 129 }, () => image());
  const bytes = readFileSync(paths[0]!);
  for (const path of paths) editor.insertTextAtCursor(path);
  editor.handleInput("\x15");
  assert.equal(existsSync(paths[0]!), false);
  for (const path of paths.slice(1))
    assert.deepEqual(readFileSync(path), bytes);
  editor.handleInput("\x1f");
  assert.equal(
    editor.getExpandedText(),
    `[Image #1]${paths.slice(1).join("")}`,
  );
});

test("macOS physical temp aliases share active, adopted, and delivered PNG ownership", {
  skip: process.platform !== "darwin",
}, () => {
  for (const mode of ["active", "adopt", "deliver"]) {
    const store = new ImageAttachmentStore();
    const path = image();
    const bytes = readFileSync(path);
    const alias = path.startsWith("/private/")
      ? path.slice(8)
      : `/private${path}`;
    assert.equal(realpathSync(path), realpathSync(alias));
    const first = store.attachClipboardPath(path, "")!;
    if (mode === "active") {
      const second = store.attachClipboardPath(alias, first)!;
      store.reconcileDraft(`${first}${first} ${second}`);
      assert.equal(store.expandPlaceholders(second), alias);
    } else {
      store.reconcileDraft("");
      if (mode === "adopt") {
        const token = store.adoptExpandedText(alias)!;
        assert.equal(store.expandPlaceholders(token), alias);
      } else {
        store.releaseDeliveredPaths(alias);
        store.clearDraft();
      }
    }
    assert.deepEqual(readFileSync(alias), bytes);
  }
});

for (const aliasKind of ["case", "hardlink"] as const) {
  test(`${aliasKind} aliases share active, adopted, and delivered physical ownership`, (t) => {
    for (const mode of ["active", "adopt", "deliver"]) {
      const store = new ImageAttachmentStore();
      const path = image();
      const bytes = readFileSync(path);
      const alias =
        aliasKind === "case"
          ? join(dirname(path), basename(path).toUpperCase())
          : join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
      if (aliasKind === "hardlink") {
        linkSync(path, alias);
        files.push(alias);
      } else if (!existsSync(alias)) {
        t.skip("filesystem is case sensitive");
        return;
      }
      assert.equal(statSync(path).dev, statSync(alias).dev);
      assert.equal(statSync(path).ino, statSync(alias).ino);
      const first = store.attachClipboardPath(path, "")!;
      if (mode === "active") {
        const second = store.attachClipboardPath(alias, first)!;
        store.reconcileDraft(`${first}${first} ${second}`);
        assert.equal(store.expandPlaceholders(second), alias);
      } else {
        store.reconcileDraft("");
        if (mode === "adopt") {
          const token = store.adoptExpandedText(alias)!;
          assert.equal(store.expandPlaceholders(token), alias);
        } else {
          store.releaseDeliveredPaths(alias);
          store.clearDraft();
        }
      }
      assert.deepEqual(readFileSync(path), bytes);
      assert.deepEqual(readFileSync(alias), bytes);
    }
  });
}

test("cleanup preserves a replaced or externally modified clipboard file", () => {
  for (const replacement of [true, false]) {
    const store = new ImageAttachmentStore();
    const path = image();
    const token = store.attachClipboardPath(path, "")!;
    if (replacement) {
      const moved = `${path}.moved`;
      files.push(moved);
      renameSync(path, moved);
    }
    const foreignBytes = Buffer.from("foreign replacement, not an owned draft");
    writeFileSync(path, foreignBytes);
    store.reconcileDraft(`${token}${token}`);
    assert.deepEqual(readFileSync(path), foreignBytes);
  }
});

test("an unresolved live file identity cannot authorize another draft file's deletion", () => {
  const store = new ImageAttachmentStore();
  const missing = image();
  const other = image();
  const bytes = readFileSync(other);
  const first = store.attachClipboardPath(missing, "")!;
  const second = store.attachClipboardPath(other, first)!;
  const moved = `${missing}.moved`;
  files.push(moved);
  renameSync(missing, moved);
  store.reconcileDraft(`${first} ${second}${second}`);
  assert.deepEqual(readFileSync(other), bytes);
  store.clearDraft();
  assert.deepEqual(readFileSync(other), bytes);
});

test("a foreign leaf symlink never grants ownership of its target", {
  skip: process.platform === "win32",
}, () => {
  const store = new ImageAttachmentStore();
  const target = image();
  const bytes = readFileSync(target);
  const link = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  files.push(link);
  symlinkSync(target, link);
  const token = store.attachClipboardPath(link, "")!;
  assert.ok(token);
  store.reconcileDraft(`${token}${token}`);
  assert.deepEqual(readFileSync(target), bytes);
  assert.equal(existsSync(link), true);
  const ownedPath = image();
  const ownedToken = store.attachClipboardPath(ownedPath, "")!;
  const moved = `${ownedPath}.moved`;
  files.push(moved);
  renameSync(ownedPath, moved);
  symlinkSync(target, ownedPath);
  store.reconcileDraft(`${ownedToken}${ownedToken}`);
  assert.deepEqual(readFileSync(target), bytes);
  assert.equal(existsSync(ownedPath), true);
});
