import assert from "node:assert/strict";
import test from "node:test";
import { toolPreview } from "../../../extensions/subagents/src/backends/tool-preview.ts";

test("tool preview retains the first meaningful line across blank lines and text parts", () => {
  assert.equal(toolPreview("\n\r\n \t\n  ready \r\nignored"), "ready");
  assert.equal(toolPreview("\uFEFF\u00A0ready\u00A0"), "ready");
  assert.equal(toolPreview(" \n\t\r\n"), undefined);
  assert.equal(toolPreview(null), undefined);
  assert.equal(
    toolPreview({
      content: [
        null,
        { type: "image", data: "x" },
        { type: "text", text: "\n  " },
        { type: "text", text: "\n done\nrest" },
      ],
    }),
    "done",
  );
  assert.equal(
    toolPreview("\n".repeat(128 * 1024) + "late line\nignored"),
    "late line",
  );
});

test("tool preview bounds a long first line to the existing consumer's 64KiB character limit", () => {
  const text = "z".repeat(1024 * 1024);
  assert.equal(toolPreview(text)?.length, 64 * 1024);
  assert.equal(
    toolPreview({ content: [{ type: "text", text }] })?.length,
    64 * 1024,
  );
});

test("tool preview does not split a large trailing log to return its short first line", () => {
  const text = "ready\n" + "x\n".repeat(4 * 1024 * 1024);
  const originalSplit = String.prototype.split;
  String.prototype.split = function (
    separator:
      | string
      | RegExp
      | { [Symbol.split](text: string, limit?: number): string[] },
    limit?: number,
  ) {
    assert.ok(
      this.length <= 64 * 1024,
      "preview split the full accumulated log",
    );
    return Reflect.apply(originalSplit, this, [separator, limit]);
  };
  try {
    assert.equal(toolPreview(text), "ready");
    assert.equal(toolPreview({ content: [{ type: "text", text }] }), "ready");
  } finally {
    String.prototype.split = originalSplit;
  }
});
