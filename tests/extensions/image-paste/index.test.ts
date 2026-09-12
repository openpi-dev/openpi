import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import {
  collapseClipboardPaths,
  ImageAttachmentEditor,
  ImageAttachmentStore,
} from "../../../extensions/image-paste/index.ts";

const created: string[] = [];

function temporaryImage(extension: "jpg" | "png", bytes: string) {
  const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.${extension}`);
  writeFileSync(path, bytes);
  created.push(path);
  return path;
}

test.after(() => {
  for (const path of created) rmSync(path, { force: true });
});

class FakeEditor implements EditorComponent {
  focused = false;
  text = "";
  cursor = 0;
  setTextCalls = 0;
  history: string[] = [];
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;

  render() {
    return [this.text];
  }

  invalidate() {}

  getText() {
    return this.text;
  }

  getExpandedText() {
    return this.text;
  }

  getCursor() {
    const before = this.text.slice(0, this.cursor).split("\n");
    return { line: before.length - 1, col: before.at(-1)?.length ?? 0 };
  }

  setText(text: string) {
    this.setTextCalls += 1;
    this.text = text;
    this.cursor = text.length;
    this.onChange?.(text);
  }

  insertTextAtCursor(text: string) {
    this.text =
      this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
    this.cursor += text.length;
    this.onChange?.(this.text);
  }

  addToHistory(text: string) {
    this.history.push(text);
  }

  handleInput(data: string) {
    if (data === "\u001b[D") this.cursor = Math.max(0, this.cursor - 1);
    if (data === "\u001b[C") {
      this.cursor = Math.min(this.text.length, this.cursor + 1);
    }
    if (data === "BACKSPACE" && this.cursor > 0) {
      this.text =
        this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor);
      this.cursor -= 1;
      this.onChange?.(this.text);
    }
  }

  submit() {
    const text = this.text.trim();
    this.text = "";
    this.cursor = 0;
    this.onChange?.("");
    this.onSubmit?.(text);
  }
}

const keybindings = {
  matches: (data: string, action: string) =>
    data === "BACKSPACE" && action === "tui.editor.deleteCharBackward",
} as unknown as KeybindingsManager;

function harness() {
  const store = new ImageAttachmentStore();
  const base = new FakeEditor();
  const editor = new ImageAttachmentEditor(base, keybindings, store);
  const submitted: string[] = [];
  editor.onSubmit = (text) => submitted.push(text);
  return { store, base, editor, submitted };
}

/**
 * Mirrors Pi's InteractiveMode.handleFollowUp(): it reads the text through
 * getExpandedText() *before* choosing a delivery path, and only the idle branch
 * reaches onSubmit. The streaming and compaction branches hand the text to
 * prompt()/queueCompactionMessage() directly.
 */
function handleFollowUp(
  editor: ImageAttachmentEditor,
  branch: "idle" | "streaming" | "compacting",
) {
  const text = editor.getExpandedText().trim();
  if (!text) return undefined;
  if (branch === "idle") {
    editor.setText("");
    editor.onSubmit?.(text);
    return text;
  }
  editor.setText("");
  return text;
}

test("clipboard paths display as compact placeholders while editing", () => {
  const first = temporaryImage("png", "first");
  const second = temporaryImage("jpg", "second");
  const { editor } = harness();

  editor.insertTextAtCursor("before ");
  editor.insertTextAtCursor(first);
  editor.insertTextAtCursor(" between ");
  editor.insertTextAtCursor(second);

  assert.equal(editor.getText(), "before [Image #1] between [Image #2]");
});

test("submission expands placeholders back to the original clipboard paths", () => {
  const first = temporaryImage("png", "first");
  const second = temporaryImage("jpg", "second");
  const { base, editor, submitted } = harness();

  editor.insertTextAtCursor("before ");
  editor.insertTextAtCursor(first);
  editor.insertTextAtCursor(" between ");
  editor.insertTextAtCursor(second);
  base.submit();

  // Pi's own contract: the message text carries real paths so the read tool can
  // open them. The placeholder is a display concern and never leaves the editor.
  assert.equal(submitted[0], `before ${first} between ${second}`);
});

test("submitted clipboard files are left on disk for the read tool", () => {
  const path = temporaryImage("png", "kept");
  const { base, editor } = harness();

  editor.insertTextAtCursor(path);
  base.submit();

  // Pi never deletes clipboard images; preserving that keeps the path valid
  // for later turns, including after a compaction retry.
  assert.equal(existsSync(path), true);
});

test("backspace anywhere in an image placeholder removes it atomically", () => {
  const path = temporaryImage("png", "image");
  const { base, editor } = harness();

  editor.insertTextAtCursor("left ");
  editor.insertTextAtCursor(path);
  editor.insertTextAtCursor(" right");
  base.cursor = "left [Image".length;
  editor.handleInput("BACKSPACE");

  assert.equal(editor.getText(), "left  right");
  assert.equal(base.cursor, "left ".length);
  assert.equal(base.setTextCalls, 0);
});

test("a removed placeholder is not expanded on submission", () => {
  const path = temporaryImage("png", "image");
  const { base, editor, submitted } = harness();

  editor.insertTextAtCursor("keep ");
  editor.insertTextAtCursor(path);
  base.cursor = editor.getText().length;
  editor.handleInput("BACKSPACE");
  base.submit();

  assert.equal(submitted[0], "keep");
  assert.equal(existsSync(path), true);
});

test("ordinary paths and unregistered placeholder text stay ordinary text", () => {
  const { base, editor, submitted } = harness();

  editor.insertTextAtCursor("/tmp/example.png [Image #1]");
  assert.equal(editor.getText(), "/tmp/example.png [Image #1]");
  base.submit();

  assert.equal(submitted[0], "/tmp/example.png [Image #1]");
});

test("duplicating a placeholder makes both copies ordinary text", () => {
  const path = temporaryImage("png", "image");
  const { base, editor, submitted } = harness();

  editor.insertTextAtCursor(path);
  editor.insertTextAtCursor(" [Image #1]");
  assert.equal(editor.getText(), "[Image #1] [Image #1]");
  base.submit();

  // An ambiguous token cannot own a path, so neither copy expands.
  assert.equal(submitted[0], "[Image #1] [Image #1]");
  assert.equal(existsSync(path), true);
});

test("deleting the last image makes its number available to the next paste", () => {
  const first = temporaryImage("png", "first");
  const second = temporaryImage("png", "second");
  const third = temporaryImage("png", "third");
  const { base, editor, submitted } = harness();

  editor.insertTextAtCursor(first);
  editor.insertTextAtCursor(" ");
  editor.insertTextAtCursor(second);
  assert.equal(editor.getText(), "[Image #1] [Image #2]");

  base.cursor = editor.getText().length;
  editor.handleInput("BACKSPACE");
  assert.equal(editor.getText(), "[Image #1] ");

  base.cursor = editor.getText().length;
  editor.insertTextAtCursor(third);
  assert.equal(editor.getText(), "[Image #1] [Image #2]");

  base.submit();
  assert.equal(submitted[0], `${first} ${third}`);
});

test("deleting an earlier image does not reorder later image numbers", () => {
  const first = temporaryImage("png", "first");
  const second = temporaryImage("png", "second");
  const third = temporaryImage("png", "third");
  const { base, editor, submitted } = harness();

  editor.insertTextAtCursor(first);
  editor.insertTextAtCursor(" ");
  editor.insertTextAtCursor(second);
  base.cursor = "[Image #1]".length;
  editor.handleInput("BACKSPACE");

  assert.equal(editor.getText(), " [Image #2]");
  base.cursor = editor.getText().length;
  editor.insertTextAtCursor(" ");
  editor.insertTextAtCursor(third);
  assert.equal(editor.getText(), " [Image #2] [Image #3]");

  base.submit();
  assert.equal(submitted[0], `${second} ${third}`);
});

test("consecutive submissions do not leak placeholders across drafts", () => {
  const first = temporaryImage("png", "first");
  const second = temporaryImage("png", "second");
  const { base, editor, submitted } = harness();

  editor.insertTextAtCursor(first);
  base.submit();
  editor.insertTextAtCursor(second);
  assert.equal(editor.getText(), "[Image #1]");
  base.submit();

  assert.equal(submitted[0], first);
  assert.equal(submitted[1], second);
});

test("clearing the editor drops placeholder ownership", () => {
  const path = temporaryImage("png", "cleared");
  const { editor, base, submitted } = harness();

  editor.insertTextAtCursor(path);
  editor.setText("");
  editor.setText("[Image #1]");
  base.submit();

  // The token no longer maps to anything, so it is submitted verbatim.
  assert.equal(submitted[0], "[Image #1]");
  assert.equal(existsSync(path), true);
});

test("Alt+Enter expands paths on every followUp branch", () => {
  // Pi reads getExpandedText() before it picks a delivery path, and only the
  // idle branch reaches onSubmit. All three must carry real paths.
  for (const branch of ["idle", "streaming", "compacting"] as const) {
    const path = temporaryImage("png", branch);
    const { editor } = harness();

    editor.insertTextAtCursor("describe ");
    editor.insertTextAtCursor(path);
    assert.equal(editor.getText(), "describe [Image #1]");

    const delivered = handleFollowUp(editor, branch);
    assert.equal(delivered, `describe ${path}`);
  }
});

test("Alt+Enter on the idle branch does not double expand via onSubmit", () => {
  const path = temporaryImage("png", "idle-once");
  const { editor, submitted } = harness();

  editor.insertTextAtCursor(path);
  handleFollowUp(editor, "idle");

  // setText("") clears the mapping before onSubmit runs, and the text is
  // already expanded, so the downstream callback must see exactly one path.
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0], path);
});

test("getExpandedText does not mutate the draft", () => {
  const path = temporaryImage("png", "pure");
  const { editor, base, submitted } = harness();

  editor.insertTextAtCursor(path);
  assert.equal(editor.getExpandedText(), path);
  assert.equal(editor.getExpandedText(), path);
  // Rendering and status reads must leave the collapsed buffer intact.
  assert.equal(editor.getText(), "[Image #1]");
  base.submit();
  assert.equal(submitted[0], path);
});

test("getExpandedText leaves ambiguous placeholders collapsed", () => {
  const path = temporaryImage("png", "ambiguous");
  const { editor } = harness();

  editor.insertTextAtCursor(path);
  editor.insertTextAtCursor(" [Image #1]");

  assert.equal(editor.getExpandedText(), "[Image #1] [Image #1]");
});

test("the transcript renders submitted clipboard paths as placeholders", () => {
  const path = temporaryImage("png", "transcript");

  assert.equal(
    collapseClipboardPaths(`${path} can you see this image?`),
    "[Image #1] can you see this image?",
  );
});

test("transcript numbering follows the order paths appear", () => {
  const first = temporaryImage("png", "first");
  const second = temporaryImage("jpg", "second");

  assert.equal(
    collapseClipboardPaths(`before ${first} between ${second} after`),
    "before [Image #1] between [Image #2] after",
  );
});

test("adjacent pasted paths collapse into separate placeholders", () => {
  // Pasting images back to back leaves no separator between the paths, so a
  // greedy directory match would absorb the next path and show one image.
  const first = temporaryImage("png", "adjacent-first");
  const second = temporaryImage("jpg", "adjacent-second");
  const third = temporaryImage("png", "adjacent-third");

  assert.equal(
    collapseClipboardPaths(`${first}${second}`),
    "[Image #1][Image #2]",
  );
  assert.equal(
    collapseClipboardPaths(`${first}${second}${third}`),
    "[Image #1][Image #2][Image #3]",
  );
  assert.equal(
    collapseClipboardPaths(`${first}${second}can you see these?`),
    "[Image #1][Image #2]can you see these?",
  );
});

test("adjacent posix paths collapse into separate placeholders", () => {
  // The Windows boundary is a drive letter, the POSIX one is a bare slash;
  // both have to end the previous match rather than extend it.
  const first = `/tmp/pi-clipboard-${randomUUID()}.png`;
  const second = `/tmp/pi-clipboard-${randomUUID()}.png`;

  assert.equal(
    collapseClipboardPaths(`${first}${second}`),
    "[Image #1][Image #2]",
  );
});

test("a path repeated in one message keeps a single transcript number", () => {
  const path = temporaryImage("png", "repeated");

  assert.equal(
    collapseClipboardPaths(`${path} and again ${path}`),
    "[Image #1] and again [Image #1]",
  );
});

test("a submitted draft round-trips back to the placeholders that were typed", () => {
  const path = temporaryImage("png", "round-trip");
  const { editor, base, submitted } = harness();

  editor.insertTextAtCursor(path);
  editor.insertTextAtCursor(" can you see this image?");
  const displayed = editor.getText();
  base.submit();

  // The model receives the real path, the transcript shows what was typed.
  assert.equal(submitted[0], `${path} can you see this image?`);
  assert.equal(collapseClipboardPaths(submitted[0]), displayed);
});

test("two images pasted back to back round-trip through submission", () => {
  const first = temporaryImage("png", "pair-first");
  const second = temporaryImage("jpg", "pair-second");
  const { editor, base, submitted } = harness();

  editor.insertTextAtCursor(first);
  editor.insertTextAtCursor(second);
  const displayed = editor.getText();
  assert.equal(displayed, "[Image #1][Image #2]");
  base.submit();

  assert.equal(submitted[0], `${first}${second}`);
  assert.equal(collapseClipboardPaths(submitted[0]), displayed);
});

test("transcript collapsing leaves ordinary paths and other temp files alone", () => {
  const unrelated = join(tmpdir(), "pi-clipboard-notes.txt");
  const ordinary = join(tmpdir(), "screenshot.png");
  const text = `see ${ordinary} and ${unrelated}`;

  assert.equal(collapseClipboardPaths(text), text);
});

test("transcript collapsing does not need the file to still exist", () => {
  // Rendering runs for reloaded and forked sessions long after the temp file
  // may have been cleaned up by the operating system.
  const missing = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);

  assert.equal(collapseClipboardPaths(`look ${missing}`), "look [Image #1]");
});

test("transcript collapsing only claims files Pi wrote to the temp directory", () => {
  // A project file that merely shares the clipboard basename is not ours, and
  // hiding its real location would misrepresent what the user sent.
  const elsewhere = join(
    "/home/user/assets",
    `pi-clipboard-${randomUUID()}.png`,
  );

  assert.equal(collapseClipboardPaths(elsewhere), elsewhere);
});

test("transcript collapsing preserves markdown link and image targets", () => {
  const path = temporaryImage("png", "target");

  assert.equal(
    collapseClipboardPaths(`![diagram](${path})`),
    `![diagram](${path})`,
  );
});

test("transcript collapsing leaves code spans verbatim", () => {
  const path = temporaryImage("png", "code");
  const fenced = `\`\`\`bash\ncp ${path} ./out.png\n\`\`\``;

  assert.equal(collapseClipboardPaths(fenced), fenced);
  assert.equal(collapseClipboardPaths(`\`${path}\``), `\`${path}\``);
});

