import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  partitionNodeTestsByPlatform,
  selectNodeTestShard,
} from "../../scripts/node-test-groups.mjs";
import { discoverTestFiles } from "../../scripts/discover-tests.mjs";

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

test("CI's Windows shards are disjoint and cover all discovered Node files", () => {
  const files = discoverTestFiles().filter((file) => file.endsWith(".test.ts"));
  const { parallel, serial } = partitionNodeTestsByPlatform(files, "win32");
  const groups = [
    selectNodeTestShard(parallel, "1/2"),
    selectNodeTestShard(parallel, "2/2"),
    serial,
  ];
  assert.ok(groups.every((group) => group.length > 0));
  const selected = groups.flat();
  assert.equal(new Set(selected).size, selected.length);
  assert.deepEqual([...selected].sort(), [...files].sort());
});
