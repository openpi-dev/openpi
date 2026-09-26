import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type {
  ExecOptions,
  ExecResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import postEdit from "../../../extensions/post-edit/index.ts";
import { SETUP_CONFIG_CHANGED_CHANNEL } from "../../../extensions/shared/setup-config.ts";
import {
  applySetupConfiguration,
  onSetupApply,
} from "../../../extensions/shared/setup-apply.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function harness(
  mode: ExtensionContext["mode"] = "tui",
  command = "npm run format",
) {
  const handlers = new Map<string, Handler[]>();
  const events = createEventBus();
  const executions: Array<{
    command: string;
    args: string[];
    options?: ExecOptions;
    result: ReturnType<typeof deferred<ExecResult>>;
  }> = [];
  const notifications: string[] = [];
  const controller = new AbortController();
  const ctx = {
    mode,
    signal: controller.signal,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: "/tmp/post-edit-test",
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    events,
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    exec(command: string, args: string[], options?: ExecOptions) {
      const result = deferred<ExecResult>();
      executions.push({ command, args, options, result });
      return result.promise;
    },
  } as unknown as ExtensionAPI;
  postEdit(pi, () => command);

  const emit = async (event: string, value: unknown = {}) => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) {
      result = await handler(value, ctx);
    }
    return result;
  };
  const applyCommand = async (value: string) => {
    command = value;
    await applySetupConfiguration(pi);
  };
  const configure = async (value: string) => {
    await applyCommand(value);
    events.emit(SETUP_CONFIG_CHANGED_CHANNEL, {});
  };
  return {
    ctx,
    emit,
    executions,
    notifications,
    configure,
    applyCommand,
    pi,
    controller,
  };
}

const success: ExecResult = {
  stdout: "",
  stderr: "",
  code: 0,
  killed: false,
};

const expectedShellArgs = (command: string) =>
  process.platform === "win32"
    ? [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `${command}; exit $LASTEXITCODE`,
      ]
    : ["-c", command];

const expectedShellCommand = () =>
  process.platform === "win32" ? "powershell.exe" : "sh";

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
  assert.equal(tui.executions[0]?.command, expectedShellCommand());
  assert.deepEqual(
    tui.executions[0]?.args,
    expectedShellArgs("npm run format"),
  );
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

