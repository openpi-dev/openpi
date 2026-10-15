import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SubagentSnapshot } from "../../extensions/subagents/src/domain.ts";
import {
  notifyWebCapabilities,
  projectBackgroundTerminalCapability,
  projectBackgroundTerminalDetail,
  projectSubagentCapability,
  projectSubagentDetail,
  projectWorkflowAgentDetail,
  projectWorkflowCapability,
  registerWebCapability,
  registerWebCapabilityActions,
  runWebCapabilityAction,
  subscribeWebCapabilities,
  type WebCapabilityScope,
  webCapabilityDetail,
  webCapabilitySnapshot,
} from "../../extensions/shared/web-observer-registry.ts";

const sessionScope = () => ({}) as unknown as SessionManager;

function subagentSnapshot(
  overrides: Partial<SubagentSnapshot> = {},
): SubagentSnapshot {
  return {
    id: "sa-1",
    origin: "model",
    backend: "pi",
    title: "Inspect package",
    prompt: "Read package.json",
    cwd: "/workspace",
    status: "running",
    createdAt: 1,
    meta: {
      backend: "pi",
      modelLabel: "provider/model",
      sessionFilePath: "/private/child.jsonl",
    },
    usage: {},
    transcript: [],
    transcriptVersion: 0,
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
    ...overrides,
  };
}

test("subagent detail clones display data, redacts private thinking, and preserves exact lifecycle", () => {
  const source = subagentSnapshot({
    status: "error",
    outcome: "interrupted",
    settledAt: 2,
    transcript: [
      { kind: "user", text: "inspect" },
      {
        kind: "assistant",
        parts: [
          { type: "thinking", text: "private reasoning", redacted: true },
          { type: "text", text: "Checking" },
          {
            type: "toolCall",
            toolId: "call-1",
            name: "read",
            argsPreview: "package.json",
          },
        ],
      },
      {
        kind: "toolResult",
        toolId: "call-1",
        name: "read",
        isError: false,
        outputPreview: "package content",
      },
    ],
    liveAssistant: { text: "Partial", thinking: "Visible thought" },
    liveTools: [{ toolId: "call-2", name: "read", done: false }],
    errorText: "Interrupted",
    finalText: "partial answer",
  });
  const detail = projectSubagentDetail(source);
  assert.equal(detail.status, "error");
  assert.equal(detail.outcome, "interrupted");
  assert.equal(detail.settledAt, 2);
  assert.equal(detail.model, "provider/model");
  assert.equal(detail.prompt, "Read package.json");
  assert.equal(detail.truncated, false);
  assert.equal(detail.omittedEntries, 0);
  assert.equal(JSON.stringify(detail).includes("/private/child.jsonl"), false);
  assert.equal(JSON.stringify(detail).includes("private reasoning"), false);
  assert.notEqual(detail.transcript, source.transcript);
  assert.notEqual(detail.transcript[1], source.transcript[1]);
  assert.notEqual(detail.liveAssistant, source.liveAssistant);
  assert.notEqual(detail.liveTools[0], source.liveTools[0]);
  const assistant = detail.transcript[1];
  assert.equal(assistant?.kind, "assistant");
  if (assistant?.kind !== "assistant") throw new Error("Missing assistant");
  assert.deepEqual(assistant.parts[0], {
    type: "thinking",
    text: "",
    redacted: true,
  });
  assert.deepEqual(source.transcript[0], { kind: "user", text: "inspect" });
});

