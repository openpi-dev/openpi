import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import { parseDocument } from "yaml";

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
// Frozen path identities only. Content changes do not automatically migrate legacy
// records; explicit scoped review removes a path from this list when migrating it.
const legacyBaseline = JSON.parse(
  readFileSync(
    new URL("./knowledge-legacy-records.json", import.meta.url),
    "utf8",
  ),
);
const historicalAdmissions = JSON.parse(
  readFileSync(
    new URL("./knowledge-historical-admissions.json", import.meta.url),
    "utf8",
  ),
);
const LEGACY_RECORDS = new Set([
  ...legacyBaseline.records,
  ...historicalAdmissions.admissions.flatMap((admission) => admission.records),
]);

function markdownFiles(directory, problems) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    // Do not follow directory links (cycles and out-of-checkout records) or
    // let a linked Markdown file bypass record admission.
    if (entry.isSymbolicLink()) {
      problems.push(`${path}: symbolic link in governed category`);
      return [];
    }
    if (entry.isDirectory()) return markdownFiles(path, problems);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

export function parseRecordFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;
  try {
    const document = parseDocument(match[1], { uniqueKeys: true });
    if (document.errors.length) return undefined;
    const value = document.toJS({ maxAliasCount: 20 });
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    return new Map(Object.entries(value));
  } catch {
    return undefined;
  }
}

function isTemplateOrIndex(directory, path) {
  return (
    path === resolve(directory, "README.md") ||
    path === resolve(directory, "TEMPLATE.md")
  );
}

// Read evidence from actual Markdown nodes. Code and raw HTML are opaque;
// list nesting and reference/inline links keep the parser's normal semantics.
function markdownEvidence(source) {
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  const nodes = [];
  const opaque = new Set(["code", "inlineCode", "html"]);
  function visit(node) {
    if (opaque.has(node.type)) return;
    nodes.push(node);
    for (const child of node.children ?? []) visit(child);
  }
  function text(node) {
    if (opaque.has(node.type)) return "";
    if (node.type === "text") return node.value;
    return (node.children ?? []).map(text).join("");
  }
  visit(fromMarkdown(body));
  const definitions = new Map();
  for (const node of nodes) {
    // CommonMark resolves duplicate reference definitions to the first one.
    if (node.type === "definition" && !definitions.has(node.identifier))
      definitions.set(node.identifier, node.url);
  }
  function targets(node) {
    if (node.type === "link" || node.type === "image") return [node.url];
    if (node.type === "linkReference" || node.type === "imageReference") {
      const target = definitions.get(node.identifier);
      return target ? [target] : [];
    }
    return [];
  }
  return {
    headings: nodes
      .filter((node) => node.type === "heading" && node.depth === 2)
      .map((node) => text(node).trim().toLowerCase()),
    // Images need valid local targets, but only real links provide navigation.
    links: nodes.flatMap(targets),
    navigationLinks: nodes
      .filter((node) => node.type === "link" || node.type === "linkReference")
      .flatMap(targets),
  };
}

function markdownLinkTargets(source) {
  return markdownEvidence(source).links;
}

