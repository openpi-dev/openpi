import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiWebAdapter } from "../../web/adapter/pi-adapter.ts";
import {
  savedSubagents,
  savedSubagentDetail,
  mergeChildHistory,
  WorkflowHistory,
} from "../../web/adapter/subagent-history.ts";
import { WebHost } from "../../web/host/web-host.ts";
import type { WebRuntimeController } from "../../web/runtime/types.ts";
import { buildWorkflowCompletionDisplay } from "../../extensions/workflows/completion-projection.ts";
import { normalizePersistedWorkflowDetails } from "../../extensions/workflows/dashboard.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";

const usage = {
  input: 2,
  output: 3,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function answer(manager: SessionManager, text: string) {
  return manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  });
}
function runtime(
  cwd: string,
  sessionDirectory: string,
  sessionManager: SessionManager,
): WebRuntimeController {
  return {
    cwd,
    workspaceSelected: true,
    sessionDirectory,
    sessionManager,
    isIdle: () => true,
    getActiveTurn: () => undefined,
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    sendPrompt: async () => {
      throw new Error("History must not execute a prompt");
    },
    newSession: async () => {
      throw new Error("History must not create a Session");
    },
    switchSession: async () => {
      throw new Error("History must not activate a Session");
    },
    listModels: () => [],
    searchModels: (query, limit) => projectWebModelSearch([], query, limit),
    setModel: async () => {
      throw new Error("History must not change the model");
    },
    subscribe: () => () => {},
    dispose: async () => {},
  };
}

test("saved Workflow bounds report omitted runs after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openpi-workflow-catalog-bound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const parent = SessionManager.inMemory(root);
  for (let index = 1; index <= 33; index++)
    parent.appendMessage({
      role: "toolResult",
      toolCallId: `workflow-${index}`,
      toolName: "workflow",
      content: [{ type: "text", text: "Completed" }],
      isError: false,
      timestamp: index,
      details: {
        runId: `wf_${index.toString(16)}`,
        sessionId: parent.getSessionId(),
        status: "completed",
        startedAt: index,
        finishedAt: index + 1,
        agents: [
          { index: 1, label: `Child ${index}`, state: "done", transcript: [] },
        ],
      },
    });
  const projection = await new WorkflowHistory().capability(parent);
  assert.equal(projection.items.length, 32);
  assert.equal(projection.omitted, 1);
  assert.equal(projection.truncated, true);
  assert.ok(projection.items.some((run) => run.runId === "wf_21"));
  assert.ok(!projection.items.some((run) => run.runId === "wf_1"));
});

test("bounded child history keeps the newest saved children while reserving live entries", () => {
  const saved = {
    items: Array.from({ length: 32 }, (_, i) => ({ id: `saved-${32 - i}` })),
    omitted: 0,
    truncated: false,
  };
  const live = { items: [{ id: "live" }], omitted: 0, truncated: false };
  const merged = mergeChildHistory(saved, live, (item) => item.id)!;
  assert.equal(merged.items.length, 32);
  assert.equal(merged.items[0]?.id, "live");
  assert.ok(merged.items.some((item) => item.id === "saved-32"));
  assert.ok(!merged.items.some((item) => item.id === "saved-1"));
  assert.equal(merged.omitted, 1);
});

test("saved child evidence cannot cross sibling branches or a cyclic ancestry", () => {
  const parent = SessionManager.inMemory("/fixture");
  const origin = parent.appendMessage({
    role: "user",
    content: "Delegate",
    timestamp: 1,
  });
  const child = SessionManager.inMemory("/fixture");
  const root = child.appendMessage({
    role: "user",
    content: "Task",
    timestamp: 1,
  });
  const left = answer(child, "Left branch");
  child.branch(root);
  const right = answer(child, "Right branch");
  parent.appendCustomEntry("subagent-finished", {
    id: "sa-1",
    title: "Review",
    origin: "model",
    status: "done",
    completion: { observed: { outcome: "success" } },
    evidence: {
      parentSessionId: parent.getSessionId(),
      parentOriginEntryId: origin,
      sessionId: child.getSessionId(),
      sessionPath: "/fixture/child.jsonl",
      generation: 1,
      sealed: true,
      parentBound: true,
      startEntryId: left,
      endEntryId: right,
    },
  });
  const saved = savedSubagents(parent)[0]!;
  assert.equal(savedSubagentDetail(saved, child), undefined);
  child.getEntry(right)!.parentId = right;
  assert.equal(
    savedSubagentDetail({ ...saved, startEntryId: null }, child),
    undefined,
  );
});

test("root BTW locators retain ownership and failed side conversations retain failure", () => {
  const parent = SessionManager.inMemory("/fixture");
  const child = SessionManager.inMemory("/fixture");
  parent.appendCustomEntry("subagent-session", {
    id: "btw-1",
    origin: "btw",
    title: "Aside",
    status: "running",
    parentSessionId: parent.getSessionId(),
    parentOriginEntryId: null,
    sessionId: child.getSessionId(),
    sessionPath: "/fixture/child.jsonl",
  });
  parent.appendCustomEntry("btw-result", {
    id: "btw-1",
    title: "Aside",
    status: "error",
    errorText: "Provider failed",
  });
  const saved = savedSubagents(parent)[0]!;
  assert.equal(saved.sessionId, child.getSessionId());
  assert.equal(saved.outcome, "failed");
});

