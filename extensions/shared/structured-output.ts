import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";

export const STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION =
  "When your task is complete, call the `structured_output` tool exactly once as your final action, with fields matching the required schema. Do not write any other text after it.";

export const STRUCTURED_OUTPUT_TOOL_DESCRIPTION =
  "Return your final result as structured data matching the required schema. Call this exactly once, as your last action; do not write any other text after it.";

export const STRUCTURED_RESULT_LIMITS = Object.freeze({
  schemaDepth: 24,
  schemaNodes: 10_000,
  resultBytes: 2 * 1024 * 1024,
  resultDepth: 24,
  resultNodes: 100_000,
  resultStringBytes: 1024 * 1024,
});

export interface EncodedStructuredResult {
  readonly value: unknown;
  readonly json: string;
  readonly byteLength: number;
}

function safeRecordKey(key: string) {
  return key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

/** Preserve the caller's full JSON Schema instead of lossy keyword conversion. */
export function jsonSchemaToTypebox(schema: unknown): TSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("structured output schema must be a bounded JSON object");
  }
  const seen = new WeakSet<object>();
  let nodes = 0;
  const validate = (current: unknown, depth: number): boolean => {
    if (
      ++nodes > STRUCTURED_RESULT_LIMITS.schemaNodes ||
      depth > STRUCTURED_RESULT_LIMITS.schemaDepth
    ) {
      return false;
    }
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return true;
    }
    if (typeof current === "number") return Number.isFinite(current);
    if (Array.isArray(current)) {
      return current.every((item) => validate(item, depth + 1));
    }
    if (typeof current !== "object" || seen.has(current)) return false;
    seen.add(current);
    return Object.keys(current).every(
      (key) =>
        safeRecordKey(key) &&
        validate((current as Record<string, unknown>)[key], depth + 1),
    );
  };
  if (!validate(schema, 0)) {
    throw new Error("structured output schema must be a bounded JSON object");
  }
  return Type.Unsafe(schema);
}

/** Encode one complete JSON result or fail before any truncated artifact exists. */
export function encodeStructuredResult(
  value: unknown,
): EncodedStructuredResult {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const validate = (current: unknown, depth: number): void => {
    if (++nodes > STRUCTURED_RESULT_LIMITS.resultNodes) {
      throw new Error("structured result exceeds the node limit");
    }
    if (depth > STRUCTURED_RESULT_LIMITS.resultDepth) {
      throw new Error("structured result exceeds the depth limit");
    }
    if (typeof current === "string") {
      if (
        Buffer.byteLength(current, "utf8") >
        STRUCTURED_RESULT_LIMITS.resultStringBytes
      ) {
        throw new Error("structured result contains an oversized string");
      }
      return;
    }
    if (
      current === null ||
      typeof current === "boolean" ||
      (typeof current === "number" && Number.isFinite(current))
    ) {
      return;
    }
    if (typeof current !== "object" || seen.has(current)) {
      throw new Error(
        "structured result must contain only acyclic JSON values",
      );
    }
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) validate(item, depth + 1);
      return;
    }
    for (const [key, item] of Object.entries(current)) {
      if (!safeRecordKey(key)) {
        throw new Error("structured result contains an unsafe object key");
      }
      validate(item, depth + 1);
    }
  };
  validate(value, 0);
  const json = JSON.stringify(value);
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > STRUCTURED_RESULT_LIMITS.resultBytes) {
    throw new Error("structured result exceeds the total byte limit");
  }
  return { value, json, byteLength };
}

/** One-shot terminating child tool shared by Workflow and Direct Subagent. */
export function createStructuredOutputTool(
  schema: unknown,
  capture: (value: unknown) => void,
): ToolDefinition {
  return defineTool({
    name: "structured_output",
    label: "Structured Output",
    description: STRUCTURED_OUTPUT_TOOL_DESCRIPTION,
    parameters: jsonSchemaToTypebox(schema),
    async execute(_toolCallId, params) {
      capture(params);
      return {
        content: [{ type: "text", text: "Recorded structured result." }],
        details: params,
        terminate: true,
      };
    },
  });
}

export function childToolsWithStructuredOutput(
  tools: readonly string[] | undefined,
  structured: boolean,
) {
  return tools
    ? [...new Set([...tools, ...(structured ? ["structured_output"] : [])])]
    : undefined;
}
