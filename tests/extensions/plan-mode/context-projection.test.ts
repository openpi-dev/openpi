import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import planMode, {
  BLOCK_REASON,
  PLAN_MODE_STATE_ENTRY,
} from "../../../extensions/plan-mode/index.ts";

// Package configuration uses Pi's process-level agent directory (same
// isolation as the shared tool-surface fixture).
let restoreAgentDirectory = () => {};
beforeEach(() => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = mkdtempSync(path.join(tmpdir(), "openpi-plan-context-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  restoreAgentDirectory = () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  };
});
afterEach(() => restoreAgentDirectory());

test("plan reminders anchor at their state entry so every request stays a prefix of the next", {
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openpi-plan-anchor-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(cwd, "probe.txt"), "hello probe\n");

  const requests: unknown[][] = [];
  const provider = fauxProvider({
    api: "openpi-plan-anchor-test",
    provider: `plan-anchor-${path.basename(cwd)}`,
    models: [{ id: "fixture", name: "Fixture", reasoning: false }],
  });
  provider.setResponses(
    [
      () =>
        fauxAssistantMessage(
          [fauxToolCall("read", { path: "probe.txt" }, { id: "r1" })],
          { stopReason: "toolUse" },
        ),
      () => fauxAssistantMessage("Read it."),
      () => fauxAssistantMessage("Done."),
    ].map((response) => (context: TranscriptContext) => {
      requests.push([...context.messages]);
      return response();
    }),
  );

  const settingsManager = SettingsManager.inMemory(
    { retry: { enabled: false }, compaction: { enabled: false } },
    { projectTrusted: false },
  );
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  modelRuntime.registerNativeProvider(provider.provider);
  await modelRuntime.setRuntimeApiKey(provider.provider.id, "fixture-key");

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [
      fileURLToPath(
        new URL("../../../extensions/plan-mode/index.ts", import.meta.url),
      ),
    ],
    noSkills: true,
    noPromptTemplates: true,
  });
  await loader.reload();

  const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model: provider.getModel(),
    modelRuntime,
    settingsManager,
    resourceLoader: loader,
    sessionManager,
  });
  try {
    // Persist an inactive plan entry before session_start, the same write
    // commitPlanState performs when the user exits planning.
    sessionManager.appendCustomEntry(PLAN_MODE_STATE_ENTRY, {
      version: 1,
      status: "inactive",
    });
    await session.bindExtensions({ mode: "print" });

    await session.prompt("first prompt");
    await session.waitForIdle();
    await session.prompt("second prompt");
    await session.waitForIdle();

    assert.ok(
      requests.length >= 3,
      `expected at least 3 provider requests, got ${requests.length}`,
    );
    for (let index = 0; index < requests.length - 1; index++) {
      const current = requests[index]!;
      const next = requests[index + 1]!;
      assert.deepEqual(
        next.slice(0, current.length),
        current,
        `request ${index} must be an exact prefix of request ${index + 1}`,
      );
    }
    for (const [index, messages] of requests.entries()) {
      const reminders = messages.filter((message) =>
        JSON.stringify(message).includes("Plan mode is inactive"),
      );
      assert.equal(
        reminders.length,
        1,
        `request ${index} must carry the inactive reminder exactly once`,
      );
      // Custom messages project to a plain user-role message on the wire.
      const reminder = reminders[0] as { role?: string };
      assert.equal(reminder.role, "user");
    }
    // The anchored reminder holds one fixed position across requests.
    const positions = requests.map((messages) =>
      messages.findIndex((message) =>
        JSON.stringify(message).includes("Plan mode is inactive"),
      ),
    );
    assert.equal(new Set(positions).size, 1);
  } finally {
    session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

// Harness mirrors tests/extensions/plan-mode/control.test.ts: a mutable
// branch and an emit() that drives the extension's real event handlers.
function harness() {
  const branch: Array<Record<string, unknown>> = [];
  const handlers = new Map<
    string,
    (event: never, ctx: ExtensionContext) => unknown
  >();
  const ctx = {
    hasUI: false,
    isIdle: () => true,
    sessionManager: { getBranch: () => branch },
    ui: { notify() {}, setStatus() {} },
  } as unknown as ExtensionContext;
  planMode({
    registerTool() {},
    registerCommand() {},
    getActiveTools: () => [],
    setActiveTools() {},
    events: { emit() {} },
    on: (
      name: string,
      handler: (event: never, ctx: ExtensionContext) => unknown,
    ) => handlers.set(name, handler),
    appendEntry(customType: string, data: unknown) {
      branch.push({
        type: "custom",
        customType,
        data,
        id: `entry-${branch.length}`,
        timestamp: new Date().toISOString(),
      });
    },
    sendMessage() {},
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: unknown = {}) =>
    handlers.get(name)?.(event as never, ctx);
  emit("session_start");
  return { branch, ctx, emit };
}

const planEntry = (timestampMs: number, data: Record<string, unknown>) => ({
  type: "custom",
  customType: PLAN_MODE_STATE_ENTRY,
  data,
  id: `entry-${timestampMs}`,
  timestamp: new Date(timestampMs).toISOString(),
});

test("reminders project in branch order at their anchors and never split a tool call from its results", () => {
  const h = harness();
  // planning armed mid-history, a duplicate planning re-arm (dedup), then a
  // mid-turn plan_ready commit landing between the assistant call and its
  // toolResult.
  h.branch.push(
    planEntry(500, { version: 1, status: "planning" }),
    planEntry(700, { version: 1, status: "planning" }),
    planEntry(3000, {
      version: 1,
      status: "ready",
      plan: "# Plan",
    }),
  );
  const messages = [
    { role: "user", content: "inspect", timestamp: 100 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "plan_ready" }],
      timestamp: 2000,
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "plan_ready",
      content: [{ type: "text", text: "Plan ready." }],
      timestamp: 4000,
    },
  ];

  const projection = h.emit("context", { messages }) as {
    messages: Array<Record<string, unknown>>;
  };
  const projected = projection.messages;
  const reminders = projected
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.customType === "openpi-plan-context");

  assert.equal(reminders.length, 2, "consecutive same-state entries dedup");
  assert.equal(reminders[0]!.message.content, BLOCK_REASON);
  assert.match(
    String(reminders[1]!.message.content),
    /plan is ready[\s\S]*Do not start implementation/,
  );
  // The planning reminder anchors at its entry: before the assistant turn.
  assert.equal(reminders[0]!.index, 1);
  assert.equal(projected[2]!.role, "assistant");
  // The ready reminder must not sit between the tool call and its result.
  assert.equal(projected[3]!.role, "toolResult");
  assert.equal(reminders[1]!.index, 4);
  // Injected timestamps are deterministic (the entry's own time).
  assert.equal(reminders[0]!.message.timestamp, 500);
  assert.equal(reminders[1]!.message.timestamp, 3000);
  // Re-projection is idempotent.
  assert.deepEqual(h.emit("context", projection), projection);
});

