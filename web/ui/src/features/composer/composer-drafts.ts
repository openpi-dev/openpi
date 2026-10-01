import type { StagedPromptImage } from "./image-attachments.ts";

export interface ComposerDraft {
  prompt: string;
  images: readonly StagedPromptImage[];
  caret: number;
  revision: number;
}

const MAX_DRAFTS = 32;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export function createComposerDraftMemory() {
  const drafts = new Map<string, ComposerDraft>();
  let revision = 0;
  const empty = () =>
    ({ prompt: "", images: [], caret: 0, revision }) satisfies ComposerDraft;
  const hasContent = (draft: ComposerDraft) =>
    draft.prompt.length > 0 || draft.images.length > 0;

  return {
    read(key: string) {
      return drafts.get(key) ?? empty();
    },
    edit(
      key: string,
      current: ComposerDraft,
      patch: Partial<Pick<ComposerDraft, "prompt" | "images" | "caret">>,
    ) {
      const next = { ...current, ...patch };
      next.caret = Math.min(Math.max(next.caret, 0), next.prompt.length);
      if (next.prompt !== current.prompt || next.images !== current.images) {
        let count = 0;
        let textBytes = 0;
        let imageBytes = 0;
        for (const [owner, draft] of drafts) {
          if (owner === key) continue;
          count += 1;
          // Count UTF-16 storage conservatively without encoding every edit.
          textBytes += draft.prompt.length * 2;
          imageBytes += draft.images.reduce(
            (sum, image) => sum + image.size,
            0,
          );
        }
        if (hasContent(next)) count += 1;
        textBytes += next.prompt.length * 2;
        imageBytes += next.images.reduce((sum, image) => sum + image.size, 0);
        if (
          count > MAX_DRAFTS ||
          textBytes > MAX_TEXT_BYTES ||
          imageBytes > MAX_IMAGE_BYTES
        )
          return null;
        next.revision = ++revision;
      }
      if (hasContent(next)) drafts.set(key, next);
      else drafts.delete(key);
      return next;
    },
    clear(key: string, capturedRevision: number) {
      if (drafts.get(key)?.revision !== capturedRevision) return null;
      drafts.delete(key);
      revision += 1;
      return empty();
    },
    move(from: string, to: string) {
      if (drafts.has(to)) return false;
      const draft = drafts.get(from);
      if (draft) {
        drafts.delete(from);
        drafts.set(to, draft);
      }
      return true;
    },
  };
}
