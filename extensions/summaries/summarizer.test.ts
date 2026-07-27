import assert from "node:assert/strict";
import test from "node:test";
import { SUMMARY_SYSTEM_PROMPT } from "./src/prompt.ts";
import { parseRecapResponse, reasoningOptions } from "./src/summarizer.ts";

test("requires recap fields to match the initiating user prompt language", () => {
  assert.match(SUMMARY_SYSTEM_PROMPT, /same language as the user's prompt/);
  assert.match(SUMMARY_SYSTEM_PROMPT, /tool output, source code, logs/);
});

test("omits reasoning when configured off", () => {
  assert.deepEqual(reasoningOptions("off"), {});
  assert.deepEqual(reasoningOptions("medium"), { reasoning: "medium" });
});

test("parses strict recap JSON", () => {
  assert.deepEqual(
    parseRecapResponse(
      '{"recap":"Updated config and ran focused tests.","next":"Review the diff."}',
    ),
    {
      recap: "Updated config and ran focused tests.",
      next: "Review the diff.",
    },
  );
});

test("accepts a completed recap without a next action", () => {
  assert.deepEqual(parseRecapResponse('{"recap":"Everything is pushed."}'), {
    recap: "Everything is pushed.",
  });
  assert.deepEqual(
    parseRecapResponse('{"recap":"Everything is pushed.","next":""}'),
    { recap: "Everything is pushed." },
  );
});

test("defensively extracts fenced or surrounded JSON and normalizes Next", () => {
  assert.deepEqual(
    parseRecapResponse(
      'Result follows:\n```json\n{"recap":"- Added the extension\\n- Tests pass","next":"Next: Reload Pi."}\n```',
    ),
    {
      recap: "- Added the extension\n- Tests pass",
      next: "Reload Pi.",
    },
  );
});

test("rejects malformed or incomplete output", () => {
  assert.throws(() => parseRecapResponse("not json"), /valid recap JSON/);
  assert.throws(
    () =>
      parseRecapResponse(
        '{"recap":"done","next":"nothing","extra":"not allowed"}',
      ),
    /valid recap JSON/,
  );
});

test("strips terminal control sequences from recap fields", () => {
  assert.deepEqual(
    parseRecapResponse(
      '{"recap":"Updated \\u001b[31mconfig\\u001b[0m.","next":"Review it.\\u0007"}',
    ),
    { recap: "Updated config.", next: "Review it." },
  );
});
