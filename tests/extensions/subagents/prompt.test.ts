/** Model-facing strings that carry a behavioral contract, not just wording. */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Value } from "typebox/value";
import { MAX_RUNNING } from "../../../extensions/subagents/src/manager.ts";
import {
  buildAgentTypeParameterDescription,
  buildSubagentSpawnResult,
  createSubagentSpawnToolSurface,
  createAgentTypeParameterSchema,
  SUBAGENT_SCHEMA_BUDGETS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from "../../../extensions/subagents/src/prompt.ts";
import {
  AGENT_TYPE_LIMITS,
  BUILT_IN_AGENT_TYPES,
  type AgentType,
} from "../../../extensions/subagents/src/agent-types.ts";

function spawnSurfaceBytes(agentTypes: readonly AgentType[]) {
  const surface = createSubagentSpawnToolSurface(agentTypes);
  return Buffer.byteLength(
    JSON.stringify({ name: "subagent_spawn", ...surface }),
    "utf8",
  );
}

function maximumRoster(): AgentType[] {
  return Array.from({ length: AGENT_TYPE_LIMITS.files }, (_, index) => {
    const prefix = `role-${index}-`;
    return {
      name: prefix + "x".repeat(AGENT_TYPE_LIMITS.nameChars - prefix.length),
      description: "界".repeat(AGENT_TYPE_LIMITS.descriptionChars),
      tools: Array.from(
        { length: AGENT_TYPE_LIMITS.tools },
        (__, toolIndex) => `custom-tool-${index}-${toolIndex}`,
      ),
      reasoningEffort: "high",
      source: `test:${index}`,
    };
  });
}

test("the generated agent_type schema exposes a compact, enforced role index", () => {
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
  assert.match(description, /explorer.*moderate reasoning/);
  assert.match(description, /implementer.*medium-high reasoning/);
  assert.match(description, /reviewer.*high reasoning/);
  assert.match(description, /advisor.*high reasoning/);
  assert.doesNotMatch(description, /default reasoning_effort/);
  assert.match(description, /parent-only.*read-only/);
  assert.doesNotMatch(description, /only: read/);
  assert.doesNotMatch(description, /subagent_spawn/);
  assert.doesNotMatch(description, /precedence/i);
});

test("reasoning guidance prioritizes the user and task difficulty without fixing a built-in level", () => {
  assert.match(
    SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
    /user's requested level/i,
  );
  assert.match(
    SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
    /task difficulty/i,
  );
  assert.match(
    SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
    /supported by the resolved child model/i,
  );
});

test("an explicit user-selected reasoning level remains available", () => {
  const schema =
    createSubagentSpawnToolSurface(BUILT_IN_AGENT_TYPES).parameters;
  const task = {
    agent_type: "reviewer",
    prompt: "Review the change.",
    name: "review",
  };

  assert.equal(Value.Check(schema, { ...task, reasoning_effort: "max" }), true);
  assert.equal(
    Value.Check(schema, { ...task, reasoning_effort: "unsupported" }),
    false,
  );
});

test("output_schema is optional and validates the schema container", () => {
  const schema =
    createSubagentSpawnToolSurface(BUILT_IN_AGENT_TYPES).parameters;
  const task = { prompt: "Review", name: "review" };
  assert.equal(Value.Check(schema, task), true);
  assert.equal(
    Value.Check(schema, {
      ...task,
      output_schema: {
        type: "object",
        properties: { verdict: { type: "string" } },
      },
    }),
    true,
  );
  assert.equal(Value.Check(schema, { ...task, output_schema: [] }), false);
});

test("the default spawn surface stays within its resident budget", () => {
  assert.ok(
    spawnSurfaceBytes(BUILT_IN_AGENT_TYPES) <=
      SUBAGENT_SCHEMA_BUDGETS.defaultSpawnSurfaceBytes,
  );
});

test("the maximum legal roster keeps every enum value while bounding summaries", () => {
  const roster = maximumRoster();
  const schema = createAgentTypeParameterSchema(roster);
  const description = buildAgentTypeParameterDescription(roster);

  for (const agentType of roster) {
    assert.equal(Value.Check(schema, agentType.name), true, agentType.name);
  }
  assert.match(description, /presets omitted/i);
  assert.doesNotMatch(description, /custom-tool-/);
  assert.ok(
    Buffer.byteLength(description, "utf8") <=
      SUBAGENT_SCHEMA_BUDGETS.roleDirectoryBytes,
  );
  assert.ok(
    spawnSurfaceBytes(roster) <=
      SUBAGENT_SCHEMA_BUDGETS.maximumSpawnSurfaceBytes,
  );
});

test("role summaries are deterministic and truncate UTF-8 without splitting it", () => {
  const long: AgentType = {
    name: "long-purpose",
    description: "界".repeat(AGENT_TYPE_LIMITS.descriptionChars),
    tools: ["read"],
    reasoningEffort: "high",
    source: "test",
  };
  const peer: AgentType = {
    name: "alpha",
    description: "Alpha role",
    source: "test",
  };
  const forward = createSubagentSpawnToolSurface([long, peer]);
  const reverse = createSubagentSpawnToolSurface([peer, long]);
  const description = (
    forward.parameters.properties.agent_type as { description?: string }
  ).description;

  assert.deepEqual(forward, reverse);
  assert.match(description ?? "", /界…/u);
  assert.doesNotMatch(description ?? "", /�/u);
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
    new URL("../../../skills/subagents/SKILL.md", import.meta.url),
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

test("interactive spawn guidance releases the turn instead of waiting on dependent work", () => {
  const guidance = SUBAGENT_SPAWN_PROMPT_GUIDELINES.join("\n");
  assert.match(guidance, /end (?:this|your) turn/i);
  assert.match(
    guidance,
    /do not (?:call )?subagent_wait merely because .*next step.*depend/i,
  );

  const result = buildSubagentSpawnResult({
    id: "sa-1",
    title: "review",
    harness: "pi",
    modelLabel: "m",
    cwd: "/repo",
  });
  assert.match(result, /end (?:this|your) turn/i);
  assert.match(result, /automatically.*re-invoked/i);
  assert.doesNotMatch(result, /next step truly cannot proceed/i);
});

test("blocking wait is reserved for an explicit synchronous contract", () => {
  assert.match(
    SUBAGENT_WAIT_TOOL_DESCRIPTION,
    /user explicitly (?:asks|asked).*current (?:response|turn)/i,
  );
  assert.match(SUBAGENT_WAIT_TOOL_DESCRIPTION, /non-interactive|automation/i);
  assert.doesNotMatch(
    SUBAGENT_WAIT_TOOL_DESCRIPTION,
    /synthesize several children.*nothing else to do/i,
  );
});
