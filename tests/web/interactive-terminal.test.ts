import assert from "node:assert/strict";
import test from "node:test";
import type { IDisposable, IPty } from "node-pty";
import {
  INTERACTIVE_TERMINAL_MAX_BACKLOG,
  INTERACTIVE_TERMINAL_MAX_INPUT,
  InteractiveTerminalManager,
} from "../../web/host/interactive-terminal.ts";
import type { WebInteractiveTerminalEvent } from "../../web/protocol/types.ts";

class FakePty implements IPty {
  readonly pid = 42;
  cols = 80;
  rows = 24;
  readonly process = "fixture-shell";
  handleFlowControl = false;
  readonly writes: Array<string | Buffer> = [];
  readonly kills: Array<string | undefined> = [];
  private readonly dataListeners = new Set<(data: string) => unknown>();
  private readonly exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => unknown
  >();

  readonly onData = (listener: (data: string) => unknown): IDisposable => {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  };

  readonly onExit = (
    listener: (event: { exitCode: number; signal?: number }) => unknown,
  ): IDisposable => {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  };

  resize(columns: number, rows: number) {
    this.cols = columns;
    this.rows = rows;
  }

  clear() {}

  write(data: string | Buffer) {
    this.writes.push(data);
  }

  kill(signal?: string) {
    this.kills.push(signal);
  }

  pause() {}

  resume() {}

  emitData(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(exitCode: number) {
    for (const listener of this.exitListeners) listener({ exitCode });
  }
}

for (const action of ["close", "retain", "dispose"] as const) {
  test(`Windows PTY ${action} uses the native signal-free termination API`, {
    skip: process.platform !== "win32",
  }, async () => {
    const pty = new FakePty();
    pty.kill = (signal?: string) => {
      assert.equal(signal, undefined, "node-pty on Windows rejects signals");
      pty.kills.push(signal);
      pty.emitExit(0);
    };
    const manager = new InteractiveTerminalManager({ spawn: () => pty });
    const terminal = await manager.create({
      sessionId: "windows-session",
      cwd: ".",
      cols: 80,
      rows: 24,
    });
    const events: WebInteractiveTerminalEvent[] = [];
    manager.subscribe("windows-session", terminal.id, (event) =>
      events.push(event),
    );
    if (action === "close") manager.close("windows-session", terminal.id, true);
    else if (action === "retain") manager.retain("next-session", ".");
    else manager.dispose();
    assert.deepEqual(pty.kills, [undefined]);
    assert.equal(manager.get("windows-session", terminal.id), undefined);
    assert.ok(events.some((event) => event.type === "closed"));
    manager.dispose();
  });
}

test("Windows native PTY exits when its manager is disposed", {
  skip: process.platform !== "win32",
  timeout: 10_000,
}, async () => {
  const { spawn } = await import("node-pty");
  const pty = spawn(process.env.ComSpec ?? "cmd.exe", [], {
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
  });
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    pty.onExit(() => {
      exited = true;
      resolve();
    });
  });
  const manager = new InteractiveTerminalManager({ spawn: () => pty });
  try {
    await manager.create({
      sessionId: "native-windows",
      cwd: ".",
      cols: 80,
      rows: 24,
    });
    manager.dispose();
    await exit;
    assert.equal(exited, true);
  } finally {
    if (!exited) pty.kill();
  }
});

