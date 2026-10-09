import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  ),
);
test("Pi endpoints augment frozen rows and retain separate host smokes", () => {
  const runtime = workflow.jobs["test-node"];
  assert.deepEqual(
    runtime.strategy.matrix.include.map((row: Record<string, string>) => [
      String(row["node-version"]),
      row["pi-host"],
    ]),
    [
      ["22.19.0", "locked"],
      ["24", "locked"],
      ["26", "locked"],
      ["22.19.0", "minimum"],
      ["22.19.0", "latest"],
    ],
  );
  const steps = runtime.steps as { name?: string; run?: string; if?: string }[];
  const selector = steps.find(
    (step) => step.run === "node scripts/select-pi-ci-host.mjs",
  );
  assert.equal(selector?.if, "matrix.pi-host != 'locked'");
  const web =
    steps.find((step) => step.name?.includes("managed Web CLI"))?.run ?? "";
  assert.match(web, /OPENPI_PI_CODING_AGENT_ENTRY="\$PWD\/node_modules/u);
  assert.match(
    web,
    /test ! -e "\$root\/app\/node_modules\/@earendil-works\/pi-coding-agent"/u,
  );
  assert.equal(
    steps.filter((step) => step.name?.startsWith("Smoke-test")).length,
    4,
  );
});
test("aggregate rejects a failed, cancelled, or skipped endpoint matrix", {
  skip: process.platform === "win32" ? "aggregate runs on Linux Bash" : false,
}, () => {
  const gate = workflow.jobs.test;
  assert.equal(gate.if, "always()");
  assert.ok(gate.needs.includes("test-node"));
  const command = gate.steps[0].run;
  for (const result of ["success", "failure", "cancelled", "skipped"]) {
    const probe = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-c", command],
      {
        env: {
          ...process.env,
          NODE_RESULT: result,
          UI_RESULT: "success",
          WINDOWS_RESULT: "success",
          E2E_RESULT: "success",
        },
      },
    );
    assert.equal(probe.status === 0, result === "success", result);
  }
});
