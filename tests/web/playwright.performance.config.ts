import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const port = 57_119;
const outputDir = resolve(tmpdir(), "openpi-web-m12-results");
const token =
  "746573742d6f70656e70692d6d31322d706572666f726d616e63652121212121";
process.env.OPENPI_WEB_E2E_TOKEN = token;

export default defineConfig({
  testDir: root,
  testMatch: "tests/web/web-performance.e2e.ts",
  outputDir,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    contextOptions: { locale: "zh-CN" },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    ...(process.env.OPENPI_WEB_BROWSER_EXECUTABLE
      ? {
          launchOptions: {
            executablePath: process.env.OPENPI_WEB_BROWSER_EXECUTABLE,
          },
        }
      : {}),
  },
  webServer: {
    command: `node --experimental-strip-types ./bin/openpi.js web . --port ${port} --no-open`,
    cwd: root,
    env: {
      ...process.env,
      OPENPI_WEB_TOKEN: token,
      PI_CODING_AGENT_DIR: resolve(outputDir, "agent"),
    },
    reuseExistingServer: false,
    timeout: 30_000,
    url: `http://127.0.0.1:${port}`,
  },
});
