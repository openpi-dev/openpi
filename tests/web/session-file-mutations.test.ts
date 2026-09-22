import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WebHost } from "../../web/host/web-host.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";
import type { WebRuntimeController } from "../../web/runtime/types.ts";

const mutations = [
  {
    route: "prompt",
    body: { content: "hello", commandId: "delayed-command" },
    status: 202,
  },
  {
    route: "model",
    body: { provider: "fixture", modelId: "model" },
    status: 200,
  },
  { route: "thinking", body: { level: "high" }, status: 200 },
] as const;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openpi-session-file-mutation-"));
  const directory = join(root, "sessions");
  let manager = SessionManager.create(root, directory);
  manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
  manager.appendMessage({
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "fixture",
    model: "model",
    stopReason: "stop",
    timestamp: 2,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  const original = manager.getSessionFile()!;
  const copy = join(directory, "copy.jsonl");
  await copyFile(original, copy);
  const id = manager.getSessionId();
  assert.equal(SessionManager.open(copy, directory).getSessionId(), id);
  const calls: {
    path: string | undefined;
    expectedPath: string | undefined;
  }[] = [];
  const record = (expectedPath: string | undefined) => {
    calls.push({ path: manager.getSessionFile(), expectedPath });
  };
  const runtime: WebRuntimeController = {
    cwd: root,
    workspaceSelected: true,
    sessionDirectory: directory,
    get sessionManager() {
      return manager;
    },
    isIdle: () => true,
    getActiveTurn: () => undefined,
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    sendPrompt: async (_content, options) => {
      record(options?.expectedSessionPath);
      return { pendingFollowUps: 0 };
    },
    newSession: async () => ({
      cancelled: false,
      sessionId: id,
      sessionPath: original,
    }),
    switchSession: async (path) => {
      manager = SessionManager.open(path, directory);
      return { cancelled: false };
    },
    listModels: () => [],
    searchModels: (query, limit) => projectWebModelSearch([], query, limit),
    setModel: async (_provider, _model, options) => {
      record(options?.expectedSessionPath);
      return {
        provider: "fixture",
        id: "model",
        name: "Model",
        label: "Model",
        current: true,
      };
    },
    setThinkingLevel: async (level, options) => {
      record(options?.expectedSessionPath);
      return { level, available: ["off", "high"], supported: true };
    },
    subscribe: () => () => {},
    dispose: async () => {},
  };
  const host = new WebHost({ runtime });
  await host.start();
  const url = new URL(host.url);
  const token = new URLSearchParams(url.hash.slice(1)).get("token");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const post = (route: string, body: unknown) =>
    fetch(`${url.origin}/api/${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  return {
    original,
    copy,
    id,
    calls,
    url,
    headers,
    post,
    close: async () => {
      await host.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

// Send real HTTP headers and part of the JSON body, then deliberately hold the
// final byte until a second HTTP request has switched the live Session file.
function delayedPost(
  url: URL,
  route: string,
  headers: Record<string, string>,
  body: unknown,
) {
  const bytes = Buffer.from(JSON.stringify(body));
  let finish!: () => void;
  const response = new Promise<Response>((resolve, reject) => {
    const req = request(
      `${url.origin}/api/${route}`,
      {
        method: "POST",
        headers: { ...headers, "Content-Length": String(bytes.length) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), { status: res.statusCode }),
          ),
        );
      },
    );
    req.on("error", reject);
    req.write(bytes.subarray(0, -1));
    finish = () => req.end(bytes.subarray(-1));
  });
  return { response, finish };
}

for (const mutation of mutations) {
  test(`${mutation.route} rejects an HTTP request delayed across a same-ID Session file switch`, async () => {
    const f = await fixture();
    const before = await Promise.all([readFile(f.original), readFile(f.copy)]);
    const delayed = delayedPost(f.url, mutation.route, f.headers, {
      ...mutation.body,
      sessionId: f.id,
      sessionPath: f.original,
    });
    try {
      const selected = await f.post("sessions/select", { path: f.copy });
      assert.equal(selected.status, 200);
      delayed.finish();
      const stale = await delayed.response;
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).code, "SESSION_CONFLICT");
      assert.deepEqual(f.calls, []);
      assert.deepEqual(
        await Promise.all([readFile(f.original), readFile(f.copy)]),
        before,
      );
      const valid = await f.post(mutation.route, {
        ...mutation.body,
        sessionId: f.id,
        sessionPath: f.copy,
      });
      assert.equal(valid.status, mutation.status);
      assert.deepEqual(f.calls, [{ path: f.copy, expectedPath: f.copy }]);
    } finally {
      delayed.finish();
      await delayed.response.catch(() => {});
      await f.close();
    }
  });

  test(`${mutation.route} requires a nonempty Session file identity`, async () => {
    const f = await fixture();
    try {
      for (const sessionPath of [undefined, "", 42, "\u0000"]) {
        const response = await f.post(mutation.route, {
          ...mutation.body,
          sessionId: f.id,
          sessionPath,
        });
        assert.equal(response.status, 400);
      }
      assert.deepEqual(f.calls, []);
    } finally {
      await f.close();
    }
  });
}

test("a command receipt cannot be rebound to a copied file sharing its Session ID", async () => {
  const f = await fixture();
  const body = {
    content: "once",
    commandId: "same-command",
    sessionId: f.id,
    sessionPath: f.original,
  };
  try {
    assert.equal((await f.post("prompt", body)).status, 202);
    assert.equal(
      (await f.post("sessions/select", { path: f.copy })).status,
      200,
    );
    const conflict = await f.post("prompt", {
      ...body,
      sessionPath: f.copy,
      retry: true,
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, "COMMAND_CONFLICT");
    assert.equal(
      (await f.post("prompt", { ...body, retry: true })).status,
      202,
    );
    assert.deepEqual(f.calls, [{ path: f.original, expectedPath: f.original }]);
  } finally {
    await f.close();
  }
});
