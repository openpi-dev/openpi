import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  partitionNodeTestsByPlatform,
  selectNodeTestShard,
} from "../../scripts/node-test-groups.mjs";
import { discoverTestFiles } from "../../scripts/discover-tests.mjs";

const setupIntegrationTest = resolve(
  "tests/extensions/setup/integration.test.ts",
);
const setupUnitTest = resolve("tests/extensions/setup/index.test.ts");
const postEditLifecycleTest = resolve(
  "tests/extensions/post-edit/lifecycle.test.ts",
);
const postEditUnitTest = resolve("tests/extensions/post-edit/index.test.ts");
const workflowExecutionTest = resolve(
  "tests/extensions/workflows/execute.e2e.test.ts",
);
const workflowUnitTest = resolve("tests/extensions/workflows/model.test.ts");
const gitInfoProcessTest = resolve("tests/extensions/git-info/process.test.ts");
const gitInfoUnitTest = resolve(
  "tests/extensions/git-info/refresh-coordinator.test.ts",
);
const unrelatedTest = resolve("tests", "test-discovery.test.ts");

test("Windows isolates real Pi lifecycles but keeps their unit tests parallel", () => {
  assert.deepEqual(
    partitionNodeTestsByPlatform(
      [
        setupUnitTest,
        setupIntegrationTest,
        postEditUnitTest,
        postEditLifecycleTest,
        unrelatedTest,
      ],
      "win32",
    ),
    {
      parallel: [setupUnitTest, postEditUnitTest, unrelatedTest],
      serial: [setupIntegrationTest, postEditLifecycleTest],
    },
  );
});

test("non-Windows keeps all Node files in the parallel group", () => {
  assert.deepEqual(
    partitionNodeTestsByPlatform(
      [
        unrelatedTest,
        setupIntegrationTest,
        workflowExecutionTest,
        gitInfoProcessTest,
        postEditLifecycleTest,
      ],
      "linux",
    ),
    {
      parallel: [
        unrelatedTest,
        setupIntegrationTest,
        workflowExecutionTest,
        gitInfoProcessTest,
        postEditLifecycleTest,
      ],
      serial: [],
    },
  );
});

test("Windows isolates sandbox execution but keeps workflow unit tests parallel", () => {
  assert.deepEqual(
    partitionNodeTestsByPlatform(
      [workflowUnitTest, workflowExecutionTest, unrelatedTest],
      "win32",
    ),
    {
      parallel: [workflowUnitTest, unrelatedTest],
      serial: [workflowExecutionTest],
    },
  );
});

test("Windows isolates short-watchdog commands but keeps git-info unit tests parallel", () => {
  assert.deepEqual(
    partitionNodeTestsByPlatform(
      [gitInfoUnitTest, gitInfoProcessTest, unrelatedTest],
      "win32",
    ),
    {
      parallel: [gitInfoUnitTest, unrelatedTest],
      serial: [gitInfoProcessTest],
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
