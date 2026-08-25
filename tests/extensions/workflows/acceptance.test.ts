import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptanceSchema,
  applyAcceptance,
  evaluateAcceptance,
  parseAcceptanceContract,
} from "../../../extensions/workflows/acceptance.ts";

const contract = parseAcceptanceContract({
  criteria: [
    {
      id: "tests",
      description: "Focused tests pass",
      requiredEvidence: ["command"],
    },
    { id: "scope", description: "Only requested files changed" },
  ],
})!;

test("explicit acceptance accepts only complete evidence", () => {
  assert.deepEqual(
    evaluateAcceptance(contract, {
      acceptance: {
        criteria: [
          { id: "tests", status: "accepted", evidence: ["command"] },
          { id: "scope", status: "accepted", evidence: ["diff"] },
        ],
      },
    }).status,
    "accepted",
  );
});

test("rejected, missing, malformed, and missing evidence remain distinct", () => {
  assert.equal(
    evaluateAcceptance(contract, {
      acceptance: {
        criteria: [
          { id: "tests", status: "rejected", evidence: ["command"] },
          { id: "scope", status: "accepted", evidence: [] },
        ],
      },
    }).status,
    "rejected",
  );
  assert.equal(evaluateAcceptance(contract, {}).status, "missing");
  assert.equal(
    evaluateAcceptance(contract, {
      acceptance: {
        criteria: [
          { id: "tests", status: "accepted", evidence: [] },
          { id: "unexpected", status: "accepted", evidence: [] },
        ],
      },
    }).status,
    "malformed",
  );
});

test("acceptance controls ok without hiding an underlying agent error", () => {
  const accepted = applyAcceptance({
    contract,
    agentOk: true,
    structured: {
      acceptance: {
        criteria: [
          { id: "tests", status: "accepted", evidence: ["command"] },
          { id: "scope", status: "accepted", evidence: [] },
        ],
      },
    },
  });
  assert.equal(accepted.ok, true);

  const failed = applyAcceptance({
    contract,
    agentOk: false,
    agentError: "provider failed",
    structured: undefined,
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? "", /provider failed; Acceptance missing/);
});

test("contract validation rejects duplicate or unsafe identifiers", () => {
  assert.throws(
    () =>
      parseAcceptanceContract({
        criteria: [
          { id: "same", description: "a" },
          { id: "same", description: "b" },
        ],
      }),
    /duplicated/,
  );
  assert.throws(
    () =>
      parseAcceptanceContract({
        criteria: [{ id: "../escape", description: "bad" }],
      }),
    /invalid id/,
  );
});

test("acceptance composes with an existing structured schema", () => {
  const schema = acceptanceSchema(
    {
      type: "object",
      additionalProperties: false,
      properties: { answer: { type: "string" } },
      required: ["answer"],
    },
    contract,
  ) as { properties: Record<string, unknown>; required: string[] };
  assert.ok(schema.properties.acceptance);
  assert.deepEqual(schema.required, ["answer", "acceptance"]);
  assert.equal(
    (acceptanceSchema(undefined, contract) as { type?: string }).type,
    "object",
  );
  assert.throws(
    () => acceptanceSchema({ type: "string" }, contract),
    /object JSON Schema/,
  );
  assert.throws(
    () =>
      acceptanceSchema(
        {
          type: "object",
          properties: { acceptance: { type: "string" } },
        },
        contract,
      ),
    /reserved property/,
  );
});
