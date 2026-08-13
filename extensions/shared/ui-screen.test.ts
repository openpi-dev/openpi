import assert from "node:assert/strict";
import test from "node:test";
import {
  isCustomScreenOpen,
  resetCustomScreenOpen,
  setCustomScreenOpen,
} from "./ui-screen.ts";

test("custom screen state toggles for widget timers", () => {
  setCustomScreenOpen(true);
  assert.equal(isCustomScreenOpen(), true);
  setCustomScreenOpen(false);
  assert.equal(isCustomScreenOpen(), false);
});

test("reset clears a leaked screen-open flag at session boundaries", () => {
  setCustomScreenOpen(true);
  assert.equal(isCustomScreenOpen(), true);
  // Simulates a session destroyed while /tasks was open: the finally block
  // never ran, but the session-start reset must restore repaint flow.
  resetCustomScreenOpen();
  assert.equal(isCustomScreenOpen(), false);
});