test("subagent detail bounds nested counts and UTF-8 text with honest omission evidence", () => {
  const huge = "界".repeat(30_000);
  const detail = projectSubagentDetail(
    subagentSnapshot({
      title: huge,
      prompt: huge,
      cwd: huge,
      finalText: huge,
      errorText: huge,
      liveAssistant: { text: huge, thinking: huge },
      liveTools: Array.from({ length: 30 }, (_, index) => ({
        toolId: `call-${index}`,
        name: "read",
        outputPreview: huge,
      })),
      transcript: Array.from({ length: 80 }, () => ({
        kind: "assistant" as const,
        parts: Array.from({ length: 50 }, () => ({
          type: "text" as const,
          text: huge,
        })),
      })),
    }),
  );
  assert.equal(detail.transcript.length, 64);
  assert.equal(detail.omittedEntries, 16);
  assert.ok(detail.liveTools.length <= 16);
  assert.equal(detail.truncated, true);
  for (const entry of detail.transcript) {
    if (entry.kind === "assistant") assert.equal(entry.parts.length, 32);
  }
  const strings: string[] = [];
  JSON.stringify(detail, (_key, value: unknown) => {
    if (typeof value === "string") strings.push(value);
    return value;
  });
  assert.ok(strings.every((value) => !value.includes("\ufffd")));
  // Includes bounded schema discriminators/keys as well as the 64 KiB text budget.
  assert.ok(Buffer.byteLength(JSON.stringify(detail)) < 160 * 1024);
  assert.ok(Buffer.byteLength(detail.prompt) <= 4 * 1024);
});

test("subagent byte limits omit identities instead of corrupting tool pairing", () => {
  const suffix = "shared-tail".repeat(100);
  const ids = [`first-${suffix}`, `second-${suffix}`];
  const projected = projectSubagentDetail(
    subagentSnapshot({
      liveTools: ids.map((toolId) => ({ toolId, name: "read" })),
      transcript: [
        {
          kind: "assistant",
          parts: ids.map((toolId) => ({
            type: "toolCall",
            toolId,
            name: "read",
          })),
        },
        ...ids.map((toolId) => ({
          kind: "toolResult" as const,
          toolId,
          name: "read",
          isError: false,
        })),
      ],
    }),
  );
  assert.deepEqual(projected.liveTools, []);
  assert.deepEqual(projected.transcript, [{ kind: "assistant", parts: [] }]);
  assert.equal(projected.omittedEntries, 2);
  assert.equal(projected.truncated, true);

  const exhausted = projectSubagentDetail(
    subagentSnapshot({
      liveTools: Array.from({ length: 16 }, (_, index) => ({
        toolId: `live-${index}`,
        name: "read",
        argsPreview: "x".repeat(4096),
        outputPreview: "x".repeat(4096),
      })),
      transcript: [
        {
          kind: "assistant",
          parts: [{ type: "toolCall", toolId: "exact-call", name: "read" }],
        },
        {
          kind: "toolResult",
          toolId: "exact-call",
          name: "read",
          isError: true,
        },
      ],
    }),
  );
  assert.equal(exhausted.omittedEntries, 1);
  assert.deepEqual(exhausted.transcript, [{ kind: "assistant", parts: [] }]);
  assert.ok(
    exhausted.liveTools.every((tool) => /^live-\d+$/u.test(tool.toolId)),
  );
  assert.equal(
    new Set(exhausted.liveTools.map((tool) => tool.toolId)).size,
    exhausted.liveTools.length,
  );
  assert.equal(exhausted.truncated, true);
});

test("subagent detail reads exact current manager data only within its Session scope", () => {
  const scope = sessionScope();
  let snapshot = subagentSnapshot();
  const unregister = registerWebCapability(scope, {
    kind: "subagents",
    snapshot: () => projectSubagentCapability([snapshot]),
    detail: (id) =>
      id === snapshot.id ? projectSubagentDetail(snapshot) : undefined,
  });
  try {
    const running = webCapabilityDetail(scope, "subagents", "sa-1");
    assert.equal(running.status, "found");
    if (running.status === "found")
      assert.equal(running.detail.status, "running");
    snapshot = {
      ...snapshot,
      status: "done",
      outcome: "completed",
      finalText: "verified",
      settledAt: 3,
    };
    const finished = webCapabilityDetail(scope, "subagents", "sa-1");
    assert.equal(finished.status, "found");
    if (finished.status === "found" && finished.detail.kind === "subagents") {
      assert.equal(finished.detail.outcome, "completed");
      assert.equal(finished.detail.finalText, "verified");
    }
    assert.deepEqual(webCapabilityDetail(scope, "subagents", "sa-unknown"), {
      status: "missing",
    });
    assert.deepEqual(webCapabilityDetail(sessionScope(), "subagents", "sa-1"), {
      status: "unavailable",
    });
    assert.deepEqual(webCapabilityDetail(scope, "subagents", "sa-1\n"), {
      status: "invalid",
    });
  } finally {
    unregister();
  }
  assert.deepEqual(webCapabilityDetail(scope, "subagents", "sa-1"), {
    status: "unavailable",
  });
});

