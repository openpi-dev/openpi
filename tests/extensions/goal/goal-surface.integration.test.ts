import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { createGoalSnapshot } from "../../../extensions/goal/state.ts";

const CAPABILITIES_EXTENSION = fileURLToPath(
  new URL("../../../extensions/capabilities/index.ts", import.meta.url),
);
const GOAL_EXTENSION = fileURLToPath(
  new URL("../../../extensions/goal/index.ts", import.meta.url),
);

interface CapturedSnapshot {
  tools?: Array<{ name: string }>;
  messages: Array<{
    role: string;
    content: unknown;
  }>;
}

test("real Pi fixture: /goal <objective> loads capability and exposes get_goal/update_goal to continuation", {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openpi-goal-surface-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const snapshots: CapturedSnapshot[] = [];
  const provider = fauxProvider({
    api: "openpi-goal-surface-test",
    provider: `goal-surface-${path.basename(cwd)}`,
    models: [{ id: "fixture", name: "Fixture", reasoning: false }],
  });

  const capture = (context: {
    tools?: Array<{ name: string }>;
    messages: Array<{ role: string; content: unknown }>;
  }) => {
    snapshots.push({
      tools: context.tools?.map(({ name }) => ({ name })),
      messages: structuredClone(context.messages),
    });
  };

  // Response 1: model executes on first continuation, then calls update_goal({ status: "complete" })
  provider.setResponses([
    (context) => {
      capture(context);
      return fauxAssistantMessage(
        [
          fauxToolCall(
            "update_goal",
            { status: "complete" },
            { id: "finish-1" },
          ),
        ],
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      capture(context);
      return fauxAssistantMessage("Goal complete and verified.");
    },
  ]);

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
    additionalExtensionPaths: [CAPABILITIES_EXTENSION, GOAL_EXTENSION],
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
    await session.bindExtensions({ mode: "rpc" });

    // 1. Clean session invariant: no resident OpenPI model tools
    const initialTools = session.getActiveToolNames();
    assert.equal(initialTools.includes("create_goal"), false);
    assert.equal(initialTools.includes("get_goal"), false);
    assert.equal(initialTools.includes("update_goal"), false);
    assert.equal(initialTools.includes("openpi_load_tools"), false);

    // 2. User runs /goal <objective> with an objective containing NO capability keywords
    await session.prompt("/goal 修复 README 的一个拼写错误");
    await session.waitForIdle();

    // 3. Active tools now include get_goal and update_goal
    const activeToolsAfterGoal = session.getActiveToolNames();
    assert.ok(
      activeToolsAfterGoal.includes("get_goal"),
      "get_goal must be active",
    );
    assert.ok(
      activeToolsAfterGoal.includes("update_goal"),
      "update_goal must be active",
    );
    assert.ok(
      activeToolsAfterGoal.includes("create_goal"),
      "create_goal must be active",
    );

    // 4. First continuation turn ran: verify provider snapshot contains get_goal and update_goal
    assert.ok(snapshots.length >= 1, "at least one turn must have run");
    const firstTurnTools = snapshots[0]?.tools?.map((t) => t.name) ?? [];
    assert.ok(
      firstTurnTools.includes("get_goal"),
      "provider snapshot must include get_goal",
    );
    assert.ok(
      firstTurnTools.includes("update_goal"),
      "provider snapshot must include update_goal",
    );

    // 5. Model called update_goal complete -> session settles, no extra continuations dispatched
    assert.equal(snapshots.length, 2); // turn 1 tool call, turn 2 final response
  } finally {
    session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("real Pi fixture: reload restores get_goal/update_goal for active goal", {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openpi-goal-reload-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const provider = fauxProvider({
    api: "openpi-goal-reload-test",
    provider: `goal-reload-${path.basename(cwd)}`,
    models: [{ id: "fixture", name: "Fixture", reasoning: false }],
  });

  // Keep goal active on turn 1 (doesn't complete yet)
  provider.setResponses([
    () => fauxAssistantMessage("Working on active goal..."),
    () => fauxAssistantMessage("Continuing work after reload..."),
  ]);

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
    additionalExtensionPaths: [CAPABILITIES_EXTENSION, GOAL_EXTENSION],
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
    await session.bindExtensions({ mode: "rpc" });
    await session.prompt("/goal 修复第二个拼写错误");
    await session.waitForIdle();

    const activeBeforeReload = session.getActiveToolNames();
    assert.ok(activeBeforeReload.includes("update_goal"));

    // Reload the session
    await session.reload();

    // After reload, active goal tools must be restored
    const activeAfterReload = session.getActiveToolNames();
    assert.ok(
      activeAfterReload.includes("get_goal"),
      "get_goal must be restored after reload",
    );
    assert.ok(
      activeAfterReload.includes("update_goal"),
      "update_goal must be restored after reload",
    );
  } finally {
    session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("real Pi fixture: fork restores get_goal/update_goal but defers continuation", {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openpi-goal-fork-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const provider = fauxProvider({
    api: "openpi-goal-fork-test",
    provider: `goal-fork-${path.basename(cwd)}`,
    models: [{ id: "fixture", name: "Fixture", reasoning: false }],
  });

  provider.setResponses([() => fauxAssistantMessage("Working on goal...")]);

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
    additionalExtensionPaths: [CAPABILITIES_EXTENSION, GOAL_EXTENSION],
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
    await session.bindExtensions({ mode: "rpc" });
    sessionManager.appendCustomEntry(
      "session-goal",
      createGoalSnapshot(
        { objective: "修复分支目标" },
        0,
        Date.now(),
        "goal_fork_fixture",
      ),
    );

    // Emit session_start with reason: "fork"
    await session.extensionRunner.emit({
      type: "session_start",
      reason: "fork",
    });

    const activeAfterFork = session.getActiveToolNames();
    assert.ok(
      activeAfterFork.includes("get_goal"),
      "get_goal must be active on fork",
    );
    assert.ok(
      activeAfterFork.includes("update_goal"),
      "update_goal must be active on fork",
    );

    // Continuation should be deferred
    assert.equal(session.isStreaming, false);
  } finally {
    session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("real Pi fixture: update_goal blocked audit preserves 3-turn requirement", {
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openpi-goal-blocked-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const provider = fauxProvider({
    api: "openpi-goal-blocked-test",
    provider: `goal-blocked-${path.basename(cwd)}`,
    models: [{ id: "fixture", name: "Fixture", reasoning: false }],
  });

  const blockerText = "Blocked by upstream dependency approval";
  provider.setResponses([
    // Turn 1 continuation: report blocked turn 1
    () =>
      fauxAssistantMessage(
        [
          fauxToolCall(
            "update_goal",
            { status: "blocked", blocker: blockerText },
            { id: "blk-1" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
    // Turn 1 assistant finish
    () => fauxAssistantMessage("Reported blocked turn 1."),
    // Turn 2 continuation: report blocked turn 2
    () =>
      fauxAssistantMessage(
        [
          fauxToolCall(
            "update_goal",
            { status: "blocked", blocker: blockerText },
            { id: "blk-2" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
    // Turn 2 assistant finish
    () => fauxAssistantMessage("Reported blocked turn 2."),
    // Turn 3 continuation: report blocked turn 3 (accepted)
    () =>
      fauxAssistantMessage(
        [
          fauxToolCall(
            "update_goal",
            { status: "blocked", blocker: blockerText },
            { id: "blk-3" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
    // Turn 3 assistant finish
    () => fauxAssistantMessage("Reported blocked turn 3."),
  ]);

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
    additionalExtensionPaths: [CAPABILITIES_EXTENSION, GOAL_EXTENSION],
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
    await session.bindExtensions({ mode: "rpc" });
    await session.prompt("/goal 测试阻塞审核");
    await session.waitForIdle();

    // After 3 consecutive turns of identical blocker, goal is now marked blocked
    // and no more continuations should run
    const toolResults = session.messages.filter(
      (m) =>
        m.role === "toolResult" &&
        (m as { toolName?: string }).toolName === "update_goal",
    );
    assert.equal(toolResults.length, 3);
    const lastResult = toolResults[2];
    assert.ok(lastResult && lastResult.role === "toolResult");
    const firstContent = lastResult.content[0];
    assert.ok(
      firstContent &&
        "text" in firstContent &&
        typeof firstContent.text === "string",
    );
    const parsedLastResult = JSON.parse(firstContent.text);
    assert.equal(parsedLastResult.goal.status, "blocked");
    assert.equal(parsedLastResult.blockedAudit.accepted, true);
    assert.equal(parsedLastResult.blockedAudit.consecutiveTurns, 3);
  } finally {
    session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
