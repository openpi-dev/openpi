/** Model-facing strings that carry a behavioral contract, not just wording. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Value } from "typebox/value";
import { MAX_RUNNING } from "./src/manager.ts";
import {
  buildAgentTypeParameterDescription,
  buildSubagentSpawnResult,
  createAgentTypeParameterSchema,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { BUILT_IN_AGENT_TYPES, type AgentType } from "./src/agent-types.ts";

test("the generated agent_type schema exposes each effective capability and effort default", () => {
  const parentOnlyType: AgentType = {
    name: "parent-only",
    description: "Attempts parent orchestration.",
    tools: ["read", "subagent_spawn"],
    source: "test",
  };
  const schema = createAgentTypeParameterSchema([
    ...BUILT_IN_AGENT_TYPES,
    parentOnlyType,
  ]);

  for (const name of [
    "explorer",
    "implementer",
    "reviewer",
    "advisor",
    "parent-only",
  ]) {
    assert.equal(Value.Check(schema, name), true, `${name} is in the enum`);
  }
  assert.equal(Value.Check(schema, "missing-type"), false);

  const description = buildAgentTypeParameterDescription([
    ...BUILT_IN_AGENT_TYPES,
    parentOnlyType,
  ]);
  assert.match(description, /explorer.*default reasoning_effort: high/);
  assert.match(description, /reviewer.*default reasoning_effort: medium/);
  assert.match(description, /advisor.*default reasoning_effort: xhigh/);
  assert.match(description, /parent-only.*reasoning_effort: inherits parent/);
  assert.match(description, /parent-only.*only: read/);
  assert.doesNotMatch(description, /only: read, subagent_spawn/);
  assert.match(
    description,
    /explicit spawn model > selected type file model > configured built-in role model > parent model/,
  );
  assert.match(
    description,
    /explicit spawn reasoning_effort > selected type default > parent reasoning effort/,
  );
});

test("the spawn description derives its concurrency cap from the manager", () => {
  assert.match(
    SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    new RegExp(`Max ${MAX_RUNNING} subagents`),
  );
});

test("the spawn schema keeps isolation compact while the Skill carries its tradeoffs", async () => {
  const description = SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.isolation;
  assert.ok(Buffer.byteLength(description, "utf8") < 300);
  assert.match(description, /concurrent writers/i);
  assert.match(description, /subagents Skill/i);

  const skill = await readFile(
    new URL("../../skills/subagents/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.match(skill, /same checkout and Git index/i);
  assert.match(skill, /commit/i);
  assert.match(skill, /gitignored/i);
});

test("a planning child reports its effective tools without an agent type", () => {
  const result = buildSubagentSpawnResult({
    id: "sa-1",
    title: "review",
    harness: "pi",
    modelLabel: "m",
    cwd: "/repo",
    tools: ["read", "rg"],
  });
  assert.match(result, /It can only use: read, rg/);
  assert.doesNotMatch(result, /Agent type/);

  const toolLess = buildSubagentSpawnResult({
    id: "sa-2",
    title: "review",
    harness: "pi",
    modelLabel: "m",
    cwd: "/repo",
    tools: [],
  });
  assert.match(toolLess, /no tools available/);

  const parentOnly = buildSubagentSpawnResult({
    id: "sa-3",
    title: "review",
    harness: "pi",
    modelLabel: "m",
    cwd: "/repo",
    tools: ["read", "subagent_spawn"],
  });
  assert.match(parentOnly, /It can only use: read/);
  assert.doesNotMatch(parentOnly, /only use: read, subagent_spawn/);
});

test("a spawned isolated child reports the branch its work will land on", () => {
  const isolated = buildSubagentSpawnResult({
    id: "sa-1",
    title: "impl",
    harness: "pi",
    modelLabel: "m",
    cwd: "/repo/.git/pi-worktrees/impl-1",
    worktreeBranch: "pi/impl-1",
  });
  // The path/branch remain discoverable because a settled direct child can be
  // sent another turn in the same isolated checkout.
  assert.match(isolated, /branch "pi\/impl-1"/);
  assert.match(isolated, /invisible here until you merge/);
  assert.match(isolated, /stays available for later send\/review/);
  assert.match(isolated, /bounded inspection proves it empty/);

  const plain = buildSubagentSpawnResult({
    id: "sa-2",
    title: "impl",
    harness: "pi",
    modelLabel: "m",
    cwd: "/repo",
  });
  assert.doesNotMatch(plain, /worktree|branch/);
});
