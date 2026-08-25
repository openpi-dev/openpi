/**
 * Execute-level workflow tests: real tool registration through index.ts, the
 * sandbox child process, artifact persistence, and the background follow-up
 * message — with agent sessions faked through the test-only
 * `__setWorkflowTestAgentSessionFactory` injection seam.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AgentSession,
  AgentSessionEventListener,
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SPINNER_INTERVAL_MS } from "../shared/spinner.ts";
import type { WorkflowDetails } from "./model.ts";
import type { WorkflowAgentSessionFactory } from "./runner.ts";

const agentDir = mkdtempSync(join(tmpdir(), "my-pi-setup-wf-e2e-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

// A clean committed git checkout: replay identity fingerprints the repository
// (HEAD, diff, untracked files), so resume tests need a real repo without
// untracked or ignored content.
const repoDir = mkdtempSync(join(tmpdir(), "my-pi-setup-wf-e2e-repo-"));
function git(args: readonly string[]) {
  execFileSync("git", args, {
    cwd: repoDir,
    stdio: ["ignore", "ignore", "ignore"],
  });
}
git(["init", "-q"]);
git(["config", "user.email", "workflow-e2e@example.com"]);
git(["config", "user.name", "Workflow E2E"]);
writeFileSync(join(repoDir, "fixture.txt"), "fixture\n");
git(["add", "."]);
git(["commit", "-q", "-m", "fixture"]);

const { default: workflows, __setWorkflowTestAgentSessionFactory } =
  await import("./index.ts");

type CapturedTool = {
  name: string;
  renderResult?: ToolDefinition["renderResult"];
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: ExtensionContext,
  ) => unknown;
};

type SentMessage = {
  message: Record<string, unknown> & {
    customType?: string;
    details?: { runId?: unknown };
  };
  options: unknown;
};

const tools = new Map<string, CapturedTool>();
let activeTools: string[] = [];
const handlers = new Map<
  string,
  Array<(event: unknown, ctx: ExtensionContext) => unknown>
>();
const sentMessages: SentMessage[] = [];
let modelIdle = true;
let sendFailures = 0;

const pi = {
  registerTool(tool: CapturedTool) {
    tools.set(tool.name, tool);
    activeTools = [
      ...activeTools.filter((name) => name !== tool.name),
      tool.name,
    ];
  },
  registerCommand() {},
  registerMessageRenderer() {},
  on(event: string, handler: unknown) {
    handlers.set(event, [
      ...(handlers.get(event) ?? []),
      handler as (event: unknown, ctx: ExtensionContext) => unknown,
    ]);
  },
  getThinkingLevel: () => "off",
  getActiveTools: () => [...activeTools],
  setActiveTools(names: string[]) {
    activeTools = [...names];
  },
  sendMessage(message: SentMessage["message"], options: unknown) {
    if (sendFailures > 0) {
      sendFailures--;
      throw new Error("injected completion transport failure");
    }
    sentMessages.push({ message, options });
  },
} as unknown as ExtensionAPI;

const ctx = {
  cwd: repoDir,
  mode: "tui",
  hasUI: true,
  isIdle: () => modelIdle,
  isProjectTrusted: () => false,
  sessionManager: {
    getSessionId: () => "wf-e2e-session",
    getEntries: () => [],
  },
  model: undefined,
  modelRegistry: { find: () => undefined },
  ui: {
    theme: {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    },
    setStatus() {},
    setWidget() {},
  },
} as unknown as ExtensionContext;

for (const [runId, status] of [
  ["wf_1e9acd0e", "completed"],
  ["wf_1e9acbad", "running"],
] as const) {
  const runDir = join(agentDir, "workflows", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "workflow.json"),
    JSON.stringify({
      runId,
      sessionId: "wf-e2e-session",
      status,
      background: true,
      startedAt: 1,
      ...(status === "completed" ? { finishedAt: 2, result: "old" } : {}),
      phases: [],
      agents: [],
    }),
  );
}

workflows(pi);
for (const handler of handlers.get("session_start") ?? []) {
  await handler({}, {
    ...ctx,
    mode: "print",
    hasUI: true,
  } as unknown as ExtensionContext);
}

const restoredLegacyDone = JSON.parse(
  readFileSync(
    join(agentDir, "workflows", "wf_1e9acd0e", "workflow.json"),
    "utf8",
  ),
) as Record<string, unknown>;
const restoredLegacyStale = JSON.parse(
  readFileSync(
    join(agentDir, "workflows", "wf_1e9acbad", "workflow.json"),
    "utf8",
  ),
) as Record<string, unknown>;
assert.equal(restoredLegacyDone.delivery, undefined);
assert.equal(restoredLegacyStale.status, "uncertain");
assert.equal(
  (restoredLegacyStale.delivery as Record<string, unknown>).id,
  "workflow:wf_1e9acbad",
);
await waitFor(
  () => sentMessages.length === 1,
  "legacy stale recovery delivery",
);
assert.match(String(sentMessages[0]?.message.content), /wf_1e9acbad/);
sentMessages.length = 0;

const workflow = tools.get("workflow")!;
const status = tools.get("workflow_status")!;
assert.ok(workflow && status);

function runDirFor(runId: unknown) {
  assert.equal(typeof runId, "string");
  return join(agentDir, "workflows", runId as string);
}

function readWorkflowJson(runId: unknown) {
  return JSON.parse(
    readFileSync(join(runDirFor(runId), "workflow.json"), "utf8"),
  ) as Record<string, unknown>;
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(predicate(), `timed out waiting for ${label}`);
}

/** A minimal AgentSession stand-in for one successful child agent call. */
function fakeAgentSession(output: string, promptGate?: Promise<void>) {
  const listeners = new Set<AgentSessionEventListener>();
  // The reviewer agent type requests the read-only tool surface; the child
  // preflight in bindChildSessionExtensions requires all of them active.
  const toolNames = [
    "read",
    "grep",
    "find",
    "ls",
    "fd",
    "rg",
    "git_show",
    "git_diff",
    "git_log",
  ];
  const messages = [
    { role: "user", content: "fixture prompt", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "text", text: output }],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      usage: {
        input: 3,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 8,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 2,
    },
  ] satisfies AgentSession["messages"];
  return {
    messages,
    model: undefined,
    extensionRunner: { hasHandlers: () => false, emit: async () => {} },
    async bindExtensions() {},
    subscribe(listener: AgentSessionEventListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      await promptGate;
      const assistant = messages.find(
        (message) => message.role === "assistant",
      );
      assert.ok(assistant);
      for (const listener of listeners) {
        listener({ type: "message_end", message: assistant });
      }
    },
    async abort() {},
    dispose() {},
    getContextUsage: () => undefined,
    getAllTools: () => toolNames.map((name) => ({ name })),
    getToolDefinition: () => undefined,
    getActiveToolNames: () => [...toolNames],
    setActiveToolsByName() {},
  } as unknown as AgentSession;
}

