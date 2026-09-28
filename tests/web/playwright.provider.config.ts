import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { WEB_PORT } from "./provider-e2e-support.ts";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const origin = `http://127.0.0.1:${WEB_PORT}`;
const browserExecutable = process.env.OPENPI_WEB_BROWSER_EXECUTABLE;
const outputDirectory = resolve(
  tmpdir(),
  "openpi-web-provider-playwright-results",
);

export default defineConfig({
  testDir: repositoryRoot,
  testMatch: [
    "tests/web/openpi-web-provider.e2e.ts",
    "tests/web/questions-provider.e2e.ts",
    "tests/web/plan-provider.e2e.ts",
    "tests/web/commands-provider.e2e.ts",
  ],
  outputDir: outputDirectory,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  use: {
    baseURL: origin,
    contextOptions: { locale: "zh-CN" },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ...(browserExecutable
      ? { launchOptions: { executablePath: browserExecutable } }
      : {}),
  },
  globalSetup: resolve(
    dirname(fileURLToPath(import.meta.url)),
    "playwright-provider-global-setup.ts",
  ),
});
