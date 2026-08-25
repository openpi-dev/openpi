import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { discoverTestFiles } from "./discover-tests.mjs";

const files = discoverTestFiles(resolve("tests"));
const nodeTests = files.filter((file) => file.endsWith(".test.ts"));
const vitestTests = files.filter((file) => file.endsWith(".spec.ts"));

if (nodeTests.length === 0 || vitestTests.length === 0) {
  throw new Error(
    `Test discovery found ${nodeTests.length} Node tests and ${vitestTests.length} Vitest tests; both suites must be non-empty.`,
  );
}

const nodeResult = spawnSync(
  process.execPath,
  ["--test", "--experimental-strip-types", ...nodeTests],
  { stdio: "inherit" },
);
if (nodeResult.status !== 0) {
  process.exit(nodeResult.status ?? 1);
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
