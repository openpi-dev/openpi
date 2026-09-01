import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  notifyWebCapabilities,
  projectBackgroundTerminalCapability,
  projectSubagentCapability,
  projectWorkflowCapability,
  registerWebCapability,
  subscribeWebCapabilities,
  type WebCapabilityScope,
  webCapabilitySnapshot,
} from "../../extensions/shared/web-observer-registry.ts";

const sessionScope = () => ({}) as unknown as SessionManager;

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