test("foreground run without agents returns the result and persists artifacts", async () => {
  const result = (await workflow.execute(
    "e2e-foreground",
    {
      script:
        'export const meta = { name: "plain-run", description: "no agents" };\nlog("hi");\nreturn { x: 1 };',
      wait: true,
    },
    undefined,
    undefined,
    ctx,
  )) as {
    content: Array<{ type: string; text: string }>;
    details: { runId?: unknown; status?: unknown };
  };

  assert.equal(result.details.status, "completed");
  const text = result.content[0]!.text;
  assert.match(text, /"plain-run" completed/);
  assert.match(text, /"x":\s*1/);

  const runId = result.details.runId;
  const runDir = runDirFor(runId);
  assert.ok(existsSync(join(runDir, "script.js")));
  const persisted = readWorkflowJson(runId);
  assert.equal(persisted.status, "completed");
  assert.equal(persisted.resultArtifact, "result.json");
  assert.deepEqual(
    JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")),
    { x: 1 },
  );

  // The run left activeRuns: the in-memory status listing holds it exactly
  // once (active and settled would both list it), settled and completed.
  const listing = (await status.execute("e2e-foreground-status", {})) as {
    details: { runs: Array<{ runId: unknown; status: unknown }> };
  };
  const mine = listing.details.runs.filter((run) => run.runId === runId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.status, "completed");
});

