export const ACCEPTANCE_STATUSES = ["accepted", "rejected"] as const;
export type AcceptanceStatus = (typeof ACCEPTANCE_STATUSES)[number];

export interface AcceptanceCriterion {
  readonly id: string;
  readonly description: string;
  readonly requiredEvidence?: readonly string[];
}

export interface AcceptanceContract {
  readonly criteria: readonly AcceptanceCriterion[];
}

export interface AcceptanceCriterionResult {
  readonly id: string;
  readonly status: AcceptanceStatus;
  readonly evidence: readonly string[];
  readonly note?: string;
}

export interface AcceptanceLedger {
  readonly status: "accepted" | "rejected" | "missing" | "malformed";
  readonly criteria: readonly AcceptanceCriterionResult[];
  readonly errors: readonly string[];
  /** Child-authored judgment retained only for migration; never a runtime fact. */
  readonly authority?: "model-self-attestation";
  readonly deprecated?: {
    readonly since: "0.5";
    readonly removal: "1.0";
  };
}

export const ACCEPTANCE_DEPRECATION_WARNING =
  "acceptance is deprecated since OpenPI 0.5 and will be removed in 1.0; it is model self-attestation, not runtime-verified evidence, and does not determine ok";

function ledger(
  value: Omit<AcceptanceLedger, "authority" | "deprecated">,
): AcceptanceLedger {
  return {
    ...value,
    authority: "model-self-attestation",
    deprecated: { since: "0.5", removal: "1.0" },
  };
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_CRITERIA = 32;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseAcceptanceContract(
  value: unknown,
): AcceptanceContract | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || !Array.isArray(value.criteria)) {
    throw new Error("acceptance must be { criteria: [...] }");
  }
  if (value.criteria.length === 0 || value.criteria.length > MAX_CRITERIA) {
    throw new Error(`acceptance.criteria must contain 1-${MAX_CRITERIA} items`);
  }
  const seen = new Set<string>();
  const criteria = value.criteria.map((raw, index): AcceptanceCriterion => {
    if (!record(raw))
      throw new Error(`acceptance criterion ${index + 1} must be an object`);
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const description =
      typeof raw.description === "string" ? raw.description.trim() : "";
    if (!ID_PATTERN.test(id))
      throw new Error(`acceptance criterion ${index + 1} has an invalid id`);
    if (seen.has(id))
      throw new Error(`acceptance criterion id "${id}" is duplicated`);
    seen.add(id);
    if (!description || description.length > 500)
      throw new Error(
        `acceptance criterion "${id}" needs a 1-500 character description`,
      );
    let requiredEvidence: string[] | undefined;
    if (raw.requiredEvidence !== undefined) {
      if (
        !Array.isArray(raw.requiredEvidence) ||
        raw.requiredEvidence.length > 16
      ) {
        throw new Error(
          `acceptance criterion "${id}" requiredEvidence must be an array of at most 16 labels`,
        );
      }
      requiredEvidence = raw.requiredEvidence.map((entry) => {
        if (typeof entry !== "string" || !entry.trim() || entry.length > 120) {
          throw new Error(
            `acceptance criterion "${id}" has an invalid evidence label`,
          );
        }
        return entry.trim();
      });
    }
    return {
      id,
      description,
      ...(requiredEvidence?.length ? { requiredEvidence } : {}),
    };
  });
  return { criteria };
}

export function acceptanceSchema(
  schema: unknown,
  contract: AcceptanceContract,
) {
  const ledger = {
    type: "object",
    additionalProperties: false,
    properties: {
      criteria: {
        type: "array",
        minItems: contract.criteria.length,
        maxItems: contract.criteria.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            status: { type: "string", enum: [...ACCEPTANCE_STATUSES] },
            evidence: {
              type: "array",
              items: { type: "string" },
              maxItems: 64,
            },
            note: { type: "string", maxLength: 1000 },
          },
          required: ["id", "status", "evidence"],
        },
      },
    },
    required: ["criteria"],
  };
  if (schema === undefined) {
    return {
      type: "object",
      properties: { acceptance: ledger },
      required: ["acceptance"],
    };
  }
  if (!record(schema) || schema.type !== "object") {
    throw new Error("acceptance can only compose with an object JSON Schema");
  }
  const properties =
    schema.properties === undefined
      ? {}
      : record(schema.properties)
        ? schema.properties
        : undefined;
  if (!properties) {
    throw new Error("acceptance schema properties must be an object");
  }
  if (Object.hasOwn(properties, "acceptance")) {
    throw new Error(
      'the caller schema already defines reserved property "acceptance"',
    );
  }
  const required =
    schema.required === undefined
      ? []
      : Array.isArray(schema.required) &&
          schema.required.every((entry) => typeof entry === "string")
        ? schema.required
        : undefined;
  if (!required)
    throw new Error("acceptance schema required must be a string array");
  return {
    ...schema,
    properties: { ...properties, acceptance: ledger },
    required: [...new Set([...required, "acceptance"])],
  };
}

