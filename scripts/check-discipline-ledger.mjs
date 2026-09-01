import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROW_PATTERN =
  /^\|\s*(OP-\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*(yes|no)\s*\|\s*`([^`]+)`\s*\|\s*$/i;

// ponytail: a static baseline catches historical rewrites while allowing new rows to append.
const HISTORICAL_LEDGER = parseLedger(`
| OP-01 | Package configuration has one canonical setup entry point | enforced | yes | \`bun run check\` |
| OP-02 | Persisted config fields are wired to the typed setup writer | enforced | yes | \`bun run check:config-contract\` |
| OP-03 | Persisted config fields appear in the status projection | enforced | yes | \`bun run check:config-contract\` |
| OP-04 | Persisted config fields are documented in README and SETUP | enforced | yes | \`bun run check:config-contract\` |
| OP-05 | Discipline ledger references valid checks wired into CI | enforced | yes | \`bun run check:discipline\` |
| OP-06 | Child tool classification fails closed | enforced | yes | \`bun run test\` |
| OP-07 | Pi host packages remain peer dependencies | enforced | yes | \`bun run test\` |
| OP-08 | Node and Vitest suites remain non-empty | enforced | yes | \`bun run test\` |
| OP-09 | Repository formatting is checked | enforced | yes | \`bun run format:check\` |
| OP-10 | Lint warnings fail the validation round | enforced | yes | \`bun run lint\` |
| OP-11 | TypeScript is checked without emitting files | enforced | yes | \`bun run typecheck\` |
| OP-12 | Runtime provenance is verified before diagnosis | manual | no | \`bun run provenance\` |
`);

export function parseLedger(source) {
  return source
    .split(/\r?\n/)
    .map((line) => ROW_PATTERN.exec(line))
    .filter(Boolean)
    .map((match) => ({
      id: match[1],
      promise: match[2].trim(),
      status: match[3].trim(),
      ci: match[4].toLowerCase(),
      check: match[5].trim(),
    }));
}

function hasShellCommand(source, command) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^\\s*|&&|\\|\\||;|\\||\\()\\s*${escaped}(?=\\s|$)`,
    "i",
  ).test(source);
}

function hasWorkflowCommand(source, command) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^\\s*|\\brun:\\s*)${escaped}(?=\\s|$)`, "i");
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, ""))
    .some((line) => pattern.test(line));
}

function scriptIsWired(name, scripts, workflows, visiting = new Set()) {
  const command = `bun run ${name}`;
  if (hasWorkflowCommand(workflows, command)) return true;
  if (visiting.has(name)) return false;
  visiting.add(name);
  return Object.entries(scripts).some(([candidate, body]) => {
    if (!hasShellCommand(body, command)) return false;
    return scriptIsWired(candidate, scripts, workflows, visiting);
  });
}

export function checkLedger({ ledgerSource, packageSource, workflowSource }) {
  const problems = [];
  if (!ledgerSource.includes("append-only")) {
    problems.push("ledger must declare its append-only policy");
  }
  const rows = parseLedger(ledgerSource);
  if (rows.length === 0) problems.push("ledger has no OP rows");
  const malformedRows = ledgerSource
    .split(/\r?\n/)
    .filter(
      (line) => /^\s*\|\s*OP-\d+\b/i.test(line) && !ROW_PATTERN.test(line),
    );
  if (malformedRows.length > 0) {
    problems.push("ledger contains malformed OP rows");
  }

  for (const expected of HISTORICAL_LEDGER) {
    const actual = rows.find((row) => row.id === expected.id);
    if (!actual) {
      problems.push(`${expected.id} is missing from the historical ledger`);
      continue;
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${expected.id} was rewritten in the historical ledger`);
    }
  }

  const manifest = JSON.parse(packageSource);
  const scripts = manifest.scripts ?? {};
  rows.forEach((row, index) => {
    const expected = `OP-${String(index + 1).padStart(2, "0")}`;
    if (row.id !== expected) {
      problems.push(
        `${row.id} breaks append-only sequence; expected ${expected}`,
      );
    }

    const command = /^bun run ([a-z0-9:_-]+)$/i.exec(row.check);
    if (!command || !scripts[command[1]]) {
      problems.push(`${row.id} references an unknown check: ${row.check}`);
    } else if (
      row.ci === "yes" &&
      !scriptIsWired(command[1], scripts, workflowSource)
    ) {
      problems.push(`${row.id} is marked CI=yes but is not wired into CI`);
    }
  });

  return { rows, problems };
}

export function assertLedger(input) {
  const result = checkLedger(input);
  if (result.problems.length > 0) {
    throw new Error(
      [
        "Discipline ledger check failed:",
        ...result.problems.map((problem) => `- ${problem}`),
      ].join("\n"),
    );
  }
  return result;
}

const read = (path) => readFileSync(resolve(ROOT, path), "utf8");
const result = assertLedger({
  ledgerSource: read("docs/disciplines.md"),
  packageSource: read("package.json"),
  workflowSource: read(".github/workflows/ci.yml"),
});
process.stdout.write(
  `✓ discipline ledger (${result.rows.length} append-only rows)\n`,
);
