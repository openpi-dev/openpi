import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SETUP_CONFIG,
  formatSetupConfig,
  parseSetupConfig,
} from "../shared/setup-config.ts";

const defaultFooterItems = [
  "cwd",
  "model",
  "thinking",
  "context",
  "cost",
  "throughput",
  "git",
  "pr",
  "activity",
];
const defaultUi = {
  showHeader: false,
  customFooter: true,
  footerItems: defaultFooterItems,
};

test("setup defaults to disabled recaps until explicitly configured", () => {
  assert.deepEqual(parseSetupConfig(undefined), DEFAULT_SETUP_CONFIG);
  assert.equal(
    formatSetupConfig(parseSetupConfig(undefined)),
    "Run recaps: disabled\nWorkflows: 8 concurrent agents · 128 total calls\nUI: large header off · custom footer on (cwd, model, thinking, context, cost, throughput, git, pr, activity)",
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
    ui: defaultUi,
  });
  assert.equal(
    formatSetupConfig(configured),
    "Run recaps: seal/deepseek-v4-flash · off\nWorkflows: 8 concurrent agents · 128 total calls\nUI: large header off · custom footer on (cwd, model, thinking, context, cost, throughput, git, pr, activity)",
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
      ui: defaultUi,
    },
  );
});

test("workflow limits default safely and accept configured fan-out", () => {
  assert.deepEqual(parseSetupConfig({}), DEFAULT_SETUP_CONFIG);
  assert.equal(parseSetupConfig({ summaries: {} }).summaries.enabled, false);
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

test("UI defaults to a compact header and dashboard footer", () => {
  assert.deepEqual(parseSetupConfig({}).ui, defaultUi);
  assert.deepEqual(
    parseSetupConfig({ ui: { showHeader: true, customFooter: false } }).ui,
    {
      showHeader: true,
      customFooter: false,
      footerItems: defaultFooterItems,
    },
  );
  assert.deepEqual(
    parseSetupConfig({
      ui: {
        footerItems: ["model", "context", "cache", "git", "model", "bogus"],
      },
    }).ui.footerItems,
    ["model", "context", "cache", "git"],
  );
  assert.deepEqual(
    parseSetupConfig({ ui: { footerItems: [] } }).ui.footerItems,
    defaultFooterItems,
  );
});
