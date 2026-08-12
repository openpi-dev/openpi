import assert from "node:assert/strict";
import test from "node:test";
import { estimateContentTokens } from "./index.ts";

test("estimateContentTokens converts characters at 4/1", () => {
  assert.equal(estimateContentTokens(0), 0);
  assert.equal(estimateContentTokens(100), 25);
  assert.equal(estimateContentTokens(101), 26);
});
