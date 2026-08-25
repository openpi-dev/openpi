import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test("recursive discovery includes nested Node and Vitest suites", () => {
  const discovered = JSON.parse(
    execFileSync(process.execPath, ["scripts/discover-tests.mjs"], {
      cwd: resolve("."),
      encoding: "utf8",
    }),
  ) as string[];

  assert.ok(
    discovered.some((file) => file.endsWith("tests/test-discovery.test.ts")),
  );
  assert.ok(discovered.some((file) => file.includes("tests/extensions/")));
  assert.ok(
    discovered.some((file) =>
      file.endsWith("tests/extensions/file-search/index.spec.ts"),
    ),
  );
});
