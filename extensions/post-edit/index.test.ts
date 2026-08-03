import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExecOptions,
  ExecResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import postEdit from "./index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(mode: ExtensionContext["mode"] = "tui") {
  const handlers = new Map<string, Handler[]>();
  const executions: Array<{
    command: string;
    args: string[];
    options?: ExecOptions;
    result: ReturnType<typeof deferred<ExecResult>>;
  }> = [];
  const notifications: string[] = [];
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: "/tmp/post-edit-test",
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    events: { on() {} },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    exec(command: string, args: string[], options?: ExecOptions) {
      const result = deferred<ExecResult>();
      executions.push({ command, args, options, result });
      return result.promise;
    },
  } as unknown as ExtensionAPI;
  postEdit(pi, () => "npm run format");

  const emit = async (event: string, value: unknown = {}) => {
    for (const handler of handlers.get(event) ?? []) {
      await handler(value, ctx);
    }
  };
  return { ctx, emit, executions, notifications };
}

const success: ExecResult = {
  stdout: "",
  stderr: "",
  code: 0,
  killed: false,
};

test("post-edit runs only in interactive TUI mode", async () => {
  for (const mode of ["rpc", "json", "print"] as const) {
    const h = harness(mode);
    await h.emit("session_start");
    await h.emit("tool_result", { toolName: "write", isError: false });
    await h.emit("agent_settled");
    assert.equal(h.executions.length, 0, `${mode} must not execute`);
  }

  const tui = harness();
  await tui.emit("session_start");
  await tui.emit("tool_result", { toolName: "edit", isError: false });
  await tui.emit("agent_settled");
  assert.equal(tui.executions.length, 1);
  assert.equal(tui.executions[0]?.options?.cwd, tui.ctx.cwd);
  tui.executions[0]?.result.resolve(success);
});

test("post-edit serially drains changed turns that settle during a run", async () => {
  const h = harness();
  await h.emit("session_start");

  await h.emit("tool_result", { toolName: "write", isError: false });
  await h.emit("agent_settled");
  assert.equal(h.executions.length, 1);

  await h.emit("tool_result", { toolName: "edit", isError: false });
  await h.emit("agent_settled");
  assert.equal(h.executions.length, 1, "the second run waits for the first");

  h.executions[0]?.result.resolve(success);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.executions.length, 2, "the pending changed turn is drained");
  h.executions[1]?.result.resolve(success);
});

test("post-edit sanitizes failure notifications", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.emit("tool_result", { toolName: "write", isError: false });
  await h.emit("agent_settled");
  h.executions[0]?.result.resolve({
    stdout: "",
    stderr: "\u001b[31mfailed\u001b[0m \u009b2J\u001b]52;c;payload\u0007safe",
    code: 1,
    killed: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(h.notifications[0] ?? "", /failed safe/);
  assert.doesNotMatch(
    h.notifications[0] ?? "",
    /payload|[\u001b\u0080-\u009f]/,
  );
});

test("post-edit aborts an in-flight command on session shutdown", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.emit("tool_result", { toolName: "write", isError: false });
  await h.emit("agent_settled");
  const signal = h.executions[0]?.options?.signal;
  assert.equal(signal?.aborted, false);

  await h.emit("session_shutdown");
  assert.equal(signal?.aborted, true);
  h.executions[0]?.result.resolve(success);
});