test("capability actions stay scoped to one SessionManager identity", async () => {
  const sessionA = sessionScope();
  const sessionB = sessionScope();
  const requests: string[] = [];
  const unregister = registerWebCapabilityActions(sessionA, {
    kind: "subagents",
    async run(request) {
      requests.push(request.action);
      return projectSubagentDetail(
        subagentSnapshot({ id: "btw-1", origin: "btw", prompt: "aside" }),
      );
    },
  });
  try {
    const detail = await runWebCapabilityAction(sessionA, {
      kind: "subagents",
      action: "spawn-btw",
      prompt: "aside",
    });
    assert.equal(detail?.kind, "subagents");
    assert.equal(detail?.id, "btw-1");
    assert.deepEqual(requests, ["spawn-btw"]);
    assert.equal(
      await runWebCapabilityAction(sessionB, {
        kind: "subagents",
        action: "spawn-btw",
        prompt: "aside",
      }),
      undefined,
    );
  } finally {
    unregister();
  }
  assert.equal(
    await runWebCapabilityAction(sessionA, {
      kind: "subagents",
      action: "spawn-btw",
      prompt: "aside",
    }),
    undefined,
  );
});

test("shares providers across separate physical module copies", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-registry-copies-"));
  const source = fileURLToPath(
    new URL(
      "../../extensions/shared/web-observer-registry.ts",
      import.meta.url,
    ),
  );
  const firstPath = join(root, "first.ts");
  const secondPath = join(root, "second.ts");
  try {
    await Promise.all([
      copyFile(source, firstPath),
      copyFile(source, secondPath),
    ]);
    const first = (await import(
      pathToFileURL(firstPath).href
    )) as typeof import("../../extensions/shared/web-observer-registry.ts");
    const second = (await import(
      pathToFileURL(secondPath).href
    )) as typeof import("../../extensions/shared/web-observer-registry.ts");
    const scope = sessionScope();
    const observed: WebCapabilityScope[] = [];
    const unsubscribe = second.subscribeWebCapabilities((changed) => {
      observed.push(changed);
    });
    const unregister = first.registerWebCapability(scope, {
      kind: "workflows",
      snapshot: () => ({
        items: [],
        omitted: 0,
        truncated: false,
      }),
    });

    assert.deepEqual(second.webCapabilitySnapshot(scope), {
      workflows: { items: [], omitted: 0, truncated: false },
    });
    assert.deepEqual(observed, [scope]);

    unregister();
    unsubscribe();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolates providers and notifications by SessionManager identity", () => {
  const sessionA = sessionScope();
  const sessionB = sessionScope();
  const changes: WebCapabilityScope[] = [];
  const unsubscribeObserver = subscribeWebCapabilities((scope) =>
    changes.push(scope),
  );
  const unregisterA = registerWebCapability(sessionA, {
    kind: "subagents",
    snapshot: () => ({ items: [], omitted: 0, truncated: false }),
  });
  const unregisterB = registerWebCapability(sessionB, {
    kind: "workflows",
    snapshot: () => ({ items: [], omitted: 0, truncated: false }),
  });

  assert.deepEqual(webCapabilitySnapshot(sessionA), {
    subagents: { items: [], omitted: 0, truncated: false },
  });
  assert.deepEqual(webCapabilitySnapshot(sessionB), {
    workflows: { items: [], omitted: 0, truncated: false },
  });
  assert.deepEqual(changes, [sessionA, sessionB]);

  notifyWebCapabilities(sessionB);
  assert.equal(changes.at(-1), sessionB);

  unregisterA();
  unregisterB();
  unsubscribeObserver();
});

