import type { StagedPromptImage } from "./image-attachments.ts";
import type { StagedPromptFile } from "./file-attachments.ts";
import {
  COMPOSER_DRAFT_LIMITS,
  parseStoredComposerDraft,
} from "./composer-draft-storage.ts";

export interface ComposerDraft {
  prompt: string;
  images: readonly StagedPromptImage[];
  files?: readonly StagedPromptFile[];
  caret: number;
  revision: number;
}

export interface ComposerDraftStorage {
  read: () => Promise<readonly unknown[]>;
  write: (
    changes: readonly { key: string; draft: ComposerDraft | null }[],
  ) => Promise<void>;
}

export interface ComposerDraftStorageState {
  status: "loading" | "saved" | "pending" | "failed";
  invalid: boolean;
}

export function createComposerDraftMemory(storage?: ComposerDraftStorage) {
  const drafts = new Map<string, ComposerDraft>();
  const changed = new Set<string>();
  const pending = new Map<string, ComposerDraft | null>();
  const listeners = new Set<() => void>();
  let state: ComposerDraftStorageState = {
    status: storage ? "loading" : "saved",
    invalid: false,
  };
  let writing = false;
  let loading = Boolean(storage);
  let revision = 0;
  const empty = () =>
    ({
      prompt: "",
      images: [],
      caret: 0,
      revision,
      files: undefined,
    }) satisfies ComposerDraft;
  const hasContent = (draft: ComposerDraft) =>
    draft.prompt.length > 0 ||
    draft.images.length > 0 ||
    Boolean(draft.files?.length);
  const attachmentBytes = (draft: ComposerDraft) =>
    draft.images.reduce((sum, image) => sum + image.size, 0) +
    (draft.files ?? []).reduce(
      (sum, file) => sum + file.size + (file.text?.length ?? 0) * 2,
      0,
    );

  const notify = (patch: Partial<ComposerDraftStorageState> = {}) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const fits = (key: string, next: ComposerDraft) => {
    let count = 0;
    let textBytes = 0;
    let imageBytes = 0;
    for (const [owner, draft] of drafts) {
      if (owner === key) continue;
      count += 1;
      textBytes += draft.prompt.length * 2;
      imageBytes += attachmentBytes(draft);
    }
    if (hasContent(next)) count += 1;
    textBytes += next.prompt.length * 2;
    imageBytes += attachmentBytes(next);
    return (
      count <= COMPOSER_DRAFT_LIMITS.count &&
      textBytes <= COMPOSER_DRAFT_LIMITS.textBytes &&
      imageBytes <= COMPOSER_DRAFT_LIMITS.imageBytes
    );
  };
  const flush = async () => {
    if (!storage || loading || writing || pending.size === 0) return;
    writing = true;
    notify({ status: "pending" });
    const changes = Array.from(pending, ([key, draft]) => ({ key, draft }));
    pending.clear();
    try {
      await storage.write(changes);
      writing = false;
      notify({ status: pending.size > 0 ? "pending" : "saved" });
      if (pending.size > 0) void flush();
    } catch {
      // Keep failed deletions too: otherwise a reload can resurrect a sent draft.
      for (const { key, draft } of changes)
        if (!pending.has(key)) pending.set(key, draft);
      writing = false;
      notify({ status: "failed" });
    }
  };
  const persist = (key: string, draft: ComposerDraft | null) => {
    if (loading) changed.add(key);
    if (!storage) return;
    pending.set(key, draft);
    if (!loading) notify({ status: "pending" });
    // Coalesce a creation handoff's delete + put in the same transaction.
    void Promise.resolve().then(flush);
  };
  const load = () =>
    storage
      ? storage
          .read()
          .then((records) => {
            let invalid = false;
            for (const record of records) {
              if (
                typeof record !== "object" ||
                record === null ||
                !("key" in record) ||
                typeof record.key !== "string" ||
                !("draft" in record)
              ) {
                invalid = true;
                continue;
              }
              if (changed.has(record.key)) continue;
              const parsed = parseStoredComposerDraft(record.key, record.draft);
              if (
                !parsed ||
                !hasContent(parsed.draft) ||
                !fits(record.key, parsed.draft)
              ) {
                invalid = true;
                continue;
              }
              invalid ||= parsed.invalid;
              drafts.set(record.key, { ...parsed.draft, revision: ++revision });
            }
            changed.clear();
            loading = false;
            notify({ status: pending.size > 0 ? "pending" : "saved", invalid });
            void flush();
          })
          .catch(() => {
            notify({ status: "failed" });
          })
      : Promise.resolve();
  const ready = load();

  return {
    ready,
    storageState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hasContent: () => drafts.size > 0,
    hasUnsavedChanges: () => pending.size > 0 || writing,
    retryStorage() {
      if (loading) {
        notify({ status: "loading" });
        return load();
      }
      return flush();
    },
    read(key: string) {
      return drafts.get(key) ?? empty();
    },
    edit(
      key: string,
      current: ComposerDraft,
      patch: Partial<
        Pick<ComposerDraft, "prompt" | "images" | "files" | "caret">
      >,
    ) {
      const next = { ...current, ...patch };
      next.caret = Math.min(Math.max(next.caret, 0), next.prompt.length);
      if (
        next.prompt !== current.prompt ||
        next.images !== current.images ||
        next.files !== current.files
      ) {
        if (!fits(key, next)) return null;
        next.revision = ++revision;
      }
      if (hasContent(next)) drafts.set(key, next);
      else drafts.delete(key);
      if (
        next.prompt !== current.prompt ||
        next.images !== current.images ||
        next.files !== current.files ||
        next.caret !== current.caret
      )
        persist(key, hasContent(next) ? next : null);
      return next;
    },
    clear(key: string, capturedRevision: number) {
      if (drafts.get(key)?.revision !== capturedRevision) return null;
      drafts.delete(key);
      revision += 1;
      persist(key, null);
      return empty();
    },
    move(from: string, to: string) {
      if (drafts.has(to)) return false;
      const draft = drafts.get(from);
      if (draft) {
        drafts.delete(from);
        drafts.set(to, draft);
        persist(from, null);
        persist(to, draft);
      }
      return true;
    },
  };
}
