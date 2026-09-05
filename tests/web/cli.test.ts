import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const entrypoint = new URL("../../bin/openpi.js", import.meta.url);
const entrypointPath = fileURLToPath(entrypoint);
test("openpi is an executable standalone Web entrypoint", async () => {
  if (process.platform !== "win32") {
    const info = await stat(entrypoint);
    assert.notEqual(info.mode & 0o100, 0);
  }

  const { stdout } = await execFileAsync(process.execPath, [
    entrypointPath,
    "--help",
  ]);
  assert.match(stdout, /Usage:\s+openpi web \[workspace\]/u);
  assert.match(stdout, /never enter an interactive terminal Pi session/u);
});

test("installed CLI loads TypeScript Web modules through its package loader", async () => {
  const temporaryRoot = await mkdtemp(join(process.cwd(), ".openpi-cli-test-"));
  const packageRoot = join(temporaryRoot, "node_modules", "@tt-a1i", "openpi");
  try {
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await mkdir(join(packageRoot, "web", "host"), { recursive: true });
    await mkdir(join(packageRoot, "web", "runtime"), { recursive: true });
    await cp(entrypointPath, join(packageRoot, "bin", "openpi.js"));
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(
      join(packageRoot, "web", "host", "browser-launcher.ts"),
      "export async function openBrowser(): Promise<boolean> { return false; }\n",
    );
    await writeFile(
      join(packageRoot, "web", "host", "terminal-status.ts"),
      "export function formatWebReadyScreen(options: { origin: string; url: string }): string { return `ready ${options.origin} ${options.url}`; }\n",
    );
    await writeFile(
      join(packageRoot, "web", "host", "web-host.ts"),
      `export class WebHost {
  origin = "http://127.0.0.1:12345";
  url = "http://127.0.0.1:12345/#token=test";
  timer: ReturnType<typeof setInterval> | undefined;
  constructor() {
    if (process.env.OPENPI_CLI_HOST_CONSTRUCTOR_FAIL === "1") {
      throw new Error("host constructor failed");
    }
  }
  async start(): Promise<void> {
    if (process.env.OPENPI_CLI_KEEPALIVE === "1") {
      this.timer = setInterval(() => undefined, 1_000);
    }
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (process.env.OPENPI_CLI_STOP_FAIL === "1") throw new Error("stop failed");
  }
}\n`,
    );
    await writeFile(
      join(packageRoot, "web", "runtime", "pi-runtime.ts"),
      `import { writeFile } from "node:fs/promises";

export class PiWebRuntime {
  static async createWithoutWorkspace(): Promise<{ cwd: string; dispose(): Promise<void> }> {
    const marker = process.env.OPENPI_CLI_NO_WORKSPACE_MARKER;
    if (marker) await writeFile(marker, "unbound");
    return PiWebRuntime.create("/web-owned-bootstrap");
  }
  static async create(cwd: string): Promise<{ cwd: string; dispose(): Promise<void> }> {
    return {
      cwd,
      async dispose(): Promise<void> {
        const marker = process.env.OPENPI_CLI_RUNTIME_DISPOSE_MARKER;
        if (marker) await writeFile(marker, "disposed");
      },
    };
  }
}\n`,
    );
    await writeFile(
      join(packageRoot, "web", "trace.ts"),
      "export function traceWeb(): void {}\n",
    );

    const { stdout } = await execFileAsync(process.execPath, [
      join(packageRoot, "bin", "openpi.js"),
      "web",
      temporaryRoot,
      "--no-open",
    ]);
    assert.match(
      stdout,
      /^OpenPI Web Workbench is running at http:\/\/127\.0\.0\.1:12345$/mu,
    );
    assert.match(
      stdout,
      /^Open this URL in a browser: http:\/\/127\.0\.0\.1:12345\/#token=test$/mu,
    );

    const noWorkspaceMarker = join(temporaryRoot, "no-workspace");
    await execFileAsync(
      process.execPath,
      [
        join(packageRoot, "bin", "openpi.js"),
        "web",
        "--no-workspace",
        "--no-open",
      ],
      {
        env: {
          ...process.env,
          OPENPI_CLI_NO_WORKSPACE_MARKER: noWorkspaceMarker,
        },
      },
    );
    assert.equal(await readFile(noWorkspaceMarker, "utf8"), "unbound");

    const disposeMarker = join(temporaryRoot, "runtime-disposed");
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          join(packageRoot, "bin", "openpi.js"),
          "web",
          temporaryRoot,
          "--no-open",
        ],
        {
          env: {
            ...process.env,
            OPENPI_CLI_HOST_CONSTRUCTOR_FAIL: "1",
            OPENPI_CLI_RUNTIME_DISPOSE_MARKER: disposeMarker,
          },
        },
      ),
      (error: unknown) => {
        assert.match(
          String((error as { stderr?: string }).stderr),
          /Failed to start OpenPI Web Workbench: host constructor failed/u,
        );
        return true;
      },
    );
    assert.equal(await readFile(disposeMarker, "utf8"), "disposed");

    if (process.platform !== "win32") {
      const child = spawn(
        process.execPath,
        [
          join(packageRoot, "bin", "openpi.js"),
          "web",
          temporaryRoot,
          "--no-open",
        ],
        {
          env: {
            ...process.env,
            OPENPI_CLI_KEEPALIVE: "1",
            OPENPI_CLI_STOP_FAIL: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      let signalOutput = "";
      let signalError = "";
      child.stdout.on("data", (chunk) => {
        signalOutput += chunk;
      });
      child.stderr.on("data", (chunk) => {
        signalError += chunk;
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("installed CLI did not start")),
          5_000,
        );
        const waitForReady = () => {
          if (
            signalOutput.includes(
              "OpenPI Web Workbench is running at http://127.0.0.1:12345",
            )
          ) {
            clearTimeout(timeout);
            resolve();
            return;
          }
          setTimeout(waitForReady, 10);
        };
        waitForReady();
      });
      child.kill("SIGTERM");
      const [exitCode] = (await once(child, "close")) as [number | null];
      assert.equal(exitCode, 1);
      assert.match(
        signalError,
        /Failed to stop OpenPI Web Workbench: stop failed/u,
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
