import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { availableParallelism } from "node:os";
import { discoverTestFiles } from "./discover-tests.mjs";
import {
  partitionNodeTestsByPlatform,
  selectNodeTestShard,
} from "./node-test-groups.mjs";

const suite = process.argv[2] ?? "all";
const shardArgument = process.argv[3];
if (
  process.argv.length > 4 ||
  !["all", "node", "ui", "node-parallel", "node-serial"].includes(suite) ||
  (shardArgument !== undefined &&
    (suite !== "node-parallel" || !shardArgument.startsWith("--shard=")))
) {
  throw new Error(
    "Usage: node scripts/run-tests.mjs [all|node|ui|node-parallel [--shard=index/total]|node-serial]",
  );
}

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

if (suite !== "ui") {
  // Explicit groups use the Windows isolation boundary on every platform so
  // their coverage can also be verified locally. Each CI group owns a VM.
  const grouped = suite === "node-parallel" || suite === "node-serial";
  const nodeTestGroups = partitionNodeTestsByPlatform(
    nodeTests,
    grouped ? "win32" : process.platform,
  );
  if (
    grouped &&
    (!nodeTestGroups.parallel.length || !nodeTestGroups.serial.length)
  ) {
    throw new Error("Both isolated Node test groups must be non-empty.");
  }
  if (suite === "node-serial") nodeTestGroups.parallel = [];
  if (suite === "node-parallel") {
    nodeTestGroups.serial = [];
    if (shardArgument !== undefined) {
      nodeTestGroups.parallel = selectNodeTestShard(
        nodeTestGroups.parallel,
        shardArgument.slice("--shard=".length),
      );
    }
  }
  // A file can itself launch several real Pi/Git/sandbox processes. Bound
  // file-level overlap so cold loaders do not fight every other fixture on
  // machines with many cores; smaller CI hosts keep Node's default budget.
  const concurrency = Math.max(1, Math.min(4, availableParallelism() - 1));
  const parallelNodeResult = runNodeTests(nodeTestGroups.parallel, [
    `--test-concurrency=${concurrency}`,
  ]);
  if (parallelNodeResult !== 0) {
    process.exit(parallelNodeResult);
  }

  // Windows process-tree and real-host subprocess tests must not overlap
  // unrelated Node test files.
  // The rest of the suite retains bounded file-level concurrency.
  const serialNodeResult = runNodeTests(nodeTestGroups.serial, [
    "--test-concurrency=1",
  ]);
  if (serialNodeResult !== 0) {
    process.exit(serialNodeResult);
  }
}

if (suite.startsWith("node")) process.exit(0);

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
