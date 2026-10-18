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
  getCurrentSystemPrompt,
  getCurrentTools,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  OPENPI_TOOL_SURFACE,
  OPENPI_TOOL_SURFACE_NAMES,
} from "../../../extensions/shared/tool-surface.ts";

// Package configuration uses Pi's process-level agent directory, independently
// of createAgentSession({ agentDir }). Keep developer setup preferences out of
// this real-host fixture; Node isolates this test file in its own process.
let restoreAgentDirectory = () => {};
beforeEach(() => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = mkdtempSync(path.join(tmpdir(), "openpi-surface-config-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  restoreAgentDirectory = () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  };
});
afterEach(() => restoreAgentDirectory());

const extensionPath = (name: string) =>
  fileURLToPath(
    new URL(`../../../extensions/${name}/index.ts`, import.meta.url),
  );

// Every extension that owns model-facing tools in OPENPI_TOOL_SURFACE.
const OPENPI_EXTENSION_PATHS = [
  "ask-user",
  "browser",
  "git-read",
  "plan-mode",
  "setup",
  "subagents",
  "workflows",
].map(extensionPath);

const RESIDENT_OPENPI_TOOLS = Object.values(OPENPI_TOOL_SURFACE).flatMap(
  ({ resident }) => [...resident],
);
const BOUNDARY_OPENPI_TOOLS = Object.values(OPENPI_TOOL_SURFACE).flatMap(
  ({ boundary }) => [...boundary],
);

interface CapturedRequest {
  tools: string;
  systemPrompt: string;
}

const serializeTools = (context: TranscriptContext) =>
  JSON.stringify(
    getCurrentTools(context.messages).map(
      ({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      }),
    ),
  );

async function createFrozenFixture(options: {
  responses: Array<
    | ReturnType<typeof fauxAssistantMessage>
    | ((context: TranscriptContext) => ReturnType<typeof fauxAssistantMessage>)
  >;
  extensionPaths?: string[];
}) {
  const root = await mkdtemp(path.join(tmpdir(), "openpi-frozen-surface-"));
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });

  const requests: CapturedRequest[] = [];
  const provider = fauxProvider({
    api: "openpi-frozen-surface-test",
    provider: `frozen-surface-${path.basename(cwd)}`,
    models: [{ id: "fixture", name: "Fixture", reasoning: false }],
  });
  provider.setResponses(
    options.responses.map((response) => (context: TranscriptContext) => {
      requests.push({
        tools: serializeTools(context),
        systemPrompt: getCurrentSystemPrompt(context.messages),
      });
      return typeof response === "function" ? response(context) : response;
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
    additionalExtensionPaths: options.extensionPaths ?? OPENPI_EXTENSION_PATHS,
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

  return {
    session,
    requests,
    provider,
    cleanup: async () => {
      session.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("frozen surface: runtime events never change the request tools or system prompt", {
  timeout: 60_000,
}, async () => {
  const fixture = await createFrozenFixture({
    responses: [
      // Turn 1: baseline plain turn.
      () => fauxAssistantMessage("Baseline answer."),
      // Turn 2: model calls workflow_status (a resident tool result).
      () =>
        fauxAssistantMessage(
          [
            fauxToolCall(
              "workflow_status",
              { runId: "wf_none" },
              { id: "wf-1" },
            ),
          ],
          { stopReason: "toolUse" },
        ),
      () => fauxAssistantMessage("No workflows are running."),
      // Turn 3: model calls subagent_check without an id (the list path); a
      // tool result must not churn tools either.
      () =>
        fauxAssistantMessage(
          [fauxToolCall("subagent_check", {}, { id: "check-1" })],
          { stopReason: "toolUse" },
        ),
      () => fauxAssistantMessage("No subagents are running."),
    ],
  });
  const { session, requests } = fixture;
  try {
    await session.bindExtensions({ mode: "print" });

    // session_start reconciled the frozen surface exactly once.
    const baseline = session.getActiveToolNames();
    for (const name of RESIDENT_OPENPI_TOOLS) {
      assert.ok(
        baseline.includes(name),
        `resident tool ${name} must be active`,
      );
    }
    for (const name of BOUNDARY_OPENPI_TOOLS) {
      assert.equal(
        baseline.includes(name),
        false,
        `boundary tool ${name} must start hidden`,
      );
    }

    // Non-boundary event 1: an ordinary prompt turn.
    await session.prompt("fix the off-by-one in the cart summary");
    await session.waitForIdle();

    // Non-boundary event 2: a turn that invokes a resident tool.
    await session.prompt("check the status of workflow wf_none");
    await session.waitForIdle();

    // Non-boundary event 3: a turn whose tool call returns a result.
    await session.prompt("list any running subagents");
    await session.waitForIdle();

    // Non-boundary event 4: a fresh agent loop start (context thresholds and
    // agent_start must not retune the surface either).
    await session.extensionRunner.emit({ type: "agent_start" });
    await session.prompt("now summarize the change");
    await session.waitForIdle();

    assert.ok(
      requests.length >= 4,
      `expected at least 4 provider requests, got ${requests.length}`,
    );
    const first = requests[0]!;
    for (const [index, request] of requests.entries()) {
      assert.equal(
        request.tools,
        first.tools,
        `request ${index} tools differ from the first request`,
      );
      assert.equal(
        request.systemPrompt,
        first.systemPrompt,
        `request ${index} system prompt differs from the first request`,
      );
    }
    // The request view and the session view agree on the frozen set.
    const wireNames = new Set(
      (JSON.parse(first.tools) as Array<{ name: string }>).map(
        (tool) => tool.name,
      ),
    );
    for (const name of RESIDENT_OPENPI_TOOLS) {
      assert.ok(wireNames.has(name), `wire tools must include ${name}`);
    }
    for (const name of BOUNDARY_OPENPI_TOOLS) {
      assert.equal(
        wireNames.has(name),
        false,
        `wire tools must not include ${name}`,
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("frozen surface: /plan is a user boundary that adds exactly the plan tools", {
  timeout: 60_000,
}, async () => {
  const fixture = await createFrozenFixture({
    responses: [
      () => fauxAssistantMessage("Baseline answer."),
      () => fauxAssistantMessage("Investigating read-only."),
      () => fauxAssistantMessage("Back to normal."),
    ],
  });
  const { session, requests } = fixture;
  try {
    await session.bindExtensions({ mode: "print" });
    const baseline = session.getActiveToolNames();

    await session.prompt("hello");
    await session.waitForIdle();
    assert.deepEqual(session.getActiveToolNames(), baseline);
    assert.equal(requests.length, 1);
    const baselineTools = requests[0]!.tools;
    const baselinePrompt = requests[0]!.systemPrompt;

    // Entering plan mode is the user boundary: exactly the plan-episode tools
    // are added, and the wire request reflects the new surface exactly once.
    await session.prompt("/plan investigate the login flow");
    await session.waitForIdle();

    const planTools = new Set([
      ...OPENPI_TOOL_SURFACE.gitRead.boundary,
      ...OPENPI_TOOL_SURFACE.plan.boundary,
      ...OPENPI_TOOL_SURFACE.interaction.boundary,
    ]);
    const duringPlan = session.getActiveToolNames();
    const added = duringPlan.filter((name) => !baseline.includes(name));
    assert.deepEqual(
      [...added].sort(),
      [...planTools].sort(),
      "plan entry must add exactly git_*, plan_ready, ask_user, human_handoff",
    );
    const removed = baseline.filter((name) => !duringPlan.includes(name));
    assert.deepEqual(removed, [], "plan entry must not remove tools");

    const planRequest = requests.at(-1)!;
    assert.notEqual(planRequest.tools, baselineTools);
    assert.notEqual(planRequest.systemPrompt, baselinePrompt);
    const planWireNames = new Set(
      (JSON.parse(planRequest.tools) as Array<{ name: string }>).map(
        (tool) => tool.name,
      ),
    );
    for (const name of planTools) {
      assert.ok(planWireNames.has(name), `plan request must include ${name}`);
    }

    // Leaving plan mode restores the exact original surface.
    await session.prompt("/plan off");
    await session.waitForIdle();
    assert.deepEqual(session.getActiveToolNames(), baseline);

    await session.prompt("one more ordinary turn");
    await session.waitForIdle();
    const lastRequest = requests.at(-1)!;
    assert.equal(lastRequest.tools, baselineTools);
    assert.equal(lastRequest.systemPrompt, baselinePrompt);
  } finally {
    await fixture.cleanup();
  }
});

test("resident OpenPI tool budget stays inside the measured bound", {
  timeout: 30_000,
}, async (t) => {
  const fixture = await createFrozenFixture({
    responses: [() => fauxAssistantMessage("ok")],
  });
  const { session } = fixture;
  try {
    await session.bindExtensions({ mode: "print" });

    let chars = 0;
    let wireChars = 0;
    const breakdown: string[] = [];
    for (const name of RESIDENT_OPENPI_TOOLS) {
      const definition = session.getToolDefinition(name);
      assert.ok(definition, `resident tool ${name} must be registered`);
      const wire = JSON.stringify({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
      }).length;
      const toolChars =
        wire +
        (definition.promptSnippet?.length ?? 0) +
        (definition.promptGuidelines ?? []).join("\n").length;
      wireChars += wire;
      chars += toolChars;
      breakdown.push(`${name}:${toolChars}`);
    }
    t.diagnostic(
      `resident OpenPI surface: ${chars} chars across ${RESIDENT_OPENPI_TOOLS.length} tools, wire-only ${wireChars} chars (${breakdown.join(", ")})`,
    );
    // Measured budget; ceiling keeps ~10% headroom for schema text drift.
    const RESIDENT_BUDGET_CHARS = 7300;
    assert.ok(
      chars <= RESIDENT_BUDGET_CHARS,
      `resident OpenPI surface is ${chars} chars across ${RESIDENT_OPENPI_TOOLS.length} tools (${breakdown.join(", ")})`,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("filesystem ownership does not hide a first-registered foreign namesake", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "openpi-foreign-tool-source-"),
  );
  const foreignExtension = path.join(fixtureRoot, "foreign.mjs");
  await writeFile(
    foreignExtension,
    `export default function foreign(pi) {
  pi.registerTool({
    name: "plan_ready",
    label: "Foreign Plan Ready",
    description: "FOREIGN_SENTINEL",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "foreign" }], details: {} };
    },
  });
}
`,
  );

  const cwd = await mkdtemp(path.join(tmpdir(), "openpi-foreign-session-"));
  const agentDir = path.join(cwd, "agent");
  await mkdir(agentDir, { recursive: true });
  try {
    const settingsManager = SettingsManager.inMemory(undefined, {
      projectTrusted: false,
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [foreignExtension, extensionPath("plan-mode")],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
    });
    try {
      await session.bindExtensions({ mode: "print" });
      assert.ok(session.getActiveToolNames().includes("plan_ready"));
      const tool = session
        .getAllTools()
        .find(({ name }) => name === "plan_ready");
      assert.equal(tool?.description, "FOREIGN_SENTINEL");
      assert.equal(tool?.sourceInfo.path, foreignExtension);
    } finally {
      session.dispose();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
