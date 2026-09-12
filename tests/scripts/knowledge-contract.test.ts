import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error The checker is a JavaScript module without declarations.
import * as knowledgeContract from "../../scripts/check-knowledge-contract.mjs";

const {
  assertKnowledgeContract,
  checkKnowledgeContract,
  parseRecordFrontmatter,
} = knowledgeContract;

const commonMetadata = `---
status: draft
created: 2026-09-04
last-verified: 2026-09-04
applies-to: fixture
related-issues: "#1"
related-prs: none
supersedes: none
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openpi-knowledge-contract-"));
  mkdirSync(join(root, "docs", "research"), { recursive: true });
  mkdirSync(join(root, "docs", "benchmarks", "runs"), { recursive: true });
  writeFileSync(
    join(root, "docs", "research", "README.md"),
    "[record](record.md)\n",
  );
  writeFileSync(
    join(root, "docs", "research", "record.md"),
    `${commonMetadata}---

# Research

## Verified facts

Fact.

## Inferences

Inference.

## Recommendations

Recommendation.

## Unknowns

Unknown.
`,
  );
  writeFileSync(
    join(root, "docs", "benchmarks", "README.md"),
    "[run](runs/run.md)\n",
  );
  writeFileSync(
    join(root, "docs", "benchmarks", "runs", "run.md"),
    `${commonMetadata}source-revision: abc123
model: fixture/model
thinking-level: high
task-set: fixture-v1
verifier: fixture-v1
sample-size: 1
isolation: temporary workspace
usage-accounting: provider receipt
failure-classification: none
limitations: synthetic fixture
evidence-reference: ../evidence.txt
rerun-entry-point: bun run fixture
---

# Benchmark

[Evidence](../evidence.txt)
`,
  );
  writeFileSync(join(root, "docs", "benchmarks", "evidence.txt"), "receipt\n");
  return root;
}

test("parses flat governed-record frontmatter", () => {
  const metadata = parseRecordFrontmatter(`${commonMetadata}---\n`);
  assert.equal(metadata?.get("status"), "draft");
  assert.equal(metadata?.get("related-issues"), "#1");
});

test("accepts reachable research and benchmark records", () => {
  const result = assertKnowledgeContract(fixture());
  assert.equal(result.records.length, 2);
});

test("ignores legacy records without frontmatter", () => {
  const root = fixture();
  writeFileSync(
    join(
      root,
      "docs",
      "research",
      "CLAUDE_CODE_WORKFLOW_FANOUT_POLICY_2026-08-23.md",
    ),
    "# Legacy\n",
  );
  assert.equal(assertKnowledgeContract(root).records.length, 2);
});

test("rejects a new frontmatter-less record outside the legacy allowlist", () => {
  const root = fixture();
  writeFileSync(join(root, "docs", "research", "new-record.md"), "# New\n");
  const result = checkKnowledgeContract(root);
  assert(
    result.problems.includes(
      "docs/research/new-record.md: missing frontmatter",
    ),
  );
});

test("reports missing benchmark evidence fields without validating claims", () => {
  const root = fixture();
  const path = join(root, "docs", "benchmarks", "runs", "run.md");
  writeFileSync(path, `${commonMetadata}---\n\n# Benchmark\n`);
  const result = checkKnowledgeContract(root);
  assert(
    result.problems.includes("docs/benchmarks/runs/run.md: missing model"),
  );
  assert(
    result.problems.includes(
      "docs/benchmarks/runs/run.md: missing failure-classification",
    ),
  );
});

test("reports unindexed records and broken repository links", () => {
  const root = fixture();
  writeFileSync(join(root, "docs", "research", "README.md"), "# Research\n");
  const record = join(root, "docs", "research", "record.md");
  writeFileSync(
    record,
    `${readFileSync(record, "utf8")}\n[Missing](missing.md)\n`,
  );
  const result = checkKnowledgeContract(root);
  assert(
    result.problems.includes(
      "docs/research/record.md: not reachable from docs/research/README.md",
    ),
  );
  assert(
    result.problems.includes(
      "docs/research/record.md: broken repository link missing.md",
    ),
  );
});
