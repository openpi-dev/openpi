import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFooterConfig,
  DEFAULT_FOOTER_ITEMS,
  DEFAULT_FOOTER_LINES,
  DEFAULT_SETUP_CONFIG,
  flattenFooterItems,
  footerLinesFromItems,
  formatFooterLines,
  formatSetupConfig,
  normalizeFooterLines,
  parseSetupConfig,
  resolveFooterPreset,
} from "../shared/setup-config.ts";

const defaultUi = {
  showHeader: false,
  customFooter: true,
  footerStyle: "powerline" as const,
  footerLines: DEFAULT_FOOTER_LINES,
  footerItems: DEFAULT_FOOTER_ITEMS,
  subagentResultDisplay: "full" as const,
  bashToolDisplay: "compact" as const,
  fileMutationDisplay: "compact" as const,
};

test("setup defaults to disabled recaps until explicitly configured", () => {
  assert.deepEqual(parseSetupConfig(undefined), DEFAULT_SETUP_CONFIG);
  assert.equal(
    formatSetupConfig(parseSetupConfig(undefined)),
    `Run recaps: disabled\nWorkflows: 8 concurrent agents · 128 total calls\nUI: large header off · custom footer on · powerline · ${formatFooterLines(DEFAULT_FOOTER_LINES)}\nSubagent results: full by default\nBash operations: folded preview (Ctrl+O expands all)\nWrite/Edit operations: folded preview (Ctrl+O expands all)\nPost-edit command: off`,
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
    postEdit: { command: "" },
  });
  assert.equal(
    formatSetupConfig(configured),
    `Run recaps: seal/deepseek-v4-flash · off\nWorkflows: 8 concurrent agents · 128 total calls\nUI: large header off · custom footer on · powerline · ${formatFooterLines(DEFAULT_FOOTER_LINES)}\nSubagent results: full by default\nBash operations: folded preview (Ctrl+O expands all)\nWrite/Edit operations: folded preview (Ctrl+O expands all)\nPost-edit command: off`,
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
      postEdit: { command: "" },
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

test("UI defaults to a compact header and one-line powerline footer", () => {
  assert.deepEqual(parseSetupConfig({}).ui, defaultUi);
  assert.deepEqual(
    parseSetupConfig({ ui: { showHeader: true, customFooter: false } }).ui,
    {
      showHeader: true,
      customFooter: false,
      footerStyle: "powerline",
      footerLines: DEFAULT_FOOTER_LINES,
      footerItems: DEFAULT_FOOTER_ITEMS,
      subagentResultDisplay: "full",
      bashToolDisplay: "compact",
      fileMutationDisplay: "compact",
    },
  );
  assert.equal(
    parseSetupConfig({ ui: { subagentResultDisplay: "compact" } }).ui
      .subagentResultDisplay,
    "compact",
  );
  assert.equal(
    parseSetupConfig({ ui: { subagentResultDisplay: "unknown" } }).ui
      .subagentResultDisplay,
    "full",
  );
  assert.equal(
    parseSetupConfig({ ui: { bashToolDisplay: "full" } }).ui.bashToolDisplay,
    "full",
  );
  assert.equal(
    parseSetupConfig({ ui: { bashToolDisplay: "unknown" } }).ui.bashToolDisplay,
    "compact",
  );
  assert.equal(
    parseSetupConfig({ ui: { fileMutationDisplay: "full" } }).ui
      .fileMutationDisplay,
    "full",
  );
  assert.equal(
    parseSetupConfig({ ui: { fileMutationDisplay: "unknown" } }).ui
      .fileMutationDisplay,
    "compact",
  );
});

test("legacy footerItems migrates onto the default one-line skeleton", () => {
  const ui = parseSetupConfig({
    ui: {
      footerItems: ["model", "context", "cache", "git", "model", "bogus"],
    },
  }).ui;

  assert.deepEqual(ui.footerLines, [
    ["model", "context", "cache", "flex", "git"],
  ]);
  assert.deepEqual(ui.footerItems, ["model", "context", "cache", "git"]);
  assert.equal(ui.footerStyle, "powerline");
});

test("empty legacy footerItems falls back to the default layout", () => {
  assert.deepEqual(
    parseSetupConfig({ ui: { footerItems: [] } }).ui.footerLines,
    DEFAULT_FOOTER_LINES,
  );
});

test("normalizeFooterLines drops unknowns, duplicates, extra flex, and empty rows", () => {
  assert.deepEqual(
    normalizeFooterLines([
      ["cwd", "flex", "flex", "model", "bogus"],
      [],
      ["model", "git", "flex"],
      ["flex"],
      ["cache"],
    ]),
    [["cwd", "flex", "model"], ["git", "flex"], ["cache"]],
  );
  assert.deepEqual(normalizeFooterLines([["nope"], []]), DEFAULT_FOOTER_LINES);
  assert.deepEqual(
    flattenFooterItems(normalizeFooterLines([["cwd", "flex", "git"]])),
    ["cwd", "git"],
  );
});

test("footerLines is the source of truth when both legacy fields exist", () => {
  const ui = parseSetupConfig({
    ui: {
      footerItems: ["model"],
      footerLines: [["cwd", "flex", "git"]],
      footerStyle: "powerline",
    },
  }).ui;
  assert.equal(ui.footerStyle, "powerline");
  assert.deepEqual(ui.footerLines, [["cwd", "flex", "git"]]);
  assert.deepEqual(ui.footerItems, ["cwd", "git"]);
});

test("presets map to style and lines", () => {
  assert.equal(resolveFooterPreset("compact").style, "plain");
  assert.equal(resolveFooterPreset("compact").lines.length, 1);
  assert.equal(resolveFooterPreset("powerline").style, "powerline");
  assert.equal(resolveFooterPreset("powerline-mono").style, "powerline-mono");
});

test("applyFooterConfig order is current → preset → style/lines; items conflicts with lines", () => {
  const base = {
    footerStyle: "plain" as const,
    footerLines: DEFAULT_FOOTER_LINES,
  };

  const fromPreset = applyFooterConfig(base, { preset: "powerline" });
  assert.equal(fromPreset.footerStyle, "powerline");
  assert.deepEqual(
    fromPreset.footerLines,
    resolveFooterPreset("powerline").lines,
  );

  const overridden = applyFooterConfig(base, {
    preset: "powerline",
    style: "plain",
    lines: [["model", "flex", "git"]],
  });
  assert.equal(overridden.footerStyle, "plain");
  assert.deepEqual(overridden.footerLines, [["model", "flex", "git"]]);

  const fromItems = applyFooterConfig(base, {
    items: ["model", "context", "git"],
  });
  assert.deepEqual(
    fromItems.footerLines,
    footerLinesFromItems(["model", "context", "git"]),
  );

  assert.throws(
    () =>
      applyFooterConfig(base, {
        items: ["model"],
        lines: [["cwd"]],
      }),
    /cannot be provided together/,
  );
});
