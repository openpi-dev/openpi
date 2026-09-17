import assert from "node:assert/strict";
import test from "node:test";
import type { WebModelSummary } from "../../web/protocol/types.ts";
import {
  filterModels,
  formatContextWindow,
  listProviders,
  modelMetaParts,
} from "../../web/ui/src/features/composer/model-picker-utils.ts";

const models: WebModelSummary[] = [
  {
    provider: "seal",
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    label: "DeepSeek V4 Flash",
    current: true,
    contextWindow: 256_000,
    reasoning: true,
    imageInput: true,
  },
  {
    provider: "seal",
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    label: "GPT-5.6 Sol",
    current: false,
    contextWindow: 1_000_000,
  },
  {
    provider: "managed:kimi-code",
    id: "k3",
    name: "K3",
    label: "K3",
    current: false,
    contextWindow: 1_048_576,
    reasoning: true,
  },
];

test("listProviders dedupes while preserving first-seen order", () => {
  assert.deepEqual(listProviders(models), ["seal", "managed:kimi-code"]);
  assert.deepEqual(listProviders([]), []);
});

test("filterModels matches query against label, name, id, and provider", () => {
  assert.deepEqual(
    filterModels(models, "flash").map((model) => model.id),
    ["deepseek-v4-flash"],
  );
  assert.deepEqual(
    filterModels(models, "KIMI").map((model) => model.id),
    ["k3"],
  );
  assert.deepEqual(
    filterModels(models, "gpt").map((model) => model.id),
    ["gpt-5.6-sol"],
  );
  assert.equal(filterModels(models, "  ").length, 3);
  assert.deepEqual(filterModels(models, "missing"), []);
});

test("formatContextWindow compacts to k and M units", () => {
  assert.equal(formatContextWindow(undefined), "");
  assert.equal(formatContextWindow(0), "");
  assert.equal(formatContextWindow(Number.NaN), "");
  assert.equal(formatContextWindow(999), "999");
  assert.equal(formatContextWindow(256_000), "256k");
  assert.equal(formatContextWindow(1_000_000), "1M");
  assert.equal(formatContextWindow(1_048_576), "1M");
  assert.equal(formatContextWindow(1_500_000), "1.5M");
});

test("modelMetaParts leads with provider and appends capabilities", () => {
  const labels = { reasoning: "Reasoning", imageInput: "Image input" };
  assert.deepEqual(modelMetaParts(models[0]!, labels), [
    "seal",
    "256k ctx",
    "Reasoning",
    "Image input",
  ]);
  assert.deepEqual(modelMetaParts(models[1]!, labels), ["seal", "1M ctx"]);
  assert.deepEqual(modelMetaParts(models[2]!, labels), [
    "managed:kimi-code",
    "1M ctx",
    "Reasoning",
  ]);
});