test("a malformed state entry fails closed to the blocked reminder at its anchor", () => {
  const h = harness();
  h.branch.push(
    planEntry(500, {
      version: 1,
      status: "ready",
      plan: "# Plan",
      extra: true,
    }),
  );
  const messages = [
    { role: "user", content: "before", timestamp: 100 },
    { role: "user", content: "after", timestamp: 1000 },
  ];
  const projection = h.emit("context", { messages }) as {
    messages: Array<Record<string, unknown>>;
  };
  assert.equal(projection.messages[1]!.customType, "openpi-plan-context");
  assert.equal(projection.messages[1]!.content, BLOCK_REASON);
});

test("transitions with no message between them project only the latest state", () => {
  const h = harness();
  h.branch.push(
    planEntry(500, { version: 1, status: "planning" }),
    planEntry(600, { version: 1, status: "inactive" }),
  );
  const messages = [
    { role: "user", content: "before", timestamp: 100 },
    { role: "user", content: "after", timestamp: 1000 },
  ];
  const projection = h.emit("context", { messages }) as {
    messages: Array<Record<string, unknown>>;
  };
  const reminders = projection.messages.filter(
    (message) => message.customType === "openpi-plan-context",
  );
  assert.equal(reminders.length, 1);
  assert.match(String(reminders[0]!.content), /Plan mode is inactive/);
  assert.equal(projection.messages[1], reminders[0]);
});
