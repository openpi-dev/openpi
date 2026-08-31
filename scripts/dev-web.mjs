import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openBrowser } from "../web/host/browser-launcher.ts";
import { createServer } from "vite";

const workspace = process.argv[2] ?? process.cwd();
const backendPort = Number(process.env.OPENPI_WEB_BACKEND_PORT || 57107);
const uiPort = Number(process.env.OPENPI_WEB_UI_PORT || 5173);
if (!Number.isInteger(backendPort) || !Number.isInteger(uiPort))
  throw new Error(
    "OPENPI_WEB_BACKEND_PORT and OPENPI_WEB_UI_PORT must be integers",
  );

const token = randomBytes(32).toString("hex");
const viteConfig = fileURLToPath(
  new URL("../web/vite.config.mjs", import.meta.url),
);

async function waitForBackend() {
  const endpoint = `http://127.0.0.1:${backendPort}/`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return;
    } catch {
      // The Pi runtime may take a few seconds to initialize on first start.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Web backend did not become ready at ${endpoint}`);
}
const backend = spawn(
  process.execPath,
  [
    "--watch",
    "--experimental-strip-types",
    fileURLToPath(new URL("../bin/openpi.js", import.meta.url)),
    "web",
    workspace,
    "--port",
    String(backendPort),
    "--no-open",
  ],
  {
    env: {
      ...process.env,
      // Development runs keep the phase/timing trace visible in this terminal.
      OPENPI_WEB_DEBUG: process.env.OPENPI_WEB_DEBUG || "1",
      OPENPI_WEB_TOKEN: token,
      OPENPI_WEB_ALLOWED_ORIGIN: `http://127.0.0.1:${uiPort}`,
    },
    stdio: "inherit",
  },
);

let ui;
let stopping;
const stop = async (exitCode = 0) => {
  stopping ??= (async () => {
    await ui?.close();
    if (!backend.killed) backend.kill("SIGTERM");
  })();
  await stopping;
  if (exitCode !== 0) process.exitCode = exitCode;
};
backend.once("exit", (code, signal) => {
  if (!stopping) void stop(code ?? (signal ? 1 : 0));
});

try {
  process.env.OPENPI_WEB_BACKEND = `http://127.0.0.1:${backendPort}`;
  await waitForBackend();
  ui = await createServer({
    configFile: viteConfig,
    server: { port: uiPort, strictPort: true },
  });
  await ui.listen();
  const uiUrl = ui.resolvedUrls?.local?.[0];
  if (!uiUrl) throw new Error("Vite did not expose a local URL");
  const browserUrl = `${uiUrl}#token=${token}`;
  console.log(`OpenPI Web development UI: ${browserUrl}`);
  console.log(`API/SSE backend: http://127.0.0.1:${backendPort}`);
  console.log(
    "UI HTML/CSS/JS changes use Vite HMR; backend changes restart the Pi runtime.",
  );
  if (!(await openBrowser(browserUrl)))
    console.log(`Open this URL in a browser: ${browserUrl}`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => void stop().finally(() => process.exit(0)));
  await new Promise(() => {});
} catch (error) {
  await stop(1);
  console.error(
    `Failed to start OpenPI Web development environment: ${error instanceof Error ? error.message : String(error)}`,
  );
}
