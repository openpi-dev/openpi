import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDiffArgs,
  buildLogArgs,
  buildShowArgs,
  GIT_LOG_DEFAULT_LIMIT,
  InvalidDiffCombinationError,
  InvalidPathError,
  InvalidRevisionError,
} from "../../../extensions/git-read/src/args.ts";

test("buildShowArgs validates revisions and paths", () => {
  assert.deepEqual(buildShowArgs({ revision: "HEAD" }), [
    "show",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--format=fuller",
    "HEAD",
  ]);
  assert.deepEqual(buildShowArgs({ revision: "  abc123  " }), [
    "show",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--format=fuller",
    "abc123",
  ]);
  assert.deepEqual(buildShowArgs({ revision: "HEAD~2", path: "src/a.ts" }), [
    "show",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--format=fuller",
    "HEAD~2",
    "--",
    "src/a.ts",
  ]);
  // Revision validation: reject anything that could smuggle flags or ranges.
  assert.throws(
    () => buildShowArgs({ revision: "--exec=evil" }),
    InvalidRevisionError,
  );
  assert.throws(
    () => buildShowArgs({ revision: "HEAD;rm -rf" }),
    InvalidRevisionError,
  );
  assert.throws(() => buildShowArgs({ revision: "" }), InvalidRevisionError);
  assert.throws(
    () => buildShowArgs({ revision: "a".repeat(201) }),
    InvalidRevisionError,
  );
  // Path validation: no traversal, no absolute, no leading dash.
  assert.throws(
    () => buildShowArgs({ revision: "HEAD", path: "../outside" }),
    InvalidPathError,
  );
  assert.throws(
    () => buildShowArgs({ revision: "HEAD", path: "/etc/passwd" }),
    InvalidPathError,
  );
  assert.throws(
    () => buildShowArgs({ revision: "HEAD", path: "a b" }),
    InvalidPathError,
  );
  // Valid revision shapes that must pass.
  assert.doesNotThrow(() => buildShowArgs({ revision: "HEAD^^^^2" }));
  assert.doesNotThrow(() => buildShowArgs({ revision: "feature/branch-name" }));
  assert.doesNotThrow(() => buildShowArgs({ revision: "v1.0.0" }));
});

test("buildDiffArgs composes only read-only diff forms", () => {
  assert.deepEqual(buildDiffArgs({}), [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
  ]);
  assert.deepEqual(buildDiffArgs({ staged: true }), [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--cached",
  ]);
  assert.deepEqual(buildDiffArgs({ from: "main", to: "feat" }), [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "main...feat",
  ]);
  assert.deepEqual(buildDiffArgs({ from: "HEAD", stat: true, path: "src" }), [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--stat",
    "HEAD",
    "--",
    "src",
  ]);
  assert.throws(
    () => buildDiffArgs({ from: "--output=x" }),
    InvalidRevisionError,
  );
  assert.throws(() => buildDiffArgs({ to: "evil;cmd" }), InvalidRevisionError);
  assert.throws(
    () => buildDiffArgs({ to: "HEAD~1" }),
    InvalidDiffCombinationError,
  );
  assert.throws(
    () => buildDiffArgs({ staged: true, from: "HEAD" }),
    InvalidDiffCombinationError,
  );
  assert.throws(() => buildDiffArgs({ path: ".." }), InvalidPathError);
});

test("buildLogArgs clamps the limit and validates inputs", () => {
  assert.deepEqual(buildLogArgs({}), [
    "log",
    "--no-color",
    "--no-ext-diff",
    "--oneline",
    "-n",
    String(GIT_LOG_DEFAULT_LIMIT),
  ]);
  assert.deepEqual(buildLogArgs({ limit: 10_000, revision: "main" }), [
    "log",
    "--no-color",
    "--no-ext-diff",
    "--oneline",
    "-n",
    "1000",
    "main",
  ]);
  assert.deepEqual(
    buildLogArgs({ limit: 0, file: "src/a.ts", oneline: false }),
    ["log", "--no-color", "--no-ext-diff", "-n", "1", "--", "src/a.ts"],
  );
  assert.throws(() => buildLogArgs({ revision: "-n5" }), InvalidRevisionError);
  assert.throws(() => buildLogArgs({ file: "a/../b" }), InvalidPathError);
});
