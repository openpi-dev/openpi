import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { GitReviewBaselineStore } from "../../web/host/git-review.ts";
import { WebHost } from "../../web/host/web-host.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";
import type { WebRuntimeController } from "../../web/runtime/types.ts";

const execFileAsync = promisify(execFile);

test("Git review HTTP access authenticates and binds the exact Session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-git-review-http-"));
  const baselineDirectory = await mkdtemp(
    join(tmpdir(), "openpi-git-review-http-baseline-"),
  );
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
      sessionId: sessionManager.getSessionId(),
    }),
    switchSession: async () => ({ cancelled: true }),
    setModel: async () => {
      throw new Error("unused");
    },
  };
  const host = new WebHost({
    runtime,
    gitReviews: new GitReviewBaselineStore(cwd, baselineDirectory),
  });
  try {
    await execFileAsync("git", ["-C", cwd, "init", "-b", "main"]);
    await writeFile(join(cwd, "review.txt"), "review\n", "utf8");
    await host.start();
    const token = new URL(host.url).hash.slice("#token=".length);
    const headers = { Authorization: `Bearer ${token}` };
    const sessions = (await (
      await fetch(`${host.origin}/api/sessions`, { headers })
    ).json()) as { sessions: Array<{ id: string; path: string }> };
    const session = sessions.sessions.find(
      (candidate) => candidate.id === sessionManager.getSessionId(),
    );
    assert.ok(session);
    const query = new URLSearchParams({
      sessionId: session.id,
      path: session.path,
      source: "session",
    });

    assert.equal(
      (await fetch(`${host.origin}/api/git-review?${query}`)).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${host.origin}/api/git-review?sessionId=${session.id}`, {
          headers,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(
          `${host.origin}/api/git-review?${new URLSearchParams({ sessionId: "stale", path: session.path })}`,
          { headers },
        )
      ).status,
      404,
    );
    const response = await fetch(`${host.origin}/api/git-review?${query}`, {
      headers,
    });
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      ok: boolean;
      snapshot?: { files: Array<{ path: string }> };
    };
    assert.equal(result.ok, true);
    assert.deepEqual(result.snapshot?.files, []);

    await writeFile(
      join(cwd, "review.txt"),
      "review\nsession change\n",
      "utf8",
    );
    const changedResponse = await fetch(
      `${host.origin}/api/git-review?${query}`,
      { headers },
    );
    assert.equal(changedResponse.status, 200);
    const changed = (await changedResponse.json()) as {
      ok: boolean;
      snapshot?: {
        comparison: string;
        files: Array<{ path: string }>;
      };
    };
    assert.equal(changed.ok, true);
    assert.equal(changed.snapshot?.comparison, "session");
    assert.deepEqual(
      changed.snapshot?.files.map((file) => file.path),
      ["review.txt"],
    );
  } finally {
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
    await rm(baselineDirectory, { recursive: true, force: true });
  }
});
