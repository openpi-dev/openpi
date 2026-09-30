import { randomBytes } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { FullConfig } from "@playwright/test";
import { WEB_PROTOCOL_VERSION } from "../../web/protocol/types.ts";
import {
  cleanupDeferredPlanWorkspaces,
  seedAgentDirectory,
  WEB_PORT,
} from "./provider-e2e-support.ts";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const origin = `http://127.0.0.1:${WEB_PORT}`;
const agentDirectory = resolve(
  tmpdir(),
  "openpi-web-plan-provider-playwright-results",
  "agent",
);

function serverIsAvailable(token: string) {
  return new Promise<boolean>((resolveAvailable) => {
    const request = httpGet(
      `${origin}/api/snapshot`,
      { headers: { authorization: `Bearer ${token}` } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.once("error", () => resolveAvailable(false));
        response.once("end", () => {
          if (response.statusCode !== 200) {
            resolveAvailable(false);
            return;
          }
          try {
            const snapshot = JSON.parse(body) as {
              cursor?: unknown;
              protocolVersion?: unknown;
            };
            resolveAvailable(
              snapshot.protocolVersion === WEB_PROTOCOL_VERSION &&
                Number.isInteger(snapshot.cursor),
            );
          } catch {
            resolveAvailable(false);
          }
        });
      },
    );
    request.setTimeout(1_000, () => request.destroy());
    request.once("error", () => resolveAvailable(false));
  });
}

function waitForServerClose(server: ChildProcess, timeoutMs: number) {
  return new Promise<boolean>((resolveClosed) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (closed: boolean) => {
      clearTimeout(timer);
      server.off("close", onClose);
      resolveClosed(closed);
    };
    const onClose = () => finish(true);
    server.once("close", onClose);
    timer = setTimeout(() => finish(false), timeoutMs);
    if (server.exitCode !== null || server.signalCode !== null) finish(true);
  });
}

function serverExitedError(server: ChildProcess) {
  return new Error(
    `Provider E2E web server exited before becoming ready (code=${server.exitCode}, signal=${server.signalCode}).`,
  );
}

async function waitForServer(server: ChildProcess, token: string) {
  const deadline = Date.now() + 30_000;
  let launchError: Error | undefined;
  server.once("error", (error) => {
    launchError = error;
  });

  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (server.exitCode !== null || server.signalCode !== null)
      throw serverExitedError(server);
    const available = await serverIsAvailable(token);
    if (launchError) throw launchError;
    if (server.exitCode !== null || server.signalCode !== null)
      throw serverExitedError(server);
    if (available) return;
    await delay(100);
  }

  throw new Error(`Provider E2E web server did not become ready at ${origin}.`);
}

async function stopServer(server: ChildProcess) {
  if (!server.pid || server.exitCode !== null || server.signalCode !== null)
    return;

  const gracefulExit = waitForServerClose(server, 5_000);
  server.kill("SIGTERM");
  if (await gracefulExit) return;

  const forcedExit = waitForServerClose(server, 5_000);
  server.kill("SIGKILL");
  if (!(await forcedExit))
    throw new Error(
      "Provider E2E web server process did not exit after SIGKILL.",
    );
}

export default async function globalSetup(_config: FullConfig) {
  // Playwright clears outputDir before globalSetup, so seed the isolated Pi
  // config now rather than when the config module is first loaded.
  seedAgentDirectory(agentDirectory, repositoryRoot);
  // A prior interrupted run may have left test workspaces behind. The port is
  // validated below before these paths are removed, so no live server owns them.
  const token = randomBytes(32).toString("hex");
  process.env.OPENPI_WEB_E2E_TOKEN = token;

  const server = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "./bin/openpi.js",
      "web",
      "--no-workspace",
      "--port",
      String(WEB_PORT),
      "--no-open",
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        OPENPI_WEB_TOKEN: token,
        PI_CODING_AGENT_DIR: agentDirectory,
      },
      stdio: "inherit",
      windowsHide: true,
    },
  );

  try {
    await waitForServer(server, token);
    await cleanupDeferredPlanWorkspaces();
  } catch (error) {
    await stopServer(server);
    throw error;
  }

  return async () => {
    await stopServer(server);
    await cleanupDeferredPlanWorkspaces();
  };
}
