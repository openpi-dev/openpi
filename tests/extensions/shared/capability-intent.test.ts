import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilitiesRequestedByPrompt,
  capabilityNameMentions,
  requestsCapabilityGateway,
} from "../../../extensions/shared/capability-intent.ts";

test("capability names select discovery across case, plurals, Chinese and multiple lines", () => {
  for (const prompt of [
    "subagent",
    "SubAgents",
    "子代理了解下项目",
    "用Subagent检查",
    "subagent.",
  ])
    assert.deepEqual(
      capabilitiesRequestedByPrompt(prompt),
      ["delegate"],
      prompt,
    );
  for (const prompt of [
    "workflow",
    "WORKFLOWS",
    "工作流",
    "用Workflow汇总",
    "workflow.",
  ])
    assert.deepEqual(
      capabilitiesRequestedByPrompt(prompt),
      ["workflow"],
      prompt,
    );
  for (const prompt of [
    "subagent, workflow",
    "讨论 子代理 和工作流",
    "不要启动\nworkflow 与 subagent",
    "Compare Subagent and Workflow",
  ])
    assert.deepEqual(
      capabilitiesRequestedByPrompt(prompt),
      ["delegate", "workflow"],
      prompt,
    );
});

test("names load discovery for discussion, negation and conditions without judging execution intent", () => {
  for (const prompt of [
    "Do not use subagents.",
    "如果需要，可以用 Subagent。",
    "子代理是什么？",
    "Explain this:\nsubagent",
    "`subagent`",
    "subagent?",
    "I use subagents in this repo",
  ])
    assert.deepEqual(
      capabilitiesRequestedByPrompt(prompt),
      ["delegate"],
      prompt,
    );
  for (const prompt of [
    "If needed, run a workflow.",
    "不要用 Workflow。",
    '\"workflow\"',
    "We run workflows every day",
  ])
    assert.deepEqual(
      capabilitiesRequestedByPrompt(prompt),
      ["workflow"],
      prompt,
    );
});

test("identifier and path fragments do not select capability names", () => {
  for (const prompt of [
    "subagent.ts",
    "workflow.json",
    "subagent.项目",
    "subagent-matching",
    "my_subagent",
    "subagent2",
    "mysubagent",
    "workflow_status",
    "工作流_状态",
    "my子代理Flag",
    "/tools/workflow",
    "C:\\tools\\subagent.ts",
    "Use subagent.ts",
    "用工作流.json",
  ])
    assert.deepEqual(capabilitiesRequestedByPrompt(prompt), [], prompt);
  const mentions = capabilityNameMentions(
    "subagent.ts then SUBAGENTS and 工作流",
  );
  assert.deepEqual(
    mentions.map((mention) => mention.capability),
    ["delegate", "workflow"],
  );
  assert.deepEqual(
    mentions.map(({ start, end }) =>
      "subagent.ts then SUBAGENTS and 工作流".slice(start, end),
    ),
    ["SUBAGENTS", "工作流"],
  );
});

test("other capabilities and gateway retain their explicit request policy", () => {
  for (const prompt of [
    "Do not use fd",
    "If needed, run a background process",
    "不要设置目标",
    "runtime snapshot",
  ])
    assert.deepEqual(capabilitiesRequestedByPrompt(prompt), [], prompt);
  assert.deepEqual(capabilitiesRequestedByPrompt("use fd"), ["search"]);
  assert.deepEqual(
    capabilitiesRequestedByPrompt("run a job in the background"),
    ["background"],
  );
  assert.deepEqual(capabilitiesRequestedByPrompt("create a goal"), ["session"]);
  assert.equal(requestsCapabilityGateway("Show OpenPI capabilities."), true);
  assert.equal(requestsCapabilityGateway("Do not use OpenPI tools."), false);
  assert.equal(requestsCapabilityGateway("workflow"), false);
});

test("legacy delegation action phrases remain compatible without inferring use from name mentions", () => {
  for (const prompt of [
    "Delegate this task.",
    "Please parallelize this work.",
    "Could you delegate this task?",
    "来并行代理检查",
    "委派任务",
  ])
    assert.deepEqual(
      capabilitiesRequestedByPrompt(prompt),
      ["delegate"],
      prompt,
    );
  assert.deepEqual(
    capabilitiesRequestedByPrompt("Never delegate this task."),
    [],
  );
});
