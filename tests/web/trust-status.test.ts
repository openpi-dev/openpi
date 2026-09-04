import assert from "node:assert/strict";
import test from "node:test";
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
