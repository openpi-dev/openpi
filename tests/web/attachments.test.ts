import assert from "node:assert/strict";
import test from "node:test";
import { validateWebAttachments } from "../../web/protocol/attachments.ts";

test("attachment validation accepts bounded supported files", () => {
  assert.deepEqual(
    validateWebAttachments([
      { name: "notes.md", mime: "text/markdown", size: 100 },
      { name: "shot.PNG", mime: "image/png", size: 200 },
      { name: "说明.txt", mime: "text/plain", size: 12 },
    ]),
    { ok: true },
  );
});

test("attachment validation rejects traversal, unsupported types, and oversized totals", () => {
  assert.equal(
    validateWebAttachments([{ name: "../secret", mime: "text/plain", size: 1 }])
      .ok,
    false,
  );
  assert.equal(
    validateWebAttachments([
      { name: "x.bin", mime: "application/octet-stream", size: 1 },
    ]).ok,
    false,
  );
  assert.equal(
    validateWebAttachments([
      { name: "a.txt", mime: "text/plain", size: 2 * 1024 * 1024 },
      { name: "b.txt", mime: "text/plain", size: 2 * 1024 * 1024 },
      { name: "c.txt", mime: "text/plain", size: 2 * 1024 * 1024 },
      { name: "d.txt", mime: "text/plain", size: 2 * 1024 * 1024 + 1 },
    ]).ok,
    false,
  );
});

test("attachment validation rejects inherited MIME keys without throwing", () => {
  for (const mime of ["constructor", "__proto__", "toString"]) {
    assert.deepEqual(
      validateWebAttachments([{ name: "x.txt", mime, size: 1 }]),
      { ok: false, error: "unsupported attachment type" },
    );
  }
});

test("attachment validation rejects MIME and extension mismatch", () => {
  assert.deepEqual(
    validateWebAttachments([
      { name: "notes.txt", mime: "text/markdown", size: 1 },
    ]),
    { ok: false, error: "attachment extension does not match type" },
  );
});
