import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { PiWebRuntime } from "../../web/runtime/pi-runtime.ts";
import { projectWebTrustStatus } from "../../web/runtime/trust-status.ts";

test("unbound or incomplete Trust facts fail closed to unknown", () => {
  assert.deepEqual(projectWebTrustStatus({}), {
    source: "pi-project-trust",
    state: "unknown",
    decision: "unknown",
    projectResources: "unknown",
    sessionTrusted: "unknown",
    refreshRequired: "unknown",
  });
  assert.deepEqual(projectWebTrustStatus({ workspace: "/workspace" }), {
    source: "pi-project-trust",
    workspace: "/workspace",
    state: "unknown",
    decision: "unknown",
    projectResources: "unknown",
    sessionTrusted: "unknown",
    refreshRequired: "unknown",
  });
});

test("projects trusted, denied, and restricted Pi Trust states", () => {
  assert.deepEqual(
    projectWebTrustStatus({
      workspace: "/trusted",
      storedDecision: true,
      projectResources: true,
      sessionTrusted: true,
    }),
    {
      source: "pi-project-trust",
      workspace: "/trusted",
      state: "trusted",
      decision: "trusted",
      projectResources: true,
      sessionTrusted: true,
      refreshRequired: false,
    },
  );
  assert.equal(
    projectWebTrustStatus({
      workspace: "/denied",
      storedDecision: false,
      projectResources: true,
      sessionTrusted: false,
    }).state,
    "untrusted",
  );
  assert.equal(
    projectWebTrustStatus({
      workspace: "/undecided",
      storedDecision: null,
      projectResources: true,
      sessionTrusted: false,
    }).state,
    "restricted",
  );
  assert.equal(
    projectWebTrustStatus({
      workspace: "/no-project-resources",
      storedDecision: null,
      projectResources: false,
      sessionTrusted: true,
    }).state,
    "trusted",
  );
});

test("TrustStore changes do not pretend to mutate active Session authority", () => {
  const newlyTrusted = projectWebTrustStatus({
    workspace: "/workspace",
    storedDecision: true,
    projectResources: true,
    sessionTrusted: false,
  });
  assert.equal(newlyTrusted.state, "restricted");
  assert.equal(newlyTrusted.decision, "trusted");
  assert.equal(newlyTrusted.refreshRequired, true);

  const newlyDenied = projectWebTrustStatus({
    workspace: "/workspace",
    storedDecision: false,
    projectResources: true,
    sessionTrusted: true,
  });
  assert.equal(newlyDenied.state, "trusted");
  assert.equal(newlyDenied.decision, "denied");
  assert.equal(newlyDenied.refreshRequired, true);
});


test("PiWebRuntime reads the real ProjectTrustStore decision", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "openpi-trust-runtime-"));
  const agentDir = await mkdtemp(join(tmpdir(), "openpi-agent-dir-"));
  await mkdir(join(workspace, ".pi"));
  await writeFile(join(workspace, ".pi", "settings.json"), "{}\n");
  new ProjectTrustStore(agentDir).set(workspace, true);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const runtime = Object.create(PiWebRuntime.prototype) as {
      hasSelectedWorkspace: boolean;
      runtime: { cwd: string; session: { settingsManager: { isProjectTrusted(): boolean } } };
      getProjectTrustStatus: PiWebRuntime["getProjectTrustStatus"];
    };
    runtime.hasSelectedWorkspace = true;
    runtime.runtime = { cwd: workspace, session: { settingsManager: { isProjectTrusted: () => true } } };
    assert.deepEqual(runtime.getProjectTrustStatus(), {
      source: "pi-project-trust", workspace, state: "trusted", decision: "trusted",
      projectResources: true, sessionTrusted: true, refreshRequired: false,
    });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
