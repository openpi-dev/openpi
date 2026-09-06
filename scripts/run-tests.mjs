import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { discoverTestFiles } from "./discover-tests.mjs";
import { partitionNodeTestsByPlatform } from "./node-test-groups.mjs";

const files = discoverTestFiles(resolve("tests"));
const nodeTests = files.filter((file) => file.endsWith(".test.ts"));
const vitestTests = files.filter((file) => file.endsWith(".spec.ts"));

if (nodeTests.length === 0 || vitestTests.length === 0) {
  throw new Error(
    `Test discovery found ${nodeTests.length} Node tests and ${vitestTests.length} Vitest tests; both suites must be non-empty.`,
  );
}

function runNodeTests(files, options = []) {
  if (files.length === 0) return 0;
  const result = spawnSync(
    process.execPath,
    ["--test", "--experimental-strip-types", ...options, ...files],
    { stdio: "inherit" },
  );
  return result.status ?? 1;
}

const nodeTestGroups = partitionNodeTestsByPlatform(nodeTests);
const parallelNodeResult = runNodeTests(nodeTestGroups.parallel);
if (parallelNodeResult !== 0) {
  process.exit(parallelNodeResult);
}

// Windows process-tree tests must not overlap unrelated Node test files.
// Keep the rest of the suite on Node's default file-level concurrency.
const serialNodeResult = runNodeTests(nodeTestGroups.serial, [
  "--test-concurrency=1",
]);
if (serialNodeResult !== 0) {
  process.exit(serialNodeResult);
}

// Invoke the CLI module through Node instead of the package-manager shim.
// Windows installs expose the shim as `vitest.cmd`, which cannot be launched
// reliably by spawnSync without a shell.
const vitestCli = resolve("node_modules/vitest/vitest.mjs");
const vitestResult = spawnSync(
  process.execPath,
  [vitestCli, "run", ...vitestTests],
  {
    stdio: "inherit",
  },
);
process.exit(vitestResult.status ?? 1);
