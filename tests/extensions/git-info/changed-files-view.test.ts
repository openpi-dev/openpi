import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeTerminalText } from "../../../extensions/git-info/src/changed-files-view.ts";

test("repository text delegates to the canonical terminal sanitizer", () => {
  const input =
    "before\u001b]52;c;Y2xpcGJvYXJk\u0007after\u001b[31mred\u001b[0m\u0001\u202espoof\u202c";
  assert.equal(sanitizeTerminalText(input), "beforeafterredspoof");
  assert.equal(sanitizeTerminalText("safe\u001b_unterminated APC"), "safe");
});
