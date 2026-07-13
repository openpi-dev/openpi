import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { safeStringify, writeFileAtomic } from "./serialization.ts";

test("safeStringify handles cycles, bigint, depth, and size", () => {
  const value: Record<string, unknown> = {
    bigint: 42n,
    nested: { deeper: { deepest: true } },
    large: "x".repeat(20_000),
  };
  value.self = value;

  const text = safeStringify(value, {
    maxBytes: 2_048,
    maxDepth: 2,
    maxStringBytes: 512,
  });
  assert.ok(Buffer.byteLength(text, "utf8") <= 2_048);
  const parsed: unknown = JSON.parse(text);
  assert.ok(parsed && typeof parsed === "object");
  assert.match(text, /42n/);
  assert.match(text, /circular/);
  assert.match(text, /truncated/);
});

test("atomic writes leave complete readable content", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-workflow-test-"));
  try {
    const file = join(directory, "artifact.json");
    writeFileAtomic(file, '{"value":1}');
    writeFileAtomic(file, '{"value":2}');
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { value: 2 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
