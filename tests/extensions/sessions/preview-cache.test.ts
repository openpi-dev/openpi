import assert from "node:assert/strict";
import test from "node:test";
import type { SessionPreview } from "../../../extensions/sessions/sessions.ts";
import {
  createSessionPreviewCache,
  measureSessionPreviewBytes,
  previewCacheKey,
} from "../../../extensions/sessions/preview-cache.ts";

const preview = (title: string): SessionPreview => ({
  title,
  subtitle: "test",
  blocks: [{ kind: "notice", text: title }],
});

test("preview cache enforces LRU entry and aggregate byte bounds", () => {
  const cache = createSessionPreviewCache({ maxEntries: 2, maxBytes: 10 });

  assert.equal(cache.set("a", preview("a"), 4), true);
  assert.equal(cache.set("b", preview("b"), 4), true);
  assert.equal(cache.get("a")?.title, "a");
  assert.equal(cache.set("c", preview("c"), 4), true);

  assert.equal(
    cache.get("b"),
    undefined,
    "get(a) must refresh a before eviction",
  );
  assert.equal(cache.entries, 2);
  assert.equal(cache.bytes, 8);
  assert.equal(cache.evictions, 1);

  assert.equal(cache.set("d", preview("d"), 7), true);
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.get("c"), undefined);
  assert.equal(cache.get("d")?.title, "d");
  assert.equal(cache.entries, 1);
  assert.equal(cache.bytes, 7);
  assert.equal(cache.evictions, 3);
});

test("preview cache refuses an oversized item and releases all references on clear", () => {
  const cache = createSessionPreviewCache({ maxEntries: 2, maxBytes: 10 });

  assert.equal(cache.set("oversized", preview("large"), 11), false);
  assert.equal(cache.entries, 0);
  assert.equal(cache.bytes, 0);

  cache.set("a", preview("a"), 4);
  cache.clear();
  assert.equal(cache.get("a"), undefined);
  assert.equal(cache.entries, 0);
  assert.equal(cache.bytes, 0);
});

test("preview cache identity includes path and exact file stat fields", () => {
  assert.notEqual(
    previewCacheKey({
      path: "/tmp/a.jsonl",
      device: "1",
      inode: "2",
      size: 3,
      mtimeNs: "4",
    }),
    previewCacheKey({
      path: "/tmp/a.jsonl",
      device: "1",
      inode: "2",
      size: 3,
      mtimeNs: "5",
    }),
  );
});

test("preview cache measures retained UTF-8 strings without serializing the object", () => {
  const value = preview("界");
  assert.equal(
    measureSessionPreviewBytes(value),
    Buffer.byteLength("界", "utf8") * 2 +
      Buffer.byteLength("titlesubtitleblockskindtexttestnotice", "utf8"),
  );
});
