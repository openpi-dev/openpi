import {
  WEB_PROMPT_IMAGE_MAX_BYTES,
  WEB_PROMPT_IMAGE_MAX_COUNT,
  WEB_PROMPT_IMAGE_MAX_TOTAL_BYTES,
} from "../../../../protocol/types.ts";
import type { ComposerDraft, ComposerDraftStorage } from "./composer-drafts.ts";
import type { StagedPromptFile } from "./file-attachments.ts";
import {
  WEB_PROMPT_FILE_MAX_BYTES,
  WEB_PROMPT_FILE_MAX_TOTAL_BYTES,
  WEB_PROMPT_FILE_MAX_COUNT,
  WEB_PROMPT_FILE_MAX_TEXT_BYTES,
} from "../../../../protocol/prompt-files.ts";
import {
  sniffPromptImageMime,
  type StagedPromptImage,
} from "./image-attachments.ts";

export const COMPOSER_DRAFT_LIMITS = {
  count: 32,
  textBytes: 1024 * 1024,
  imageBytes: 128 * 1024 * 1024,
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validOwner(key: string) {
  if (key.length > 8192) return false;
  try {
    const owner: unknown = JSON.parse(key);
    return (
      Array.isArray(owner) &&
      ((owner.length === 3 &&
        owner[0] === "session" &&
        typeof owner[1] === "string" &&
        owner[1].length > 0 &&
        owner[1].length <= 1024 &&
        typeof owner[2] === "string" &&
        owner[2].length > 0 &&
        owner[2].length <= 4096) ||
        (owner.length === 2 &&
          owner[0] === "workspace" &&
          (owner[1] === null ||
            (typeof owner[1] === "string" && owner[1].length <= 4096))))
    );
  } catch {
    return false;
  }
}

export function parseStoredComposerDraft(key: string, value: unknown) {
  if (
    !validOwner(key) ||
    !object(value) ||
    typeof value.prompt !== "string" ||
    value.prompt.length * 2 > COMPOSER_DRAFT_LIMITS.textBytes ||
    !Array.isArray(value.images)
  )
    return null;
  const images: StagedPromptImage[] = [];
  const files: StagedPromptFile[] = [];
  let invalid = false;
  const caret =
    typeof value.caret === "number" &&
    Number.isSafeInteger(value.caret) &&
    value.caret >= 0 &&
    value.caret <= value.prompt.length
      ? value.caret
      : value.prompt.length;
  if (caret !== value.caret) invalid = true;
  let bytes = 0;
  for (const candidate of value.images) {
    if (
      !object(candidate) ||
      typeof candidate.name !== "string" ||
      candidate.name.length > 1024 ||
      typeof candidate.data !== "string" ||
      typeof candidate.size !== "number" ||
      !Number.isSafeInteger(candidate.size) ||
      candidate.size <= 0 ||
      candidate.size > WEB_PROMPT_IMAGE_MAX_BYTES ||
      candidate.data.length !== Math.ceil(candidate.size / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(candidate.data)
    ) {
      invalid = true;
      continue;
    }
    try {
      const binary = atob(candidate.data);
      if (binary.length !== candidate.size) {
        invalid = true;
        continue;
      }
      const header = Uint8Array.from(binary.slice(0, 12), (c) =>
        c.charCodeAt(0),
      );
      const mimeType = sniffPromptImageMime(header);
      if (
        !mimeType ||
        mimeType !== candidate.mimeType ||
        images.length >= WEB_PROMPT_IMAGE_MAX_COUNT ||
        bytes + candidate.size > WEB_PROMPT_IMAGE_MAX_TOTAL_BYTES
      ) {
        invalid = true;
        continue;
      }
      bytes += candidate.size;
      images.push({
        id:
          typeof candidate.id === "string" && candidate.id.length <= 1024
            ? candidate.id
            : (globalThis.crypto?.randomUUID?.() ??
              `${Date.now()}-${images.length}-${candidate.name}`),
        name: candidate.name,
        size: candidate.size,
        data: candidate.data,
        mimeType,
        // Never trust a stored blob URL: it belongs to a previous document.
        previewUrl: `data:${mimeType};base64,${candidate.data}`,
      });
    } catch {
      invalid = true;
    }
  }
  let fileBytes = 0;
  for (const candidate of Array.isArray(value.files) ? value.files : []) {
    if (
      !object(candidate) ||
      typeof candidate.name !== "string" ||
      !candidate.name ||
      candidate.name.length > 1024 ||
      /[\u0000-\u001f\u007f]/u.test(candidate.name) ||
      typeof candidate.mimeType !== "string" ||
      candidate.mimeType.length > 256 ||
      typeof candidate.data !== "string" ||
      typeof candidate.size !== "number" ||
      !Number.isSafeInteger(candidate.size) ||
      candidate.size < 0 ||
      candidate.size > WEB_PROMPT_FILE_MAX_BYTES ||
      candidate.data.length !== Math.ceil(candidate.size / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/u.test(candidate.data) ||
      files.length + images.length >= WEB_PROMPT_FILE_MAX_COUNT ||
      fileBytes + candidate.size > WEB_PROMPT_FILE_MAX_TOTAL_BYTES ||
      (candidate.text !== undefined &&
        (typeof candidate.text !== "string" ||
          new TextEncoder().encode(candidate.text).length >
            WEB_PROMPT_FILE_MAX_TEXT_BYTES))
    ) {
      invalid = true;
      continue;
    }
    try {
      if (atob(candidate.data).length !== candidate.size) {
        invalid = true;
        continue;
      }
      fileBytes += candidate.size;
      files.push({
        id:
          typeof candidate.id === "string" && candidate.id.length <= 1024
            ? candidate.id
            : (globalThis.crypto?.randomUUID?.() ??
              `${Date.now()}-${files.length}`),
        name: candidate.name,
        mimeType: candidate.mimeType,
        size: candidate.size,
        data: candidate.data,
        ...(typeof candidate.text === "string" ? { text: candidate.text } : {}),
        extraction:
          candidate.extraction === "text" ||
          candidate.extraction === "truncated"
            ? candidate.extraction
            : "unavailable",
        ...(candidate.extraction === "unavailable" &&
        (candidate.extractionError === "encoding" ||
          candidate.extractionError === "document")
          ? { extractionError: candidate.extractionError }
          : {}),
      });
    } catch {
      invalid = true;
    }
  }
  if (value.files !== undefined && !Array.isArray(value.files)) invalid = true;
  return {
    draft: {
      prompt: value.prompt,
      caret,
      images,
      ...(files.length ? { files } : {}),
      revision: 0,
    },
    invalid,
  };
}

const DATABASE = "openpi.composer-drafts";
const STORE = "drafts";

export function createBrowserComposerDraftStorage(): ComposerDraftStorage {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        // IndexedDB is scoped by origin, including host and port. Session keys
        // include Pi's file identity, and survive a host-token rotation.
        request = window.indexedDB.open(DATABASE, 1);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, {
          keyPath: "key",
        });
        store.createIndex("usage", ["textBytes", "imageBytes"]);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        request.onsuccess = () => request.result.close();
        reject(new Error("draft-storage-blocked"));
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
    });
  return {
    async read() {
      const database = await open();
      try {
        return await new Promise<unknown[]>((resolve, reject) => {
          const transaction = database.transaction(STORE, "readonly");
          const request = transaction
            .objectStore(STORE)
            .getAll(undefined, COMPOSER_DRAFT_LIMITS.count + 1);
          let result: unknown[] = [];
          request.onsuccess = () => {
            result = request.result;
          };
          transaction.oncomplete = () => resolve(result);
          request.onerror = () => reject(request.error);
          transaction.onabort = () => reject(transaction.error);
        });
      } finally {
        database.close();
      }
    },
    async write(changes) {
      const database = await open();
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(STORE, "readwrite");
          const store = transaction.objectStore(STORE);
          const owners = new Set(changes.map(({ key }) => key));
          let count = 0;
          let textBytes = 0;
          let imageBytes = 0;
          // Read indexed byte counts, not every image payload, on each edit.
          const request = store.index("usage").openKeyCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) {
              if (!owners.has(String(cursor.primaryKey))) {
                const usage = cursor.key as [number, number];
                count += 1;
                textBytes += usage[0];
                imageBytes += usage[1];
              }
              cursor.continue();
              return;
            }
            for (const { draft } of changes) {
              if (!draft) continue;
              count += 1;
              textBytes += draft.prompt.length * 2;
              imageBytes +=
                draft.images.reduce((sum, image) => sum + image.size, 0) +
                (draft.files ?? []).reduce(
                  (sum, file) => sum + file.size + (file.text?.length ?? 0) * 2,
                  0,
                );
            }
            if (
              count > COMPOSER_DRAFT_LIMITS.count ||
              textBytes > COMPOSER_DRAFT_LIMITS.textBytes ||
              imageBytes > COMPOSER_DRAFT_LIMITS.imageBytes
            ) {
              transaction.abort();
              return;
            }
            for (const { key, draft } of changes) {
              if (!draft) store.delete(key);
              else
                store.put({
                  key,
                  draft: {
                    prompt: draft.prompt,
                    caret: draft.caret,
                    images: draft.images.map(
                      ({ previewUrl: _previewUrl, ...image }) => image,
                    ),
                    ...(draft.files?.length ? { files: draft.files } : {}),
                  },
                  textBytes: draft.prompt.length * 2,
                  imageBytes:
                    draft.images.reduce((sum, image) => sum + image.size, 0) +
                    (draft.files ?? []).reduce(
                      (sum, file) =>
                        sum + file.size + (file.text?.length ?? 0) * 2,
                      0,
                    ),
                });
            }
          };
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () =>
            reject(transaction.error ?? new Error("draft-storage-limit"));
        });
      } finally {
        database.close();
      }
    },
  };
}