test("reuses one bounded PTY per Session and replays exact output cursors", async () => {
  const pty = new FakePty();
  const spawn: typeof import("node-pty").spawn = (_file, _args, options) => {
    pty.cols = options.cols ?? 80;
    pty.rows = options.rows ?? 24;
    return pty;
  };
  const manager = new InteractiveTerminalManager({
    spawn,
    cleanupMs: 60_000,
    maxTerminals: 1,
  });
  const created = await manager.create({
    sessionId: "session-a",
    cwd: ".",
    cols: 1,
    rows: 2_000,
  });
  assert.equal(created.reused, false);
  assert.equal(pty.cols, 2);
  assert.equal(pty.rows, 1_000);
  assert.equal(
    (
      await manager.create({
        sessionId: "session-a",
        cwd: ".",
        cols: 80,
        rows: 24,
      })
    ).reused,
    true,
  );

  assert.equal(manager.write("session-a", created.id, "pwd\r"), true);
  assert.equal(
    manager.write(
      "session-a",
      created.id,
      "x".repeat(INTERACTIVE_TERMINAL_MAX_INPUT + 1),
    ),
    false,
  );
  assert.deepEqual(pty.writes, ["pwd\r"]);
  assert.equal(manager.resize("session-a", created.id, 120, 40), true);
  assert.equal(pty.cols, 120);
  assert.equal(pty.rows, 40);

  const output = "x".repeat(INTERACTIVE_TERMINAL_MAX_BACKLOG + 20);
  pty.emitData(output);
  const events: WebInteractiveTerminalEvent[] = [];
  const first = manager.subscribe("session-a", created.id, (event) =>
    events.push(event),
  );
  assert.ok(first);
  assert.equal(first.output.reset, true);
  assert.equal(first.output.data.length, INTERACTIVE_TERMINAL_MAX_BACKLOG);
  assert.equal(first.output.offset, output.length);
  first.unsubscribe();

  const replay = manager.subscribe(
    "session-a",
    created.id,
    (event) => events.push(event),
    output.length - 7,
  );
  assert.ok(replay);
  assert.equal(replay.output.reset, false);
  assert.equal(replay.output.data, "x".repeat(7));
  pty.emitData("ready");
  assert.deepEqual(events.at(-1), {
    type: "output",
    data: "ready",
    offset: output.length + 5,
  });
  pty.emitExit(7);
  assert.deepEqual(events.at(-1), { type: "exit", exitCode: 7 });
  replay.unsubscribe();

  assert.equal(manager.close("session-a", created.id), true);
  assert.equal(manager.get("session-a", created.id), undefined);
  manager.dispose();
});

test("deduplicates concurrent creates and reserves capacity before loading the PTY", async () => {
  const ptys: FakePty[] = [];
  const spawn: typeof import("node-pty").spawn = () => {
    const pty = new FakePty();
    ptys.push(pty);
    return pty;
  };
  const manager = new InteractiveTerminalManager({
    spawn,
    cleanupMs: 60_000,
    maxTerminals: 1,
  });

  const first = manager.create({
    sessionId: "session-a",
    cwd: ".",
    cols: 80,
    rows: 24,
  });
  const duplicate = manager.create({
    sessionId: "session-a",
    cwd: ".",
    cols: 120,
    rows: 40,
  });
  const overCapacity = manager.create({
    sessionId: "session-b",
    cwd: ".",
    cols: 80,
    rows: 24,
  });

  const [created, reused] = await Promise.all([first, duplicate]);
  assert.equal(ptys.length, 1);
  assert.equal(created.id, reused.id);
  assert.equal(created.reused, false);
  assert.equal(reused.reused, true);
  await assert.rejects(overCapacity, /capacity is full/u);
  assert.equal(ptys.length, 1);
  manager.dispose();
});

test("cancels pending creates when the retained Session changes or the manager disposes", async () => {
  const scenarios = ["retain", "dispose"] as const;
  for (const scenario of scenarios) {
    const ptys: FakePty[] = [];
    let release!: (spawn: typeof import("node-pty").spawn) => void;
    const delayedSpawn = new Promise<typeof import("node-pty").spawn>(
      (resolve) => {
        release = resolve;
      },
    );
    const manager = new InteractiveTerminalManager({ maxTerminals: 1 });
    const internals = manager as unknown as {
      loadSpawn: () => Promise<typeof import("node-pty").spawn>;
    };
    internals.loadSpawn = () => delayedSpawn;

    const pending = manager.create({
      sessionId: "session-a",
      cwd: ".",
      cols: 80,
      rows: 24,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (scenario === "retain") manager.retain("session-b", ".");
    else manager.dispose();
    release(() => {
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    });

    await assert.rejects(pending, /creation was cancelled/u);
    assert.equal(ptys.length, 0, scenario);
    const replacement = await manager.create({
      sessionId: "session-b",
      cwd: ".",
      cols: 80,
      rows: 24,
    });
    assert.equal(replacement.sessionId, "session-b");
    assert.equal(ptys.length, 1, scenario);
    manager.dispose();
  }
});
