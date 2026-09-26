import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { askWebQuestions } from "../../extensions/ask-user/web-bridge.ts";
import { WebHost } from "../../web/host/web-host.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";
import type {
  WebActiveTurn,
  WebRuntimeController,
  WebRuntimeEvent,
} from "../../web/runtime/types.ts";
import { questionFixture } from "./question-fixtures.ts";

test("authenticated Host binds questions to prompt controller, rejects replay theft and cleans up on Session switch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-web-questions-"));
  let manager = SessionManager.inMemory(cwd);
  let active: WebActiveTurn | undefined;
  const listeners = new Set<(event: WebRuntimeEvent) => void>();
  const events: Array<{ type: string; detail?: Record<string, unknown> }> = [];
  const runtime: WebRuntimeController = {
    workspaceSelected: true,
    cwd,
    sessionDirectory: cwd,
    get sessionManager() {
      return manager;
    },
    isIdle: () => !active,
    getActiveTurn: () => active,
    sendPrompt: async (_content, options) => {
      active = {
        sessionId: manager.getSessionId(),
        commandId: options!.commandId!,
        epoch: 1,
      };
      for (const listener of listeners) listener({ type: "agent_start" });
      return { pendingFollowUps: 0 };
    },
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    newSession: async () => ({
      cancelled: false,
      sessionId: manager.getSessionId(),
    }),
    switchSession: async () => ({ cancelled: false }),
    listModels: () => [],
    searchModels: (query, limit) => projectWebModelSearch([], query, limit),
    setModel: async () => {
      throw new Error("unused");
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: async () => {},
  };
  const token = "a".repeat(64);
  const controller = "ea1e029c-363a-47cf-a917-889e5d0ab477";
  const other = "aa1e029c-363a-47cf-a917-889e5d0ab477";
  const host = new WebHost({
    runtime,
    token,
    onEvent: (type, detail) => events.push({ type, detail }),
  });
  await host.start();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-OpenPI-Web-Controller": controller,
  };
  const post = (path: string, body: unknown, controllerId = controller) =>
    fetch(`${host.origin}${path}`, {
      method: "POST",
      headers: { ...headers, "X-OpenPI-Web-Controller": controllerId },
      body: JSON.stringify(body),
    });
  const sessionId = manager.getSessionId();
  try {
    const prompt = {
      sessionId,
      sessionPath: manager.getSessionFile() ?? `current:${sessionId}`,
      content: "ask",
      commandId: "prompt",
      controllerId: controller,
    };
    assert.equal((await post("/api/prompt", prompt)).status, 202);
    assert.equal(
      (await post("/api/prompt", { ...prompt, controllerId: other }, other))
        .status,
      409,
    );
    const pending = askWebQuestions(manager, "ask-1", questionFixture);
    assert.ok(pending);
    const read = await fetch(
      `${host.origin}/api/questions/pending?sessionId=${sessionId}`,
      { headers },
    );
    const request = (await read.json()).pending;
    assert.ok(request.requestId);
    assert.equal(
      (
        await fetch(
          `${host.origin}/api/questions/pending?sessionId=${sessionId}`,
        )
      ).status,
      401,
    );
    const foreign = await fetch(
      `${host.origin}/api/questions/pending?sessionId=${sessionId}`,
      { headers: { ...headers, "X-OpenPI-Web-Controller": other } },
    );
    assert.deepEqual(await foreign.json(), { pending: null });
    const answer = {
      sessionId,
      requestId: request.requestId,
      action: "answer",
      answers: questionFixture.map((q) => ({
        id: q.id,
        selected: q.options[0]!.label,
      })),
    };
    assert.equal(
      (await post("/api/questions/answer", answer, other)).status,
      403,
    );
    assert.equal(
      (await post("/api/questions/answer", { ...answer, answers: [] })).status,
      400,
    );
    assert.equal((await post("/api/questions/answer", answer)).status, 200);
    assert.deepEqual(await pending, {
      kind: "answered",
      answers: answer.answers,
    });
    assert.deepEqual(
      await (await post("/api/questions/answer", answer)).json(),
      { state: "answered", replayed: true },
    );
    const pendingAgain = askWebQuestions(manager, "ask-2", questionFixture);
    const old = manager;
    manager = SessionManager.inMemory(cwd);
    active = undefined;
    for (const listener of listeners) listener({ type: "session_switched" });
    assert.deepEqual(await pendingAgain, { kind: "cancelled" });
    assert.equal(askWebQuestions(old, "stale", questionFixture), undefined);
    const invalidations = events.filter((e) => e.type === "questions_changed");
    assert.ok(invalidations.length >= 4);
    assert.ok(invalidations.every((event) => event.detail === undefined));
  } finally {
    await host.stop();
    assert.equal(
      askWebQuestions(manager, "closed", questionFixture),
      undefined,
    );
    await rm(cwd, { recursive: true, force: true });
  }
});
