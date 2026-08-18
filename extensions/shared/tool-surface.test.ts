import assert from "node:assert/strict";
import test from "node:test";
import {
  CHILD_EXCLUDED_TOOL_NAMES,
  CHILD_SAFE_PACKAGE_TOOL_NAMES,
} from "./child-session.ts";
import {
  DEFAULT_OPENPI_ACTIVE_TOOL_NAMES,
  loadOpenPiCapabilities,
  OPENPI_CAPABILITY_NAMES,
  OPENPI_TOOL_SURFACE,
  OPENPI_TOOL_SURFACE_NAMES,
  patchOwnedTools,
  resetOpenPiToolSurface,
} from "./tool-surface.ts";

function harness(
  initial: readonly string[],
  available: readonly string[] = OPENPI_TOOL_SURFACE_NAMES,
) {
  let active = [...initial];
  const writes: string[][] = [];
  return {
    pi: {
      getActiveTools: () => [...active],
      getAllTools: () => available.map((name) => ({ name })),
      setActiveTools(names: string[]) {
        active = [...names];
        writes.push([...names]);
      },
    },
    active: () => [...active],
    writes,
  };
}

test("owner patch starts from the latest tool list and preserves foreign tools", () => {
  const h = harness([
    "read",
    "third_party_tool",
    "subagent_wait",
    "subagent_spawn",
  ]);
  resetOpenPiToolSurface(h.pi);
  loadOpenPiCapabilities(h.pi, ["delegate"]);
  h.writes.length = 0;

  assert.equal(
    patchOwnedTools(h.pi, "subagents", {
      disable: ["subagent_wait"],
      enable: ["subagent_list", "subagent_check"],
    }),
    true,
  );
  assert.deepEqual(h.active(), [
    "read",
    "third_party_tool",
    "subagent_spawn",
    "subagent_check",
    "subagent_list",
  ]);

  h.pi.setActiveTools([...h.active(), "late_third_party_tool"]);
  h.writes.length = 0;
  patchOwnedTools(h.pi, "subagents", {
    enable: ["subagent_wait"],
  });
  assert.deepEqual(h.active(), [
    "read",
    "third_party_tool",
    "subagent_spawn",
    "subagent_check",
    "subagent_list",
    "late_third_party_tool",
    "subagent_wait",
  ]);
});

test("owner patch fails closed on undeclared tools", () => {
  const h = harness(["read", "subagent_spawn"]);
  assert.throws(
    () =>
      patchOwnedTools(h.pi, "subagents", {
        disable: ["workflow_status"],
      }),
    /does not own tool "workflow_status"/,
  );
  assert.equal(h.writes.length, 0);
});

test("inline ownership fails open without hiding foreign tools", () => {
  let active = ["read", "openpi_load_tools", "subagent_spawn", "subagent_wait"];
  const openPiSource = "<inline:openpi-subagents>";
  const pi = {
    getActiveTools: () => [...active],
    getAllTools: () => [
      { name: "openpi_load_tools" },
      {
        name: "subagent_spawn",
        sourceInfo: { path: "<inline:foreign>", source: "inline" },
      },
      ...OPENPI_TOOL_SURFACE.subagents.deferred.map((name) => ({
        name,
        sourceInfo: { path: openPiSource, source: "inline" },
      })),
    ],
    setActiveTools(names: string[]) {
      active = [...names];
    },
  };

  resetOpenPiToolSurface(pi);
  patchOwnedTools(pi, "subagents", {
    disable: OPENPI_TOOL_SURFACE.subagents.deferred,
  });
  assert.ok(active.includes("subagent_spawn"));
  assert.ok(active.includes("subagent_wait"));

  loadOpenPiCapabilities(pi, ["delegate"]);
  patchOwnedTools(pi, "subagents", { enable: ["subagent_wait"] });
  assert.equal(active.filter((name) => name === "subagent_spawn").length, 1);
  assert.ok(active.includes("subagent_wait"));
});

test("an explicitly bound inline owner controls only its declared source", () => {
  let active = ["read", "openpi_load_tools"];
  const pi = {
    getActiveTools: () => [...active],
    getAllTools: () => [
      { name: "read" },
      {
        name: "openpi_load_tools",
        sourceInfo: {
          path: "<inline:openpi-capabilities-test>",
          source: "inline",
        },
      },
    ],
    setActiveTools(names: string[]) {
      active = [...names];
    },
  };

  resetOpenPiToolSurface(pi, {
    capabilities: "<inline:openpi-capabilities-test>",
  });

  assert.deepEqual(active, ["read"]);
});

test("owner patch is a no-op when the desired surface is already active", () => {
  const h = harness(["read", "openpi_load_tools", "subagent_spawn"]);
  resetOpenPiToolSurface(h.pi);
  loadOpenPiCapabilities(h.pi, ["delegate"]);
  h.writes.length = 0;
  assert.equal(
    patchOwnedTools(h.pi, "subagents", {
      enable: ["subagent_spawn"],
      disable: ["subagent_wait"],
    }),
    false,
  );
  assert.deepEqual(h.writes, []);
});

test("catalog defines the compact parent entry surface and every managed name once", () => {
  assert.deepEqual(DEFAULT_OPENPI_ACTIVE_TOOL_NAMES, []);
  assert.deepEqual(OPENPI_CAPABILITY_NAMES, [
    "search",
    "delegate",
    "workflow",
    "background",
    "session",
  ]);
  assert.equal(
    OPENPI_TOOL_SURFACE_NAMES.length,
    new Set(OPENPI_TOOL_SURFACE_NAMES).size,
  );
  assert.deepEqual(OPENPI_TOOL_SURFACE.subagents.deferred, [
    "subagent_wait",
    "subagent_cancel",
    "subagent_send",
    "subagent_check",
    "subagent_list",
  ]);
});

test("an unloaded capability remembers lifecycle state without exposing its tools", () => {
  const h = harness(["read", "openpi_load_tools", "tasks_add", "tasks_update"]);
  resetOpenPiToolSurface(h.pi);
  patchOwnedTools(h.pi, "tasks", {
    enable: OPENPI_TOOL_SURFACE.tasks.deferred,
  });
  patchOwnedTools(h.pi, "goal", {
    disable: OPENPI_TOOL_SURFACE.goal.deferred,
  });
  assert.deepEqual(h.active(), ["read"]);

  const loaded = loadOpenPiCapabilities(h.pi, ["session"]);
  assert.deepEqual(loaded.activatedTools, [
    "tasks_add",
    "tasks_update",
    "tasks_list",
    "create_goal",
  ]);
  assert.deepEqual(h.active(), [
    "read",
    "tasks_add",
    "tasks_update",
    "tasks_list",
    "create_goal",
  ]);
});

test("visibility catalog and child-session policy classify the same package tools", () => {
  assert.deepEqual(
    [...OPENPI_TOOL_SURFACE_NAMES].sort(),
    [...CHILD_SAFE_PACKAGE_TOOL_NAMES, ...CHILD_EXCLUDED_TOOL_NAMES].sort(),
  );
});
