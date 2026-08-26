import assert from "node:assert/strict";
import { test } from "node:test";
import { projectText } from "../../../extensions/shared/text-projection.ts";

test("zero-byte projections are empty", () => {
  assert.equal(
    projectText("🙂".repeat(100), {
      maxBytes: 0,
      maxLines: 20,
      recovery: "kept in artifacts",
    }),
    "",
  );
});

test("tiny projections never exceed their UTF-8 byte budget", () => {
  for (const maxBytes of [1, 2, 3, 4, 5, 16]) {
    const projected = projectText("🙂".repeat(100), {
      maxBytes,
      maxLines: 20,
      recovery: "kept in artifacts",
    });
    assert.ok(Buffer.byteLength(projected, "utf8") <= maxBytes);
    assert.doesNotMatch(projected, /�/);
  }
});
