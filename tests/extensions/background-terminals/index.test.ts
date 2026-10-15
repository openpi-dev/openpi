import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import backgroundTerminals from "../../../extensions/background-terminals/index.ts";

type CapturedTool = {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
};

test("session start keeps only the background entry tool active", () => {
  let active = ["read", "third_party_tool"];
  const registered: string[] = [];
  let sessionStart:
    | ((event: unknown, ctx: ExtensionContext) => unknown)
    | undefined;
  const pi = {
    on(event: string, handler: unknown) {
      if (event === "session_start") {
        sessionStart = handler as typeof sessionStart;
      }
    },
    registerTool(tool: { name: string }) {
      registered.push(tool.name);
      active = [...active.filter((name) => name !== tool.name), tool.name];
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
    registerMessageRenderer() {},
    registerCommand() {},
  } as unknown as ExtensionAPI;

  backgroundTerminals(pi);
  assert.ok(sessionStart);
  sessionStart({}, { hasUI: false } as unknown as ExtensionContext);

  assert.deepEqual(registered, [
    "bg_start",
    "bg_status",
    "bg_list",
    "bg_kill",
    "bg_watch",
  ]);
  assert.deepEqual(active, ["read", "third_party_tool", "bg_start"]);
});

test("a successful start exposes lifecycle tools but a rejected start does not", async () => {
  let active: string[] = [];
  const tools = new Map<string, CapturedTool>();
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => unknown>
  >();
  const pi = {
    on(event: string, handler: unknown) {
      handlers.set(event, [
        ...(handlers.get(event) ?? []),
        handler as (event: unknown, ctx: ExtensionContext) => unknown,
      ]);
    },
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
      active = [...active.filter((name) => name !== tool.name), tool.name];
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
    registerMessageRenderer() {},
    registerCommand() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => false,
  } as unknown as ExtensionContext;

  backgroundTerminals(pi);
  for (const handler of handlers.get("session_start") ?? []) {
    await handler({}, ctx);
  }
  assert.deepEqual(active, ["bg_start"]);

  const start = tools.get("bg_start");
  assert.ok(start);
  await assert.rejects(
    start.execute(
      "bad-start",
      {
        command: 'node -e "process.exit(0)"',
        title: "bad",
        working_dir: "missing-openpi-directory",
      },
      undefined,
      undefined,
      ctx,
    ),
    /working_dir is not a directory/,
  );
  assert.deepEqual(active, ["bg_start"]);

  try {
    await start.execute(
      "good-start",
      { command: 'node -e "process.exit(0)"', title: "good" },
      undefined,
      undefined,
      ctx,
    );
    assert.deepEqual(active, [
      "bg_start",
      "bg_status",
      "bg_list",
      "bg_kill",
      "bg_watch",
    ]);
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) {
      await handler({}, ctx);
    }
  }
});

test("FAIL: an aborted multi-id bg_kill still delivers the terminal that already settled", {
  skip: process.platform === "win32",
}, async () => {
  const tools = new Map<string, CapturedTool>();
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => unknown>
  >();
  const sent: Array<{
    content: string;
    details: { id?: string; results?: Array<{ id: string }> };
  }> = [];
  let active: string[] = [];
  const pi = {
    on(event: string, handler: unknown) {
      handlers.set(event, [
        ...(handlers.get(event) ?? []),
        handler as (event: unknown, ctx: ExtensionContext) => unknown,
      ]);
    },
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
    registerMessageRenderer() {},
    registerCommand() {},
    sendMessage(message: (typeof sent)[number]) {
      sent.push(message);
    },
  } as unknown as ExtensionAPI;
  let idle = false;
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => idle,
    sessionManager: { getSessionId: () => "bg-kill-abort" },
  } as unknown as ExtensionContext;
  const emit = async (event: string) => {
    for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
  };
  const call = (
    name: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) =>
    tools.get(name)!.execute(name, params, signal, undefined, ctx) as Promise<{
      details: {
        id: string;
        terminals?: Array<{ id: string; status: string }>;
      };
    }>;
  // bg_list, unlike bg_status, never hands a settlement to the model itself.
  const statusOf = async (id: string) =>
    (await call("bg_list", {})).details.terminals?.find(
      (terminal) => terminal.id === id,
    )?.status;
  const waitFor = async (check: () => Promise<boolean> | boolean) => {
    const deadline = Date.now() + 10_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  backgroundTerminals(pi);
  await emit("session_start");
  try {
    const fast = await call("bg_start", { command: "sleep 30", title: "fast" });
    const slow = await call("bg_start", {
      command: "trap '' TERM; sleep 30",
      title: "slow",
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    const abort = new AbortController();
    const killing = call(
      "bg_kill",
      { ids: [fast.details.id, slow.details.id] },
      abort.signal,
    );
    await waitFor(async () => (await statusOf(fast.details.id)) === "killed");
    abort.abort();
    await assert.rejects(killing, /termination continues in the background/);

    await waitFor(async () => (await statusOf(slow.details.id)) !== "running");
    idle = true;
    await emit("agent_settled");
    const deliveredIds = () =>
      sent.flatMap(({ details }) =>
        details.results
          ? details.results.map((result) => result.id)
          : details.id
            ? [details.id]
            : [],
      );
    await waitFor(() =>
      [fast.details.id, slow.details.id].every((id) =>
        deliveredIds().includes(id),
      ),
    );
    // Leave room for a duplicate batch to show up before counting.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(deliveredIds().sort(), [fast.details.id, slow.details.id]);
  } finally {
    await emit("session_shutdown");
  }
});
