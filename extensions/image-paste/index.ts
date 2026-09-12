import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { type EditorComponent, matchesKey } from "@earendil-works/pi-tui";
import {
  BelowEditorNavigationEditor,
  BelowEditorStripState,
} from "../shared/below-editor-navigation.ts";
import {
  registerEditorLayer,
  removeEditorLayer,
} from "../shared/editor-layers.ts";

const IMAGE_PLACEHOLDER = /\[Image #(\d+)\]/g;
const PI_CLIPBOARD_IMAGE =
  /^pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(gif|jpe?g|png|webp)$/i;
/**
 * Locate clipboard image paths inside already-submitted text.
 *
 * Pasting two images produces adjacent paths with no separator between them,
 * so the directory portion is matched as discrete segments that exclude both
 * path separators and `:`, and it is lazy rather than greedy. A greedy middle
 * absorbs the next path's `C:` or `/tmp` and renders the pair as one
 * placeholder; laziness ends each match at the first filename that completes
 * it, which is exactly the boundary between two pasted images.
 */
const CLIPBOARD_PATH_IN_TEXT =
  /(?:[A-Za-z]:[\\/]|[\\/])(?:[^\s\\/:"'<>|]+[\\/])*?pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:gif|jpe?g|png|webp)/gi;
const IMAGE_EXTENSIONS = new Set([".gif", ".jpg", ".jpeg", ".png", ".webp"]);
const LEFT_INPUT = "\u001b[D";
const RIGHT_INPUT = "\u001b[C";

interface Attachment {
  readonly id: number;
  readonly placeholder: string;
  readonly path: string;
}

function normalizedPath(path: string) {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Directories a Pi clipboard image can legitimately come from.
 *
 * The local temp directory covers the running host. The generic POSIX and
 * Windows temp shapes are also accepted because a transcript is rendered on
 * whatever machine reopens the session, which is not always the one that
 * pasted the image. An arbitrary project directory is still rejected, so a file
 * that merely shares the basename keeps its real path on screen.
 */
const PORTABLE_TEMP_DIRECTORY =
  /^(?:[\\/](?:tmp|private[\\/](?:tmp|var[\\/]folders[\\/][^\\/]+[\\/][^\\/]+[\\/]T)|var[\\/]folders[\\/][^\\/]+[\\/][^\\/]+[\\/]T)|[A-Za-z]:[\\/](?:Users[\\/][^\\/]+[\\/]AppData[\\/]Local[\\/]Temp|Windows[\\/]Temp|Temp))$/i;

function isTemporaryDirectory(directory: string) {
  if (normalizedPath(directory) === normalizedPath(tmpdir())) return true;
  return PORTABLE_TEMP_DIRECTORY.test(directory.replace(/[\\/]+$/, ""));
}

/**
 * Provenance check shared by attachment tracking and transcript collapsing:
 * the file must carry Pi's clipboard name and sit directly in a temp
 * directory. Deliberately free of disk access so an already-sent message still
 * collapses after the OS has reclaimed the file.
 */
function isPiClipboardPath(path: string) {
  if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) return false;
  if (!isTemporaryDirectory(dirname(path))) return false;
  return PI_CLIPBOARD_IMAGE.test(basename(path));
}

function isPiClipboardImage(path: string) {
  if (!isPiClipboardPath(path)) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Spans that must survive verbatim: fenced blocks and inline code are quoted
 * source, and a rewritten path there stops being copy-pasteable.
 */
const MARKDOWN_VERBATIM = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g;

function verbatimSpans(text: string) {
  return [...text.matchAll(MARKDOWN_VERBATIM)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/**
 * Collapse clipboard image paths back into compact placeholders for display.
 *
 * Submission deliberately expands placeholders into real paths so the model can
 * read the file, which would otherwise push issue #413's long temp paths from
 * the editor into the transcript. This runs at render time only and is
 * deliberately stateless: numbering follows the order the paths appear in the
 * message, so replays, forks and reloaded sessions all render identically
 * without any mapping having to survive the submission.
 *
 * Rewriting is bounded by provenance and by Markdown structure. Only files Pi
 * itself wrote into the temp directory are collapsed, so an unrelated path that
 * merely shares the basename keeps its full text. Fenced blocks, inline code
 * and link/image targets are left untouched, because collapsing a `](...)`
 * target would break the very image it points at.
 *
 * The number can differ from what the editor showed if images were deleted
 * mid-draft. Transcript numbering only distinguishes images within one message,
 * so that is accepted rather than carried through message metadata.
 */
export function collapseClipboardPaths(text: string) {
  const skip = verbatimSpans(text);
  let next = 1;
  const assigned = new Map<string, string>();
  return text.replace(CLIPBOARD_PATH_IN_TEXT, (match, offset: number) => {
    if (!isPiClipboardPath(match)) return match;
    if (skip.some((span) => offset >= span.start && offset < span.end)) {
      return match;
    }
    // `](path)` is a link or image target; replacing it silently breaks the
    // reference, so the path stays literal even though it is a clipboard file.
    if (text.startsWith("](", Math.max(0, offset - 2)) && offset >= 2) {
      return match;
    }
    // A path repeated in one message keeps a single number: the transcript
    // shows the same image, so a second number would imply a second image.
    const existing = assigned.get(match);
    if (existing) return existing;
    const placeholder = `[Image #${next++}]`;
    assigned.set(match, placeholder);
    return placeholder;
  });
}

function placeholderOccurrences(text: string) {
  return [...text.matchAll(IMAGE_PLACEHOLDER)].map((match) => ({
    id: Number(match[1]),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/**
 * Replace each placeholder that appears exactly once with its clipboard path.
 * Ambiguous tokens stay collapsed so user-edited text is never over-expanded.
 */
function expandWith(text: string, attachments: Iterable<Attachment>) {
  const entries = [...attachments];
  if (entries.length === 0) return text;
  const occurrenceCounts = new Map<number, number>();
  for (const occurrence of placeholderOccurrences(text)) {
    occurrenceCounts.set(
      occurrence.id,
      (occurrenceCounts.get(occurrence.id) ?? 0) + 1,
    );
  }
  let expanded = text;
  for (const attachment of entries) {
    if (occurrenceCounts.get(attachment.id) !== 1) continue;
    expanded = expanded.replaceAll(attachment.placeholder, attachment.path);
  }
  return expanded;
}

/**
 * Display-only registry mapping compact placeholders to the clipboard paths Pi
 * inserted. This mirrors the editor's native long-paste markers: the buffer
 * shows `[Image #1]`, submission expands it back to the real path, and the
 * message Pi sends is byte-identical to unmodified Pi.
 *
 * Nothing here owns the temporary file. Pi leaves clipboard images in tmpdir so
 * the read tool can still open them later, and that contract is preserved.
 */
export class ImageAttachmentStore {
  private nextAttachmentId = 1;
  private readonly draft = new Map<number, Attachment>();

  get hasDraft() {
    return this.draft.size > 0;
  }

  attachClipboardPath(path: string, editorText: string) {
    if (!isPiClipboardImage(path)) return undefined;

    let id = this.nextAttachmentId;
    while (this.draft.has(id) || editorText.includes(`[Image #${id}]`)) id += 1;
    const placeholder = `[Image #${id}]`;
    this.nextAttachmentId = id + 1;
    this.draft.set(id, { id, placeholder, path } satisfies Attachment);
    return placeholder;
  }

  reconcileDraft(text: string) {
    const occurrenceCounts = new Map<number, number>();
    for (const occurrence of placeholderOccurrences(text)) {
      occurrenceCounts.set(
        occurrence.id,
        (occurrenceCounts.get(occurrence.id) ?? 0) + 1,
      );
    }
    for (const id of [...this.draft.keys()]) {
      // Placeholder text is user-editable, so only an unambiguous single
      // occurrence keeps its mapping. Duplicated or removed tokens degrade to
      // ordinary text; the underlying file is left alone either way.
      if (occurrenceCounts.get(id) === 1) continue;
      this.draft.delete(id);
    }
    this.nextAttachmentId =
      this.draft.size === 0 ? 1 : Math.max(...this.draft.keys()) + 1;
  }

  /**
   * Expand every unambiguously tracked placeholder back to its clipboard path,
   * matching the editor's own `expandPasteMarkers` behaviour at submission time.
   *
   * This is a pure query: Pi calls getExpandedText() for rendering and status
   * as well as for submission, so expansion must never mutate the draft.
   * Expanding an already expanded string is a no-op, which keeps the
   * getExpandedText() and onSubmit paths safe to combine.
   */
  expandPlaceholders(text: string) {
    return expandWith(text, this.draft.values());
  }

  /**
   * Copy the current mapping so a submission can still expand after the editor
   * has cleared the buffer and released the draft.
   */
  snapshotDraft() {
    return this.draft.size === 0 ? undefined : [...this.draft.values()];
  }

  clearDraft() {
    this.draft.clear();
    this.nextAttachmentId = 1;
  }

  /**
   * Rebuild the mapping from text that already contains real clipboard paths
   * and return its collapsed form.
   *
   * Pi hands expanded text back to the editor on paths this extension does not
   * own: handleDequeue() restores queued messages through setText(), and
   * history recall replays what addToHistory() stored. Without adopting those
   * paths the buffer would show issue #413's long temp path again and the
   * tokens would no longer expand on the next submit.
   */
  adoptExpandedText(text: string) {
    const paths = [...text.matchAll(CLIPBOARD_PATH_IN_TEXT)]
      .map((match) => match[0])
      .filter((path) => isPiClipboardPath(path));
    if (paths.length === 0) return undefined;

    this.clearDraft();
    let collapsed = text;
    for (const path of paths) {
      if ([...this.draft.values()].some((entry) => entry.path === path)) {
        continue;
      }
      const id = this.nextAttachmentId++;
      const placeholder = `[Image #${id}]`;
      this.draft.set(id, { id, placeholder, path } satisfies Attachment);
      collapsed = collapsed.replaceAll(path, placeholder);
    }
    return collapsed;
  }

  attachmentHit(
    text: string,
    cursor: number,
    direction: "backward" | "forward",
  ) {
    for (const occurrence of placeholderOccurrences(text)) {
      if (!this.draft.has(occurrence.id)) continue;
      if (
        direction === "backward"
          ? cursor > occurrence.start && cursor <= occurrence.end
          : cursor >= occurrence.start && cursor < occurrence.end
      ) {
        return occurrence;
      }
    }
    return undefined;
  }

  cleanup() {
    this.clearDraft();
  }
}

interface CursorEditor extends EditorComponent {
  getCursor(): { line: number; col: number } | undefined;
}

function cursorOffset(editor: EditorComponent) {
  const cursor = (
    editor as EditorComponent & Partial<CursorEditor>
  ).getCursor?.();
  if (!cursor) return undefined;
  const lines = editor.getText().split("\n");
  let offset = 0;
  for (let line = 0; line < cursor.line; line += 1) {
    offset += (lines[line]?.length ?? 0) + 1;
  }
  return offset + cursor.col;
}

export class ImageAttachmentEditor extends BelowEditorNavigationEditor {
  private readonly editor: EditorComponent;
  private readonly editorKeybindings: KeybindingsManager;
  private readonly attachments: ImageAttachmentStore;
  private downstreamChange?: (text: string) => void;
  private downstreamSubmit?: (text: string) => void;
  private submittedDraft?: readonly Attachment[];
  private settingText = false;

  constructor(
    base: EditorComponent,
    keybindings: KeybindingsManager,
    attachments: ImageAttachmentStore,
  ) {
    super(
      base,
      keybindings,
      new BelowEditorStripState(),
      () => false,
      () => undefined,
      () => undefined,
    );
    this.editor = base;
    this.editorKeybindings = keybindings;
    this.attachments = attachments;
    this.onChange = super.onChange;
    this.onSubmit = super.onSubmit;
  }

  override get onChange() {
    return this.downstreamChange;
  }

  override set onChange(value: ((text: string) => void) | undefined) {
    this.downstreamChange = value;
    super.onChange = (text) => {
      if (!this.settingText) {
        // submitValue() clears the buffer and reports it here before invoking
        // onSubmit, so an empty buffer ends the draft and restarts numbering.
        // Keep a snapshot so the submit that caused it can still expand.
        if (text.length === 0) {
          this.submittedDraft = this.attachments.snapshotDraft();
          this.attachments.clearDraft();
        } else {
          this.submittedDraft = undefined;
          // History recall uses setTextInternal (bypasses setText) and only
          // fires onChange. When there is no draft but the text contains
          // clipboard paths, adopt them so the buffer shows compact tokens.
          const adopted =
            !this.attachments.hasDraft &&
            this.attachments.adoptExpandedText(text);
          if (adopted) {
            this.settingText = true;
            try {
              super.setText(adopted);
            } finally {
              this.settingText = false;
            }
          } else {
            this.attachments.reconcileDraft(text);
          }
        }
      }
      this.downstreamChange?.(text);
    };
  }

  override get onSubmit() {
    return this.downstreamSubmit;
  }

  override set onSubmit(value: ((text: string) => void) | undefined) {
    this.downstreamSubmit = value;
    super.onSubmit = value
      ? (text) => {
          // Plain Enter reaches here after submitValue() already cleared the
          // buffer, so expand against the snapshot taken at that moment. Paths
          // that read getExpandedText() first pass real paths in, and expanding
          // an already expanded string is a no-op.
          const snapshot = this.submittedDraft;
          this.submittedDraft = undefined;
          value(
            snapshot
              ? expandWith(text, snapshot)
              : this.attachments.expandPlaceholders(text),
          );
        }
      : undefined;
  }

  /**
   * Pi reads the submitted text through this seam before it picks a delivery
   * path -- handleFollowUp() calls it ahead of prompt(), queueCompactionMessage()
   * and onSubmit alike. Expanding here is what keeps every Alt+Enter branch
   * from shipping a bare `[Image #1]`.
   */
  override getExpandedText() {
    const base = super.getExpandedText?.() ?? this.getText();
    return this.attachments.expandPlaceholders(base);
  }

  override setText(text: string) {
    // Pi restores queued messages and history entries as expanded paths. Adopt
    // them so the buffer shows compact tokens and the next submit can expand
    // again; ordinary text falls through to plain reconciliation.
    const adopted =
      text.length > 0 ? this.attachments.adoptExpandedText(text) : undefined;
    const next = adopted ?? text;
    this.settingText = true;
    try {
      super.setText(next);
    } finally {
      this.settingText = false;
    }
    if (adopted !== undefined) return;
    if (next.length > 0) {
      this.attachments.reconcileDraft(next);
    } else {
      this.attachments.clearDraft();
    }
  }

  override insertTextAtCursor(text: string) {
    const placeholder = this.attachments.attachClipboardPath(
      text,
      this.getText(),
    );
    super.insertTextAtCursor(placeholder ?? text);
  }

  private deleteAttachment(data: string, direction: "backward" | "forward") {
    const text = this.getText();
    const cursor = cursorOffset(this.editor);
    if (cursor === undefined) return false;
    const hit = this.attachments.attachmentHit(text, cursor, direction);
    if (!hit) return false;

    // Keep Pi's editor state intact: setText() would clear its native long-paste
    // registry. Move to one edge, then replay the already-matched deletion
    // action so one user keypress removes the whole image token without
    // disturbing ordinary paste markers or autocomplete state.
    const navigationInput = direction === "backward" ? RIGHT_INPUT : LEFT_INPUT;
    const navigationSteps =
      direction === "backward" ? hit.end - cursor : cursor - hit.start;
    for (let step = 0; step < navigationSteps; step += 1) {
      this.editor.handleInput(navigationInput);
    }
    for (let step = hit.start; step < hit.end; step += 1) {
      this.editor.handleInput(data);
    }
    return true;
  }

  override handleInput(data: string) {
    if (
      (this.editorKeybindings.matches(data, "tui.editor.deleteCharBackward") ||
        matchesKey(data, "shift+backspace")) &&
      this.deleteAttachment(data, "backward")
    ) {
      return;
    }
    if (
      (this.editorKeybindings.matches(data, "tui.editor.deleteCharForward") ||
        matchesKey(data, "shift+delete")) &&
      this.deleteAttachment(data, "forward")
    ) {
      return;
    }
    super.handleInput(data);
  }
}

function installImagePasteEditor(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  attachments: ImageAttachmentStore,
) {
  if (ctx.mode !== "tui") return;
  registerEditorLayer(pi, ctx, {
    id: "image-paste",
    order: 1_000,
    wrap: (base, _tui, _theme, keybindings) =>
      new ImageAttachmentEditor(base, keybindings, attachments),
  });
}

export default function imagePaste(
  pi: ExtensionAPI,
  attachments = new ImageAttachmentStore(),
) {
  // Rendering-only counterpart to submission expansion: the model still
  // receives real paths, while the transcript keeps the compact placeholders
  // that issue #413 asked for. Restricted to user messages so paths the
  // assistant legitimately quotes are left untouched.
  pi.registerMarkdownTransformer((markdown, context) =>
    context.messageType === "user"
      ? collapseClipboardPaths(markdown)
      : markdown,
  );

  pi.on("session_start", (_event, ctx) => {
    installImagePasteEditor(pi, ctx, attachments);
  });

  pi.on("session_shutdown", () => {
    removeEditorLayer(pi, "image-paste");
    attachments.cleanup();
  });
}
