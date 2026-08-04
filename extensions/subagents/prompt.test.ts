/** Model-facing strings that carry a behavioral contract, not just wording. */

import assert from "node:assert/strict";
import test from "node:test";
import { MAX_RUNNING } from "./src/manager.ts";
import {
  buildSubagentSpawnResult,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
} from "./src/prompt.ts";

test("the spawn description derives its concurrency cap from the manager", () => {
  assert.match(
    SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    new RegExp(`Max ${MAX_RUNNING} subagents`),
  );
});

test("the spawn description tells the model when isolation is needed and what it gets back", () => {
  const description = SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.isolation;
  // The model has to learn the hazard, not just the flag: without the "why",
  // it has no basis for choosing isolation on a concurrent write fan-out.
  assert.match(description, /same git index|git index/);
  // Committing is what makes the work survive teardown.
  assert.match(description, /COMMIT/);
  // And the two costs it must weigh before turning it on.
  assert.match(description, /git repository/);
  assert.match(description, /gitignored/);
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
  // Without the branch name the parent cannot find committed work once the
  // isolated directory is reclaimed.
  assert.match(isolated, /branch "pi\/impl-1"/);
  assert.match(isolated, /invisible here until you merge/);

  const plain = buildSubagentSpawnResult({
    id: "sa-2",
    title: "impl",
    harness: "pi",
    modelLabel: "m",
    cwd: "/repo",
  });
  assert.doesNotMatch(plain, /worktree|branch/);
});
