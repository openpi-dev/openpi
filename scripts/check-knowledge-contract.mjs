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

function isTemplateOrIndex(path) {
  return ["README.md", "TEMPLATE.md"].includes(path.split(sep).at(-1));
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
  for (const match of source.matchAll(MARKDOWN_LINK_PATTERN)) {
    const target = match[1];
    if (/^(?:[a-z]+:|#|\/)/i.test(target)) continue;
    const decoded = decodeURIComponent(target.split(/[?#]/, 1)[0]);
    const resolved = resolve(dirname(path), decoded);
    const withinRoot =
      resolved === root || resolved.startsWith(`${root}${sep}`);
    if (!withinRoot || !existsSync(resolved)) {
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
      if (isTemplateOrIndex(path)) continue;
      const source = readFileSync(path, "utf8");
      const metadata = parseRecordFrontmatter(source);
      // Decision 0001 is forward-only. A record without frontmatter is legacy
      // until a scoped review explicitly migrates it into this contract.
      if (!metadata) continue;

      const record = relativeRecordPath(canonicalRoot, path);
      records.push(record);
      validateMetadata({ category, metadata, record, problems });
      if (category === "research") {
        validateResearchSections({ source, record, problems });
      }

      const indexTarget = relative(directory, path).split(sep).join("/");
      if (!indexSource.includes(`](${indexTarget})`)) {
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
