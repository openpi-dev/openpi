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
    "Run recaps: local fallback (no model calls)",
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
  });
  assert.equal(
    formatSetupConfig(configured),
    "Run recaps: seal/deepseek-v4-flash · off",
  );

  assert.deepEqual(
    parseSetupConfig({
      summaries: {
        enabled: false,
        model: { provider: "", model: 42, reasoning: "turbo" },
      },
    }),
    { summaries: { enabled: false } },
  );
});