test("an interrupted second run keeps earlier answers in history without claiming them as its result", () => {
  const parent = SessionManager.inMemory("/fixture");
  const origin = parent.appendMessage({
    role: "user",
    content: "Delegate",
    timestamp: 1,
  });
  const child = SessionManager.inMemory("/fixture");
  child.appendMessage({ role: "user", content: "First task", timestamp: 1 });
  const boundary = answer(child, "The previous run answer");
  child.appendMessage({ role: "user", content: "Second task", timestamp: 2 });
  parent.appendCustomEntry("subagent-session", {
    id: "sa-1",
    title: "Second task",
    status: "running",
    parentSessionId: parent.getSessionId(),
    parentOriginEntryId: origin,
    sessionId: child.getSessionId(),
    sessionPath: "/fixture/child.jsonl",
    startEntryId: boundary,
  });
  const detail = savedSubagentDetail(savedSubagents(parent)[0]!, child);
  assert.equal(detail?.status, "unknown");
  assert.equal(detail?.outcome, undefined);
  assert.equal(detail?.finalText, "");
  assert.match(JSON.stringify(detail?.transcript), /The previous run answer/);
});

for (const pending of [false, true, "background"] as const)
  test(`cold Workflow children recover from ${pending === "background" ? "a background completion display" : pending ? "a launch catalog" : "a completion receipt"} and persisted transcript`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "openpi-workflow-restart-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    t.after(() => {
      if (previousAgentDir === undefined)
        delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    });
    const cwd = join(root, "project");
    await mkdir(cwd);
    const directory = join(root, "parents");
    const parent = SessionManager.create(cwd, directory);
    parent.appendMessage({
      role: "user",
      content: "Review with a Workflow",
      timestamp: Date.now(),
    });
    answer(parent, "Starting Workflow");
    const run = {
      runId: "wf_123abc",
      sessionId: parent.getSessionId(),
      status: "completed",
      startedAt: 1,
      finishedAt: 2,
      agents: [
        {
          index: 1,
          label: "Workflow review",
          state: "done",
          startedAt: 1,
          finishedAt: 2,
          model: "fixture/fixture",
          transcript: [],
        },
      ],
    };
    if (pending === true)
      parent.appendCustomEntry("workflow-child", {
        ...run,
        status: "running",
        agents: [
          {
            index: 1,
            label: "Workflow review",
            state: "running",
            startedAt: 1,
          },
        ],
      });
    else if (pending === false)
      parent.appendMessage({
        role: "toolResult",
        toolCallId: "workflow-call",
        toolName: "workflow",
        content: [{ type: "text", text: "Completed" }],
        isError: false,
        details: run,
        timestamp: Date.now(),
      });
    const runDirectory = join(root, "agent", "workflows", run.runId);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      join(runDirectory, "workflow.json"),
      JSON.stringify({ ...run, transcriptArtifact: "transcripts.json" }),
    );
    await writeFile(
      join(runDirectory, "transcripts.json"),
      JSON.stringify({
        "1": [
          {
            kind: "text",
            text: "The persisted Workflow review.",
            role: "assistant",
            timestamp: 1,
          },
        ],
      }),
    );
    if (pending === "background") {
      parent.appendMessage({
        role: "toolResult",
        toolCallId: "workflow-call",
        toolName: "workflow",
        content: [{ type: "text", text: "Started in background" }],
        isError: false,
        timestamp: Date.now(),
        details: { ...run, status: "running", agents: [] },
      });
      parent.appendCustomMessageEntry(
        "workflow-result",
        "Workflow completed",
        true,
        buildWorkflowCompletionDisplay([
          {
            deliveryId: "fixture-completion",
            details: normalizePersistedWorkflowDetails(run.runId, run)!,
            runDir: runDirectory,
          },
        ]),
      );
    }
    const active = SessionManager.create(cwd, directory);
    active.appendMessage({
      role: "user",
      content: "Other conversation",
      timestamp: Date.now(),
    });
    answer(active, "Ready");
    const adapter = new PiWebAdapter(runtime(cwd, directory, active));
    const snapshot = await adapter.getSnapshot(parent.getSessionFile());
    const children =
      snapshot.selectedSession?.capabilities?.workflows?.items[0]?.children
        ?.items;
    assert.equal(children?.[0]?.id, "wf_123abc:call:1");
    assert.equal(children?.[0]?.status, "done");
    const detail = await adapter.capabilityDetail(
      parent.getSessionId(),
      parent.getSessionFile()!,
      "workflows",
      "wf_123abc:call:1",
    );
    assert.equal(detail?.kind, "workflows");
    assert.match(
      JSON.stringify(detail?.transcript),
      /The persisted Workflow review/,
    );
    await rm(join(runDirectory, "transcripts.json"));
    const metadataOnly = await adapter.capabilityDetail(
      parent.getSessionId(),
      parent.getSessionFile()!,
      "workflows",
      "wf_123abc:call:1",
    );
    assert.equal(metadataOnly?.status, "done");
    assert.equal(
      metadataOnly?.kind === "workflows" && metadataOnly.transcriptUnavailable,
      true,
    );
    assert.equal(active.getSessionId(), snapshot.currentSessionId);
  });