test("replacement and unregister are provider-identity safe", () => {
  const scope = sessionScope();
  let firstListener: (() => void) | undefined;
  let secondListener: (() => void) | undefined;
  let changes = 0;
  const unsubscribeObserver = subscribeWebCapabilities(() => changes++);
  const unregisterFirst = registerWebCapability(scope, {
    kind: "subagents",
    snapshot: () => ({
      items: [{ id: "first", title: "first", status: "running", createdAt: 1 }],
      omitted: 0,
      truncated: false,
    }),
    subscribe: (listener) => {
      firstListener = listener;
      return () => {
        firstListener = undefined;
      };
    },
  });
  const unregisterSecond = registerWebCapability(scope, {
    kind: "subagents",
    snapshot: () => ({
      items: [{ id: "second", title: "second", status: "done", createdAt: 2 }],
      omitted: 0,
      truncated: false,
    }),
    subscribe: (listener) => {
      secondListener = listener;
      return () => {
        secondListener = undefined;
      };
    },
  });

  assert.equal(firstListener, undefined);
  assert.ok(secondListener);
  unregisterFirst();
  assert.deepEqual(webCapabilitySnapshot(scope).subagents?.items, [
    { id: "second", title: "second", status: "done", createdAt: 2 },
  ]);
  secondListener?.();
  assert.equal(changes, 3);

  unregisterSecond();
  assert.deepEqual(webCapabilitySnapshot(scope), {});
  assert.equal(secondListener, undefined);
  assert.equal(changes, 4);
  unsubscribeObserver();
});

test("disconnects provider subscriptions when the observer closes", () => {
  const scope = sessionScope();
  let disconnected = false;
  const unregister = registerWebCapability(scope, {
    kind: "background-terminals",
    snapshot: () => ({ items: [], omitted: 0, truncated: false }),
    subscribe: () => () => {
      disconnected = true;
    },
  });
  const unsubscribeObserver = subscribeWebCapabilities(() => {});

  unsubscribeObserver();
  assert.equal(disconnected, true);
  unregister();
});

test("projects bounded canonical activity without private payloads", () => {
  const subagents = projectSubagentCapability(
    Array.from({ length: 40 }, (_, index) => ({
      id: `sa-${index}`,
      title: index === 0 ? "x".repeat(500) : `agent ${index}`,
      prompt: "private prompt",
      finalText: "private answer",
      status: index === 39 ? ("running" as const) : ("done" as const),
      outcome: index === 39 ? undefined : ("completed" as const),
      createdAt: index,
      settledAt: index === 39 ? undefined : index + 1,
    })),
  );
  assert.equal(subagents.items.length, 32);
  assert.equal(subagents.items[0]?.id, "sa-39");
  assert.equal(subagents.omitted, 8);
  assert.equal(subagents.truncated, true);
  assert.equal("prompt" in subagents.items[0]!, false);
  assert.equal("finalText" in subagents.items[0]!, false);

  const withAdmission = projectSubagentCapability([], {
    enabled: true,
    limit: 2,
    held: 2,
    queued: 1,
    heldByOrigin: { workflow: 1, direct: 1, btw: 0 },
    queuedByOrigin: { workflow: 0, direct: 0, btw: 1 },
    blockedReason:
      "Waiting for a shared child execution slot (2 active / 2 limit).",
  });
  assert.deepEqual(withAdmission.childExecutionAdmission, {
    enabled: true,
    limit: 2,
    held: 2,
    queued: 1,
    heldByOrigin: { workflow: 1, direct: 1, btw: 0 },
    queuedByOrigin: { workflow: 0, direct: 0, btw: 1 },
    blockedReason:
      "Waiting for a shared child execution slot (2 active / 2 limit).",
  });

  const workflowSources = [
    {
      runId: "wf-1",
      name: "review",
      status: "running" as const,
      currentPhase: "test",
      startedAt: 1,
      agents: [
        { state: "running" as const, transcript: ["private"] },
        { state: "done" as const, preview: "private" },
      ],
      result: "private",
    },
  ];
  const workflows = projectWorkflowCapability(workflowSources);
  assert.deepEqual(workflows.items[0]?.agents, {
    total: 2,
    running: 1,
    done: 1,
    error: 0,
    uncertain: 0,
  });
  assert.equal("result" in workflows.items[0]!, false);

  const boundedAgents = projectWorkflowCapability([
    {
      runId: "wf-many",
      status: "running",
      startedAt: 1,
      agents: Array.from({ length: 2_000 }, () => ({ state: "done" })),
    },
  ]);
  assert.equal(boundedAgents.items[0]?.agents.omitted, 976);
  assert.equal(boundedAgents.truncated, true);

  const terminalSources = [
    {
      id: "bg-1",
      title: "server",
      status: "done" as const,
      createdAt: 1,
      settledAt: 2,
      exitCode: 0,
      command: "secret command",
      stdout: { text: "private output" },
    },
  ];
  const terminals = projectBackgroundTerminalCapability(terminalSources);
  assert.deepEqual(terminals.items, [
    {
      id: "bg-1",
      title: "server",
      status: "done",
      createdAt: 1,
      settledAt: 2,
      exitCode: 0,
    },
  ]);
});

