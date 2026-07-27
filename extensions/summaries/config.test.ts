import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SETUP_CONFIG,
  formatSetupConfig,
  parseSetupConfig,
} from "../shared/setup-config.ts";

test("setup defaults to enabled local recaps without model calls", () => {
  assert.deepEqual(parseSetupConfig(undefined), DEFAULT_SETUP_CONFIG);
  assert.equal(
    formatSetupConfig(parseSetupConfig(undefined)),
    "Run recaps: local fallback (no model calls)\nWorkflows: 8 concurrent agents · 128 total calls",
  );
});

test("setup config accepts model choices and drops malformed models", () => {
  const configured = parseSetupConfig({
    summaries: {
      enabled: true,
      model: {
        provider: " seal ",
        model: " deepseek-v4-flash ",
        reasoning: "off",
      },
    },
  });
  assert.deepEqual(configured, {
    summaries: {
      enabled: true,
      model: {
        provider: "seal",
        model: "deepseek-v4-flash",
        reasoning: "off",
      },
    },
    workflows: { concurrency: 8, maxAgentCalls: 128 },
  });
  assert.equal(
    formatSetupConfig(configured),
    "Run recaps: seal/deepseek-v4-flash · off\nWorkflows: 8 concurrent agents · 128 total calls",
  );

  assert.deepEqual(
    parseSetupConfig({
      summaries: {
        enabled: false,
        model: { provider: "", model: 42, reasoning: "turbo" },
      },
    }),
    {
      summaries: { enabled: false },
      workflows: { concurrency: 8, maxAgentCalls: 128 },
    },
  );
});

test("workflow limits default safely and accept configured fan-out", () => {
  assert.deepEqual(parseSetupConfig({}), DEFAULT_SETUP_CONFIG);
  assert.deepEqual(
    parseSetupConfig({
      workflows: { concurrency: 16, maxAgentCalls: 256 },
    }).workflows,
    { concurrency: 16, maxAgentCalls: 256 },
  );
  assert.deepEqual(
    parseSetupConfig({
      workflows: { concurrency: 65, maxAgentCalls: 1_025 },
    }).workflows,
    { concurrency: 8, maxAgentCalls: 128 },
  );
});