export function isAcceptanceLedger(value: unknown): value is AcceptanceLedger {
  if (
    !record(value) ||
    !Array.isArray(value.criteria) ||
    !Array.isArray(value.errors)
  ) {
    return false;
  }
  return (
    (value.status === "accepted" ||
      value.status === "rejected" ||
      value.status === "missing" ||
      value.status === "malformed") &&
    (value.authority === undefined ||
      value.authority === "model-self-attestation") &&
    (value.deprecated === undefined ||
      (record(value.deprecated) &&
        value.deprecated.since === "0.5" &&
        value.deprecated.removal === "1.0")) &&
    value.errors.every((error) => typeof error === "string") &&
    value.criteria.every(
      (criterion) =>
        record(criterion) &&
        typeof criterion.id === "string" &&
        (criterion.status === "accepted" || criterion.status === "rejected") &&
        Array.isArray(criterion.evidence) &&
        criterion.evidence.every((entry) => typeof entry === "string"),
    )
  );
}

export function acceptanceInstruction(contract: AcceptanceContract) {
  const criteria = contract.criteria.map(
    (criterion) =>
      `- ${criterion.id}: ${criterion.description}${criterion.requiredEvidence?.length ? `; required evidence labels: ${criterion.requiredEvidence.join(", ")}` : ""}`,
  );
  return [
    "Deprecated compatibility protocol: this acceptance ledger is your own model self-attestation, not runtime-verified evidence, and it does not determine execution success.",
    "Include an `acceptance.criteria` array in structured_output with exactly these ids. Mark rejected when the criterion is not demonstrated. Evidence entries must be concise labels or concrete references; do not invent evidence.",
    ...criteria,
  ].join("\n");
}

export function evaluateAcceptance(
  contract: AcceptanceContract,
  structured: unknown,
): AcceptanceLedger {
  if (!record(structured) || !record(structured.acceptance)) {
    return ledger({
      status: "missing",
      criteria: [],
      errors: ["structured result omitted acceptance"],
    });
  }
  const rawCriteria = structured.acceptance.criteria;
  if (!Array.isArray(rawCriteria)) {
    return ledger({
      status: "malformed",
      criteria: [],
      errors: ["acceptance.criteria is not an array"],
    });
  }
  const errors: string[] = [];
  const byId = new Map<string, AcceptanceCriterionResult>();
  for (const raw of rawCriteria) {
    if (!record(raw) || typeof raw.id !== "string") {
      errors.push("acceptance contains a criterion without an id");
      continue;
    }
    if (byId.has(raw.id)) {
      errors.push(`acceptance criterion "${raw.id}" is duplicated`);
      continue;
    }
    const status = raw.status;
    const evidence = Array.isArray(raw.evidence)
      ? raw.evidence
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
    if (status !== "accepted" && status !== "rejected") {
      errors.push(`acceptance criterion "${raw.id}" has an invalid status`);
      continue;
    }
    byId.set(raw.id, {
      id: raw.id,
      status,
      evidence,
      ...(typeof raw.note === "string" && raw.note.trim()
        ? { note: raw.note.trim().slice(0, 1000) }
        : {}),
    });
  }
  const results: AcceptanceCriterionResult[] = [];
  for (const criterion of contract.criteria) {
    const result = byId.get(criterion.id);
    if (!result) {
      errors.push(`acceptance criterion "${criterion.id}" is missing`);
      continue;
    }
    const missingEvidence = (criterion.requiredEvidence ?? []).filter(
      (required) => !result.evidence.includes(required),
    );
    if (missingEvidence.length) {
      errors.push(
        `acceptance criterion "${criterion.id}" lacks evidence: ${missingEvidence.join(", ")}`,
      );
    }
    results.push(result);
  }
  for (const id of byId.keys()) {
    if (!contract.criteria.some((criterion) => criterion.id === id)) {
      errors.push(`unexpected acceptance criterion "${id}"`);
    }
  }
  if (errors.length)
    return ledger({ status: "malformed", criteria: results, errors });
  return ledger({
    status: results.every((result) => result.status === "accepted")
      ? "accepted"
      : "rejected",
    criteria: results,
    errors: [],
  });
}

export function applyAcceptance(options: {
  contract?: AcceptanceContract;
  structured: unknown;
  agentOk: boolean;
  agentError?: string;
}) {
  const ledger = options.contract
    ? evaluateAcceptance(options.contract, options.structured)
    : undefined;
  const ok = options.agentOk;
  const error = ok ? undefined : (options.agentError ?? "Agent failed");
  return {
    ok,
    ...(ledger
      ? { ledger, acceptanceWarning: ACCEPTANCE_DEPRECATION_WARNING }
      : {}),
    ...(error ? { error } : {}),
  };
}