test("post-edit independently bounds the command and output in failure notifications", async () => {
  const h = harness("tui", "x".repeat(500));
  await h.emit("session_start");
  await h.emit("tool_result", { toolName: "write", isError: false });
  await h.emit("agent_settled");
  h.executions[0]?.result.resolve({
    stdout: "",
    stderr: "y".repeat(1_000),
    code: 127,
    killed: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  const notice = h.notifications[0] ?? "";
  assert.match(notice, /exit 127/);
  assert.match(notice, /x+…/);
  assert.match(notice, /y+…/);
  assert.ok([...notice].length < 600, "notification must stay compact");
  assert.doesNotMatch(notice, /x{200}|y{400}/);
});

test("post-edit bounds execution errors before notifying", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.emit("tool_result", { toolName: "write", isError: false });
  await h.emit("agent_settled");
  h.executions[0]?.result.reject(new Error("z".repeat(1_000)));
  await new Promise((resolve) => setImmediate(resolve));

  const notice = h.notifications[0] ?? "";
  assert.match(notice, /could not run/);
  assert.match(notice, /z+…/);
  assert.ok([...notice].length < 400, "execution error must stay compact");
  assert.doesNotMatch(notice, /z{400}/);
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

test("post-edit joins the active and queued runs before starting the next agent", async () => {
  const h = harness();
  await h.emit("tool_result", { toolName: "write", isError: false });
  await h.emit("agent_settled");
  await h.emit("tool_result", { toolName: "edit", isError: false });
  await h.emit("agent_settled");
  let started = false;
  const next = h.emit("agent_start").then(() => {
    started = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, false);
  h.executions[0]?.result.resolve(success);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.executions.length, 2);
  assert.equal(started, false);
  h.executions[1]?.result.resolve(success);
  await next;
  assert.equal(started, true);
});

test("post-edit fences every tool when a formatter is scheduled after agent start", async () => {
  for (const toolName of [
    "write",
    "edit",
    "bash",
    "read",
    "grep",
    "find",
    "ls",
    "custom_reader",
  ]) {
    const h = harness();
    await h.emit("agent_start");
    await h.emit("tool_result", { toolName: "write", isError: false });
    await h.emit("agent_settled");
    let continued = false;
    const call = h.emit("tool_call", { toolName }).then(() => {
      continued = true;
    });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(continued, false, toolName);
    } finally {
      h.executions[0]?.result.resolve(success);
      await call;
    }
    assert.equal(continued, true);
  }
});

test("post-edit admits tools without an outstanding command and reads do not schedule one", async () => {
  const h = harness();
  for (const toolName of ["read", "grep", "find", "ls", "custom_reader"]) {
    assert.equal(await h.emit("tool_call", { toolName }), undefined);
    await h.emit("tool_result", { toolName, isError: false });
  }
  await h.emit("agent_settled");
  assert.equal(h.executions.length, 0);
});

test("post-edit snapshots queued command and cwd rather than reinterpreting config", async () => {
  const h = harness("tui", "format-one");
  await h.emit("tool_result", { toolName: "write", isError: false });
  await h.emit("agent_settled");
  await h.configure("format-two");
  await h.emit("tool_result", { toolName: "edit", isError: false });
  await h.emit("agent_settled");
  await h.configure("format-three");
  h.executions[0]?.result.resolve(success);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.executions[1]?.args, expectedShellArgs("format-two"));
  assert.equal(h.executions[1]?.options?.cwd, h.ctx.cwd);
  h.executions[1]?.result.resolve(success);
});

test("disabling post-edit drops queued work but still joins the active command", async () => {
  const h = harness();
  for (let i = 0; i < 2; i++) {
    await h.emit("tool_result", { toolName: "edit", isError: false });
    await h.emit("agent_settled");
  }
  await h.configure("");
  let continued = false;
  const next = h.emit("agent_start").then(() => {
    continued = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(continued, false);
  assert.equal(h.executions[0]?.options?.signal?.aborted, false);
  h.executions[0]?.result.resolve(success);
  await next;
  assert.equal(h.executions.length, 1);
});

test("a failed disable apply preserves queued post-edit work for rollback", async () => {
  const h = harness("tui", "format-original");
  for (let i = 0; i < 2; i++) {
    await h.emit("tool_result", { toolName: "edit", isError: false });
    await h.emit("agent_settled");
  }
  const unsubscribe = onSetupApply(h.pi, () => {
    throw new Error("Another consumer failed");
  });
  await assert.rejects(h.applyCommand(""), /Configuration consumer failed/);
  unsubscribe();
  await h.applyCommand("format-original");
  let continued = false;
  const next = h.emit("agent_start").then(() => {
    continued = true;
  });
  h.executions[0]?.result.resolve(success);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(continued, false);
  assert.deepEqual(h.executions[1]?.args, expectedShellArgs("format-original"));
  h.executions[1]?.result.resolve(success);
  await next;
  assert.equal(continued, true);
});

test("session reset requests cancellation without releasing a still-running command", async () => {
  const h = harness();
  await h.emit("tool_result", { toolName: "edit", isError: false });
  await h.emit("agent_settled");
  const oldCall = h.emit("tool_call", { toolName: "write" });
  await h.emit("session_start");
  assert.equal(h.executions[0]?.options?.signal?.aborted, true);
  await h.emit("tool_result", { toolName: "write", isError: false });
  await h.emit("agent_settled");
  assert.equal(h.executions.length, 1, "abort requested does not mean exited");
  h.executions[0]?.result.resolve({ ...success, killed: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.executions.length, 2);
  h.executions[1]?.result.resolve(success);
  const result = await oldCall;
  assert.equal((result as { block: boolean }).block, true);
  assert.deepEqual(h.notifications, [], "old session results stay silent");
});

test("killed with exit zero is reported as interrupted and releases the next turn", async () => {
  const h = harness();
  await h.emit("tool_result", { toolName: "write", isError: false });
  await h.emit("agent_settled");
  const next = h.emit("agent_start");
  h.executions[0]?.result.resolve({ ...success, killed: true });
  await next;
  assert.match(h.notifications[0] ?? "", /interrupted/);
});

test("only successful native writes schedule one command per settled turn", async () => {
  const h = harness();
  for (const event of [
    { toolName: "write", isError: true },
    { toolName: "edit", isError: true },
    { toolName: "bash", isError: false },
    { toolName: "read", isError: false },
  ])
    await h.emit("tool_result", event);
  await h.emit("agent_settled");
  assert.equal(h.executions.length, 0);
  await h.emit("tool_result", { toolName: "write", isError: false });
  await h.emit("tool_result", { toolName: "edit", isError: false });
  await h.emit("agent_settled");
  await h.emit("agent_settled");
  assert.equal(h.executions.length, 1);
  h.executions[0]?.result.resolve(success);
});

test("canceling a waiting Agent unblocks teardown without releasing its command", async () => {
  for (const [event, toolName] of [
    ["agent_start", ""],
    ["tool_call", "write"],
    ["tool_call", "read"],
    ["tool_call", "custom_reader"],
  ] as const) {
    const h = harness();
    await h.emit("tool_result", { toolName: "write", isError: false });
    await h.emit("agent_settled");
    const wait = h.emit(event, { toolName });
    h.controller.abort();
    const result = await wait;
    if (event === "tool_call")
      assert.equal((result as { block: boolean }).block, true);
    assert.equal(h.executions[0]?.options?.signal?.aborted, false);
    await h.emit("session_shutdown");
    assert.equal(h.executions[0]?.options?.signal?.aborted, true);
    h.executions[0]?.result.resolve({ ...success, killed: true });
  }
});
