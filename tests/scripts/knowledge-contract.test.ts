import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
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

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openpi-knowledge-contract-"));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ scripts: { fixture: "node rerun.mjs" } }),
  );
  writeFileSync(join(root, "rerun.mjs"), "// fixture rerun entry\n");
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

test("rejects unresolved benchmark metadata and nested index bypasses", () => {
  const root = fixture();
  const run = join(root, "docs", "benchmarks", "runs", "run.md");
  writeFileSync(
    run,
    readFileSync(run, "utf8")
      .replace(
        "evidence-reference: ../evidence.txt",
        "evidence-reference: missing-evidence.json",
      )
      .replace(
        "rerun-entry-point: bun run fixture",
        "rerun-entry-point: missing-command",
      ),
  );
  const nested = join(root, "docs", "research", "topic");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "README.md"), "# Ungoverned record\n");
  writeFileSync(
    join(root, "docs", "research", "README.md"),
    "<!-- [record](record.md) -->\n",
  );

  const result = checkKnowledgeContract(root);
  assert(
    result.problems.includes(
      "docs/benchmarks/runs/run.md: invalid evidence-reference missing-evidence.json",
    ),
  );
  assert(
    result.problems.includes(
      "docs/benchmarks/runs/run.md: invalid rerun-entry-point missing-command",
    ),
  );
  assert(
    result.problems.includes(
      "docs/research/topic/README.md: missing frontmatter",
    ),
  );
  assert(
    result.problems.includes(
      "docs/research/record.md: not reachable from docs/research/README.md",
    ),
  );
});

test("standard YAML rejects null comment values, duplicates and invalid documents", () => {
  for (const replacement of [
    "related-issues: #1",
    "related-issues: null",
    "related-issues: []",
  ]) {
    const root = fixture();
    const path = join(root, "docs/research/record.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace('related-issues: "#1"', replacement),
    );
    assert.ok(
      checkKnowledgeContract(root).problems.some((problem: string) =>
        problem.includes("missing related-issues"),
      ),
      replacement,
    );
  }
  for (const header of [
    "status: draft\nstatus: validated",
    "status: [unfinished",
    "- list",
  ]) {
    assert.equal(parseRecordFrontmatter(`---\n${header}\n---\n`), undefined);
  }
  assert.deepEqual(
    parseRecordFrontmatter('---\nrelated-issues: ["#1", "#2"]\n---\n')?.get(
      "related-issues",
    ),
    ["#1", "#2"],
  );
  const root = fixture();
  const path = join(root, "docs/research/record.md");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      "status: draft",
      "status: draft\nstatus: validated",
    ),
  );
  assert.ok(
    checkKnowledgeContract(root).problems.some((problem: string) =>
      problem.includes("missing frontmatter"),
    ),
  );
});

test("frozen legacy path stays legacy after an ordinary correction, new sibling cannot opt out", () => {
  const root = fixture();
  const old = join(root, "docs/research/CHILD_RENDER_PARITY_2026-10-05.md");
  writeFileSync(old, "# Legacy correction\n");
  assert.equal(assertKnowledgeContract(root).records.length, 2);
  writeFileSync(old, "# Legacy typo corrected\n");
  assert.equal(assertKnowledgeContract(root).records.length, 2);
  writeFileSync(
    join(root, "docs/research/NEW_CHILD_RENDER_PARITY.md"),
    "# New\n",
  );
  assert.ok(
    checkKnowledgeContract(root).problems.includes(
      "docs/research/NEW_CHILD_RENDER_PARITY.md: missing frontmatter",
    ),
  );
});

test("only category-root templates are exempt and code/comment links cannot provide reachability", () => {
  const root = fixture();
  mkdirSync(join(root, "docs/research/nested"));
  writeFileSync(
    join(root, "docs/research/nested/TEMPLATE.md"),
    "# Not exempt\n",
  );
  writeFileSync(
    join(root, "docs/research/README.md"),
    "<!-- [record](record.md) -->\n```md\n[record](record.md)\n```\n`[record](record.md)`\n",
  );
  const result = checkKnowledgeContract(root);
  assert.ok(
    result.problems.includes(
      "docs/research/nested/TEMPLATE.md: missing frontmatter",
    ),
  );
  assert.ok(
    result.problems.includes(
      "docs/research/record.md: not reachable from docs/research/README.md",
    ),
  );
});

test("benchmark rerun commands must resolve an actual package script and local entry", () => {
  for (const body of [undefined, "node missing.mjs", "bun run fixture"]) {
    const root = fixture();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: body ? { fixture: body } : {} }),
    );
    assert.ok(
      checkKnowledgeContract(root).problems.includes(
        "docs/benchmarks/runs/run.md: invalid rerun-entry-point bun run fixture",
      ),
    );
  }
});

test("malformed URI escapes and linked external evidence fail without throwing", (t) => {
  const root = fixture();
  const record = join(root, "docs/research/record.md");
  writeFileSync(
    record,
    readFileSync(record, "utf8") + "\n[Malformed](%ZZ.md)\n",
  );
  assert.ok(
    checkKnowledgeContract(root).problems.some((problem: string) =>
      problem.includes("broken repository link %ZZ.md"),
    ),
  );
  if (process.platform === "win32") {
    t.diagnostic(
      "Symlink creation requires platform privilege; URI denial above remains checked",
    );
    return;
  }
  const outside = fixture();
  symlinkSync(
    join(outside, "rerun.mjs"),
    join(root, "docs/benchmarks/escape.txt"),
  );
  const run = join(root, "docs/benchmarks/runs/run.md");
  writeFileSync(
    run,
    readFileSync(run, "utf8").replace("../evidence.txt", "../escape.txt"),
  );
  const result = checkKnowledgeContract(root);
  assert.ok(
    result.problems.some((problem: string) =>
      problem.includes("invalid evidence-reference ../escape.txt"),
    ),
  );
  assert.ok(
    result.problems.some((problem: string) =>
      problem.includes("symbolic link in governed category"),
    ),
  );
});

