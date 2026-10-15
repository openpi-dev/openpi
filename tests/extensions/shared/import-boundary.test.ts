import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { posix, relative, resolve, sep, win32 } from "node:path";
import test from "node:test";
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

function violatesSearchBoundary(
  file: string,
  source: string,
  paths = { resolve, relative, sep },
  root = ROOT,
) {
  return runtimeImports(source).filter((specifier) => {
    if (!specifier.startsWith(".")) return false;
    const target = paths
      .relative(root, paths.resolve(root, file, "..", specifier))
      .split(paths.sep)
      .join("/");
    if (SEARCH_SHARED.includes(file)) {
      return (
        target.startsWith("extensions/") &&
        !target.startsWith("extensions/shared/")
      );
    }
    return /^extensions\/file-search\/src\/(?:output|process)\.ts$/.test(
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

for (const [platform, paths, root] of [
  ["posix", posix, "/review/repo"],
  ["win32", win32, "C:/review/repo"],
] as const) {
  test(`${platform} search guard rejects values/re-exports and permits pure types`, () => {
    const violations = (file: string, source: string) =>
      violatesSearchBoundary(file, source, paths, root);
    for (const source of [
      'import { x } from "../file-search/src/output.ts";',
      'import { type as value } from "../file-search/src/output.ts";',
      'import { type T, x } from "../file-search/src/output.ts";',
      'export * from "../file-search/src/output.ts";',
      'export { x } from "../file-search/src/output.ts";',
      'import "../file-search/src/output.ts";',
    ])
      assert.equal(violations(SEARCH_SHARED[0]!, source).length, 1, source);
    for (const source of [
      'import type { T } from "../subagents/src/domain.ts";',
      'import { type T } from "../subagents/src/domain.ts";',
      'export type { T } from "../subagents/src/domain.ts";',
      'export { type T } from "../subagents/src/domain.ts";',
      'import { x } from "./search-output.ts";',
    ])
      assert.deepEqual(violations(SEARCH_SHARED[0]!, source), [], source);
    for (const file of CONSUMERS) {
      for (const name of ["output", "process"]) {
        const relativeSpecifier = paths
          .relative(
            paths.resolve(root, file, ".."),
            paths.resolve(root, `extensions/file-search/src/${name}.ts`),
          )
          .split(paths.sep)
          .join("/");
        const specifier = relativeSpecifier.startsWith(".")
          ? relativeSpecifier
          : `./${relativeSpecifier}`;
        for (const clause of [
          "import { x } from",
          "import { type as value } from",
          "import { type T, x } from",
          "export * from",
          "export { x } from",
          "import",
        ]) {
          const source = `${clause} "${specifier}";`;
          assert.equal(
            violations(file, source).length,
            1,
            `${file}: ${source}`,
          );
        }
        for (const clause of [
          "import type { T } from",
          "import { type T } from",
          "export type { T } from",
          "export { type T } from",
        ]) {
          const source = `${clause} "${specifier}";`;
          assert.deepEqual(violations(file, source), [], `${file}: ${source}`);
        }
      }
    }
    // Unrelated modules, sibling path prefixes and parent directories are not
    // this seam's private implementation. Existing shared seams remain valid.
    for (const source of [
      'import { x } from "../../extensions-other/file.ts";',
      'import { x } from "../../other/extensions/file-search/src/process.ts";',
      'import { x } from "../file-search/src/other.ts";',
      'import { x } from "../shared/agent-tool-renderer.ts";',
    ])
      assert.deepEqual(violations(CONSUMERS[1]!, source), [], source);
  });
}