test("prose still collapses when the same message contains a code block", () => {
  const shown = temporaryImage("png", "prose");
  const quoted = temporaryImage("png", "quoted");

  assert.equal(
    collapseClipboardPaths(`${shown}\n\`\`\`\n${quoted}\n\`\`\``),
    `[Image #1]\n\`\`\`\n${quoted}\n\`\`\``,
  );
});

test("dequeued messages come back as placeholders and expand again", () => {
  // Pi queues getExpandedText() and restores it through setText(), so without
  // adopting those paths the editor would show issue #413's long temp path.
  const path = temporaryImage("png", "queued");
  const { editor } = harness();

  editor.insertTextAtCursor(path);
  const queued = handleFollowUp(editor, "compacting");
  assert.equal(queued, path);

  editor.setText(queued ?? "");

  assert.equal(editor.getText(), "[Image #1]");
  assert.equal(editor.getExpandedText(), path);
});

test("dequeuing several images renumbers them in order", () => {
  const first = temporaryImage("png", "queued-first");
  const second = temporaryImage("jpg", "queued-second");
  const { editor } = harness();

  editor.setText(`${first}${second} still there?`);

  assert.equal(editor.getText(), "[Image #1][Image #2] still there?");
  assert.equal(editor.getExpandedText(), `${first}${second} still there?`);
});

test("history recall restores compact placeholders and expands again", () => {
  const path = temporaryImage("png", "history");
  const { base, editor } = harness();

  // Pi stores getExpandedText() into history — the real path.
  editor.addToHistory(`${path} do you see it?`);
  assert.deepEqual(base.history, [`${path} do you see it?`]);

  // Up-arrow recall uses setTextInternal which bypasses setText and only
  // fires onChange. Simulate that by writing directly to the base editor.
  base.text = base.history[0];
  base.onChange?.(base.text);

  assert.equal(editor.getText(), "[Image #1] do you see it?");
  assert.equal(editor.getExpandedText(), `${path} do you see it?`);
});
