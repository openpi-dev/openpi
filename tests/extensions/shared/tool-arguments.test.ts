import assert from "node:assert/strict";
import test from "node:test";
import { projectToolArguments } from "../../../extensions/shared/tool-arguments.ts";

test("oversized arguments stop traversal before later values and preserve BOM-prefixed paths", () => {
  const path = "\uFEFFreport.md";
  const small = projectToolArguments({ path });
  assert.deepEqual(small.evidenceArguments, { path });
  assert.equal(small.argsTruncated, false);

  let trailingReads = 0;
  const preview = projectToolArguments({
    payload: "界".repeat(2_000_000),
    get trailing() {
      trailingReads++;
      return "outside the preview";
    },
    path,
  });
  assert.equal(trailingReads, 0);
  assert.equal(preview.argsTruncated, true);
  assert.deepEqual(preview.evidenceArguments, { path });
  assert.ok(Buffer.byteLength(preview.argsPreview!) <= 4096);
});

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
  const widePath = projectToolArguments({
    path: "界".repeat(2_000),
    command: "git status",
  });
  assert.equal(widePath.argsTruncated, true);
  assert.deepEqual(widePath.evidenceArguments, { command: "git status" });
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