test("workflow children retain exact run/call identity and uncertain or interrupted outcomes", () => {
  const projected = projectWorkflowCapability([
    {
      runId: "wf_a1",
      status: "running",
      startedAt: 1,
      agents: [
        { index: 1, label: "same label", state: "done", startedAt: 1 },
        { index: 2, label: "same label", state: "uncertain", startedAt: 2 },
        {
          index: 3,
          label: "uncertain stop",
          state: "error",
          executionOutcome: "uncertain",
          startedAt: 3,
        },
        {
          index: 4,
          label: "cancelled",
          state: "error",
          executionOutcome: "cancelled",
          startedAt: 4,
        },
        {
          index: 5,
          label: "retained uncertainty",
          state: "done",
          completion: { observed: { outcome: "uncertain" } },
          startedAt: 5,
        },
      ],
    },
    {
      runId: "wf_b2",
      status: "completed",
      startedAt: 1,
      agents: [{ index: 1, label: "same label", state: "done", startedAt: 1 }],
    },
  ]);
  const first = projected.items.find((item) => item.runId === "wf_a1")!;
  const children = new Map(
    first.children!.items.map((item) => [item.id, item]),
  );
  assert.equal(children.get("wf_a1:call:1")?.status, "done");
  for (const index of [2, 3, 5]) {
    const child = children.get(`wf_a1:call:${index}`)!;
    assert.equal(child.status, "unknown");
    assert.equal(child.outcome, undefined);
  }
  assert.equal(children.get("wf_a1:call:4")?.outcome, "interrupted");
  assert.equal(first.agents.done, 1);
  assert.equal(first.agents.uncertain, 3);
  assert.equal(
    projected.items.find((item) => item.runId === "wf_b2")?.children?.items[0]
      ?.id,
    "wf_b2:call:1",
  );
});

test("workflow owner failure remains failed when child execution succeeded but its result could not persist", () => {
  const agent = {
    index: 1,
    label: "Oversized authoritative result",
    state: "error",
    executionOutcome: "success",
    completion: { observed: { outcome: "success" } },
    resultPersistence: "failed",
    startedAt: 1,
    finishedAt: 2,
    transcript: [],
    transcriptUnavailable: true,
  };
  const run = projectWorkflowCapability([
    { runId: "wf_a1", status: "completed", startedAt: 1, agents: [agent] },
  ]).items[0]!;
  assert.equal(run.children?.items[0]?.status, "error");
  assert.equal(run.children?.items[0]?.outcome, "failed");
  assert.equal(run.agents.error, 1);
  assert.equal(run.agents.done, 0);
  const detail = projectWorkflowAgentDetail("wf_a1", agent);
  assert.equal(detail?.status, "error");
  assert.equal(detail?.outcome, "failed");
});

