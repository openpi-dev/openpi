import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CHILD_EXCLUDED_TOOL_NAMES,
  CHILD_SAFE_PACKAGE_TOOL_NAMES,
  RETIRED_OPENPI_TOOL_NAMES,
} from "../../../extensions/shared/child-session.ts";
import {
  isOwnedToolActive,
  isOwnedToolAvailable,
  OPENPI_TOOL_SURFACE,
  OPENPI_TOOL_SURFACE_NAMES,
  patchOwnedTools,
} from "../../../extensions/shared/tool-surface.ts";

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
    "subagent_spawn",
    "subagent_cancel",
    "subagent_send",
    "subagent_check",
  ]);

  // subagent_wait missing from active: resident reconcile adds it
  assert.equal(
    patchOwnedTools(h.pi, "subagents", {
      enable: OPENPI_TOOL_SURFACE.subagents.resident,
    }),
    true,
  );
  assert.deepEqual(h.active(), [
    "read",
    "third_party_tool",
    "subagent_spawn",
    "subagent_cancel",
    "subagent_send",
    "subagent_check",
    "subagent_wait",
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
    "subagent_cancel",
    "subagent_send",
    "subagent_check",
    "subagent_wait",
    "late_third_party_tool",
  ]);
});

test("disabling a resident tool throws instead of churning the frozen surface", () => {
  const h = harness(["read", ...OPENPI_TOOL_SURFACE.workflows.resident]);
  assert.throws(
    () => patchOwnedTools(h.pi, "workflows", { disable: ["workflow_status"] }),
    /workflows cannot disable resident tool "workflow_status"/,
  );
  assert.throws(
    () =>
      patchOwnedTools(h.pi, "workflows", {
        enable: ["workflow"],
        disable: ["workflow_stop"],
      }),
    /workflows cannot disable resident tool "workflow_stop"/,
  );
  // The throw happens before any surface write.
  assert.equal(h.writes.length, 0);
  assert.ok(h.active().includes("workflow_status"));
});

test("boundary tools enable and disable while resident tools stay put", () => {
  const h = harness(["read", ...OPENPI_TOOL_SURFACE.workflows.resident]);
  assert.equal(
    patchOwnedTools(h.pi, "gitRead", {
      enable: OPENPI_TOOL_SURFACE.gitRead.boundary,
    }),
    true,
  );
  assert.deepEqual(h.active(), [
    "read",
    ...OPENPI_TOOL_SURFACE.workflows.resident,
    ...OPENPI_TOOL_SURFACE.gitRead.boundary,
  ]);

  assert.equal(
    patchOwnedTools(h.pi, "gitRead", {
      disable: OPENPI_TOOL_SURFACE.gitRead.boundary,
    }),
    true,
  );
  assert.deepEqual(h.active(), [
    "read",
    ...OPENPI_TOOL_SURFACE.workflows.resident,
  ]);
});

test("owner patch fails closed on undeclared tools", () => {
  const h = harness(["read", "subagent_spawn"]);
  assert.throws(
    () =>
      patchOwnedTools(h.pi, "subagents", {
        disable: ["workflow_status"],
      }),
    /subagents does not own tool "workflow_status"/,
  );
  assert.equal(h.writes.length, 0);
});

test("owned-tool activity requires both visibility and matching provenance", () => {
  const setupPath = fileURLToPath(
    new URL("../../../extensions/setup/index.ts", import.meta.url),
  );
  let active = ["read", "configure_my_pi_setup"];
  const sourceInfo = { path: setupPath, source: "extension" };
  const pi = {
    getActiveTools: () => [...active],
    getAllTools: () => [
      { name: "read" },
      { name: "configure_my_pi_setup", sourceInfo },
    ],
    setActiveTools(names: string[]) {
      active = [...names];
    },
  };

  assert.equal(isOwnedToolActive(pi, "setup", "configure_my_pi_setup"), true);
  assert.equal(
    isOwnedToolAvailable(pi, "setup", "configure_my_pi_setup"),
    true,
  );
  active = ["read"];
  assert.equal(isOwnedToolActive(pi, "setup", "configure_my_pi_setup"), false);
  assert.equal(
    isOwnedToolAvailable(pi, "setup", "configure_my_pi_setup"),
    true,
  );
  active = ["read", "configure_my_pi_setup"];
  sourceInfo.path = "<foreign:configure_my_pi_setup>";
  assert.equal(isOwnedToolActive(pi, "setup", "configure_my_pi_setup"), false);
  assert.equal(
    isOwnedToolAvailable(pi, "setup", "configure_my_pi_setup"),
    false,
  );
  assert.throws(
    () => isOwnedToolActive(pi, "setup", "workflow"),
    /setup does not own tool "workflow"/,
  );
});

test("inline ownership fails open without hiding foreign tools", () => {
  let active = ["read", "subagent_spawn", "subagent_wait"];
  const openPiSource = "<inline:openpi-subagents>";
  const pi = {
    getActiveTools: () => [...active],
    getAllTools: () => [
      {
        name: "subagent_spawn",
        sourceInfo: { path: "<inline:foreign>", source: "inline" },
      },
      ...OPENPI_TOOL_SURFACE.subagents.resident
        .filter((name) => name !== "subagent_spawn")
        .map((name) => ({
          name,
          sourceInfo: { path: openPiSource, source: "inline" },
        })),
    ],
    setActiveTools(names: string[]) {
      active = [...names];
    },
  };

  // reconcile does not remove an active namesake owned by a foreign source
  patchOwnedTools(pi, "subagents", {
    enable: OPENPI_TOOL_SURFACE.subagents.resident,
  });
  assert.ok(active.includes("subagent_spawn"));
  assert.ok(active.includes("subagent_wait"));
  assert.equal(active.filter((name) => name === "subagent_spawn").length, 1);
});

test("owner patch is a no-op when the desired surface is already active", () => {
  const h = harness(["read", ...OPENPI_TOOL_SURFACE.subagents.resident]);
  assert.equal(
    patchOwnedTools(h.pi, "subagents", {
      enable: OPENPI_TOOL_SURFACE.subagents.resident,
    }),
    false,
  );
  assert.deepEqual(h.writes, []);
});

test("catalog defines resident and boundary names exactly once", () => {
  assert.equal(
    OPENPI_TOOL_SURFACE_NAMES.length,
    new Set(OPENPI_TOOL_SURFACE_NAMES).size,
  );
  assert.deepEqual(OPENPI_TOOL_SURFACE.subagents.resident, [
    "subagent_spawn",
    "subagent_wait",
    "subagent_cancel",
    "subagent_send",
    "subagent_check",
  ]);
  assert.deepEqual(OPENPI_TOOL_SURFACE.subagents.boundary, []);
  // Retired tools are absent from the managed surface.
  const managed = new Set<string>(OPENPI_TOOL_SURFACE_NAMES);
  for (const retired of RETIRED_OPENPI_TOOL_NAMES) {
    assert.equal(managed.has(retired), false, retired);
  }
});

test("visibility catalog and child-session policy classify the same package tools", () => {
  assert.deepEqual(
    [...OPENPI_TOOL_SURFACE_NAMES].sort(),
    [...CHILD_SAFE_PACKAGE_TOOL_NAMES, ...CHILD_EXCLUDED_TOOL_NAMES].sort(),
  );
});
