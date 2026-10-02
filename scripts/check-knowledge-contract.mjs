import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECORD_METADATA = [
  "status",
  "created",
  "last-verified",
  "applies-to",
  "related-issues",
  "related-prs",
  "supersedes",
];
const BENCHMARK_METADATA = [
  "source-revision",
  "model",
  "thinking-level",
  "task-set",
  "verifier",
  "sample-size",
  "isolation",
  "usage-accounting",
  "failure-classification",
  "limitations",
  "evidence-reference",
  "rerun-entry-point",
];
const RESEARCH_SECTIONS = [
  "verified facts",
  "inferences",
  "recommendations",
  "unknowns",
];
const RECORD_STATUSES = new Set(["draft", "validated", "superseded"]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LEGACY_RECORDS = new Set([
  "docs/research/CLAUDE_CODE_WORKFLOW_FANOUT_POLICY_2026-08-23.md",
  "docs/research/CLAUDE_CODE_WORKFLOW_RUNTIME_CONTRACT_2026-08-23.md",
  "docs/research/CACHE_USAGE_CONTRACT_2026-09-11.md",
  "docs/research/CAPABILITY_GATEWAY_BOUNDARY_2026-08-30.md",
  "docs/research/OPENPI_HARNESS_STRENGTH_PROTOCOL_2026-08-30.md",
  "docs/research/OPENPI_ZERO_RESIDENT_SURFACE_DIAGNOSTIC_2026-08-30.md",
  "docs/benchmarks/OPENPI_PI_OMP_54_CELL_DIAGNOSTIC.md",
  "docs/benchmarks/receipts/openpi-issue-46-arm64-54-cell-v1.md",
]);
const MARKDOWN_LINK_PATTERN =
  /!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

function markdownFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

export function parseRecordFrontmatter(source) {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  if (end < 0) return undefined;
  const metadata = new Map();
  for (const line of lines.slice(1, end)) {
    const match = /^([a-z][a-z0-9-]*):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    metadata.set(match[1], match[2].replace(/^(?:"(.*)"|'(.*)')$/, "$1$2"));
  }
  return metadata;
}

function isTemplateOrIndex(directory, path) {
  return path === resolve(directory, "README.md") || path === resolve(directory, "TEMPLATE.md");
}

function markdownLinkTargets(source) {
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, "");
  const prose = withoutComments
    .split(/\r?\n/)
    .reduce(
      (state, line) => {
        if (/^\s*(```|~~~)/.test(line)) return { ...state, fenced: !state.fenced };
        if (!state.fenced) state.lines.push(line.replace(/`[^`]*`/g, ""));
        return state;
      },
      { fenced: false, lines: [] },
    )
    .lines.join("\n");
  return [...prose.matchAll(MARKDOWN_LINK_PATTERN)].map((match) => match[1]);
}

function isRepositoryReference(root, path, value) {
  if (/^(?:[a-z]+:|#|\/)/i.test(value)) return false;
  const decoded = decodeURIComponent(value.split(/[?#]/, 1)[0]);
  const resolved = resolve(dirname(path), decoded);
  return (
    (resolved === root || resolved.startsWith(`${root}${sep}`)) &&
    existsSync(resolved)
  );
}

function isExternalOrArchiveIdentity(value) {
  if (value.startsWith("archive:")) return value.slice("archive:".length).trim().length > 0;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function validateBenchmarkEvidence({ root, path, metadata, record, problems }) {
  const evidence = metadata.get("evidence-reference")?.trim() ?? "";
  if (
    evidence &&
    !isRepositoryReference(root, path, evidence) &&
    !isExternalOrArchiveIdentity(evidence)
  ) {
    problems.push(`${record}: invalid evidence-reference ${evidence}`);
  }

  const rerun = metadata.get("rerun-entry-point")?.trim() ?? "";
  if (
    rerun &&
    !isRepositoryReference(root, path, rerun) &&
    !/^(?:bun|node|npm|pnpm|yarn)\s+\S/u.test(rerun) &&
    !isExternalOrArchiveIdentity(rerun)
  ) {
    problems.push(`${record}: invalid rerun-entry-point ${rerun}`);
  }
}

function relativeRecordPath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function validateMetadata({ category, metadata, record, problems }) {
  for (const key of RECORD_METADATA) {
    if (!metadata.get(key)?.trim()) problems.push(`${record}: missing ${key}`);
  }
  const status = metadata.get("status");
  if (status && !RECORD_STATUSES.has(status)) {
    problems.push(`${record}: unsupported status ${status}`);
  }
  for (const key of ["created", "last-verified"]) {
    const value = metadata.get(key);
    if (value && !DATE_PATTERN.test(value)) {
      problems.push(`${record}: ${key} must use YYYY-MM-DD`);
    }
  }
  if (category === "benchmarks") {
    for (const key of BENCHMARK_METADATA) {
      if (!metadata.get(key)?.trim())
        problems.push(`${record}: missing ${key}`);
    }
  }
}

function validateResearchSections({ source, record, problems }) {
  const headings = new Set(
    source
      .split(/\r?\n/)
      .map((line) => /^##\s+(.+?)\s*$/.exec(line)?.[1].toLowerCase())
      .filter(Boolean),
  );
  for (const section of RESEARCH_SECTIONS) {
    if (!headings.has(section))
      problems.push(`${record}: missing section ${section}`);
  }
}

function validateLinks({ root, path, source, problems }) {
  for (const target of markdownLinkTargets(source)) {
    if (/^(?:[a-z]+:|#|\/)/i.test(target)) continue;
    if (!isRepositoryReference(root, path, target)) {
      problems.push(
        `${relativeRecordPath(root, path)}: broken repository link ${target}`,
      );
    }
  }
}

export function checkKnowledgeContract(root = REPOSITORY_ROOT) {
  const canonicalRoot = realpathSync(root);
  const problems = [];
  const records = [];

  for (const category of ["research", "benchmarks"]) {
    const directory = resolve(canonicalRoot, "docs", category);
    const indexPath = resolve(directory, "README.md");
    const indexSource = existsSync(indexPath)
      ? readFileSync(indexPath, "utf8")
      : "";
    if (!indexSource)
      problems.push(`docs/${category}/README.md: missing category index`);

    for (const path of markdownFiles(directory)) {
      if (isTemplateOrIndex(directory, path)) continue;
      const source = readFileSync(path, "utf8");
      const record = relativeRecordPath(canonicalRoot, path);
      // Decision 0001 is forward-only, but legacy is an immutable allowlist,
      // not an opt-out available to newly added files.
      if (LEGACY_RECORDS.has(record)) continue;
      const metadata = parseRecordFrontmatter(source);
      if (!metadata) {
        problems.push(`${record}: missing frontmatter`);
        continue;
      }
      records.push(record);
      validateMetadata({ category, metadata, record, problems });
      if (category === "research") {
        validateResearchSections({ source, record, problems });
      }

      if (category === "benchmarks") {
        validateBenchmarkEvidence({
          root: canonicalRoot,
          path,
          metadata,
          record,
          problems,
        });
      }

      const indexTarget = relative(directory, path).split(sep).join("/");
      if (!markdownLinkTargets(indexSource).includes(indexTarget)) {
        problems.push(
          `${record}: not reachable from docs/${category}/README.md`,
        );
      }
      validateLinks({ root: canonicalRoot, path, source, problems });
    }

    if (indexSource) {
      validateLinks({
        root: canonicalRoot,
        path: indexPath,
        source: indexSource,
        problems,
      });
    }
  }

  return { records: records.sort(), problems };
}

export function assertKnowledgeContract(root = REPOSITORY_ROOT) {
  const result = checkKnowledgeContract(root);
  if (result.problems.length > 0) {
    throw new Error(
      [
        "Knowledge contract check failed:",
        ...result.problems.map((problem) => `- ${problem}`),
      ].join("\n"),
    );
  }
  return result;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const result = assertKnowledgeContract();
  process.stdout.write(
    `✓ knowledge contract (${result.records.length} governed records)\n`,
  );
}
