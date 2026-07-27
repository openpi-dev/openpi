import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SUMMARY_CONFIG, parseSummaryConfig } from "./src/config.ts";

test("summary config defaults to low-cost Seal DeepSeek Flash", () => {
  assert.deepEqual(parseSummaryConfig(undefined), DEFAULT_SUMMARY_CONFIG);
  assert.deepEqual(DEFAULT_SUMMARY_CONFIG, {
    provider: "seal",
    model: "deepseek-v4-flash",
    reasoning: "off",
  });
});

test("summary config accepts valid private overrides and rejects partial corruption", () => {
  assert.deepEqual(
    parseSummaryConfig({
      provider: " anthropic ",
      model: " claude-sonnet ",
      reasoning: "high",
    }),
    {
      provider: "anthropic",
      model: "claude-sonnet",
      reasoning: "high",
    },
  );

  assert.deepEqual(
    parseSummaryConfig({ provider: "", model: 42, reasoning: "turbo" }),
    DEFAULT_SUMMARY_CONFIG,
  );
  assert.deepEqual(
    parseSummaryConfig({
      provider: "anthropic",
      model: 42,
      reasoning: "high",
    }),
    DEFAULT_SUMMARY_CONFIG,
  );
});
