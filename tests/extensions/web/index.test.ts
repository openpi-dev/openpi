import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import web, {
  type WebCommandDependencies,
  type WebProcess,
} from "../../../extensions/web/index.ts";

type CommandHandler = (
  args: string,
  ctx: ExtensionCommandContext,
) => Promise<void>;
type CustomFactory = (
  tui: {
    stop(): void;
    start(): void;
    requestRender(force?: boolean): void;
  },
  theme: unknown,
  keybindings: unknown,
  done: (value: unknown) => void,
) => unknown;

class FakeWebProcess extends EventEmitter implements WebProcess {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kills: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.kills.push(signal);
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }
}

function harness(
  options: { mode?: "tui" | "print"; idle?: boolean; stopError?: Error } = {},
) {
  const hooks = new Map<string, Array<(event: unknown) => unknown>>();
  let command: CommandHandler | undefined;
  let customCalls = 0;
  let stopped = 0;
  let started = 0;
  let rendered = 0;
  let spawnCalls = 0;
  let activeSigint = 0;
  let clearCalls = 0;
  const notifications: Array<{ message: string; level?: string }> = [];
  const children: FakeWebProcess[] = [];
  const cwd = "/workspace/current";
  const pi = {
    registerCommand(name: string, definition: { handler: CommandHandler }) {
      assert.equal(name, "web");
      command = definition.handler;
    },
    on(event: string, handler: (event: unknown) => unknown) {
      hooks.set(event, [...(hooks.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;

  const dependencies: WebCommandDependencies = {
    entrypoint: "/package/bin/openpi.js",
    spawn(commandName, args, spawnOptions) {
      spawnCalls++;
      assert.equal(commandName, process.execPath);
      assert.deepEqual(args, [
        "/package/bin/openpi.js",
        "web",
        "--no-workspace",
      ]);
      assert.equal(spawnOptions.cwd, "/package/bin");
      assert.equal(spawnOptions.env.PWD, "/package/bin");
      assert.equal(spawnOptions.env.OLDPWD, undefined);
      assert.equal(spawnOptions.env.INIT_CWD, undefined);
      assert.equal(spawnOptions.env.PI_SESSION_ID, undefined);
      assert.equal(spawnOptions.env.PI_SESSION_FILE, undefined);
      assert.equal(spawnOptions.env.PATH, process.env.PATH);
      assert.equal(spawnOptions.shell, false);
      assert.equal(spawnOptions.stdio, "inherit");
      const child = new FakeWebProcess();
      children.push(child);
      return child;
    },
    clearTerminal() {
      clearCalls++;
    },
    holdParentSigint() {
      activeSigint++;
      return () => {
        activeSigint--;
      };
    },
    shutdownTimeoutMs: 20,
  };

  const ctx = {
    cwd,
    mode: options.mode ?? "tui",
    isIdle: () => options.idle ?? true,
    hasPendingMessages: () => false,
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
      custom(factory: CustomFactory) {
        customCalls++;
        return new Promise((resolve) => {
          factory(
            {
              stop() {
                if (options.stopError) throw options.stopError;
                stopped++;
              },
              start() {
                started++;
              },
              requestRender(force?: boolean) {
                assert.equal(force, true);
                rendered++;
              },
            },
            {},
            {},
            resolve,
          );
        });
      },
    },
  } as unknown as ExtensionCommandContext;

  web(pi, dependencies);

  const run = (args = "") => {
    assert.ok(command);
    return command(args, ctx);
  };
  const emit = async (event: string, payload: unknown = {}) => {
    for (const handler of hooks.get(event) ?? []) await handler(payload);
  };

  return {
    run,
    emit,
    children,
    notifications,
    customCalls: () => customCalls,
    stopped: () => stopped,
    started: () => started,
    rendered: () => rendered,
    spawnCalls: () => spawnCalls,
    activeSigint: () => activeSigint,
    clearCalls: () => clearCalls,
  };
}

test("/web hands the terminal to the exact packaged Web CLI and restores Pi", async () => {
  const previousSessionId = process.env.PI_SESSION_ID;
  const previousSessionFile = process.env.PI_SESSION_FILE;
  process.env.PI_SESSION_ID = "terminal-session";
  process.env.PI_SESSION_FILE = "/tmp/terminal-session.jsonl";
  const h = harness();
  try {
    const running = h.run();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(h.spawnCalls(), 1);
    assert.equal(h.stopped(), 1);
    assert.equal(h.clearCalls(), 1);
    assert.equal(h.activeSigint(), 1);
    assert.equal(h.started(), 0);

    h.children[0]!.close(0);
    await running;

    assert.equal(h.activeSigint(), 0);
    assert.equal(h.started(), 1);
    assert.equal(h.rendered(), 1);
    assert.deepEqual(h.notifications.at(-1), {
      message: "OpenPI Web Workbench stopped.",
      level: "info",
    });
  } finally {
    if (previousSessionId === undefined) delete process.env.PI_SESSION_ID;
    else process.env.PI_SESSION_ID = previousSessionId;
    if (previousSessionFile === undefined) delete process.env.PI_SESSION_FILE;
    else process.env.PI_SESSION_FILE = previousSessionFile;
  }
});

test("/web rejects unsupported modes, arguments, busy sessions, and duplicates", async () => {
  const print = harness({ mode: "print" });
  await print.run();
  assert.equal(print.spawnCalls(), 0);
  assert.match(print.notifications.at(-1)?.message ?? "", /interactive TUI/u);

  const args = harness();
  await args.run("/tmp/other");
  assert.equal(args.spawnCalls(), 0);
  assert.match(args.notifications.at(-1)?.message ?? "", /Usage: \/web/u);

  const busy = harness({ idle: false });
  await busy.run();
  assert.equal(busy.spawnCalls(), 0);
  assert.match(busy.notifications.at(-1)?.message ?? "", /idle/u);

  const duplicate = harness();
  const running = duplicate.run();
  await new Promise((resolve) => setImmediate(resolve));
  await duplicate.run();
  assert.equal(duplicate.spawnCalls(), 1);
  assert.match(
    duplicate.notifications.at(-1)?.message ?? "",
    /already running/u,
  );
  duplicate.children[0]!.close(0);
  await running;
});

test("/web restores the TUI and reports startup or process failures", async () => {
  const h = harness();
  const running = h.run();
  await new Promise((resolve) => setImmediate(resolve));
  h.children[0]!.emit("error", new Error("spawn failed"));
  await running;

  assert.equal(h.activeSigint(), 0);
  assert.equal(h.started(), 1);
  assert.equal(h.rendered(), 1);
  assert.match(h.notifications.at(-1)?.message ?? "", /spawn failed/u);

  const nonzero = harness();
  const failed = nonzero.run();
  await new Promise((resolve) => setImmediate(resolve));
  nonzero.children[0]!.close(2);
  await failed;
  assert.match(nonzero.notifications.at(-1)?.message ?? "", /code 2/u);

  const signalled = harness();
  const terminated = signalled.run();
  await new Promise((resolve) => setImmediate(resolve));
  signalled.children[0]!.close(null, "SIGKILL");
  await terminated;
  assert.deepEqual(signalled.notifications.at(-1), {
    message: "OpenPI Web Workbench was terminated by SIGKILL.",
    level: "error",
  });

  const stopFailure = harness({ stopError: new Error("terminal unavailable") });
  await stopFailure.run();
  assert.equal(stopFailure.activeSigint(), 0);
  assert.equal(stopFailure.started(), 0);
  assert.match(
    stopFailure.notifications.at(-1)?.message ?? "",
    /terminal unavailable/u,
  );
});

test("session shutdown terminates the foreground Web process without repainting stale TUI", async () => {
  const h = harness();
  const running = h.run();
  await new Promise((resolve) => setImmediate(resolve));

  const shutdown = h.emit("session_shutdown", {
    type: "session_shutdown",
    reason: "quit",
  });
  assert.deepEqual(h.children[0]!.kills, ["SIGTERM"]);
  h.children[0]!.close(0, "SIGTERM");
  await Promise.all([running, shutdown]);

  assert.equal(h.activeSigint(), 0);
  assert.equal(h.started(), 0);
  assert.equal(h.rendered(), 0);
});

test("session shutdown force-kills a Web child that misses its graceful deadline", async () => {
  const h = harness();
  const running = h.run();
  await new Promise((resolve) => setImmediate(resolve));

  const shutdown = h.emit("session_shutdown", {
    type: "session_shutdown",
    reason: "quit",
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(h.children[0]!.kills, ["SIGTERM", "SIGKILL"]);
  h.children[0]!.close(null, "SIGKILL");
  await Promise.all([running, shutdown]);

  assert.equal(h.activeSigint(), 0);
  assert.equal(h.started(), 0);
});
