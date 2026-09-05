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

test("deprecated self-attestation never controls runtime ok", () => {
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
  assert.equal(accepted.ledger?.authority, "model-self-attestation");
  assert.deepEqual(accepted.ledger?.deprecated, {
    since: "0.5",
    removal: "1.0",
  });
  assert.match(accepted.acceptanceWarning ?? "", /does not determine ok/);

  const rejected = applyAcceptance({
    contract,
    agentOk: true,
    structured: {
      acceptance: {
        criteria: [
          { id: "tests", status: "rejected", evidence: ["command"] },
          { id: "scope", status: "accepted", evidence: [] },
        ],
      },
    },
  });
  assert.equal(rejected.ok, true);
  assert.equal(rejected.ledger?.status, "rejected");
  assert.equal(rejected.error, undefined);

  const failed = applyAcceptance({
    contract,
    agentOk: false,
    agentError: "provider failed",
    structured: undefined,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, "provider failed");
  assert.equal(failed.ledger?.status, "missing");
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

test("contract validation rejects scalar or invalid requiredEvidence", () => {
  assert.throws(
    () =>
      parseAcceptanceContract({
        criteria: [
          {
            id: "tests",
            description: "Focused tests pass.",
            requiredEvidence: "test-command" as unknown as string[],
          },
        ],
      }),
    /requiredEvidence must be an array/,
  );
  assert.throws(
    () =>
      parseAcceptanceContract({
        criteria: [
          {
            id: "tests",
            description: "Focused tests pass.",
            requiredEvidence: Array.from(
              { length: 17 },
              (_, i) => `label-${i}`,
            ),
          },
        ],
      }),
    /at most 16 labels/,
  );
  assert.throws(
    () =>
      parseAcceptanceContract({
        criteria: [
          {
            id: "tests",
            description: "Focused tests pass.",
            requiredEvidence: ["   "],
          },
        ],
      }),
    /invalid evidence label/,
  );
  assert.throws(
    () =>
      parseAcceptanceContract({
        criteria: [
          {
            id: "tests",
            description: "Focused tests pass.",
            requiredEvidence: ["a".repeat(121)],
          },
        ],
      }),
    /invalid evidence label/,
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
