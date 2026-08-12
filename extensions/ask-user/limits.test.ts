import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ANSWER_DRAFT_UTF8_BYTES,
  answerDraftByteLength,
  answerDraftFits,
  longerThanAnswerDraftLimit,
} from "./limits.ts";

test("answer draft byte accounting respects the cap", () => {
  assert.equal(answerDraftByteLength("abc"), 3);
  // CJK is 3 bytes per character in UTF-8.
  assert.equal(answerDraftByteLength("裁定"), 6);
  assert.equal(answerDraftFits("x".repeat(100)), true);
  assert.equal(
    answerDraftFits("裁".repeat(MAX_ANSWER_DRAFT_UTF8_BYTES / 3 + 1)),
    false,
  );
  assert.equal(
    longerThanAnswerDraftLimit(
      "裁".repeat(MAX_ANSWER_DRAFT_UTF8_BYTES / 3 + 1),
      "short",
    ),
    true,
  );
  assert.equal(longerThanAnswerDraftLimit("short", "shorter"), false);
});