test("workflow child snapshots bound nested data and never truncate navigable identities", () => {
  const sources = Array.from({ length: 40 }, (_, runIndex) => ({
    runId: `wf_${runIndex.toString(16)}`,
    name: "界".repeat(500),
    status: "running" as const,
    startedAt: runIndex,
    agents: Array.from({ length: 2_000 }, (_, index) => ({
      index: index + 1,
      label: "界".repeat(500),
      state: index === 0 ? "running" : "done",
      startedAt: index,
      prompt: "private prompt",
      preview: "private result",
      transcript: ["private transcript"],
    })),
  }));
  const snapshot = projectWorkflowCapability(sources);
  assert.equal(snapshot.items.length, 32);
  for (const run of snapshot.items) {
    assert.equal(run.children?.items.length, 32);
    assert.equal(run.children?.omitted, 1_968);
    assert.equal(run.children?.truncated, true);
    assert.equal(run.children?.items[0]?.id, `${run.runId}:call:1`);
    assert.ok(run.children?.items.every((child) => child.runId === run.runId));
  }
  const json = JSON.stringify(snapshot);
  assert.ok(Buffer.byteLength(json) < 4 * 1024 * 1024);
  assert.equal(json.includes("private"), false);

  const invalid = projectWorkflowCapability([
    {
      runId: "wf_c3",
      status: "completed",
      startedAt: 1,
      memoryProjection: { omitted: { agents: 7 } },
      agents: [
        { index: -1, state: "done" },
        { index: 1.5, state: "done" },
        { index: 2, state: "done" },
        { index: 2, state: "done" },
      ],
    },
    {
      runId: `wf_${"a".repeat(160)}`,
      status: "completed",
      startedAt: 1,
      agents: [{ index: 1, state: "done" }],
    },
  ]);
  assert.ok(invalid.items.every((run) => run.children?.items.length === 0));
  assert.equal(
    invalid.items.find((run) => run.runId === "wf_c3")?.children?.omitted,
    11,
  );
});

test("workflow detail shares body limits and marks retained or replayed missing evidence", () => {
  const detail = projectWorkflowAgentDetail("wf_a1", {
    index: 1,
    label: "Inspect package",
    state: "error",
    executionOutcome: "uncertain",
    startedAt: 1,
    finishedAt: 2,
    cwd: "/workspace",
    model: "fixture/reasoner",
    errorText: "Child termination is uncertain",
    transcriptUnavailable: false,
    transcript: Array.from({ length: 80 }, (_, index) => ({
      kind: "assistant" as const,
      parts: [
        { type: "text" as const, text: "界".repeat(30_000) },
        { type: "toolCall" as const, toolId: `tool-${index}`, name: "read" },
      ],
    })),
  });
  assert.ok(detail);
  assert.equal(detail.kind, "workflows");
  assert.equal(detail.id, "wf_a1:call:1");
  assert.equal(detail.runId, "wf_a1");
  assert.equal(detail.status, "unknown");
  assert.equal(detail.outcome, undefined);
  assert.equal(detail.transcriptUnavailable, false);
  assert.equal(detail.truncated, true);
  assert.ok(detail.omittedEntries > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(detail)) < 128 * 1024);

  const retainedOwner = {
    index: 1,
    label: "Replayed child",
    state: "done",
    startedAt: 1,
    replayed: true,
    transcript: [],
    transcriptUnavailable: true,
    preview: "A bounded preview is not a final result",
  };
  const retained = projectWorkflowAgentDetail("wf_b2", retainedOwner);
  assert.ok(retained);
  assert.equal(retained.transcriptUnavailable, true);
  assert.equal(retained.replayed, true);
  assert.equal(retained.finalText, "");
  assert.equal(JSON.stringify(retained).includes("bounded preview"), false);
  assert.equal(
    projectWorkflowAgentDetail("../wf_b2", {
      index: 1,
      state: "done",
      transcript: [],
      transcriptUnavailable: true,
    }),
    undefined,
  );
});

