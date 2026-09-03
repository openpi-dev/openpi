#!/usr/bin/env node

import { resolve } from "node:path";
import { createJiti } from "jiti";

function printHelp() {
  console.log(`OpenPI Web Workbench

Usage:
  openpi web [workspace]
  openpi [workspace]          Alias for openpi web [workspace]

Options:
  --port <number>              Bind a specific loopback port (development)
  --no-open                    Do not open a browser (development)

Starts an isolated local Web runtime. Browser conversations and session changes
never enter an interactive terminal Pi session.`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}
const command = args[0] === "web" ? args.slice(1) : args;
const noOpen = command.includes("--no-open");
const noWorkspace = command.includes("--no-workspace");
const portIndex = command.indexOf("--port");
const portText = portIndex >= 0 ? command[portIndex + 1] : undefined;
const workspaceArgs = [];
for (let index = 0; index < command.length; index++) {
  const value = command[index];
  if (value === "--no-open") continue;
  if (value === "--no-workspace") continue;
  if (value === "--port") {
    index++;
    continue;
  }
  workspaceArgs.push(value);
}
const configuredPort = portText ?? process.env.OPENPI_WEB_PORT;
const port = configuredPort === undefined ? undefined : Number(configuredPort);
if (portIndex >= 0 && (!portText || portText.startsWith("--"))) {
  console.error("--port requires a value");
  process.exit(1);
}
if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
  console.error("--port must be an integer between 0 and 65535");
  process.exit(1);
}
if (workspaceArgs.length > 1) {
  console.error("Usage: openpi web [workspace]");
  process.exit(1);
}
if (noWorkspace && workspaceArgs.length > 0) {
  console.error("--no-workspace cannot be combined with a workspace");
  process.exit(1);
}

let host;
let runtime;
let stopping;
const stop = () => {
  stopping ??= host?.stop() ?? runtime?.dispose() ?? Promise.resolve();
  return stopping;
};

try {
  const jiti = createJiti(import.meta.url);
  const [browserModule, hostModule, runtimeModule, statusModule, traceModule] =
    await Promise.all([
      jiti.import("../web/host/browser-launcher.ts"),
      jiti.import("../web/host/web-host.ts"),
      jiti.import("../web/runtime/pi-runtime.ts"),
      jiti.import("../web/host/terminal-status.ts"),
      jiti.import("../web/trace.ts"),
    ]);
  const { openBrowser } = browserModule;
  const { WebHost } = hostModule;
  const { PiWebRuntime } = runtimeModule;
  const { formatWebReadyScreen } = statusModule;
  const { traceWeb } = traceModule;
  runtime = noWorkspace
    ? await PiWebRuntime.createWithoutWorkspace()
    : await PiWebRuntime.create(resolve(workspaceArgs[0] ?? process.cwd()));
  host = new WebHost({
    runtime,
    ...(port === undefined ? {} : { port }),
    ...(process.env.OPENPI_WEB_TOKEN
      ? { token: process.env.OPENPI_WEB_TOKEN }
      : {}),
    ...(process.env.OPENPI_WEB_ALLOWED_ORIGIN
      ? { allowedOrigins: [process.env.OPENPI_WEB_ALLOWED_ORIGIN] }
      : {}),
  });
  await host.start();
  traceWeb("web_started", {
    ...(runtime.workspaceSelected === true ? { cwd: runtime.cwd } : {}),
    origin: host.origin,
  });
  const opened = noOpen ? false : await openBrowser(host.url);
  if (noWorkspace) {
    console.log(
      formatWebReadyScreen({
        origin: host.origin,
        url: host.url,
        opened,
      }),
    );
  } else {
    console.log(`OpenPI Web Workbench is running at ${host.origin}`);
    if (!opened) console.log(`Open this URL in a browser: ${host.url}`);
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void stop().then(
        () => process.exit(0),
        (error) => {
          console.error(
            `Failed to stop OpenPI Web Workbench: ${error instanceof Error ? error.message : String(error)}`,
          );
          process.exit(1);
        },
      );
    });
  }
} catch (error) {
  let cleanupError;
  try {
    await stop();
  } catch (caught) {
    cleanupError = caught;
  }
  console.error(
    `Failed to start OpenPI Web Workbench: ${error instanceof Error ? error.message : String(error)}`,
  );
  if (cleanupError) {
    console.error(
      `Failed to clean up OpenPI Web Workbench: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
    );
  }
  process.exit(1);
}
