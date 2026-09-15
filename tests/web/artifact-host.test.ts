import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WebHost } from "../../web/host/web-host.ts";
import type { WebRuntimeController } from "../../web/runtime/types.ts";

test("artifact HTTP access authenticates, binds a Session, serves exact revisions and revokes on lifecycle changes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-artifact-http-"));
  const sessionManager = SessionManager.inMemory(cwd);
  const runtime: WebRuntimeController = {
    searchModels: (query, limit) =>
      projectWebModelSearch(runtime.listModels(), query, limit),
    cwd,
    workspaceSelected: true,
    sessionManager,
    sessionDirectory: cwd,
    isIdle: () => true,
    getActiveTurn: () => undefined,
    listModels: () => [],
    subscribe: () => () => undefined,
    dispose: async () => undefined,
    sendPrompt: async () => ({ pendingFollowUps: 0 }),
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    newSession: async () => ({
      cancelled: true,
      sessionId: runtime.sessionManager.getSessionId(),
    }),
    switchSession: async () => ({ cancelled: true }),
    setModel: async () => {
      throw new Error("unused");
    },
  };
  const host = new WebHost({ runtime });
  try {
    await writeFile(join(cwd, "report space.md"), "# Report\nversion one");
    await host.start();
    const token = new URL(host.url).hash.slice("#token=".length);
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    const body = JSON.stringify({
      sessionId: sessionManager.getSessionId(),
      reference: "report%20space.md",
      access: "read-file",
    });
    assert.equal(
      (
        await fetch(`${host.origin}/api/artifacts/resolve`, {
          method: "POST",
          body,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${host.origin}/api/artifacts/resolve`, {
          method: "POST",
          headers: { ...headers, Origin: "https://evil.example" },
          body,
        })
      ).status,
      403,
    );
    const resolved = await fetch(`${host.origin}/api/artifacts/resolve`, {
      method: "POST",
      headers,
      body,
    });
    assert.equal(resolved.status, 200);
    const { handle } = (await resolved.json()) as { handle: string };
    assert.ok(!handle.includes(token));
    const params = new URLSearchParams({
      sessionId: sessionManager.getSessionId(),
      handle,
    });
    const preview = (await (
      await fetch(`${host.origin}/api/artifacts/content?${params}`, { headers })
    ).json()) as { text: string; artifact: { revision: string } };
    assert.equal(preview.text, "# Report\nversion one");
    const download = `${host.origin}/api/artifacts/content?${params}&download=1&revision=${preview.artifact.revision}`;
    const file = await fetch(download, { headers });
    assert.equal(file.status, 200);
    assert.equal(await file.text(), preview.text);
    assert.equal(file.headers.get("x-content-type-options"), "nosniff");
    assert.match(file.headers.get("content-disposition") ?? "", /attachment/u);
    assert.equal(file.headers.get("cache-control"), "no-store");
    await writeFile(join(cwd, "report space.md"), "version two");
    assert.equal((await fetch(download, { headers })).status, 409);
    host.publish("session_switched");
    assert.equal(
      (
        await fetch(`${host.origin}/api/artifacts/content?${params}`, {
          headers,
        })
      ).status,
      410,
    );
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