test("projects bounded terminal detail with exact identity and recovery evidence", () => {
  const detail = projectBackgroundTerminalDetail({
    id: "bt-exact",
    title: "dev server",
    command: `prefix-${"c".repeat(5_000)}`,
    cwd: `/workspace/${"d".repeat(3_000)}`,
    pid: 42,
    status: "failed",
    createdAt: 1,
    settledAt: 2,
    exitCode: 1,
    errorText: "e".repeat(3_000),
    stdout: {
      modelSafeText: `old-${"x".repeat(20_000)}-tail`,
      totalBytes: 30_000,
      truncatedBytes: 4_000,
      spillPath: "/private/full-stdout.log",
    },
    stderr: {
      modelSafeText: "failure",
      totalBytes: 7,
      truncatedBytes: 0,
    },
  });

  assert.equal(detail.id, "bt-exact");
  assert.equal(detail.kind, "background-terminals");
  assert.equal(detail.command.endsWith("c".repeat(100)), true);
  assert.equal(Buffer.byteLength(detail.command) <= 4 * 1024, true);
  assert.equal(Buffer.byteLength(detail.cwd) <= 2 * 1024, true);
  assert.equal(Buffer.byteLength(detail.errorText ?? "") <= 2 * 1024, true);
  assert.equal(Buffer.byteLength(detail.stdout.text) <= 16 * 1024, true);
  assert.equal(detail.stdout.text.endsWith("-tail"), true);
  assert.equal(detail.stdout.omittedBytes > 0, true);
  assert.equal(detail.stdout.recoveryAvailable, true);
  assert.equal("spillPath" in detail.stdout, false);
  assert.equal(detail.stderr.truncated, false);
  assert.equal(detail.truncated, true);
});

test("detail lookup is Session-scoped, exact, and fail-closed", () => {
  const scope = sessionScope();
  const otherScope = sessionScope();
  const detail = projectBackgroundTerminalDetail({
    id: "bt-1",
    title: "server",
    command: "run-server",
    cwd: process.cwd(),
    status: "running",
    createdAt: 1,
    stdout: {
      modelSafeText: "ready",
      totalBytes: 5,
      truncatedBytes: 0,
    },
    stderr: { modelSafeText: "", totalBytes: 0, truncatedBytes: 0 },
  });
  const unregister = registerWebCapability(scope, {
    kind: "background-terminals",
    snapshot: () => ({ items: [], omitted: 0, truncated: false }),
    detail: (id) => (id === detail.id ? detail : undefined),
  });
  try {
    assert.deepEqual(
      webCapabilityDetail(scope, "background-terminals", "bt-1"),
      {
        status: "found",
        detail,
      },
    );
    assert.deepEqual(
      webCapabilityDetail(scope, "background-terminals", "bt-missing"),
      { status: "missing" },
    );
    assert.deepEqual(
      webCapabilityDetail(otherScope, "background-terminals", "bt-1"),
      { status: "unavailable" },
    );
    assert.deepEqual(webCapabilityDetail(scope, "background-terminals", ""), {
      status: "invalid",
    });
  } finally {
    unregister();
  }
});

test("projects bounded activity text on code points instead of splitting a surrogate pair", () => {
  const emoji = "\u{1F680}";
  const subagents = projectSubagentCapability([
    {
      id: "sa-emoji",
      title: `${"x".repeat(158)}${emoji}tail`,
      status: "running",
      createdAt: 1,
    },
  ]);

  // The complete emoji survives the bound; a UTF-16 unit cut would have left a
  // lone high surrogate in the bounded capability snapshot.
  assert.equal(subagents.items[0]?.title, `${"x".repeat(158)}${emoji}…`);
  assert.equal(subagents.truncated, true);
});
