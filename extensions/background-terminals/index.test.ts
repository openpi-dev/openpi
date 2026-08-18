import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import backgroundTerminals from "./index.ts";

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
