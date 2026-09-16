import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const effectCohort = "4.0.0-beta.103";

test("Effect packages stay on one published prerelease cohort", () => {
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  for (const packageName of [
    "effect",
    "@effect/platform-node",
    "@effect/platform-node-shared",
    "@effect/vitest",
  ]) {
    assert.equal(dependencies[packageName], effectCohort, packageName);
  }
});
