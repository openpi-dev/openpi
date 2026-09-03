import { spawn as nodeSpawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface WebProcess {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

interface SpawnWebOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: "inherit";
}

function webProcessEnvironment(cwd: string) {
  const environment: NodeJS.ProcessEnv = { ...process.env, PWD: cwd };
  delete environment.OLDPWD;
  delete environment.INIT_CWD;
  delete environment.PI_SESSION_ID;
  delete environment.PI_SESSION_FILE;
  return environment;
}

export interface WebCommandDependencies {
  entrypoint: string;
  spawn(command: string, args: string[], options: SpawnWebOptions): WebProcess;
  clearTerminal(): void;
  holdParentSigint(): () => void;
  shutdownTimeoutMs: number;
}

type WebExit =
  | { kind: "close"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "error"; error: Error };

interface ActiveWebProcess {
  child: WebProcess;
  closed: Promise<void>;
}

const defaultDependencies: WebCommandDependencies = {
  entrypoint: fileURLToPath(new URL("../../bin/openpi.js", import.meta.url)),
  spawn(command, args, options) {
    return nodeSpawn(command, args, options);
  },
  clearTerminal() {
    process.stdout.write("\u001b[2J\u001b[H");
  },
  holdParentSigint() {
    const keepPiAlive = () => {};
    process.on("SIGINT", keepPiAlive);
    return () => process.removeListener("SIGINT", keepPiAlive);
  },
  shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
};

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

async function stopWebProcess(active: ActiveWebProcess, timeoutMs: number) {
  if (active.child.exitCode !== null || active.child.signalCode !== null)
    return;
  active.child.kill("SIGTERM");
  const timedOut = await Promise.race([
    active.closed.then(() => false),
    delay(timeoutMs).then(() => true),
  ]);
  if (!timedOut) return;
  if (active.child.exitCode === null && active.child.signalCode === null) {
    active.child.kill("SIGKILL");
    await Promise.race([active.closed, delay(timeoutMs)]);
  }
}

function runWebInForeground(
  ctx: ExtensionCommandContext,
  dependencies: WebCommandDependencies,
  setActive: (active: ActiveWebProcess | undefined) => void,
  isShuttingDown: () => boolean,
) {
  return ctx.ui.custom<WebExit>((tui, _theme, _keybindings, done) => {
    let finished = false;
    let tuiStopped = false;
    let resolveClosed = () => {};
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const releaseParentSigint = dependencies.holdParentSigint();

    const finish = (result: WebExit) => {
      if (finished) return;
      finished = true;
      releaseParentSigint();
      setActive(undefined);
      resolveClosed();
      if (tuiStopped && !isShuttingDown()) {
        tui.start();
        tui.requestRender(true);
      }
      done(result);
    };

    try {
      tui.stop();
      tuiStopped = true;
      dependencies.clearTerminal();
      const childCwd = dirname(dependencies.entrypoint);
      const child = dependencies.spawn(
        process.execPath,
        [dependencies.entrypoint, "web", "--no-workspace"],
        {
          cwd: childCwd,
          env: webProcessEnvironment(childCwd),
          shell: false,
          stdio: "inherit",
        },
      );
      setActive({ child, closed });
      child.once("error", (error) => finish({ kind: "error", error }));
      child.once("close", (code, signal) =>
        finish({ kind: "close", code, signal }),
      );
    } catch (error) {
      finish({
        kind: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }

    return { render: () => [], invalidate: () => {} };
  });
}

export default function web(
  pi: ExtensionAPI,
  dependencies: WebCommandDependencies = defaultDependencies,
) {
  let active: ActiveWebProcess | undefined;
  let running = false;
  let shuttingDown = false;

  pi.on("session_start", () => {
    shuttingDown = false;
  });

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    if (active) {
      await stopWebProcess(active, dependencies.shutdownTimeoutMs);
    }
  });

  pi.registerCommand("web", {
    description:
      "Open the separate OpenPI Web Workbench in this terminal until Ctrl+C",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /web", "warning");
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/web requires the interactive TUI.", "warning");
        return;
      }
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify(
          "Wait until the current Pi Session is idle before starting /web.",
          "warning",
        );
        return;
      }
      if (running) {
        ctx.ui.notify("OpenPI Web Workbench is already running.", "warning");
        return;
      }

      running = true;
      try {
        const result = await runWebInForeground(
          ctx,
          dependencies,
          (next) => {
            active = next;
          },
          () => shuttingDown,
        );
        if (shuttingDown) return;
        if (result.kind === "error") {
          ctx.ui.notify(
            `Failed to start OpenPI Web Workbench: ${result.error.message}`,
            "error",
          );
          return;
        }
        if (result.signal !== null) {
          ctx.ui.notify(
            `OpenPI Web Workbench was terminated by ${result.signal}.`,
            "error",
          );
          return;
        }
        if (result.code !== 0) {
          ctx.ui.notify(
            `OpenPI Web Workbench exited with code ${result.code ?? "unknown"}.`,
            "error",
          );
          return;
        }
        ctx.ui.notify("OpenPI Web Workbench stopped.", "info");
      } finally {
        active = undefined;
        running = false;
      }
    },
  });
}
