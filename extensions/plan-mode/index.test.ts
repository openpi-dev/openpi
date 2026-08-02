import assert from "node:assert/strict";
import test from "node:test";
import { BLOCKED_TOOLS } from "./index.ts";

test("plan mode blocks every way to change state, including delegation", () => {
  // Direct mutation.
  for (const tool of ["edit", "write", "bash"]) {
    assert.ok(BLOCKED_TOOLS.has(tool), `${tool} must be blocked`);
  }
  // Delegation would escape the gate: a child session's writes are invisible
  // to this extension's tool_call handler, so the spawn itself is blocked.
  for (const tool of [
    "subagent_spawn",
    "subagent_send",
    "workflow",
    "bg_start",
  ]) {
    assert.ok(BLOCKED_TOOLS.has(tool), `${tool} must be blocked`);
  }
});

test("plan mode never blocks investigation", () => {
  // A planner that cannot read is useless; these must stay available.
  for (const tool of ["read", "grep", "find", "ls", "fd", "rg"]) {
    assert.equal(
      BLOCKED_TOOLS.has(tool),
      false,
      `${tool} must stay available while planning`,
    );
  }
});