function isRepositoryReference(root, path, value) {
  if (typeof value !== "string" || /^(?:[a-z]+:|#|\/)/i.test(value))
    return false;
  try {
    const decoded = decodeURIComponent(value.split(/[?#]/, 1)[0]);
    const target = resolve(dirname(path), decoded);
    if (!(target === root || target.startsWith(`${root}${sep}`))) return false;
    const canonical = realpathSync(target);
    return canonical === root || canonical.startsWith(`${root}${sep}`);
  } catch {
    return false;
  }
}

function isExternalOrArchiveIdentity(value) {
  if (typeof value !== "string") return false;
  if (value.startsWith("archive:")) return /^archive:\S+$/u.test(value);
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      Boolean(url.hostname)
    );
  } catch {
    return false;
  }
}

function textValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function recordValue(value) {
  return (
    textValue(value) ||
    (Array.isArray(value) && value.length > 0 && value.every(textValue))
  );
}

// A command label alone is not rerun reachability. Only literal local script
// paths or existing package-script mappings to those entries are admitted.
function isRerunCommand(root, command, visiting = new Set()) {
  if (!textValue(command)) return false;
  const direct = /^(?:node|bun) (?!run(?: |$))(\S+)(?: .*)?$/u.exec(command);
  if (direct && !/[;&|`$<>]/u.test(command)) {
    return (
      isRepositoryReference(root, resolve(root, "package.json"), direct[1]) &&
      statSync(resolve(root, direct[1])).isFile()
    );
  }
  const script = /^(?:bun|npm|pnpm|yarn) run ([\w:.-]+)$/u.exec(command);
  if (!script || visiting.has(script[1])) return false;
  try {
    const body = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))
      .scripts?.[script[1]];
    visiting.add(script[1]);
    return textValue(body) && isRerunCommand(root, body, visiting);
  } catch {
    return false;
  }
}

function validateBenchmarkEvidence({ root, path, metadata, record, problems }) {
  const evidence = metadata.get("evidence-reference");
  if (
    textValue(evidence) &&
    !isRepositoryReference(root, path, evidence) &&
    !isExternalOrArchiveIdentity(evidence)
  ) {
    problems.push(`${record}: invalid evidence-reference ${evidence}`);
  }
  const rerun = metadata.get("rerun-entry-point");
  if (
    textValue(rerun) &&
    !isRepositoryReference(root, path, rerun) &&
    !isRerunCommand(root, rerun) &&
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
    if (!recordValue(metadata.get(key)))
      problems.push(`${record}: missing ${key}`);
  }
  const status = metadata.get("status");
  if (status && !RECORD_STATUSES.has(status)) {
    problems.push(`${record}: unsupported status ${status}`);
  }
  for (const key of ["created", "last-verified"]) {
    const value = metadata.get(key);
    if (
      value !== undefined &&
      (!textValue(value) || !DATE_PATTERN.test(value))
    ) {
      problems.push(`${record}: ${key} must use YYYY-MM-DD`);
    }
  }
  if (category === "benchmarks") {
    for (const key of BENCHMARK_METADATA) {
      if (
        !(
          key === "sample-size" &&
          Number.isInteger(metadata.get(key)) &&
          metadata.get(key) > 0
        ) &&
        !textValue(metadata.get(key))
      )
        problems.push(`${record}: missing ${key}`);
    }
  }
}

function validateResearchSections({ source, record, problems }) {
  const headings = new Set(markdownEvidence(source).headings);
  for (const section of RESEARCH_SECTIONS) {
    if (!headings.has(section))
      problems.push(`${record}: missing section ${section}`);
  }
}

function validateLinks({ root, path, source, problems }) {
  for (const target of markdownLinkTargets(source)) {
    if (/^(?:https?:|mailto:|archive:|#)/i.test(target)) continue;
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
    if (
      existsSync(directory) &&
      !realpathSync(directory).startsWith(`${canonicalRoot}${sep}`)
    ) {
      problems.push(`docs/${category}: category escapes repository`);
      continue;
    }
    const indexPath = resolve(directory, "README.md");
    const indexSource = isRepositoryReference(
      canonicalRoot,
      resolve(directory, "record.md"),
      "README.md",
    )
      ? readFileSync(indexPath, "utf8")
      : "";
    if (!indexSource)
      problems.push(`docs/${category}/README.md: missing category index`);

    for (const path of markdownFiles(directory, problems)) {
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

      if (
        !markdownEvidence(indexSource).navigationLinks.some((target) => {
          if (!isRepositoryReference(canonicalRoot, indexPath, target))
            return false;
          return (
            resolve(
              directory,
              decodeURIComponent(target.split(/[?#]/, 1)[0]),
            ) === path
          );
        })
      ) {
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
