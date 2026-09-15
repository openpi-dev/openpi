import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const script = resolve("scripts/check-docs-contract.mjs");
const metadata = `decision-status: accepted
created: 2026-09-12
last-reviewed: 2026-09-12
applies-to: fixture
owner: maintainer
related-issues:
  - "#1"
related-prs: "#2"
supersedes: none`;

function check(contents: string, filename = "record.md") {
  const root = mkdtempSync(join(tmpdir(), "openpi-docs-contract-"));
  try {
    const file = join(root, "docs", "decisions", filename);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
    return spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("Decision discovery accepts YAML lists and CRLF on every platform", () => {
  const result = check(
    `---\n${metadata}\n---\n# Fixture\n`.replaceAll("\n", "\r\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 decision records/);
});

test("empty, null, comment-only, and duplicate metadata are rejected", () => {
  for (const owner of ['""', "null", "# comment", "[]"]) {
    const result = check(
      `---\n${metadata.replace("owner: maintainer", `owner: ${owner}`)}\n---\n`,
    );
    assert.equal(result.status, 1, owner);
  }
  assert.equal(check(`---\n${metadata}\nowner: duplicate\n---\n`).status, 1);
});

test("nested README records cannot evade the Decision contract", () => {
  assert.equal(check("# missing metadata", "topic/README.md").status, 1);
  assert.equal(check("# index", "README.md").status, 0);
});
