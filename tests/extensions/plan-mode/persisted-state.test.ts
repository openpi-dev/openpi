import assert from "node:assert/strict";
import test from "node:test";
import {
  decodePlanModeState,
  PLAN_MODE_STATE_ENTRY,
  restorePlanModeState,
} from "../../../extensions/plan-mode/persisted-state.ts";

test("Plan Mode rejects future and malformed sidecar records without opening writes", () => {
  assert.equal(
    decodePlanModeState({ version: 2, status: "ready", plan: "Implement" }),
    undefined,
  );
  assert.equal(
    decodePlanModeState({
      version: 1,
      status: "ready",
      plan: "Implement",
      future: true,
    }),
    undefined,
  );

  const restored = restorePlanModeState([
    {
      type: "custom",
      customType: PLAN_MODE_STATE_ENTRY,
      data: { version: 2, status: "ready", plan: "Implement" },
    },
  ]);

  assert.equal(restored.planning, true);
  assert.match(restored.error ?? "", /malformed/u);
  assert.equal(restored.readyPlan, undefined);
});

test("Plan Mode keeps its exact current sidecar shape available", () => {
  assert.deepEqual(
    decodePlanModeState({ version: 1, status: "ready", plan: "  Implement  " }),
    { planning: true, readyPlan: "Implement" },
  );
});
