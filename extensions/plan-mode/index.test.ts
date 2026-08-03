import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
    "bg_kill",
    "subagent_cancel",
    "workflow_stop",
    "configure_my_pi_setup",
    "context_pivot",
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

/**
 * Tools this package registers that are safe while planning: pure reads, and
 * the peeks/asks that carry no side effect. Anything NOT here must be blocked,
 * so a future write-capable tool cannot silently escape the plan-mode gate.
 */
const PLAN_SAFE_TOOLS = new Set([
  "fd",
  "rg",
  "bg_status",
  "bg_list",
  "bg_watch",
  "subagent_check",
  "subagent_list",
  "subagent_wait",
  "workflow_status",
  "tasks_add",
  "tasks_update",
  "tasks_list",
  "get_goal",
  "create_goal",
  "update_goal",
  "ask_user",
]);

test("every registered package tool is classified for the plan-mode gate", async () => {
  const extensionsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const entries = await readdir(extensionsDir, { withFileTypes: true });
  const registerToolRe = /registerTool\s*(?:<[^(]*>)?\s*\(\s*\{?/g;
  const nameRe = /name\s*:\s*["'`]([a-z0-9_]+)["'`]/i;
  const found = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "shared") continue;
    let source: string;
    try {
      source = await readFile(
        path.join(extensionsDir, entry.name, "index.ts"),
        "utf8",
      );
    } catch {
      continue;
    }
    let match: RegExpExecArray | null;
    while ((match = registerToolRe.exec(source))) {
      const nameMatch = nameRe.exec(
        source.slice(match.index, match.index + 400),
      );
      if (nameMatch) found.add(nameMatch[1]);
    }
  }
  assert.ok(
    found.size >= 15,
    `scan should find the package tools, got ${found.size}`,
  );
  for (const tool of found) {
    assert.ok(
      BLOCKED_TOOLS.has(tool) || PLAN_SAFE_TOOLS.has(tool),
      `tool "${tool}" is unclassified for plan mode: block it in BLOCKED_TOOLS ` +
        "(if it can change anything) or add it to PLAN_SAFE_TOOLS here",
    );
  }
});
