import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import test from "node:test";

test("recursive discovery includes nested Node and Vitest suites", () => {
  const testsRoot = resolve("tests");
  const discovered = JSON.parse(
    execFileSync(process.execPath, ["scripts/discover-tests.mjs"], {
      cwd: resolve("."),
      encoding: "utf8",
    }),
  ) as string[];

  assert.ok(discovered.includes(resolve(testsRoot, "test-discovery.test.ts")));
  assert.ok(
    discovered.some((file) =>
      relative(testsRoot, file).startsWith(`extensions${sep}`),
    ),
  );
  assert.ok(
    discovered.includes(
      resolve(testsRoot, "extensions", "file-search", "index.spec.ts"),
    ),
  );
});

test("test support stays outside the production extension tree", () => {
  assert.equal(existsSync(resolve("tests/support/subagents-stub.ts")), true);
  assert.equal(
    existsSync(resolve("extensions/subagents/test-support/stub.ts")),
    false,
  );
});
