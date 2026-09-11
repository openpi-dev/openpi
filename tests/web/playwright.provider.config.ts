import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import {
  seedAgentDirectory,
  WEB_PORT,
  WEB_TOKEN,
} from "./provider-e2e-support.ts";

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
const agentDirectory = resolve(outputDirectory, "agent");

// The seeded agent dir is isolated from the default suite. It must exist before
// the backend starts because ModelConfig reads it during runtime creation.
seedAgentDirectory(agentDirectory);

process.env.OPENPI_WEB_E2E_TOKEN = WEB_TOKEN;

export default defineConfig({
  testDir: repositoryRoot,
  testMatch: "tests/web/openpi-web-provider.e2e.ts",
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
  webServer: {
    command: `node --experimental-strip-types ./bin/openpi.js web --no-workspace --port ${WEB_PORT} --no-open`,
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OPENPI_WEB_TOKEN: WEB_TOKEN,
      PI_CODING_AGENT_DIR: agentDirectory,
    },
    reuseExistingServer: false,
    timeout: 30_000,
    url: origin,
  },
});
