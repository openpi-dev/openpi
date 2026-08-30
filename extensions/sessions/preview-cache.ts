import type { PreviewFileIdentity } from "./preview-loader.ts";
import type { SessionPreview } from "./sessions.ts";

export const PREVIEW_CACHE_MAX_ENTRIES = 16;
export const PREVIEW_CACHE_MAX_BYTES = 4 * 1024 * 1024;

interface PreviewCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
}

interface CacheEntry {
  preview: SessionPreview;
  bytes: number;
}

export function measureSessionPreviewBytes(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (Array.isArray(value)) {
    return value.reduce(
      (total, nested) => total + measureSessionPreviewBytes(nested),
      0,
    );
  }
  if (typeof value !== "object" || value === null) return 0;
  return Object.entries(value).reduce(
    (total, [key, nested]) =>
      total +
      Buffer.byteLength(key, "utf8") +
      measureSessionPreviewBytes(nested),
    0,
  );
}

export function previewCacheKey(identity: PreviewFileIdentity) {
  return [
    identity.path,
    identity.device,
    identity.inode,
    identity.size,
    identity.mtimeNs,
  ].join(":");
}

export function createSessionPreviewCache(options: PreviewCacheOptions = {}) {
  const maxEntries = Math.max(
    1,
    options.maxEntries ?? PREVIEW_CACHE_MAX_ENTRIES,
  );
  const maxBytes = Math.max(1, options.maxBytes ?? PREVIEW_CACHE_MAX_BYTES);
  const cache = new Map<string, CacheEntry>();
  let totalBytes = 0;
  let evictionCount = 0;

  const remove = (key: string) => {
    const entry = cache.get(key);
    if (!entry) return false;
    cache.delete(key);
    totalBytes -= entry.bytes;
    return true;
  };

  const get = (key: string) => {
    const entry = cache.get(key);
    if (!entry) return undefined;
    cache.delete(key);
    cache.set(key, entry);
    return entry.preview;
  };

  const set = (key: string, preview: SessionPreview, bytes: number) => {
    remove(key);
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > maxBytes) return false;

    cache.set(key, { preview, bytes });
    totalBytes += bytes;
    while (cache.size > maxEntries || totalBytes > maxBytes) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined || !remove(oldest)) break;
      evictionCount++;
    }
    return cache.has(key);
  };

  const clear = () => {
    cache.clear();
    totalBytes = 0;
  };

  return {
    get,
    set,
    clear,
    get entries() {
      return cache.size;
    },
    get bytes() {
      return totalBytes;
    },
    get evictions() {
      return evictionCount;
    },
  };
}
