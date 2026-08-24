import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import workflows from "./index.ts";

test("session start keeps the complete workflow capability group stable", () => {
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
    registerCommand() {},
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI;

  workflows(pi);
  assert.ok(sessionStart);
  sessionStart({}, {
    cwd: process.cwd(),
    hasUI: false,
    mode: "print",
    isProjectTrusted: () => false,
    sessionManager: {
      getSessionId: () => "tool-surface-session",
      getEntries: () => [],
    },
    ui: {
      setStatus() {},
      setWidget() {},
    },
  } as unknown as ExtensionContext);

  assert.deepEqual(registered, [
    "workflow",
    "workflow_stop",
    "workflow_status",
  ]);
  assert.deepEqual(active, [
    "read",
    "third_party_tool",
    "workflow",
    "workflow_stop",
    "workflow_status",
  ]);
});
