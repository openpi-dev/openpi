import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const port = 57_109;
const token =
  "746573742d6f70656e70692d7765622d72656163742d6d76702d746f6b656e21";
const origin = `http://127.0.0.1:${port}`;
const browserExecutable = process.env.OPENPI_WEB_BROWSER_EXECUTABLE;
const outputDirectory = resolve(tmpdir(), "openpi-web-playwright-results");
const agentDirectory = resolve(outputDirectory, "agent");

process.env.OPENPI_WEB_E2E_TOKEN = token;

export default defineConfig({
  testDir: repositoryRoot,
  testMatch: "tests/web/openpi-web.e2e.ts",
  outputDir: outputDirectory,
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
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
    command:
      "node --experimental-strip-types ./bin/openpi.js web . --port 57109 --no-open",
    cwd: repositoryRoot,
    env: {
      ...process.env,
      OPENPI_WEB_TOKEN: token,
      PI_CODING_AGENT_DIR: agentDirectory,
    },
    reuseExistingServer: false,
    timeout: 30_000,
    url: origin,
  },
});
