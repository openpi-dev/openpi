#!/usr/bin/env node
/**
 * DDD boundary gate (docs/DDD_DEVELOPMENT.md):
 *
 * R1 — extensions must not import each other: every cross-extension relative
 *      import must target `../shared/`. This keeps the dependency graph
 *      acyclic and single-direction (extension → shared kernel).
 *
 * R2 — domain-layer files must not touch the UI/event surface: files matching
 *      the domain naming convention (domain/state/model/policy/frames/limits/
 *      signal-detection/tasks/sessions) may import types, but importing the
 *      extension wiring symbols (ExtensionContext/ExtensionAPI/Theme/TUI/…)
 *      leaks infrastructure into the pure layer.
 *
 * Exit 0 = clean; nonzero with a report = violations. Run from the package
 * root; add to CI or a pre-commit hook.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const EXTENSIONS_ROOT = new URL("../extensions/", import.meta.url).pathname;
const DOMAIN_FILE =
  /(^|\/)(domain|state|model|policy|frames|limits|signal-detection|tasks|sessions)\.ts$/;
const WIRING_SYMBOLS = [
  "ExtensionContext",
  "ExtensionAPI",
  "ExtensionCommandContext",
  "ExtensionUIContext",
  "Theme",
  "TUI",
  "Extension",
  "ToolInfo",
];

const violations = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (
      entry === "node_modules" ||
      entry === ".test.ts" ||
      entry.endsWith(".test.ts")
    ) {
      if (entry.endsWith(".test.ts")) continue;
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    const content = readFileSync(full, "utf8");
    const rel = full.replace(EXTENSIONS_ROOT, "extensions/");

    // R1: cross-extension imports (relative ..<ext>/ paths).
    for (const match of content.matchAll(/from "\.\.\/([a-z0-9-]+)\//g)) {
      const target = match[1];
      if (target !== "shared") {
        violations.push(
          `R1 ${rel}: imports another extension "${target}" — route through shared/`,
        );
      }
    }

    // R2: domain-named files importing wiring symbols.
    if (DOMAIN_FILE.test(entry)) {
      for (const symbol of WIRING_SYMBOLS) {
        const re = new RegExp(`import\\s+(?:type\\s+)?\\{[^}]*\\b${symbol}\\b`);
        // `import type { … }` is fine; value imports of wiring symbols are not.
        if (re.test(content) && !/import\s+type\s+\{/.test(content)) {
          violations.push(
            `R2 ${rel}: domain file imports wiring symbol ${symbol}`,
          );
        }
      }
    }
  }
}

walk(EXTENSIONS_ROOT);

if (violations.length > 0) {
  console.error("DDD boundary violations:");
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error(`\n${violations.length} violation(s). Fix before merging.`);
  process.exit(1);
}
console.log("DDD boundaries clean ✓");
