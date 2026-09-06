import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function inspectPath(path: string) {
  try {
    return { exists: true, content: await readFile(path, "utf8") };
  } catch (error) {
    return {
      exists: false,
      error:
        error instanceof Error && "code" in error
          ? String(error.code)
          : String(error),
    };
  }
}

// Same-dir write-then-rename makes the final name appear only after
// contents are complete. Directory watch can fire first for the staging
// name and miss the rename; also wake from the writer's stderr.
function waitForPublishedMarker(
  path: string,
  expected: string,
  timeoutMs: number,
  diagnostics: () => string,
  wake?: NodeJS.ReadableStream,
) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      wake?.off("data", tryRead);
      if (error) reject(error);
      else resolve();
    };
    const tryRead = () => {
      void readFile(path, "utf8").then(
        (content) => {
          if (content === expected) finish();
        },
        () => {},
      );
    };
    const timer = setTimeout(() => {
      void Promise.all([inspectPath(path), inspectPath(`${path}.tmp`)]).then(
        ([marker, staging]) => {
          finish(
            new Error(
              `timed out waiting for ${path} contents; marker=${JSON.stringify(marker)} staging=${JSON.stringify(staging)}; ${diagnostics()}`,
            ),
          );
        },
      );
    }, timeoutMs);
    const watcher = watch(dirname(path), tryRead);
    watcher.on("error", (error) => {
      finish(new Error(`watch error for ${path}: ${error}; ${diagnostics()}`));
    });
    wake?.on("data", tryRead);
    tryRead();
  });
}

const entrypoint = new URL("../../bin/openpi.js", import.meta.url);
const entrypointPath = fileURLToPath(entrypoint);
const staticAssetsPath = fileURLToPath(
  new URL("../../web/host/static-assets.ts", import.meta.url),
);
const resolverPath = fileURLToPath(
  new URL("../../web/host/pi-coding-agent-entry.ts", import.meta.url),
);

async function copyStandaloneLoader(packageRoot: string) {
  await cp(entrypointPath, join(packageRoot, "bin", "openpi.js"));
  await cp(
    resolverPath,
    join(packageRoot, "web", "host", "pi-coding-agent-entry.ts"),
  );
}

async function writeOfficialPeer(root: string, marker = "peer") {
  const peerRoot = join(
    root,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  await mkdir(join(peerRoot, "dist"), { recursive: true });
  await writeFile(
    join(peerRoot, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      type: "module",
      exports: { ".": { import: "./dist/index.js" } },
    }),
  );
  await writeFile(
    join(peerRoot, "dist", "index.js"),
    `export const PI_ENTRY_STUB = ${JSON.stringify(marker)};\n`,
  );
  return peerRoot;
}

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

test("CLI registers stop signals before printing readiness", async () => {
  const source = await readFile(entrypointPath, "utf8");
  const handlers = source.indexOf("process.once(signal, onStopSignal)");
  const workspaceReady = source.indexOf(
    "OpenPI Web Workbench is running at ${host.origin}",
  );
  const unboundReady = source.indexOf("formatWebReadyScreen(");
  assert.notEqual(handlers, -1);
  assert.notEqual(workspaceReady, -1);
  assert.notEqual(unboundReady, -1);
  assert.ok(handlers < workspaceReady);
  assert.ok(handlers < unboundReady);
  assert.equal(source.includes("process.on(signal, onStopSignal)"), false);
});

