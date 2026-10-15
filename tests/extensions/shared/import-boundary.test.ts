import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { parse } from "acorn";

const ROOT = resolve(import.meta.dirname, "../../..");
const SEARCH_SHARED = [
  "extensions/shared/search-output.ts",
  "extensions/shared/search-process.ts",
];
const CONSUMERS = [
  "extensions/file-search/index.ts",
  "extensions/git-read/index.ts",
  "extensions/git-read/src/process.ts",
];

// Check just this extracted search seam, not unrelated existing shared owners.
function runtimeImports(source: string) {
  // Node erases type-only syntax before the existing JavaScript parser sees
  // imports, avoiding a second TypeScript parser dependency.
  const file = parse(stripTypeScriptTypes(source), {
    ecmaVersion: "latest",
    sourceType: "module",
  });
  return file.body.flatMap((statement) => {
    // Erasure keeps an empty import/export clause for named type-only
    // specifiers. Consult that original clause, not the erased empty braces.
    const clause = /^\s*(?:import|export)\s*\{([^}]*)\}/u.exec(
      source.slice(statement.start, statement.end),
    )?.[1];
    const erasedTypeClause =
      (statement.type === "ImportDeclaration" &&
        statement.specifiers.length === 0) ||
      (statement.type === "ExportNamedDeclaration" &&
        statement.specifiers.length === 0);
    if (
      erasedTypeClause &&
      clause &&
      clause
        .split(",")
        .filter((item) => item.trim())
        .every((item) => /^\s*type\s+/u.test(item))
    )
      return [];
    if (
      statement.type === "ImportDeclaration" ||
      statement.type === "ExportNamedDeclaration" ||
      statement.type === "ExportAllDeclaration"
    ) {
      return typeof statement.source?.value === "string"
        ? [statement.source.value]
        : [];
    }
    return [];
  });
}

function violatesSearchBoundary(file: string, source: string) {
  return runtimeImports(source).filter((specifier) => {
    if (!specifier.startsWith(".")) return false;
    const target = resolve(ROOT, file, "..", specifier);
    if (SEARCH_SHARED.includes(file)) {
      return (
        target.startsWith(resolve(ROOT, "extensions") + "/") &&
        !target.startsWith(resolve(ROOT, "extensions/shared") + "/")
      );
    }
    return /\/extensions\/file-search\/src\/(?:output|process)\.ts$/.test(
      target,
    );
  });
}

test("shared search implementations and their consumers keep the extracted boundary", async () => {
  for (const file of [...SEARCH_SHARED, ...CONSUMERS]) {
    assert.deepEqual(
      violatesSearchBoundary(file, await readFile(resolve(ROOT, file), "utf8")),
      [],
      file,
    );
  }
  // A forwarding shim would pass a consumer-only guard but still invert ownership.
  for (const file of SEARCH_SHARED) {
    const source = await readFile(resolve(ROOT, file), "utf8");
    assert.match(source, /export (?:async )?(?:function|const|class)/);
  }
});

test("search guard rejects value/mixed imports and re-exports, permits pure types", () => {
  for (const source of [
    'import { x } from "../file-search/src/output.ts";',
    'import { type as value } from "../file-search/src/output.ts";',
    'import { type T, x } from "../file-search/src/output.ts";',
    'export * from "../file-search/src/output.ts";',
    'export { x } from "../file-search/src/output.ts";',
    'import "../file-search/src/output.ts";',
  ])
    assert.equal(
      violatesSearchBoundary(SEARCH_SHARED[0]!, source).length,
      1,
      source,
    );
  for (const source of [
    'import type { T } from "../subagents/src/domain.ts";',
    'import { type T } from "../subagents/src/domain.ts";',
    'export type { T } from "../subagents/src/domain.ts";',
    'export { type T } from "../subagents/src/domain.ts";',
    'import { x } from "./search-output.ts";',
  ])
    assert.deepEqual(
      violatesSearchBoundary(SEARCH_SHARED[0]!, source),
      [],
      source,
    );
  assert.equal(
    violatesSearchBoundary(
      CONSUMERS[1]!,
      'export * from "../file-search/src/process.ts";',
    ).length,
    1,
  );
});
