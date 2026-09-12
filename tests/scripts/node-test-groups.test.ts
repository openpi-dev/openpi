import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { partitionNodeTestsByPlatform } from "../../scripts/node-test-groups.mjs";

const backgroundTest = resolve(
  "tests",
  "extensions",
  "background-terminals",
  "manager.test.ts",
);
const backgroundUnitTest = resolve(
  "tests",
  "extensions",
  "background-terminals",
  "output.test.ts",
);
const unrelatedTest = resolve("tests", "test-discovery.test.ts");

test("Windows isolates background-terminal tests from other Node files", () => {
  assert.deepEqual(
    partitionNodeTestsByPlatform(
      [backgroundTest, unrelatedTest, backgroundUnitTest],
      "win32",
    ),
    {
      parallel: [unrelatedTest],
      serial: [backgroundTest, backgroundUnitTest],
    },
  );
});

test("non-Windows keeps all Node files in the parallel group", () => {
  assert.deepEqual(
    partitionNodeTestsByPlatform(
      [backgroundTest, unrelatedTest, backgroundUnitTest],
      "linux",
    ),
    {
      parallel: [backgroundTest, unrelatedTest, backgroundUnitTest],
      serial: [],
    },
  );
});
