import assert from "node:assert/strict";
import test from "node:test";
import {
  hasTerminalControls,
  sanitizeTerminalText,
} from "../../../extensions/shared/terminal-text.ts";

test("terminal sanitizer removes CSI and terminated or unterminated terminal strings", () => {
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
  assert.equal(sanitizeTerminalText("before\u001b_unterminated APC"), "before");
  assert.equal(sanitizeTerminalText("before\u0090unterminated DCS"), "before");
  assert.equal(sanitizeTerminalText("a\u0085b\tc"), "ab  c");
});

test("terminal sanitizer removes bidi spoofing controls but preserves shaping joiners", () => {
  assert.equal(
    sanitizeTerminalText(
      "left\u061c\u200eright\u202eevil\u202c\u2066isolated\u2069 soft\u00adjoin\u2060bom\ufeff",
    ),
    "leftrightevilisolated softjoinbom",
  );
  assert.equal(
    sanitizeTerminalText("می\u200cروم 👩\u200d💻"),
    "می\u200cروم 👩\u200d💻",
  );
});

test("terminal control detection rejects control-bearing transcript labels", () => {
  assert.equal(hasTerminalControls("Ready|ERROR"), false);
  assert.equal(hasTerminalControls("Ready\nERROR"), true);
  assert.equal(hasTerminalControls("\u001b]52;c;payload\u0007"), true);
  assert.equal(hasTerminalControls("\u009b2J"), true);
  assert.equal(hasTerminalControls("safe\u202eevil\u202c"), true);
  assert.equal(hasTerminalControls("soft\u00adhyphen"), true);
  assert.equal(hasTerminalControls("word\u2060joiner"), true);
  assert.equal(hasTerminalControls("می\u200cروم"), false);
});
