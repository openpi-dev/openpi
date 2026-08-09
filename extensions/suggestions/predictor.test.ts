import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSuggestionPrompt,
  SUGGESTION_SYSTEM_PROMPT,
} from "./src/prompt.ts";
import { parseSuggestionResponse, reasoningOptions } from "./src/predictor.ts";

test("parses one bounded one-line suggestion and strips terminal controls", () => {
  assert.equal(
    parseSuggestionResponse(
      '{"suggestion":"  跑一下完整测试\\n然后提交 \\u001b[31m红色\\u001b[0m  "}',
    ),
    "跑一下完整测试 然后提交 红色",
  );
  assert.equal(
    parseSuggestionResponse(JSON.stringify({ suggestion: "x".repeat(250) }))
      ?.length,
    200,
  );
});

test("rejects invisible output and strips direction controls", () => {
  assert.equal(
    parseSuggestionResponse('{"suggestion":"\\u200b\\u0301\\u202e"}'),
    undefined,
  );
  assert.equal(
    parseSuggestionResponse('{"suggestion":"run\\u202e tests"}'),
    "run tests",
  );
});

test("accepts null and extracts fenced or wrapped JSON", () => {
  assert.equal(parseSuggestionResponse('{"suggestion":null}'), undefined);
  assert.equal(
    parseSuggestionResponse(
      'result follows\n```json\n{"suggestion":"检查一下 diff"}\n```',
    ),
    "检查一下 diff",
  );
});

test("rejects malformed or over-specified responses", () => {
  assert.throws(
    () => parseSuggestionResponse("not json"),
    /valid suggestion JSON/,
  );
  assert.throws(
    () => parseSuggestionResponse('{"suggestion":"ok","next":"extra"}'),
    /valid suggestion JSON/,
  );
});

test("omits reasoning only when configured off", () => {
  assert.deepEqual(reasoningOptions("off"), {});
  assert.deepEqual(reasoningOptions("minimal"), { reasoning: "minimal" });
  assert.deepEqual(reasoningOptions("xhigh"), { reasoning: "xhigh" });
});

test("prompt predicts user input rather than recapping the run", () => {
  assert.match(SUGGESTION_SYSTEM_PROMPT, /exactly as the user would type/);
  assert.match(SUGGESTION_SYSTEM_PROMPT, /one line and at most 200 characters/);
  assert.match(SUGGESTION_SYSTEM_PROMPT, /Return null/);
  assert.doesNotMatch(SUGGESTION_SYSTEM_PROMPT, /cover everything performed/i);
  assert.equal(
    buildSuggestionPrompt("USER\nfix it"),
    "Predict the next user input after this fully settled main-agent run.\n\n<current_run>\nUSER\nfix it\n</current_run>",
  );
});