test("external and archive evidence identities pass syntax checks without claiming retrievability", () => {
  for (const reference of [
    "https://example.com/receipts/run",
    "archive:fixture-v1/receipt.json",
  ]) {
    const root = fixture();
    const run = join(root, "docs/benchmarks/runs/run.md");
    writeFileSync(
      run,
      readFileSync(run, "utf8").replace(
        "evidence-reference: ../evidence.txt",
        `evidence-reference: ${reference}`,
      ),
    );
    assert.equal(assertKnowledgeContract(root).records.length, 2);
  }
});

test("research headings inside comments or fenced code do not satisfy distinctions", () => {
  const root = fixture();
  const path = join(root, "docs/research/record.md");
  writeFileSync(
    path,
    `${commonMetadata}---\n<!--\n## Verified facts\n## Inferences\n-->\n\n~~~md\n## Recommendations\n## Unknowns\n~~~\n`,
  );
  assert.equal(
    checkKnowledgeContract(root).problems.filter((problem: string) =>
      problem.includes("missing section"),
    ).length,
    4,
  );
});

test("excessive YAML alias expansion fails closed", () => {
  const source =
    "---\na: &a [a, a, a]\nb: &b [*a, *a, *a]\nc: &c [*b, *b, *b]\nd: &d [*c, *c, *c]\ne: [*d, *d, *d]\n---\n";
  assert.equal(parseRecordFrontmatter(source), undefined);
});

test("index links normalize relative spelling and local absolute body paths fail", () => {
  const root = fixture();
  writeFileSync(
    join(root, "docs/research/README.md"),
    "[record](./record.md#facts)\n",
  );
  assert.equal(assertKnowledgeContract(root).records.length, 2);
  const path = join(root, "docs/research/record.md");
  writeFileSync(
    path,
    readFileSync(path, "utf8") + "\n[Private](/tmp/private-evidence.md)\n",
  );
  assert.ok(
    checkKnowledgeContract(root).problems.includes(
      "docs/research/record.md: broken repository link /tmp/private-evidence.md",
    ),
  );
});

test("only matching sufficiently long fences expose prose after closure", () => {
  const headings =
    "## Verified facts\n## Inferences\n## Recommendations\n## Unknowns\n";
  for (const [opening, inner, closing] of [
    ["````md", "```", "````"],
    ["~~~~md", "~~~", "~~~~"],
    ["````md", "~~~~", "````"],
    ["~~~~md", "```", "~~~~"],
    ["````md", "```` trailing text", "````"],
  ]) {
    const root = fixture();
    const fenced = `${opening}\n${inner}\n${headings}[record](record.md)\n${closing}\n`;
    writeFileSync(join(root, "docs/research/README.md"), fenced);
    writeFileSync(
      join(root, "docs/research/record.md"),
      `${commonMetadata}---\n${fenced}`,
    );
    const { problems } = checkKnowledgeContract(root);
    assert.ok(
      problems.includes(
        "docs/research/record.md: not reachable from docs/research/README.md",
      ),
      fenced,
    );
    for (const section of [
      "verified facts",
      "inferences",
      "recommendations",
      "unknowns",
    ]) {
      assert.ok(
        problems.includes(
          `docs/research/record.md: missing section ${section}`,
        ),
        fenced,
      );
    }
    // A longer matching closing fence ends the block; subsequent real prose
    // is eligible for both index reachability and required Research headings.
    writeFileSync(
      join(root, "docs/research/README.md"),
      `${opening}\n${inner}\n${closing}${closing[0]}\n[record](record.md)\n`,
    );
    writeFileSync(
      join(root, "docs/research/record.md"),
      `${commonMetadata}---\n${opening}\n${inner}\n${closing}${closing[0]}\n${headings}`,
    );
    assert.deepEqual(checkKnowledgeContract(root).problems, [], fenced);
  }
});

test("explicit historical integration admissions compose with frozen legacy paths, not new siblings", () => {
  const root = fixture();
  const baseline = JSON.parse(
    readFileSync(
      new URL("../../scripts/knowledge-legacy-records.json", import.meta.url),
      "utf8",
    ),
  );
  const historical = JSON.parse(
    readFileSync(
      new URL(
        "../../scripts/knowledge-historical-admissions.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const admitted = historical.admissions.flatMap(
    (entry: { records: string[] }) => entry.records,
  );
  assert.equal(baseline.records.length, 66);
  assert.equal(admitted.length, 14);
  assert.equal(new Set([...baseline.records, ...admitted]).size, 80);
  for (const record of [...baseline.records, ...admitted]) {
    const path = join(root, record);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "# Historical record with an ordinary correction\n");
  }
  assert.equal(assertKnowledgeContract(root).records.length, 2);
  const sibling = "docs/research/PI_BROWSER_TOOLS_NEW.md";
  writeFileSync(join(root, sibling), "# New sibling\n");
  assert.ok(
    checkKnowledgeContract(root).problems.includes(
      `${sibling}: missing frontmatter`,
    ),
  );
});
