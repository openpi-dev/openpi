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
