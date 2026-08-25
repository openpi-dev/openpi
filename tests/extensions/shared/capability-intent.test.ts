import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilitiesRequestedByPrompt,
  requestsCapabilityGateway,
} from "../../../extensions/shared/capability-intent.ts";

test("classifies explicit capability intent across English, Chinese, and mixed phrases", () => {
  assert.deepEqual(capabilitiesRequestedByPrompt("subagent, workflow"), [
    "delegate",
    "workflow",
  ]);
  assert.deepEqual(
    capabilitiesRequestedByPrompt("用 Subagent 并行检查这三个模块"),
    ["delegate"],
  );
  assert.deepEqual(capabilitiesRequestedByPrompt("子代理了解下项目"), [
    "delegate",
  ]);
  assert.deepEqual(
    capabilitiesRequestedByPrompt("Use subagents to review this change"),
    ["delegate"],
  );
  assert.deepEqual(
    capabilitiesRequestedByPrompt("用 Workflow 分阶段实现和审查"),
    ["workflow"],
  );
  assert.deepEqual(
    capabilitiesRequestedByPrompt("Run a workflow for implementation"),
    ["workflow"],
  );
});

test("reserved English capability words authorize the matching groups", () => {
  assert.deepEqual(
    capabilitiesRequestedByPrompt("Compare Subagent and Workflow"),
    ["delegate", "workflow"],
  );
});

test("negation and conditional language remain fail-closed", () => {
  for (const prompt of [
    "Do not use subagents.",
    "If needed, run a workflow.",
    "如果需要，可以用 Subagent。",
    "不要用 Workflow。",
  ]) {
    assert.deepEqual(capabilitiesRequestedByPrompt(prompt), [], prompt);
  }
});

test("Chinese discussion of subagents does not authorize delegation", () => {
  for (const prompt of [
    "子代理是什么？",
    "子代理的设计有哪些取舍？",
    "聊聊子代理的设计",
  ]) {
    assert.deepEqual(capabilitiesRequestedByPrompt(prompt), [], prompt);
  }
});

test("gateway intent shares the same negation policy", () => {
  assert.equal(requestsCapabilityGateway("Show OpenPI capabilities."), true);
  assert.equal(requestsCapabilityGateway("Do not use OpenPI tools."), false);
});
