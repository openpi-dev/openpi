import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createParser } from "eventsource-parser";
import { WebHost } from "../../web/host/web-host.ts";
import {
  WEB_MAX_EVENT_BYTES,
  type WebEvent,
  type WebLiveMessage,
  type WebSnapshot,
} from "../../web/protocol/types.ts";
import { PiWebRuntime } from "../../web/runtime/pi-runtime.ts";

const REPLY = "中".repeat(20_000);

/** One real Pi Session whose faux model streams a long Chinese reply. */
async function longReplyHost(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "openpi-live-budget-"));
  const cwd = join(directory, "workspace");
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir, { recursive: true });
  const provider = "live-budget-fixture";
  const faux = fauxProvider({
    api: provider,
    provider,
    models: [{ id: "fixture", name: "Fixture", reasoning: false }],
    // 400 characters per delta, paced like a fast real stream.
    tokenSize: { min: 100, max: 100 },
    tokensPerSecond: 4_000,
  });
  faux.setResponses([fauxAssistantMessage(REPLY)]);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(provider, "fixture-key");
  const settingsManager = SettingsManager.inMemory(undefined, {
    projectTrusted: false,
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();
  const services = {
    cwd,
    agentDir,
    settingsManager,
    modelRuntime,
    resourceLoader: loader,
    diagnostics: [],
  };
  const create: CreateAgentSessionRuntimeFactory = async (options) => ({
    ...(await createAgentSessionFromServices({
      services,
      sessionManager: options.sessionManager,
      model: faux.getModel(),
      tools: [],
    })),
    services,
    diagnostics: [],
  });
  const sessions = join(directory, "sessions");
  const runtime = await createAgentSessionRuntime(create, {
    cwd,
    agentDir,
    sessionManager: SessionManager.create(cwd, sessions),
  });
  const web = Reflect.construct(PiWebRuntime, [
    runtime,
    sessions,
    { timeoutMs: 10_000, release: async () => {} },
    { release: async () => {} },
    true,
  ]) as PiWebRuntime;
  await (
    web as unknown as { startRuntimeSession(): Promise<void> }
  ).startRuntimeSession();
  const host = new WebHost({ runtime: web });
  await host.start();
  t.after(async () => {
    await host.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const launched = new URL(host.url);
  const token = new URLSearchParams(launched.hash.slice(1)).get("token");
  assert.ok(token);
  return {
    web,
    origin: launched.origin,
    headers: { Authorization: `Bearer ${token}` },
  };
}

/**
 * Follow the stream with the browser client's rules: a `state_invalidated`
 * event or a cursor gap forces a snapshot refetch and a new connection.
 */
function followLikeClient(origin: string, headers: Record<string, string>) {
  const stats = {
    connections: 0,
    snapshots: 0,
    invalidations: 0,
    messageUpdates: 0,
    largestEventBytes: 0,
    lastMessageEnd: undefined as WebLiveMessage | undefined,
  };
  const stop = new AbortController();
  const snapshot = async () => {
    stats.snapshots++;
    const response = await fetch(`${origin}/api/snapshot`, { headers });
    return (await response.json()) as WebSnapshot & { cursor: number };
  };
  const connect = async (cursor: number) => {
    stats.connections++;
    const response = await fetch(`${origin}/events?cursor=${cursor}`, {
      headers,
      signal: stop.signal,
    });
    assert.ok(response.body);
    let resync = false;
    const parser = createParser({
      onEvent(record) {
        if (resync) return;
        stats.largestEventBytes = Math.max(
          stats.largestEventBytes,
          Buffer.byteLength(record.data),
        );
        const event = JSON.parse(record.data) as WebEvent;
        if (event.sequence <= cursor) return;
        if (
          event.sequence !== cursor + 1 ||
          event.type === "state_invalidated"
        ) {
          if (event.type === "state_invalidated") stats.invalidations++;
          resync = true;
          return;
        }
        cursor = event.sequence;
        if (event.type === "message_update") stats.messageUpdates++;
        if (event.type === "message_end")
          stats.lastMessageEnd = event.detail?.message as WebLiveMessage;
      },
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (!resync) {
        const chunk = await reader.read();
        if (chunk.done) return undefined;
        parser.feed(decoder.decode(chunk.value, { stream: true }));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return (await snapshot()).cursor;
  };
  const done = (async () => {
    let cursor: number | undefined = (await snapshot()).cursor;
    try {
      while (cursor !== undefined && !stop.signal.aborted)
        cursor = await connect(cursor);
    } catch (error) {
      if (!stop.signal.aborted) throw error;
    }
  })();
  return {
    stats,
    async close() {
      stop.abort();
      await done;
    },
  };
}

test("FAIL: a long Chinese reply streams without invalidating the SSE stream", {
  timeout: 30_000,
}, async (t) => {
  const { web, origin, headers } = await longReplyHost(t);
  const client = followLikeClient(origin, headers);
  // Let the client hold its first connection before the reply starts.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const sessionId = web.sessionManager.getSessionId();
  await web.sendPrompt("Answer at length in Chinese", {
    commandId: "long-cjk-reply",
    expectedSessionId: sessionId,
  });
  const deadline = Date.now() + 20_000;
  while (!web.isIdle() || web.getActiveTurn()) {
    assert.ok(Date.now() < deadline, "the reply settled");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  await client.close();
  const { stats } = client;
  t.diagnostic(JSON.stringify({ ...stats, lastMessageEnd: undefined }));

  assert.equal(stats.invalidations, 0, "no update was invalidated");
  assert.equal(stats.connections, 1, "the client never had to reconnect");
  assert.equal(stats.snapshots, 1, "only the initial snapshot was fetched");
  assert.ok(stats.messageUpdates >= 40, `${stats.messageUpdates} updates`);
  assert.ok(stats.largestEventBytes <= WEB_MAX_EVENT_BYTES);
  // The live projection says it is partial instead of silently ending early.
  assert.equal(stats.lastMessageEnd?.truncation?.visibleText, true);
  assert.match(stats.lastMessageEnd?.content ?? "", /\[truncated\]$/);

  // The persisted entry still recovers the complete reply.
  const settled = (await (
    await fetch(`${origin}/api/snapshot`, { headers })
  ).json()) as WebSnapshot;
  const session = settled.selectedSession;
  assert.ok(session);
  const reply = session.entries
    .filter((entry) => entry.message?.role === "assistant")
    .at(-1);
  assert.ok(reply);
  assert.equal(reply.message?.truncation?.visibleText, true);
  let text = "";
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page = (await (
      await fetch(
        `${origin}/api/session/item?${new URLSearchParams({
          sessionId: session.id,
          sessionPath: session.path,
          entryId: reply.id,
          cursor: String(cursor),
        })}`,
        { headers },
      )
    ).json()) as { text: string; nextCursor: number | null };
    text += page.text;
    cursor = page.nextCursor;
  }
  assert.equal(text, REPLY);
});
