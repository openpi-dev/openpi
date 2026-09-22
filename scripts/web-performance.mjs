import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Run against the checked-in production bundle without touching web/dist.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = resolve(root, "web/dist/app.js");
const hash = () =>
  createHash("sha256").update(readFileSync(bundle)).digest("hex");
const before = hash();
const result = spawnSync(
  resolve(root, "node_modules/.bin/playwright"),
  [
    "test",
    "--config",
    "tests/web/playwright.performance.config.ts",
    ...process.argv.slice(2),
  ],
  { cwd: root, env: process.env, stdio: "inherit" },
);
const after = hash();
if (before !== after)
  throw new Error("web/dist/app.js changed during measurement");
console.log(`Production bundle SHA-256: ${before}`);
console.log(
  "Evidence: system temp directory/openpi-web-m12-results (Playwright test attachments)",
);
process.exitCode = result.status ?? 1;