for (const finished of [true, false])
  test(`cold parent retains ${finished ? "completed" : "owner-lost"} child history outside the transcript page`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "openpi-subagent-restart-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, "project");
    const directory = join(root, "parents");
    await mkdir(cwd);
    const parent = SessionManager.create(cwd, directory);
    parent.appendMessage({
      role: "user",
      content: "Delegate the review",
      timestamp: Date.now(),
    });
    const origin = answer(parent, "Starting the child");
    const child = SessionManager.create(cwd, join(root, "children"));
    child.appendMessage({
      role: "user",
      content: "Review the implementation",
      timestamp: Date.now(),
    });
    const end = answer(
      child,
      finished
        ? "The review found one issue."
        : "Partial review before shutdown.",
    );
    parent.appendCustomEntry("subagent-session", {
      id: "sa-1",
      title: "Review implementation",
      origin: "model",
      status: "running",
      model: "fixture/fixture",
      cwd,
      prompt: "Review the implementation",
      sessionId: child.getSessionId(),
      sessionPath: child.getSessionFile(),
      parentSessionId: parent.getSessionId(),
      parentOriginEntryId: origin,
    });
    if (finished)
      parent.appendCustomEntry("subagent-finished", {
        id: "sa-1",
        title: "Review implementation",
        origin: "model",
        status: "done",
        evidence: {
          sessionId: child.getSessionId(),
          sessionPath: child.getSessionFile(),
          parentSessionId: parent.getSessionId(),
          parentOriginEntryId: origin,
          startEntryId: null,
          endEntryId: end,
          generation: 1,
          sealed: true,
          parentBound: true,
        },
        completion: { observed: { outcome: "success" } },
      });
    for (let i = 0; i < 300; i++)
      parent.appendMessage({
        role: "user",
        content: `Later message ${i}`,
        timestamp: Date.now(),
      });
    const parentFile = parent.getSessionFile()!;
    const before = await readFile(parentFile, "utf8");
    // Fresh adapters/Hosts have no child manager or observer registry from the old run.
    const active = SessionManager.create(cwd, directory);
    active.appendMessage({
      role: "user",
      content: "An unrelated active conversation",
      timestamp: Date.now(),
    });
    answer(active, "Ready");
    const control = runtime(cwd, directory, active);
    const adapter = new PiWebAdapter(control);
    const snapshot = await adapter.getSnapshot(parentFile);
    assert.equal(snapshot.selectedSession?.id, parent.getSessionId());
    assert.equal(
      snapshot.selectedSession?.entries.some(
        (entry) => entry.message?.customType === "subagent-finished",
      ),
      false,
    );
    assert.deepEqual(
      snapshot.selectedSession?.capabilities?.subagents?.items.map((item) => [
        item.id,
        item.title,
        item.status,
        item.outcome,
      ]),
      [
        [
          "sa-1",
          "Review implementation",
          finished ? "done" : "unknown",
          finished ? "completed" : undefined,
        ],
      ],
    );
    assert.deepEqual(snapshot.runtime.capabilities?.subagents?.items ?? [], []);
    const currentSnapshot = await new PiWebAdapter(
      runtime(cwd, directory, parent),
    ).getSnapshot(parentFile);
    assert.deepEqual(
      currentSnapshot.runtime.capabilities?.subagents,
      snapshot.selectedSession?.capabilities?.subagents,
    );
    const host = new WebHost({ runtime: control });
    await host.start();
    t.after(() => host.stop());
    const token = new URLSearchParams(new URL(host.url).hash.slice(1)).get(
      "token",
    );
    const query = new URLSearchParams({
      kind: "subagents",
      id: "sa-1",
      sessionId: parent.getSessionId(),
      sessionPath: parentFile,
    });
    const response = await fetch(
      `${host.origin}/api/capabilities/detail?${query}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(
      result.detail.finalText,
      finished
        ? "The review found one issue."
        : "Partial review before shutdown.",
    );
    assert.equal(result.detail.transcript[0].text, "Review the implementation");
    assert.deepEqual(result.detail.liveTools, []);
    assert.equal(result.detail.status, finished ? "done" : "unknown");
    assert.equal(control.sessionManager.getSessionId(), active.getSessionId());
    assert.equal(await readFile(parentFile, "utf8"), before);
    query.set("sessionId", active.getSessionId());
    assert.equal(
      (
        await fetch(`${host.origin}/api/capabilities/detail?${query}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
      404,
    );
  });
