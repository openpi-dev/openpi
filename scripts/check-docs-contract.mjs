import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve("docs");
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
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  return new Map(
    match[1]
      .split("\n")
      .map((line) => line.match(/^([\w-]+):\s*(.*)$/))
      .filter(Boolean)
      .map(([, key, value]) => [key, value.trim()]),
  );
}

const files = markdownFiles(root);
const decisions = files.filter(
  (file) =>
    file.includes(`${join("docs", "decisions")}${"/"}`) &&
    !["README.md", "TEMPLATE.md"].includes(file.split("/").pop()),
);
const errors = [];

for (const file of decisions) {
  const metadata = frontmatter(readFileSync(file, "utf8"));
  if (!metadata) {
    errors.push(`${relative(process.cwd(), file)}: missing YAML frontmatter`);
    continue;
  }
  for (const field of requiredDecisionFields) {
    if (!metadata.get(field)) errors.push(`${relative(process.cwd(), file)}: missing ${field}`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`docs contract (${decisions.length} decision records)`);
