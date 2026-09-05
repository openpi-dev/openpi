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
  readdirSync,
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
import { SPINNER_INTERVAL_MS } from "../../../extensions/shared/spinner.ts";
import { reclaimWorktree } from "../../../extensions/shared/worktree.ts";
import { persistWorkflowJson } from "../../../extensions/workflows/artifacts.ts";
import {
  MAX_SETTLED_RUNS,
  type WorkflowDetails,
} from "../../../extensions/workflows/model.ts";
import type { WorkflowAgentSessionFactory } from "../../../extensions/workflows/runner.ts";

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

const {
  default: workflows,
  __setWorkflowTestAgentSessionFactory,
  __setWorkflowTestLifecycleHooks,
  shutdownActiveWorkflowRuns,
} = await import("../../../extensions/workflows/index.ts");

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

workflows(pi, {
  settledRetention: { maxRuns: 8, maxBytes: 64 * 1024 },
});
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
const workflowStop = tools.get("workflow_stop")!;
const status = tools.get("workflow_status")!;
assert.ok(workflow && workflowStop && status);

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
function fakeAgentSession(
  output: string,
  promptGate?: Promise<void>,
  onPrompt?: (prompt: string) => void,
) {
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
    async prompt(promptValue?: unknown) {
      onPrompt?.(typeof promptValue === "string" ? promptValue : "");
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

test("oversized workflow args fail before child sessions or journals are created", async () => {
  let sessionCreations = 0;
  __setWorkflowTestAgentSessionFactory(async () => {
    sessionCreations++;
    return { session: fakeAgentSession("unexpected child session") };
  });

  const script =
    'export const meta = { name: "oversized-workflow-args" };\nreturn 1;';
  const args = [JSON.stringify("x".repeat(300_000)), "x".repeat(300_000)];

  try {
    for (const rawArgs of args) {
      const launch = (await workflow.execute(
        "e2e-oversized-workflow-args",
        { script, args: rawArgs, wait: false },
        undefined,
        undefined,
        ctx,
      )) as { details: { runId?: unknown } };
      const runId = launch.details.runId;
      await waitFor(
        () => readWorkflowJson(runId).status === "failed",
        "oversized workflow args failure",
      );

      const runDir = runDirFor(runId);
      const persisted = readWorkflowJson(runId);
      assert.match(
        String(persisted.error),
        /Workflow args exceed the .* IPC limit/,
      );
      assert.deepEqual(persisted.agents, []);
      assert.equal(existsSync(join(runDir, "journal.json")), false);
      assert.equal(readFileSync(join(runDir, "args.json"), "utf8"), rawArgs);
    }
  } finally {
    __setWorkflowTestAgentSessionFactory(undefined);
  }

  assert.equal(sessionCreations, 0);
});

test("print hosts wait by default and reject detached delivery", async () => {
  const printCtx = {
    ...ctx,
    mode: "print",
    hasUI: false,
  } as unknown as ExtensionContext;
  const inline = (await workflow.execute(
    "e2e-print-default",
    {
      script:
        'export const meta = { name: "print-default" };\nreturn { inline: true };',
    },
    undefined,
    undefined,
    printCtx,
  )) as AgentToolResult<WorkflowDetails>;

  assert.equal(inline.details.status, "completed");
  assert.equal(inline.details.background, false);
  assert.equal(inline.details.delivery?.state, "consumed-inline");

  const legacyInline = (await workflow.execute(
    "e2e-print-legacy-inline",
    {
      script:
        'export const meta = { name: "print-legacy-inline" };\nreturn { inline: true };',
      background: false,
    },
    undefined,
    undefined,
    printCtx,
  )) as AgentToolResult<WorkflowDetails>;
  assert.equal(legacyInline.details.background, false);
  assert.equal(legacyInline.details.delivery?.state, "consumed-inline");
  assert.doesNotMatch(
    legacyInline.content
      .map((entry) => (entry.type === "text" ? entry.text : ""))
      .join("\n"),
    /deprecated|migration/i,
  );

  const workflowsDir = join(agentDir, "workflows");
  const runDirsBefore = readdirSync(workflowsDir).sort();
  const messagesBefore = sentMessages.length;
  for (const input of [{ wait: false }, { background: true }]) {
    await assert.rejects(
      Promise.resolve().then(() =>
        workflow.execute(
          "e2e-print-detached",
          { script: "return { detached: true };", ...input },
          undefined,
          undefined,
          printCtx,
        ),
      ),
      /cannot deliver.*wait: true/i,
    );
  }
  assert.deepEqual(readdirSync(workflowsDir).sort(), runDirsBefore);
  assert.equal(sentMessages.length, messagesBefore);
});

test("interrupting an inline wait leaves the run stoppable and delivers one terminal result", async () => {
  sentMessages.length = 0;
  modelIdle = true;
  let sessionCreated = false;
  let releasePrompt = () => {};
  const promptGate = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  __setWorkflowTestAgentSessionFactory(async () => {
    sessionCreated = true;
    return { session: fakeAgentSession("interrupted output", promptGate) };
  });

  try {
    const controller = new AbortController();
    let interruptedMessage = "";
    const execution = Promise.resolve(
      workflow.execute(
        "e2e-interrupted-inline-wait",
        {
          script:
            'export const meta = { name: "interrupted-inline-wait" };\n' +
            'return await agent("wait for interruption", { agent_type: "reviewer" });',
          wait: true,
        },
        controller.signal,
        undefined,
        ctx,
      ),
    ).then(
      () => assert.fail("interrupted inline wait unexpectedly resolved"),
      (error: unknown) => {
        interruptedMessage = String(
          error instanceof Error ? error.message : error,
        );
      },
    );

    await waitFor(() => sessionCreated, "inline workflow before interruption");
    controller.abort();
    await execution;
    const runId = interruptedMessage.match(/run (wf_[0-9a-f]+)/)?.[1];
    assert.ok(runId);
    assert.match(interruptedMessage, /continues in the background/);
    assert.equal(readWorkflowJson(runId).status, "running");

    await workflowStop.execute("e2e-interrupted-inline-stop", { runId });
    releasePrompt();
    await waitFor(
      () => readWorkflowJson(runId).status === "aborted",
      "interrupted inline workflow cancellation",
    );
    await waitFor(
      () =>
        sentMessages.filter((sent) => sent.message.details?.runId === runId)
          .length === 1,
      "interrupted inline terminal delivery",
    );
  } finally {
    releasePrompt();
    __setWorkflowTestAgentSessionFactory(undefined);
  }
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
      wait: false,
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

test("shutdown preserves a failed completion for reload recovery", async () => {
  sentMessages.length = 0;
  modelIdle = false;
  sendFailures = 1;
  const run = (await workflow.execute(
    "e2e-shutdown-reload-delivery",
    {
      script:
        'export const meta = { name: "shutdown-reload-delivery" };\nreturn { durable: true };',
      background: true,
    },
    undefined,
    undefined,
    ctx,
  )) as { details: { runId?: unknown } };

  await waitFor(
    () =>
      (readWorkflowJson(run.details.runId).delivery as { state?: string })
        ?.state === "pending",
    "pending completion before shutdown",
  );
  for (const handler of handlers.get("session_shutdown") ?? []) {
    await handler({}, ctx);
  }
  assert.equal(
    (readWorkflowJson(run.details.runId).delivery as { state?: string }).state,
    "pending",
  );

  const reloadedHandlers = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => unknown>
  >();
  const reloadedPi = {
    ...pi,
    registerTool() {},
    on(event: string, handler: unknown) {
      reloadedHandlers.set(event, [
        ...(reloadedHandlers.get(event) ?? []),
        handler as (event: unknown, ctx: ExtensionContext) => unknown,
      ]);
    },
  } as unknown as ExtensionAPI;
  workflows(reloadedPi);

  modelIdle = true;
  for (const handler of reloadedHandlers.get("session_start") ?? []) {
    await handler({}, { ...ctx, mode: "print" } as unknown as ExtensionContext);
  }
  await waitFor(
    () =>
      sentMessages.filter(
        (sent) => sent.message.details?.runId === run.details.runId,
      ).length === 1,
    "completion after reload recovery",
  );
  assert.equal(
    (readWorkflowJson(run.details.runId).delivery as { state?: string }).state,
    "delivered",
  );

  // The original instance represents the process that was replaced. Drain
  // its intentionally retained in-memory retry so later tests do not batch it
  // with an unrelated completion; the assertion above was reached solely via
  // the fresh instance and persisted session state.
  for (const handler of handlers.get("agent_settled") ?? []) {
    await handler({}, ctx);
  }
  await waitFor(
    () => sentMessages.length === 2,
    "discarded predecessor instance retry",
  );
  sentMessages.length = 0;
});

test("cancelled detached delivery preserves aborted status after artifact persistence failure", async () => {
  sentMessages.length = 0;
  modelIdle = true;
  let sessionCreated = false;
  let releasePrompt = () => {};
  const promptGate = new Promise<void>((resolve) => {
    releasePrompt = resolve;
  });
  __setWorkflowTestAgentSessionFactory(async () => {
    sessionCreated = true;
    return { session: fakeAgentSession("cancelled output", promptGate) };
  });

  try {
    const launch = (await workflow.execute(
      "e2e-cancelled-persistence-failure",
      {
        script:
          'export const meta = { name: "cancelled-persistence-failure" };\n' +
          'return await agent("wait for cancellation", { agent_type: "reviewer" });',
        background: true,
      },
      undefined,
      undefined,
      ctx,
    )) as { details: { runId?: unknown } };
    const runId = launch.details.runId;
    const transcripts = join(runDirFor(runId), "transcripts.json");
    await waitFor(
      () => sessionCreated && existsSync(transcripts),
      "active detached workflow before cancellation",
    );

    // Make the final artifact write fail after the cancellation path has
    // selected `aborted`; terminal recovery can still rewrite workflow.json.
    rmSync(transcripts);
    mkdirSync(transcripts);
    writeFileSync(join(transcripts, "blocker"), "keep directory non-empty\n");

    await workflowStop.execute("e2e-cancel-stop", { runId });
    releasePrompt();

    await waitFor(
      () => sentMessages.some((sent) => sent.message.details?.runId === runId),
      "cancelled completion delivery",
    );

    const persisted = readWorkflowJson(runId);
    assert.equal(persisted.status, "aborted");
    assert.match(String(persisted.error), /Workflow was aborted/);
    assert.match(String(persisted.error), /Artifact persistence failed/);

    const delivered = sentMessages.find(
      (sent) => sent.message.details?.runId === runId,
    );
    assert.ok(delivered);
    const deliveredDetails = delivered.message.details as {
      entries?: Array<{ status?: unknown; alerts?: unknown[] }>;
    };
    const deliveredEntry = deliveredDetails.entries?.[0];
    assert.equal(deliveredEntry?.status, "aborted");
    assert.ok(
      deliveredEntry?.alerts?.some((alert) =>
        String(alert).includes("Workflow was aborted"),
      ),
    );
    assert.ok(
      deliveredEntry?.alerts?.some((alert) =>
        String(alert).includes("Artifact persistence failed"),
      ),
    );
  } finally {
    releasePrompt();
    __setWorkflowTestAgentSessionFactory(undefined);
  }
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

test("settled retention is bounded while status and artifacts remain observable", async () => {
  const before = (await status.execute("e2e-retention-before", {})) as {
    details: { settledRunsEvicted: number };
  };
  const runIds: string[] = [];

  for (let index = 0; index < MAX_SETTLED_RUNS + 1; index++) {
    const result = (await workflow.execute(
      `e2e-retention-${index}`,
      {
        script: `export const meta = { name: "retention-${index}" };\nreturn ${index};`,
        wait: true,
      },
      undefined,
      undefined,
      ctx,
    )) as { details: { runId?: unknown } };
    assert.equal(typeof result.details.runId, "string");
    runIds.push(result.details.runId as string);
  }

  const after = (await status.execute("e2e-retention-after", {})) as {
    content: Array<{ text?: string }>;
    details: {
      runs: Array<{ runId: unknown }>;
      settledRunsEvicted: number;
    };
  };
  assert.ok(after.details.runs.length <= MAX_SETTLED_RUNS);
  assert.ok(
    after.details.settledRunsEvicted >= before.details.settledRunsEvicted + 1,
  );
  assert.match(
    after.content[0]?.text ?? "",
    /Retention \(current session\): .* evicted\/omitted .*Canonical artifacts remain available on disk\./,
  );

  const oldestRunId = runIds[0]!;
  assert.equal(existsSync(join(runDirFor(oldestRunId), "workflow.json")), true);
  const lookup = (await status.execute("e2e-retention-lookup", {
    runId: oldestRunId,
  })) as {
    details: { runs: Array<{ runId: unknown; status: unknown }> };
  };
  assert.equal(lookup.details.runs[0]?.runId, oldestRunId);
  assert.equal(lookup.details.runs[0]?.status, "completed");
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

type ReplayAcceptanceVerdict = "rejected" | "missing" | "malformed";

type ReplayAcceptanceAgent = {
  state: unknown;
  replayed?: unknown;
  invocation?: {
    admissionState?: unknown;
    executionState?: unknown;
    outcome?: unknown;
  };
  acceptance?: { status?: unknown };
  error?: unknown;
  resultArtifact?: unknown;
  resultRef?: unknown;
};

type ReplayAcceptanceFixture = {
  resumed: {
    content: Array<{ type: string; text: string }>;
    details: { runId?: unknown };
  };
  agents: ReplayAcceptanceAgent[];
  runDir: string;
  sessionCreations: number;
};

let replayAcceptanceFixtureId = 0;

function tamperedAcceptance(verdict: ReplayAcceptanceVerdict) {
  if (verdict === "rejected") {
    return {
      acceptance: {
        criteria: [{ id: "tests", status: "rejected", evidence: ["command"] }],
      },
    };
  }
  if (verdict === "missing") return {};
  return {
    acceptance: {
      criteria: [
        {
          id: `\u001b[31m${"x".repeat(3_000)}\u001b[0m`,
          status: "rejected",
          evidence: ["command"],
        },
      ],
    },
  };
}

async function runTamperedAcceptanceReplay(
  verdict: ReplayAcceptanceVerdict,
): Promise<ReplayAcceptanceFixture> {
  let sessionCreations = 0;
  const factory: WorkflowAgentSessionFactory = async (options) => {
    sessionCreations++;
    const structuredTool = options?.customTools?.find(
      (tool) => tool.name === "structured_output",
    );
    assert.ok(structuredTool);
    const session = fakeAgentSession("acceptance replay output");
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
    const prompt = session.prompt.bind(session);
    session.prompt = async () => {
      await structuredTool.execute(
        "acceptance-replay",
        {
          acceptance: {
            criteria: [
              { id: "tests", status: "accepted", evidence: ["command"] },
            ],
          },
        },
        new AbortController().signal,
        () => {},
        ctx,
      );
      await prompt("fixture prompt");
    };
    return { session };
  };
  __setWorkflowTestAgentSessionFactory(factory);

  const fixtureId = ++replayAcceptanceFixtureId;
  const script =
    `export const meta = { name: "acceptance-replay-${fixtureId}" };\n` +
    'const r = await agent("verify the fixture", { agent_type: "reviewer", acceptance: { criteria: [{ id: "tests", description: "Focused tests pass", requiredEvidence: ["command"] }] } });\n' +
    "return { ok: r.ok, error: r.error, acceptanceWarning: r.acceptanceWarning };";

  try {
    const first = (await workflow.execute(
      `e2e-acceptance-replay-source-${fixtureId}`,
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
    assert.equal(journal.entries.length, 1);
    if (verdict === "missing") delete journal.entries[0]!.structured;
    else journal.entries[0]!.structured = tamperedAcceptance(verdict);
    writeFileSync(journalPath, JSON.stringify(journal));

    const resumed = (await workflow.execute(
      `e2e-acceptance-replay-resume-${fixtureId}`,
      {
        script,
        resume_from_run_id: String(first.details.runId),
        wait: true,
      },
      undefined,
      undefined,
      ctx,
    )) as ReplayAcceptanceFixture["resumed"];
    const persisted = readWorkflowJson(resumed.details.runId);
    return {
      resumed,
      agents: persisted.agents as ReplayAcceptanceAgent[],
      runDir: runDirFor(resumed.details.runId),
      sessionCreations,
    };
  } finally {
    __setWorkflowTestAgentSessionFactory(undefined);
  }
}

const replayAcceptanceVerdicts = [
  "rejected",
  "missing",
  "malformed",
] as const satisfies readonly ReplayAcceptanceVerdict[];

// Keep the three projections independent: the deprecated model judgment, the
// runtime execution record, and success-only filesystem side effects.
test("replay self-attestation verdicts do not override runtime success", async () => {
  for (const verdict of replayAcceptanceVerdicts) {
    const fixture = await runTamperedAcceptanceReplay(verdict);
    const projected = fixture.resumed.content
      .map((entry) => entry.text)
      .join("\n");
    assert.match(projected, /"ok"\s*:\s*true/);
    assert.doesNotMatch(projected, /"error"/);
    assert.match(projected, /model self-attestation/);
  }
});

test("replay self-attestation remains distinct from runtime records", async () => {
  for (const verdict of replayAcceptanceVerdicts) {
    const { agents, sessionCreations } =
      await runTamperedAcceptanceReplay(verdict);
    assert.equal(sessionCreations, 1);
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.state, "done");
    assert.equal(agents[0]?.replayed, true);
    assert.equal(agents[0]?.invocation?.admissionState, "replayed");
    assert.equal(agents[0]?.invocation?.executionState, "settled");
    assert.equal(agents[0]?.invocation?.outcome, "success");
    assert.equal(agents[0]?.acceptance?.status, verdict);
    assert.equal(agents[0]?.error, undefined);
    assert.equal(typeof agents[0]?.resultArtifact, "string");
    assert.equal(typeof agents[0]?.resultRef, "string");
  }
});

test("replayed runtime successes retain artifacts despite self-attestation", async () => {
  for (const verdict of replayAcceptanceVerdicts) {
    const { runDir } = await runTamperedAcceptanceReplay(verdict);
    assert.equal(
      existsSync(join(runDir, "agent-results/agent-0001.json")),
      true,
    );
    assert.equal(existsSync(join(runDir, "journal.json")), true);
  }
});

test("structured agent results survive handoff refs and downstream inputs", async () => {
  let sessionCreations = 0;
  let downstreamPrompt = "";
  const factory: WorkflowAgentSessionFactory = async (options) => {
    sessionCreations++;
    if (sessionCreations > 1) {
      return {
        session: fakeAgentSession("downstream output", undefined, (prompt) => {
          downstreamPrompt = prompt;
        }),
      };
    }

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
        "structured-handoff",
        { verdict: "accepted", score: 7 },
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
      "e2e-structured-handoff",
      {
        script:
          'export const meta = { name: "structured-handoff" };\n' +
          'const first = await agent("produce a verdict", { agent_type: "reviewer", schema: { type: "object", properties: { verdict: { type: "string" }, score: { type: "number" } }, required: ["verdict", "score"] } });\n' +
          'const second = await agent("consume the upstream verdict", { agent_type: "reviewer", inputs: [first.ref] });\n' +
          "return { firstOk: first.ok, firstRef: first.ref ?? null, secondOk: second.ok, secondOutput: second.output };",
        wait: true,
      },
      undefined,
      undefined,
      ctx,
    )) as { details: { runId?: unknown } };

    const runId = result.details.runId;
    const runDir = runDirFor(runId);
    const returned = JSON.parse(
      readFileSync(join(runDir, "result.json"), "utf8"),
    ) as {
      firstOk: unknown;
      firstRef: unknown;
      secondOk: unknown;
      secondOutput: unknown;
    };
    assert.equal(returned.firstOk, true);
    assert.equal(typeof returned.firstRef, "string");
    assert.equal(returned.secondOk, true);
    assert.equal(returned.secondOutput, "downstream output");
    assert.match(downstreamPrompt, /accepted/);

    const persisted = readWorkflowJson(runId);
    const agents = persisted.agents as Array<{
      callId?: unknown;
      state: unknown;
      resultArtifact?: unknown;
      resultRef?: unknown;
      inputCallIds?: unknown;
    }>;
    assert.equal(agents.length, 2);
    assert.equal(agents[0]?.state, "done");
    assert.equal(agents[0]?.resultArtifact, "agent-results/agent-0001.json");
    assert.equal(typeof agents[0]?.resultRef, "string");
    assert.equal(agents[1]?.state, "done");
    assert.equal(agents[1]?.resultArtifact, "agent-results/agent-0002.json");
    assert.deepEqual(agents[1]?.inputCallIds, [agents[0]?.callId]);
    assert.equal(sessionCreations, 2);
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

test("extension retention stays bounded and reports evictions under settled-run pressure", async () => {
  const before = (await status.execute("e2e-retention-before", {})) as {
    details: {
      retention: {
        retainedRuns: number;
        retainedBytes: number;
        evictedRuns: number;
      };
    };
  };
  const beforeEvictions = before.details.retention.evictedRuns;
  let sessionCreations = 0;
  __setWorkflowTestAgentSessionFactory(async () => {
    sessionCreations++;
    return { session: fakeAgentSession(`pressure output ${sessionCreations}`) };
  });
  const script =
    'export const meta = { name: "retention-pressure" };\n' +
    'const r = await agent("pressure fixture", { agent_type: "reviewer", label: "pressure-agent" });\n' +
    'log("pressure log: " + r.output);\n' +
    "return { ok: r.ok, output: r.output };";

  const runIds: string[] = [];
  try {
    for (let index = 0; index < 16; index++) {
      const result = (await workflow.execute(
        `e2e-retention-pressure-${index}`,
        { script, wait: true },
        undefined,
        undefined,
        ctx,
      )) as { details: { runId?: unknown; status?: unknown } };
      assert.equal(result.details.status, "completed");
      assert.equal(typeof result.details.runId, "string");
      runIds.push(result.details.runId as string);
    }
  } finally {
    __setWorkflowTestAgentSessionFactory(undefined);
  }

  for (const runId of runIds) {
    const persisted = readWorkflowJson(runId);
    assert.equal((persisted.agents as unknown[]).length, 1);
    assert.equal((persisted.logs as unknown[]).length, 1);
  }

  const after = (await status.execute("e2e-retention-after", {})) as {
    content: Array<{ text: string }>;
    details: {
      runs: Array<{ name?: unknown; total: number }>;
      retention: {
        retainedRuns: number;
        retainedBytes: number;
        evictedRuns: number;
        settledRunsEvicted: number;
      };
      settledRunsEvicted: number;
    };
  };
  assert.equal(sessionCreations, 16);
  assert.equal(after.details.retention.retainedRuns, 8);
  assert.ok(after.details.retention.retainedBytes <= 64 * 1024);
  assert.ok(after.details.retention.evictedRuns - beforeEvictions >= 8);
  assert.equal(
    after.details.retention.settledRunsEvicted,
    after.details.retention.evictedRuns,
  );
  assert.equal(
    after.details.settledRunsEvicted,
    after.details.retention.evictedRuns,
  );
  const retainedPressureRuns = after.details.runs.filter(
    (run) => run.name === "retention-pressure",
  );
  assert.equal(retainedPressureRuns.length, 8);
  assert.ok(retainedPressureRuns.every((run) => run.total === 1));
  assert.match(after.content[0]!.text, /evicted\/omitted/);
});

test("forced settlement persists worktree cleanup that finishes later", async () => {
  modelIdle = true;
  for (const handler of handlers.get("agent_settled") ?? []) {
    await handler({}, ctx);
  }
  sentMessages.length = 0;
  let activeRun:
    | Parameters<typeof shutdownActiveWorkflowRuns>[0][number]
    | undefined;
  let markCleanupStarted = () => {};
  let releaseCleanup = () => {};
  const cleanupStarted = new Promise<void>((resolve) => {
    markCleanupStarted = resolve;
  });
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let actualCleanup: Awaited<ReturnType<typeof reclaimWorktree>> | undefined;
  let latePersistenceFailures = 0;

  __setWorkflowTestAgentSessionFactory(async () => ({
    session: fakeAgentSession("isolated agent output"),
  }));
  __setWorkflowTestLifecycleHooks({
    persistWorkflow(runDir, details, journal) {
      if (
        latePersistenceFailures === 0 &&
        details.status === "failed" &&
        details.agents.some((agent) => agent.worktreeCleanup !== undefined)
      ) {
        latePersistenceFailures++;
        throw new Error("injected late cleanup persistence failure");
      }
      persistWorkflowJson(runDir, details, journal);
    },
    onRunStarted(run) {
      activeRun = run;
    },
    async reclaimWorktree(repoCwd, worktree) {
      markCleanupStarted();
      await cleanupGate;
      actualCleanup = await reclaimWorktree(repoCwd, worktree);
      return actualCleanup;
    },
  });

  try {
    const launch = (await workflow.execute(
      "e2e-forced-worktree-cleanup",
      {
        script:
          'export const meta = { name: "forced-worktree-cleanup" };\n' +
          'await agent("finish in isolation", { agent_type: "reviewer", isolation: "worktree" });\n' +
          "return true;",
        background: true,
      },
      undefined,
      undefined,
      ctx,
    )) as { details: { runId?: unknown } };

    await cleanupStarted;
    assert.ok(activeRun);
    assert.equal(await shutdownActiveWorkflowRuns([activeRun], 10), false);

    const forced = readWorkflowJson(launch.details.runId);
    assert.equal(forced.status, "failed");
    const forcedAgent = (forced.agents as Array<Record<string, unknown>>)[0];
    assert.equal(forcedAgent?.worktreeCleanup, undefined);

    releaseCleanup();
    await activeRun.completion;
    assert.ok(actualCleanup);
    assert.equal(latePersistenceFailures, 1);

    const deliveriesForRun = () =>
      sentMessages.filter((sent) =>
        String(sent.message.content).includes(
          `(${String(launch.details.runId)})`,
        ),
      );
    await waitFor(
      () => deliveriesForRun().length === 1,
      "forced settlement completion delivery",
    );

    const persisted = readWorkflowJson(launch.details.runId);
    assert.equal(persisted.status, "failed");
    assert.match(String(persisted.error), /Session shutdown deadline exceeded/);
    assert.match(
      String(persisted.error),
      /Artifact persistence failed: injected late cleanup persistence failure/,
    );
    const agent = (persisted.agents as Array<Record<string, unknown>>)[0];
    assert.deepEqual(agent?.worktreeCleanup, actualCleanup);
    assert.equal(
      agent?.worktreeBranch,
      actualCleanup.branchDeleted ? undefined : actualCleanup.branch,
    );
    if (actualCleanup.removed) assert.equal(agent?.worktreePath, undefined);
    assert.equal(typeof agent?.worktreeHandoffArtifact, "string");
    const delivery = persisted.delivery as Record<string, unknown>;
    assert.equal(
      delivery.id,
      `workflow:${String(launch.details.runId)}:terminal`,
    );
    assert.equal(delivery.state, "delivered");
    assert.equal(delivery.attempts, 1);
    assert.equal(typeof delivery.updatedAt, "number");
    assert.equal(typeof delivery.deliveredAt, "number");

    const delivered = deliveriesForRun()[0];
    assert.ok(delivered);
    assert.match(String(delivered.message.content), /failed/);
    assert.match(
      String(delivered.message.content),
      /Session shutdown deadline exceeded/,
    );

    for (const handler of handlers.get("agent_settled") ?? []) {
      await handler({}, ctx);
    }
    assert.equal(deliveriesForRun().length, 1);
  } finally {
    releaseCleanup();
    if (activeRun?.completion) await activeRun.completion.catch(() => {});
    __setWorkflowTestLifecycleHooks(undefined);
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
