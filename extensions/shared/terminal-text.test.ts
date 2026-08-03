import assert from "node:assert/strict";
import test from "node:test";
import { hasTerminalControls, sanitizeTerminalText } from "./terminal-text.ts";

test("terminal sanitizer removes CSI, OSC 52, C1, and unterminated OSC", () => {
  assert.equal(
    sanitizeTerminalText(
      "\u001b[31mred\u001b[0m \u009b2Jok \u001b]52;c;payload\u0007safe",
    ),
    "red ok safe",
  );
  assert.equal(sanitizeTerminalText("before\u009d52;c;payload"), "before");
  assert.equal(
    sanitizeTerminalText("before\u001bP1;2;hidden\u001b\\after"),
    "beforeafter",
  );
  assert.equal(
    sanitizeTerminalText("before\u001bPhidden\u0007still hidden\u001b\\after"),
    "beforeafter",
  );
  assert.equal(sanitizeTerminalText("a\u0085b\tc"), "ab  c");
});

test("terminal control detection rejects control-bearing transcript labels", () => {
  assert.equal(hasTerminalControls("Ready|ERROR"), false);
  assert.equal(hasTerminalControls("Ready\nERROR"), true);
  assert.equal(hasTerminalControls("\u001b]52;c;payload\u0007"), true);
  assert.equal(hasTerminalControls("\u009b2J"), true);
});
