import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const setupAgentDir = mkdtempSync(
  join(tmpdir(), "openpi-setup-session-start-"),
);
process.env.PI_CODING_AGENT_DIR = setupAgentDir;

after(() => rmSync(setupAgentDir, { recursive: true, force: true }));

const { default: setupExtension } = await import(
  "../../../extensions/setup/index.ts"
);
const { SETUP_CONFIG_PATH, inspectSetupConfig } = await import(
  "../../../extensions/shared/setup-config.ts"
);

function createHarness() {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const tools = new Map<string, { name: string }>();
  const pi = {
    events: { emit() {}, on() {} },
    registerCommand() {},
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getActiveTools: () => [],
    getAllTools: () => [...tools.keys()].map((name) => ({ name })),
    getThinkingLevel: () => "off",
    sendMessage() {},
    sendUserMessage() {},
  };
  setupExtension(pi as never);
  const notifications: Array<{ message: string; level: string | undefined }> =
    [];
  const ctx = {
    mode: "rpc",
    hasUI: true,
    cwd: "/tmp",
    ui: {
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
    },
  };
  return {
    pi,
    ctx,
    notifications,
    async emit(event: string) {
      const list = handlers.get(event) ?? [];
      for (const handler of list) await handler({ type: event }, ctx);
    },
  };
}

test("legacy unversioned file with only known fields stays quiet on session_start", async () => {
  writeFileSync(
    SETUP_CONFIG_PATH,
    '{"suggestions":{"enabled":false},"workflows":{"concurrency":8,"maxAgentCalls":128}}',
  );
  const h = createHarness();
  await h.emit("session_start");
  assert.deepEqual(h.notifications, []);
  rmSync(SETUP_CONFIG_PATH, { force: true });
});

test("legacy unversioned file with unknown fields still warns and names the path", async () => {
  writeFileSync(SETUP_CONFIG_PATH, '{"future":{"token":"PRIVATE_VALUE"}}');
  const h = createHarness();
  await h.emit("session_start");
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].level, "warning");
  assert.match(h.notifications[0].message, /warning @ future/);
  assert.match(h.notifications[0].message, /\/openpi-setup/);
  assert.doesNotMatch(
    h.notifications[0].message,
    /legacy format or unknown fields/i,
  );
  assert.doesNotMatch(h.notifications[0].message, /PRIVATE_VALUE/);
  rmSync(SETUP_CONFIG_PATH, { force: true });
});

test("malformed JSON still routes through the safe-default error branch", async () => {
  writeFileSync(SETUP_CONFIG_PATH, "{broken");
  const h = createHarness();
  await h.emit("session_start");
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].level, "error");
  assert.match(h.notifications[0].message, /safe defaults/i);
  assert.match(h.notifications[0].message, /writes are blocked/i);
  rmSync(SETUP_CONFIG_PATH, { force: true });
});

test("inspectSetupConfig agrees that the legacy-only case is silent", () => {
  writeFileSync(SETUP_CONFIG_PATH, '{"suggestions":{"enabled":false}}');
  const inspected = inspectSetupConfig();
  assert.equal(inspected.writable, true);
  assert.equal(inspected.diagnostics.length, 1);
  assert.equal(inspected.diagnostics[0].path, "configVersion");
  rmSync(SETUP_CONFIG_PATH, { force: true });
});