test("installed CLI loads TypeScript Web modules through its package loader", async () => {
  const temporaryRoot = await mkdtemp(join(process.cwd(), ".openpi-cli-test-"));
  const packageRoot = join(temporaryRoot, "node_modules", "@tt-a1i", "openpi");
  try {
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await mkdir(join(packageRoot, "web", "host"), { recursive: true });
    await mkdir(join(packageRoot, "web", "runtime"), { recursive: true });
    await copyStandaloneLoader(packageRoot);
    await writeOfficialPeer(temporaryRoot);
    await cp(
      staticAssetsPath,
      join(packageRoot, "web", "host", "static-assets.ts"),
    );
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
      `import { readFile } from "node:fs/promises";
import { MARKED_BROWSER_URL } from "./static-assets.ts";

export class WebHost {
  origin = "http://127.0.0.1:12345";
  url = "http://127.0.0.1:12345/#token=test";
  timer: ReturnType<typeof setInterval> | undefined;
  constructor() {
    if (process.env.OPENPI_CLI_HOST_CONSTRUCTOR_FAIL === "1") {
      throw new Error("host constructor failed");
    }
  }
  async start(): Promise<void> {
    await readFile(MARKED_BROWSER_URL);
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
      const closed = once(child, "close") as Promise<
        [number | null, NodeJS.Signals | null]
      >;
      child.stderr.on("data", (chunk) => {
        signalError += chunk;
      });
      const started = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("installed CLI did not start")),
          5_000,
        );
        let sentStop = false;
        const onStdout = (chunk: string) => {
          signalOutput += chunk;
          if (
            sentStop ||
            !signalOutput.includes(
              "OpenPI Web Workbench is running at http://127.0.0.1:12345",
            )
          ) {
            return;
          }
          sentStop = true;
          child.stdout.off("data", onStdout);
          clearTimeout(timeout);
          child.kill("SIGTERM");
          resolve();
        };
        child.stdout.on("data", onStdout);
      });
      await started;
      const [exitCode, signal] = await closed;
      assert.equal(
        exitCode,
        1,
        `expected process.exit(1) after stop failure, got code=${String(exitCode)} signal=${String(signal)} stderr=${signalError}`,
      );
      assert.equal(signal, null);
      assert.match(
        signalError,
        /Failed to stop OpenPI Web Workbench: stop failed/u,
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("installed CLI aliases the Pi peer package to the handed-over entry", async () => {
  const temporaryRoot = await mkdtemp(join(process.cwd(), ".openpi-cli-test-"));
  const packageRoot = join(temporaryRoot, "node_modules", "@tt-a1i", "openpi");
  try {
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await mkdir(join(packageRoot, "web", "host"), { recursive: true });
    await mkdir(join(packageRoot, "web", "runtime"), { recursive: true });
    await copyStandaloneLoader(packageRoot);
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    const handedRoot = join(temporaryRoot, "handed-pi");
    await mkdir(join(handedRoot, "dist"), { recursive: true });
    await writeFile(
      join(handedRoot, "package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        type: "module",
        exports: { ".": { import: "./dist/index.js" } },
      }),
    );
    const stubEntry = join(handedRoot, "dist", "index.js");
    await writeFile(stubEntry, 'export const PI_ENTRY_STUB = "handed-over";\n');
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
  origin = "http://127.0.0.1:12346";
  url = "http://127.0.0.1:12346/";
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}\n`,
    );
    await writeFile(
      join(packageRoot, "web", "trace.ts"),
      "export function traceWeb(): void {}\n",
    );
    await writeFile(
      join(packageRoot, "web", "runtime", "pi-runtime.ts"),
      `import { writeFile } from "node:fs/promises";
import { PI_ENTRY_STUB } from "@earendil-works/pi-coding-agent";

export class PiWebRuntime {
  static async createWithoutWorkspace(): Promise<{ cwd: string; dispose(): Promise<void> }> {
    const marker = process.env.OPENPI_CLI_PI_ENTRY_MARKER;
    if (marker) await writeFile(marker, PI_ENTRY_STUB);
    return {
      cwd: "/web-owned-bootstrap",
      async dispose(): Promise<void> {},
    };
  }
}\n`,
    );

    const entryMarker = join(temporaryRoot, "pi-entry");
    const { stdout } = await execFileAsync(
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
          OPENPI_PI_CODING_AGENT_ENTRY: stubEntry,
          OPENPI_CLI_PI_ENTRY_MARKER: entryMarker,
        },
      },
    );
    assert.match(stdout, /ready http:\/\/127\.0\.0\.1:12346/u);
    assert.equal(await readFile(entryMarker, "utf8"), "handed-over");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("installed CLI resolves its own official-export peer and fail-closes without one", async () => {
  const temporaryRoot = await mkdtemp(join(process.cwd(), ".openpi-cli-test-"));
  const packageRoot = join(temporaryRoot, "node_modules", "@tt-a1i", "openpi");
  const peerRoot = join(
    temporaryRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const otherPi = join(temporaryRoot, "other-pi");
  try {
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await mkdir(join(packageRoot, "web", "host"), { recursive: true });
    await mkdir(join(packageRoot, "web", "runtime"), { recursive: true });
    await mkdir(join(peerRoot, "dist"), { recursive: true });
    await mkdir(join(otherPi, "dist"), { recursive: true });
    await mkdir(join(otherPi, "bin"), { recursive: true });
    await copyStandaloneLoader(packageRoot);
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(
      join(peerRoot, "package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        type: "module",
        exports: { ".": { import: "./dist/index.js" } },
      }),
    );
    await writeFile(
      join(peerRoot, "dist", "index.js"),
      'export const PI_ENTRY_STUB = "install-peer";\n',
    );
    await writeFile(
      join(otherPi, "package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        type: "module",
        exports: { ".": { import: "./dist/index.js" } },
      }),
    );
    await writeFile(
      join(otherPi, "dist", "index.js"),
      'export const PI_ENTRY_STUB = "path-pi";\n',
    );
    await writeFile(join(otherPi, "bin", "pi"), "#!/usr/bin/env node\n");
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
  origin = "http://127.0.0.1:12347";
  url = "http://127.0.0.1:12347/";
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}\n`,
    );
    await writeFile(
      join(packageRoot, "web", "trace.ts"),
      "export function traceWeb(): void {}\n",
    );
    await writeFile(
      join(packageRoot, "web", "runtime", "pi-runtime.ts"),
      `import { writeFile } from "node:fs/promises";
import { PI_ENTRY_STUB } from "@earendil-works/pi-coding-agent";

export class PiWebRuntime {
  static async createWithoutWorkspace(): Promise<{ cwd: string; dispose(): Promise<void> }> {
    const marker = process.env.OPENPI_CLI_PI_ENTRY_MARKER;
    if (marker) await writeFile(marker, PI_ENTRY_STUB);
    return {
      cwd: "/web-owned-bootstrap",
      async dispose(): Promise<void> {},
    };
  }
}\n`,
    );

    const entryMarker = join(temporaryRoot, "pi-entry");
    const childEnv = { ...process.env };
    delete childEnv.OPENPI_PI_CODING_AGENT_ENTRY;
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        join(packageRoot, "bin", "openpi.js"),
        "web",
        "--no-workspace",
        "--no-open",
      ],
      {
        env: {
          ...childEnv,
          PATH: join(otherPi, "bin"),
          OPENPI_CLI_PI_ENTRY_MARKER: entryMarker,
        },
      },
    );
    assert.match(stdout, /ready http:\/\/127\.0\.0\.1:12347/u);
    assert.equal(await readFile(entryMarker, "utf8"), "install-peer");

    const isolatedRoot = await mkdtemp(
      join(process.cwd(), ".openpi-cli-isolated-"),
    );
    await mkdir(join(isolatedRoot, "bin"), { recursive: true });
    await mkdir(join(isolatedRoot, "web", "host"), { recursive: true });
    await copyStandaloneLoader(isolatedRoot);
    await writeFile(
      join(isolatedRoot, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    try {
      await execFileAsync(
        process.execPath,
        [
          join(isolatedRoot, "bin", "openpi.js"),
          "web",
          "--no-workspace",
          "--no-open",
        ],
        {
          env: {
            ...childEnv,
            PATH: join(otherPi, "bin"),
          },
        },
      );
      assert.fail("missing peer must fail closed");
    } catch (error) {
      assert.match(
        String((error as { stderr?: string }).stderr),
        /could not resolve @earendil-works\/pi-coding-agent/u,
      );
    } finally {
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("a second SIGTERM uses default termination while stop is in flight", async () => {
  if (process.platform === "win32") return;
  const temporaryRoot = await mkdtemp(join(process.cwd(), ".openpi-cli-test-"));
  const packageRoot = join(temporaryRoot, "node_modules", "@tt-a1i", "openpi");
  const stopMarker = join(temporaryRoot, "stop-entered");
  let child: ReturnType<typeof spawn> | undefined;
  let output = "";
  let errorOutput = "";
  try {
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await mkdir(join(packageRoot, "web", "host"), { recursive: true });
    await mkdir(join(packageRoot, "web", "runtime"), { recursive: true });
    await copyStandaloneLoader(packageRoot);
    await writeOfficialPeer(temporaryRoot);
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
      `import { rename, writeFile } from "node:fs/promises";

export class WebHost {
  origin = "http://127.0.0.1:12348";
  url = "http://127.0.0.1:12348/";
  hang: ReturnType<typeof setInterval> | undefined;
  async start(): Promise<void> {
    this.hang = setInterval(() => undefined, 60_000);
  }
  async stop(): Promise<void> {
    const marker = process.env.OPENPI_CLI_STOP_ENTERED_MARKER;
    if (marker) {
      const staging = \`\${marker}.tmp\`;
      await writeFile(staging, "entered");
      await rename(staging, marker);
      process.stderr.write("stop-entered\\n");
    }
    this.hang ??= setInterval(() => undefined, 60_000);
    await new Promise(() => {});
  }
}\n`,
    );
    await writeFile(
      join(packageRoot, "web", "trace.ts"),
      "export function traceWeb(): void {}\n",
    );
    await writeFile(
      join(packageRoot, "web", "runtime", "pi-runtime.ts"),
      `export class PiWebRuntime {
  static async create(cwd: string): Promise<{ cwd: string; dispose(): Promise<void> }> {
    return { cwd, async dispose(): Promise<void> {} };
  }
}\n`,
    );

    child = spawn(
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
          OPENPI_CLI_STOP_ENTERED_MARKER: stopMarker,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout = child.stdout;
    const stderr = child.stderr;
    assert.ok(stdout);
    assert.ok(stderr);
    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    stdout.on("data", (chunk) => {
      output += chunk;
    });
    stderr.on("data", (chunk) => {
      errorOutput += chunk;
    });
    let firstKill: boolean | undefined;
    const diagnostics = () =>
      `firstKill=${String(firstKill)} code=${String(child?.exitCode)} signal=${String(child?.signalCode)} stdout=${output} stderr=${errorOutput}`;
    const closed = once(child, "close") as Promise<
      [number | null, NodeJS.Signals | null]
    >;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`installed CLI did not start; ${diagnostics()}`));
      }, 5_000);
      let sentFirst = false;
      const onStdout = () => {
        if (
          sentFirst ||
          !output.includes(
            "OpenPI Web Workbench is running at http://127.0.0.1:12348",
          )
        ) {
          return;
        }
        sentFirst = true;
        stdout.off("data", onStdout);
        clearTimeout(timeout);
        firstKill = child?.kill("SIGTERM");
        resolve();
      };
      stdout.on("data", onStdout);
    });
    assert.equal(
      firstKill,
      true,
      `first SIGTERM not delivered; ${diagnostics()}`,
    );
    await waitForPublishedMarker(
      stopMarker,
      "entered",
      5_000,
      diagnostics,
      stderr,
    );
    assert.equal(await readFile(stopMarker, "utf8"), "entered");
    child.kill("SIGTERM");
    const [exitCode, signal] = await Promise.race([
      closed,
      new Promise<[number | null, NodeJS.Signals | null]>((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `child did not exit after second SIGTERM; ${diagnostics()}`,
            ),
          );
        }, 5_000);
      }),
    ]);
    assert.equal(
      exitCode,
      null,
      `expected default SIGTERM, got code=${String(exitCode)} signal=${String(signal)} stdout=${output} stderr=${errorOutput}`,
    );
    assert.equal(signal, "SIGTERM");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        once(child, "close"),
        new Promise((resolve) => {
          setTimeout(resolve, 1_000);
        }),
      ]);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
