import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import backgroundTerminals from "../../../extensions/background-terminals/index.ts";
import { webCapabilityDetail } from "../../../extensions/shared/web-observer-registry.ts";

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

test("bg_start preserves shell-significant trailing whitespace", {
  skip: process.platform === "win32",
  timeout: 20_000,
}, async () => {
  const tools = new Map<string, CapturedTool>();
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => unknown>
  >();
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
      active.push(tool.name);
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
    registerMessageRenderer() {},
    registerCommand() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const scope = { getSessionId: () => "command-preservation" };
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => false,
    sessionManager: scope,
  } as unknown as ExtensionContext;
  backgroundTerminals(pi);
  const emit = async (event: string) => {
    for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
  };
  await emit("session_start");
  try {
    const start = tools.get("bg_start"),
      list = tools.get("bg_list");
    assert(start && list);
    const before = await list.execute("before", {}, undefined, undefined, ctx);
    await assert.rejects(
      start.execute(
        "blank",
        { command: " \t\n ", title: "blank" },
        undefined,
        undefined,
        ctx,
      ),
      /command must not be empty/,
    );
    assert.deepEqual(
      await list.execute("after", {}, undefined, undefined, ctx),
      before,
    );
    for (const command of [
      "printf %s hello",
      "printf %s hello" + String.fromCharCode(92) + " ",
    ]) {
      const control = spawnSync("/bin/sh", ["-c", command], { timeout: 5_000 });
      assert.ifError(control.error);
      assert.equal(control.status, 0);
      assert.equal(
        control.stdout.toString(),
        command.endsWith(" ") ? "hello " : "hello",
      );
      const result = (await start.execute(
        "start",
        { command, title: "command preservation", timeout_seconds: 3 },
        undefined,
        undefined,
        ctx,
      )) as { details: { id: string } };
      const deadline = Date.now() + 5_000;
      let observed = webCapabilityDetail(
        scope,
        "background-terminals",
        result.details.id,
      );
      while (
        observed.status === "found" &&
        observed.detail.status === "running" &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        observed = webCapabilityDetail(
          scope,
          "background-terminals",
          result.details.id,
        );
      }
      assert.equal(observed.status, "found");
      if (observed.status !== "found")
        assert.fail("missing registered terminal");
      const snapshot = observed.detail;
      assert.equal(snapshot.kind, "background-terminals");
      if (snapshot.kind !== "background-terminals")
        assert.fail("wrong capability kind");
      assert.equal(snapshot.status, "done");
      assert.equal(snapshot.exitCode, 0);
      assert.equal(snapshot.stdout.totalBytes, control.stdout.length);
      assert.deepEqual(Buffer.from(snapshot.stdout.text), control.stdout);
      assert.equal(snapshot.stderr.text, "");
      assert.equal(snapshot.command, command);
    }
  } finally {
    await emit("session_shutdown");
  }
});
