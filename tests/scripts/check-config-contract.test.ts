import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

test("configuration contract checker catches fixture drift", () => {
  const script = resolve("scripts/check-config-contract.mjs");
  const result = spawnSync(process.execPath, [script, "--self-test"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "fixture test failed");
  }
});
