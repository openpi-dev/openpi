import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { openBrowser } from "../web/host/browser-launcher.ts";
import {
  createBackendStartupMonitor,
  resolveDevelopmentPorts,
  waitForBackend,
} from "./dev-web-support.ts";

const workspace = process.argv[2] ?? process.cwd();
const viteConfig = fileURLToPath(
  new URL("../web/vite.config.mjs", import.meta.url),
);

let ui;
let backend;
let stopping;
const stop = async (exitCode = 0) => {
  stopping ??= (async () => {
    await ui?.close();
    if (backend && !backend.killed) backend.kill("SIGTERM");
  })();
  await stopping;
  if (exitCode !== 0) process.exitCode = exitCode;
};

try {
  const ports = await resolveDevelopmentPorts();
  const { backendOrigin, uiOrigin } = ports;
  if (ports.ui.port !== ports.ui.preferredPort) {
    console.warn(
      `Port ${ports.ui.preferredPort} is already in use; using ${ports.ui.port} for the OpenPI Web development UI.`,
    );
  }
  if (ports.backend.port !== ports.backend.preferredPort) {
    console.warn(
      `Port ${ports.backend.preferredPort} is already in use; using ${ports.backend.port} for the OpenPI Web backend.`,
    );
  }

  const token = randomBytes(32).toString("hex");
  const startup = createBackendStartupMonitor();
  backend = spawn(
    process.execPath,
    [
      "--watch",
      "--experimental-strip-types",
      fileURLToPath(new URL("../bin/openpi.js", import.meta.url)),
      "web",
      workspace,
      "--port",
      String(ports.backend.port),
      "--no-open",
    ],
    {
      env: {
        ...process.env,
        // Development runs keep the phase/timing trace visible in this terminal.
        OPENPI_WEB_DEBUG: process.env.OPENPI_WEB_DEBUG || "1",
        OPENPI_WEB_TOKEN: token,
        OPENPI_WEB_ALLOWED_ORIGIN: uiOrigin,
      },
      stdio: ["inherit", "inherit", "pipe"],
    },
  );
  backend.stderr.setEncoding("utf8");
  backend.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    startup.push(chunk);
  });
  backend.once("error", (error) => startup.fail(error));
  backend.once("exit", (code, signal) => {
    startup.fail(
      new Error(
        signal
          ? `OpenPI Web backend was terminated by ${signal}`
          : `OpenPI Web backend exited with code ${code ?? "unknown"}`,
      ),
    );
    if (!stopping) void stop(code ?? (signal ? 1 : 0));
  });

  process.env.OPENPI_WEB_BACKEND = backendOrigin;
  process.env.OPENPI_WEB_UI_PORT = String(ports.ui.port);
  await waitForBackend({ backendOrigin, token, startup });
  ui = await createServer({
    configFile: viteConfig,
    server: { port: ports.ui.port, strictPort: true },
  });
  await ui.listen();
  const uiUrl = ui.resolvedUrls?.local?.[0];
  if (!uiUrl) throw new Error("Vite did not expose a local URL");
  const browserUrl = `${uiUrl}#token=${token}`;
  console.log(`OpenPI Web development UI: ${browserUrl}`);
  console.log(`API/SSE backend: ${backendOrigin}`);
  console.log(
    "React and CSS changes use Vite HMR; backend changes restart the Pi runtime.",
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