test("background runs deliver a follow-up that triggers a turn only when idle", async () => {
  sentMessages.length = 0;

  modelIdle = true;
  const idleRun = (await workflow.execute(
    "e2e-bg-idle",
    {
      script: 'export const meta = { name: "bg-idle" };\nlog("bg");\nreturn 7;',
    },
    undefined,
    undefined,
    ctx,
  )) as { details: { runId?: unknown } };
  assert.equal(typeof idleRun.details.runId, "string");

  await waitFor(
    () =>
      sentMessages.some(
        (sent) => sent.message.details?.runId === idleRun.details.runId,
      ),
    "idle background follow-up",
  );
  const idleFollowUp = sentMessages.find(
    (sent) => sent.message.details?.runId === idleRun.details.runId,
  )!;
  assert.equal(idleFollowUp.message.customType, "workflow-result");
  assert.equal(idleFollowUp.message.display, true);
  assert.match(String(idleFollowUp.message.content), /bg-idle/);
  assert.deepEqual(idleFollowUp.options, {
    deliverAs: "followUp",
    triggerTurn: true,
  });

  modelIdle = false;
  const busyRun = (await workflow.execute(
    "e2e-bg-busy",
    {
      script: 'export const meta = { name: "bg-busy" };\nreturn 8;',
      background: true,
    },
    undefined,
    undefined,
    ctx,
  )) as { details: { runId?: unknown } };
  assert.equal(typeof busyRun.details.runId, "string");

  await waitFor(
    () => readWorkflowJson(busyRun.details.runId).status === "completed",
    "busy workflow settlement",
  );
  assert.equal(
    sentMessages.some(
      (sent) => sent.message.details?.runId === busyRun.details.runId,
    ),
    false,
  );
  for (const handler of handlers.get("agent_settled") ?? []) {
    await handler({}, ctx);
  }
  await waitFor(
    () =>
      sentMessages.some(
        (sent) => sent.message.details?.runId === busyRun.details.runId,
      ),
    "busy background follow-up after parent settled",
  );
  const busyFollowUp = sentMessages.find(
    (sent) => sent.message.details?.runId === busyRun.details.runId,
  )!;
  assert.deepEqual(busyFollowUp.options, {
    deliverAs: "followUp",
    triggerTurn: true,
  });
});

test("a settled launch card does not repaint while its detached run stays active", async () => {
  modelIdle = true;
  sentMessages.length = 0;
  let releasePrompt = () => {};
  const promptGate = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  __setWorkflowTestAgentSessionFactory(async () => ({
    session: fakeAgentSession("detached output", promptGate),
  }));

  let runId: unknown;
  try {
    const launch = (await workflow.execute(
      "e2e-detached-render",
      {
        script:
          'export const meta = { name: "detached-render" };\n' +
          'return await agent("wait for release", { agent_type: "reviewer" });',
      },
      undefined,
      undefined,
      ctx,
    )) as AgentToolResult<WorkflowDetails>;
    runId = launch.details.runId;
    assert.equal(launch.details.status, "running");

    const renderResult = workflow.renderResult;
    assert.ok(renderResult);
    let invalidations = 0;
    const component = renderResult(
      launch,
      { expanded: false, isPartial: false },
      ctx.ui.theme,
      {
        args: {},
        toolCallId: "call-detached-render",
        invalidate: () => {
          invalidations += 1;
        },
        lastComponent: undefined,
        state: {},
        cwd: repoDir,
        executionStarted: true,
        argsComplete: true,
        isPartial: false,
        expanded: false,
        showImages: false,
        isError: false,
      },
    );
    const first = component.render(100);

    await new Promise((resolve) =>
      setTimeout(resolve, SPINNER_INTERVAL_MS * 3),
    );
    assert.equal(invalidations, 0);
    assert.deepEqual(component.render(100), first);
  } finally {
    releasePrompt();
    if (runId !== undefined) {
      await waitFor(
        () => readWorkflowJson(runId).status === "completed",
        "detached render workflow settlement",
      );
      await waitFor(
        () =>
          sentMessages.some((sent) => sent.message.details?.runId === runId),
        "detached render workflow delivery",
      );
    }
    __setWorkflowTestAgentSessionFactory(undefined);
  }
});

test("failed completion delivery remains durable and retries once with the same id", async () => {
  sentMessages.length = 0;
  modelIdle = true;
  sendFailures = 1;
  const run = (await workflow.execute(
    "e2e-delivery-retry",
    {
      script:
        'export const meta = { name: "delivery-retry" };\nreturn { durable: true };',
    },
    undefined,
    undefined,
    ctx,
  )) as { details: { runId?: unknown } };

  await waitFor(() => {
    const persisted = readWorkflowJson(run.details.runId);
    const delivery = persisted.delivery as
      | { state?: unknown; attempts?: unknown; id?: unknown }
      | undefined;
    return delivery?.state === "pending" && delivery.attempts === 1;
  }, "pending durable delivery after transport failure");
  const before = readWorkflowJson(run.details.runId).delivery as {
    id: string;
  };

  for (const handler of handlers.get("agent_settled") ?? []) {
    await handler({}, ctx);
  }
  await waitFor(
    () =>
      sentMessages.some(
        (sent) => sent.message.details?.runId === run.details.runId,
      ),
    "retried workflow completion",
  );
  const after = readWorkflowJson(run.details.runId).delivery as {
    id: string;
    state: string;
    attempts: number;
  };
  assert.equal(after.id, before.id);
  assert.equal(after.state, "delivered");
  assert.equal(after.attempts, 2);
  assert.equal(
    sentMessages.filter(
      (sent) => sent.message.details?.runId === run.details.runId,
    ).length,
    1,
  );
});

