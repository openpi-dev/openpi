import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openpi-test-runner-"));
  for (const directory of [
    "scripts",
    "tests/extensions/background-terminals",
    "node_modules/vitest",
  ]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  for (const script of [
    "run-tests.mjs",
    "discover-tests.mjs",
    "node-test-groups.mjs",
  ]) {
    copyFileSync(resolve("scripts", script), join(root, "scripts", script));
  }
  writeFileSync(
    join(root, "tests", "sample.test.ts"),
    `
    import assert from "node:assert/strict";
    import test from "node:test";
    test("node suite marker", () => assert.notEqual(process.env.FAIL_SUITE, "node"));
  `,
  );
  writeFileSync(
    join(root, "tests", "second.test.ts"),
    `import test from "node:test"; test("second node marker", () => {});`,
  );
  writeFileSync(
    join(root, "tests/extensions/background-terminals", "process.test.ts"),
    `
    import assert from "node:assert/strict";
    import test from "node:test";
    test("isolated process marker", () => assert.notEqual(process.env.FAIL_SUITE, "serial"));
    `,
  );
  writeFileSync(
    join(root, "tests", "sample.spec.ts"),
    "// UI discovery fixture\n",
  );
  // A tiny CLI stand-in isolates runner selection/exit behavior from Vitest itself.
  writeFileSync(
    join(root, "node_modules/vitest/vitest.mjs"),
    `
    import assert from "node:assert/strict";
    assert.equal(process.argv[2], "run");
    assert.ok(process.argv[3].endsWith("sample.spec.ts"));
    console.log("ui suite marker");
    process.exit(process.env.FAIL_SUITE === "ui" ? 7 : 0);
  `,
  );
  return {
    root,
    run(args: string[] = [], failSuite = "") {
      const env: NodeJS.ProcessEnv = { ...process.env, FAIL_SUITE: failSuite };
      // Start a fresh test runner rather than inheriting this test worker context.
      delete env.NODE_TEST_CONTEXT;
      return spawnSync(process.execPath, ["scripts/run-tests.mjs", ...args], {
        cwd: root,
        env,
        encoding: "utf8",
      });
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("split suite commands together cover the unchanged default command", () => {
  const runner = fixture();
  try {
    for (const [args, nodeExpected, uiExpected] of [
      [[], true, true],
      [["all"], true, true],
      [["node"], true, false],
      [["ui"], false, true],
    ] as const) {
      const result = runner.run([...args]);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stdout.includes("node suite marker"), nodeExpected);
      assert.equal(result.stdout.includes("ui suite marker"), uiExpected);
    }
  } finally {
    runner.dispose();
  }
});

test("test failures propagate and default execution stops after Node failure", () => {
  const runner = fixture();
  try {
    const node = runner.run(["node"], "node");
    assert.notEqual(node.status, 0);
    assert.equal(node.stdout.includes("ui suite marker"), false);
    assert.equal(runner.run(["ui"], "ui").status, 7);
    const combined = runner.run([], "node");
    assert.notEqual(combined.status, 0);
    assert.equal(combined.stdout.includes("ui suite marker"), false);
    assert.equal(runner.run([], "ui").status, 7);
  } finally {
    runner.dispose();
  }
});

test("isolated shards cover every Node file exactly once and propagate failures", () => {
  const runner = fixture();
  try {
    const outputs = [
      runner.run(["node-parallel", "--shard=1/2"]),
      runner.run(["node-parallel", "--shard=2/2"]),
      runner.run(["node-serial"]),
    ];
    for (const result of outputs) {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stdout.includes("ui suite marker"), false);
    }
    for (const marker of [
      "node suite marker",
      "second node marker",
      "isolated process marker",
    ]) {
      assert.equal(
        outputs.filter((result) => result.stdout.includes(marker)).length,
        1,
      );
    }
    assert.equal(outputs[2].stdout.includes("isolated process marker"), true);
    assert.notEqual(
      runner.run(["node-parallel", "--shard=1/2"], "node").status,
      0,
    );
    assert.notEqual(runner.run(["node-serial"], "serial").status, 0);
    assert.notEqual(runner.run([], "serial").status, 0);
  } finally {
    runner.dispose();
  }
});

test("invalid and empty shards fail before executing any tests", () => {
  const runner = fixture();
  try {
    for (const shard of [
      "0/2",
      "3/2",
      "1/0",
      "1/3",
      "1/2junk",
      "1/9007199254740992",
    ]) {
      const result = runner.run(["node-parallel", `--shard=${shard}`]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Invalid Node test shard/);
      assert.equal(result.stdout.includes("marker"), false);
    }
    for (const args of [
      ["node-serial", "--shard=1/2"],
      ["node-parallel", "extra"],
      ["node-parallel", "--shard=1/2", "extra"],
    ]) {
      assert.match(runner.run(args).stderr, /Usage:/);
    }
    rmSync(join(runner.root, "tests/extensions/background-terminals"), {
      recursive: true,
    });
    const result = runner.run(["node-parallel"]);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Both isolated Node test groups must be non-empty/,
    );
    assert.equal(result.stdout.includes("marker"), false);
  } finally {
    runner.dispose();
  }
});

test("invalid selection and empty discovery fail before running a partial suite", () => {
  const runner = fixture();
  try {
    for (const args of [["unknown"], ["node", "extra"]]) {
      const result = runner.run(args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Usage:/);
      assert.equal(result.stdout.includes("suite marker"), false);
    }
    rmSync(join(runner.root, "tests", "sample.spec.ts"));
    const empty = runner.run(["node"]);
    assert.notEqual(empty.status, 0);
    assert.match(empty.stderr, /both suites must be non-empty/);
    assert.equal(empty.stdout.includes("suite marker"), false);
  } finally {
    runner.dispose();
  }
});
