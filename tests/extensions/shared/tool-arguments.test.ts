import assert from "node:assert/strict";
import test from "node:test";
import { projectToolArguments } from "../../../extensions/shared/tool-arguments.ts";

test("argument previews retain original evidence after large fields within UTF-8 budgets", () => {
  const projected = projectToolArguments({
    padding: "界".repeat(20_000),
    path: "src/known.ts",
    offset: 8,
    limit: 12,
  });
  assert.equal(projected.argsTruncated, true);
  assert.deepEqual(projected.evidenceArguments, {
    path: "src/known.ts",
    offset: 8,
    limit: 12,
  });
  assert.ok(Buffer.byteLength(projected.argsPreview!) <= 4096);
  assert.ok(!projected.argsPreview?.includes("\ufffd"));
  const huge = projectToolArguments({
    command: "界".repeat(10_000),
    path: "known.ts",
    query: "x".repeat(10_000),
  });
  assert.equal(huge.argsTruncated, true);
  assert.ok(
    Object.values(huge.evidenceArguments!).reduce<number>(
      (bytes, value) =>
        bytes + (typeof value === "string" ? Buffer.byteLength(value) : 0),
      0,
    ) <= 4096,
  );
});

test("generic tool targets remain usable while absent arguments are never fabricated", () => {
  const args = {
    target: "main",
    pattern: "needle",
    query: "topic",
    url: "https://example.com",
    runId: "wf_123",
  };
  const projected = projectToolArguments(args);
  assert.deepEqual(projected.evidenceArguments, args);
  assert.equal(projected.argsTruncated, false);
  const generic = projectToolArguments({ expression: "2 + 2" });
  assert.equal(generic.evidenceArguments, undefined);
  assert.deepEqual(JSON.parse(generic.argsPreview!), { expression: "2 + 2" });
  const absent = projectToolArguments(undefined);
  assert.equal(absent.argsPreview, undefined);
  assert.equal(absent.evidenceArguments, undefined);
  assert.equal(absent.argsTruncated, true);
});
