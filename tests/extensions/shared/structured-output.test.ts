import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createStructuredOutputTool,
  encodeStructuredResult,
  jsonSchemaToTypebox,
  STRUCTURED_RESULT_LIMITS,
} from "../../../extensions/shared/structured-output.ts";

test("the shared terminating tool captures one complete validated JSON value", async () => {
  const captured: unknown[] = [];
  const tool = createStructuredOutputTool(
    {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
    (result) => captured.push(result),
  );
  const result = await tool.execute(
    "call-1",
    { answer: "ready" },
    undefined,
    undefined,
    {} as ExtensionContext,
  );

  assert.equal(result.terminate, true);
  assert.deepEqual(captured, [{ answer: "ready" }]);
  assert.deepEqual(encodeStructuredResult(captured[0]), {
    value: { answer: "ready" },
    json: '{"answer":"ready"}',
    byteLength: 18,
  });
});

test("schema and result bounds fail closed without producing partial JSON", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => jsonSchemaToTypebox(cyclic), /bounded JSON object/);
  assert.throws(() => encodeStructuredResult(cyclic), /acyclic JSON values/);
  assert.throws(
    () =>
      encodeStructuredResult({
        text: "x".repeat(STRUCTURED_RESULT_LIMITS.resultStringBytes + 1),
      }),
    /oversized string/,
  );
  assert.throws(
    () => encodeStructuredResult({ value: Number.NaN }),
    /only acyclic JSON values/,
  );
  assert.throws(
    () =>
      encodeStructuredResult({
        a: "a".repeat(STRUCTURED_RESULT_LIMITS.resultStringBytes),
        b: "b".repeat(STRUCTURED_RESULT_LIMITS.resultStringBytes),
      }),
    /total byte limit/,
  );
});