test("a failing script reports the error and records the run as failed", async () => {
  await assert.rejects(
    Promise.resolve(
      workflow.execute(
        "e2e-failing",
        {
          script:
            'export const meta = { name: "boom-run" };\nthrow new Error("kaboom");',
          wait: true,
        },
        undefined,
        undefined,
        ctx,
      ),
    ),
    /kaboom/,
  );

  const runs = (await status.execute("e2e-failing-status", {})) as {
    details: {
      runs: Array<{ runId: unknown; name: unknown; status: unknown }>;
    };
  };
  const failed = runs.details.runs.find((run) => run.name === "boom-run");
  assert.ok(failed);
  assert.equal(failed.status, "failed");
  const persisted = readWorkflowJson(failed.runId);
  assert.equal(persisted.status, "failed");
  assert.match(String(persisted.error), /kaboom/);
});

test("agent calls run through the injected session factory and resume replays the journal", async () => {
  let sessionCreations = 0;
  const factory: WorkflowAgentSessionFactory = async () => {
    sessionCreations += 1;
    return { session: fakeAgentSession("injected agent output") };
  };
  __setWorkflowTestAgentSessionFactory(factory);

  const agentScript =
    'export const meta = { name: "agent-run" };\n' +
    'const r = await agent("say something", { agent_type: "reviewer", label: "speaker" });\n' +
    'log("agent said: " + r.output);\n' +
    "return { ok: r.ok, output: r.output };";

  try {
    const first = (await workflow.execute(
      "e2e-agent-first",
      { script: agentScript, wait: true },
      undefined,
      undefined,
      ctx,
    )) as {
      content: Array<{ type: string; text: string }>;
      details: { runId?: unknown };
    };
    const firstText = first.content[0]!.text;
    assert.match(firstText, /"agent-run" completed/);
    assert.match(firstText, /injected agent output/);
    assert.equal(sessionCreations, 1);

    const firstRunId = first.details.runId;
    const firstDir = runDirFor(firstRunId);
    // A replay-safe read-only agent call is journaled on success.
    const journal = JSON.parse(
      readFileSync(join(firstDir, "journal.json"), "utf8"),
    ) as { entries: unknown[] };
    assert.equal(journal.entries.length, 1);

    // Resume with identical script and call content: the journal hit means no
    // new child session is created.
    const resumed = (await workflow.execute(
      "e2e-agent-resume",
      {
        script: agentScript,
        resume_from_run_id: String(firstRunId),
        wait: true,
      },
      undefined,
      undefined,
      ctx,
    )) as {
      content: Array<{ type: string; text: string }>;
      details: { runId?: unknown };
    };
    const resumedText = resumed.content[0]!.text;
    assert.match(resumedText, /injected agent output/);
    assert.match(resumedText, /Resumed from .*replayed 1\/1 agent call/);
    assert.equal(sessionCreations, 1);

    const persisted = readWorkflowJson(resumed.details.runId);
    const agents = persisted.agents as Array<{
      state: unknown;
      replayed?: unknown;
      resultArtifact?: unknown;
    }>;
    assert.equal(agents.length, 1);
    assert.equal(agents[0]!.state, "done");
    assert.equal(agents[0]!.replayed, true);
    assert.equal(agents[0]!.resultArtifact, "agent-results/agent-0001.json");
    assert.deepEqual(
      JSON.parse(
        readFileSync(
          join(
            runDirFor(resumed.details.runId),
            String(agents[0]!.resultArtifact),
          ),
          "utf8",
        ),
      ),
      { output: "injected agent output" },
    );
  } finally {
    __setWorkflowTestAgentSessionFactory(undefined);
  }
});

