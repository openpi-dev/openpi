import assert from "node:assert/strict";
import test from "node:test";
import { textFromContent } from "./index.ts";

test("textFromContent flattens string and block content", () => {
  assert.equal(textFromContent("plain"), "plain");
  assert.equal(textFromContent(""), "");
  assert.equal(textFromContent(undefined), "");
  assert.equal(
    textFromContent([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
      { type: "image", data: "x" },
    ]),
    "a\nb\n[image]",
  );
  assert.equal(textFromContent([{ type: "text" }]), "");
  assert.equal(textFromContent(null), "");
});
