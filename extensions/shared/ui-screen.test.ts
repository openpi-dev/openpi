import assert from "node:assert/strict";
import test from "node:test";
import { isCustomScreenOpen, setCustomScreenOpen } from "./ui-screen.ts";

test("custom screen state toggles for widget timers", () => {
  setCustomScreenOpen(true);
  assert.equal(isCustomScreenOpen(), true);
  setCustomScreenOpen(false);
  assert.equal(isCustomScreenOpen(), false);
});