test("oversized authoritative agent results fail without a success record", async () => {
  const factory: WorkflowAgentSessionFactory = async (options) => {
    const structuredTool = options?.customTools?.find(
      (tool) => tool.name === "structured_output",
    );
    assert.ok(structuredTool);
    const session = fakeAgentSession("");
    const existingTools = session.getAllTools();
    session.getAllTools = () => [
      ...existingTools,
      {
        name: structuredTool.name,
        description: structuredTool.description,
        parameters: structuredTool.parameters,
        promptGuidelines: structuredTool.promptGuidelines,
        sourceInfo: {
          path: "<custom:structured_output>",
          source: "custom",
          scope: "temporary",
          origin: "top-level",
        },
      },
    ];
    session.getActiveToolNames = () => [
      ...existingTools.map((tool) => tool.name),
      structuredTool.name,
    ];
    session.getToolDefinition = (name) =>
      name === structuredTool.name ? structuredTool : undefined;
    session.prompt = async () => {
      await structuredTool.execute(
        "oversized-structured-output",
        { blob: "x".repeat(3 * 1024 * 1024) },
        new AbortController().signal,
        () => {},
        ctx,
      );
    };
    return { session };
  };
  __setWorkflowTestAgentSessionFactory(factory);

  try {
    const result = (await workflow.execute(
      "e2e-agent-result-budget",
      {
        script:
          'export const meta = { name: "oversized-agent-result" };\n' +
          'const r = await agent("return a large fixture", { agent_type: "reviewer", schema: { type: "object", properties: { blob: { type: "string" } }, required: ["blob"] } });\n' +
          "return { ok: r.ok, error: r.error };",
        wait: true,
      },
      undefined,
      undefined,
      ctx,
    )) as { details: { runId?: unknown } };

    const persisted = readWorkflowJson(result.details.runId);
    const agents = persisted.agents as Array<{
      state: unknown;
      error?: unknown;
      resultArtifact?: unknown;
      resultRef?: unknown;
    }>;
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.state, "error");
    assert.match(String(agents[0]?.error), /agent result artifact exceeded/i);
    assert.equal(agents[0]?.resultArtifact, undefined);
    assert.equal(agents[0]?.resultRef, undefined);
    assert.equal(
      existsSync(
        join(runDirFor(result.details.runId), "agent-results/agent-0001.json"),
      ),
      false,
    );
    assert.equal(
      existsSync(join(runDirFor(result.details.runId), "journal.json")),
      false,
    );
  } finally {
    __setWorkflowTestAgentSessionFactory(undefined);
  }
});

test("an oversized legacy replay is rejected without a success record", async () => {
  let sessionCreations = 0;
  const factory: WorkflowAgentSessionFactory = async () => {
    sessionCreations++;
    return { session: fakeAgentSession("legacy replay source") };
  };
  __setWorkflowTestAgentSessionFactory(factory);
  const script =
    'export const meta = { name: "oversized-replay" };\n' +
    'const r = await agent("replay fixture", { agent_type: "reviewer" });\n' +
    "return { ok: r.ok, error: r.error };";

  try {
    const first = (await workflow.execute(
      "e2e-oversized-replay-source",
      { script, wait: true },
      undefined,
      undefined,
      ctx,
    )) as { details: { runId?: unknown } };
    const sourceDir = runDirFor(first.details.runId);
    const journalPath = join(sourceDir, "journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    let tooDeep: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 40; depth++) tooDeep = { next: tooDeep };
    journal.entries[0]!.structured = tooDeep;
    writeFileSync(journalPath, JSON.stringify(journal));

    const resumed = (await workflow.execute(
      "e2e-oversized-replay-resume",
      {
        script,
        resume_from_run_id: String(first.details.runId),
        wait: true,
      },
      undefined,
      undefined,
      ctx,
    )) as { details: { runId?: unknown } };

    assert.equal(sessionCreations, 1);
    const resumedDir = runDirFor(resumed.details.runId);
    const persisted = readWorkflowJson(resumed.details.runId);
    const agents = persisted.agents as Array<{
      state: unknown;
      replayed?: unknown;
      error?: unknown;
      resultArtifact?: unknown;
      resultRef?: unknown;
    }>;
    assert.equal(agents[0]?.state, "error");
    assert.equal(agents[0]?.replayed, undefined);
    assert.match(String(agents[0]?.error), /agent result artifact exceeded/i);
    assert.equal(agents[0]?.resultArtifact, undefined);
    assert.equal(agents[0]?.resultRef, undefined);
    assert.equal(
      existsSync(join(resumedDir, "agent-results/agent-0001.json")),
      false,
    );
    assert.equal(existsSync(join(resumedDir, "journal.json")), false);
  } finally {
    __setWorkflowTestAgentSessionFactory(undefined);
  }
});

test.after(() => {
  for (const handler of handlers.get("session_shutdown") ?? []) {
    void handler({}, ctx);
  }
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});
