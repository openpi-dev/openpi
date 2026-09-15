import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseDocument } from "yaml";

const root = resolve("docs/decisions");
const requiredDecisionFields = [
  "decision-status",
  "created",
  "last-reviewed",
  "applies-to",
  "owner",
  "related-issues",
  "related-prs",
  "supersedes",
];

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length) return null;
  const value = document.toJS({ maxAliasCount: 20 });
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

const decisions = markdownFiles(root).filter(
  (file) =>
    ![join(root, "README.md"), join(root, "TEMPLATE.md")].includes(file),
);
const errors = [];

for (const file of decisions) {
  let metadata;
  try {
    metadata = frontmatter(readFileSync(file, "utf8"));
  } catch {
    metadata = null;
  }
  if (!metadata) {
    errors.push(`${relative(process.cwd(), file)}: missing YAML frontmatter`);
    continue;
  }
  for (const field of requiredDecisionFields) {
    const value = metadata[field];
    const present =
      typeof value === "string"
        ? value.trim().length > 0
        : Array.isArray(value) &&
          value.length > 0 &&
          value.every(
            (item) => typeof item === "string" && item.trim().length > 0,
          );
    if (!present)
      errors.push(`${relative(process.cwd(), file)}: missing ${field}`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`docs contract (${decisions.length} decision records)`);
