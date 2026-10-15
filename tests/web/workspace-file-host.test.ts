import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ArtifactReader } from "../../web/host/artifacts.ts";
import { WebHost } from "../../web/host/web-host.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";
import type { WebRuntimeController } from "../../web/runtime/types.ts";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openpi-workspace-file-http-"));
  const cwd = join(root, "workspace");
  const sessions = join(root, "sessions");
  await mkdir(cwd);
  let manager = SessionManager.create(cwd, sessions);
  manager.appendMessage({
    role: "user",
    content: "isolated Files fixture",
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "fixture",
    model: "model",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  let disposeCalls = 0;
  const runtime: WebRuntimeController = {
    cwd,
    workspaceSelected: true,
    get sessionManager() {
      return manager;
    },
    sessionDirectory: sessions,
    searchModels: (query, limit) => projectWebModelSearch([], query, limit),
    isIdle: () => true,
    getActiveTurn: () => undefined,
    listModels: () => [],
    subscribe: () => () => undefined,
    dispose: async () => {
      disposeCalls++;
    },
    sendPrompt: async () => ({ pendingFollowUps: 0 }),
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    newSession: async () => ({
      cancelled: true,
      sessionId: manager.getSessionId(),
    }),
    switchSession: async () => ({ cancelled: true }),
    setModel: async () => {
      throw new Error("unused");
    },
  };
  const host = new WebHost({ runtime });
  await host.start();
  const token = new URLSearchParams(new URL(host.url).hash.slice(1)).get(
    "token",
  );
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const sessionId = manager.getSessionId();
  const sessionPath = manager.getSessionFile();
  assert.ok(sessionPath);
  const body = {
    sessionId,
    sessionPath,
    access: "write-workspace-file",
    kind: "create-file",
    directory: ".",
    name: "new.txt",
  };
  return {
    root,
    cwd,
    host,
    headers,
    body,
    runtime,
    switchTo: (path: string) => {
      manager = SessionManager.open(path, sessions);
    },
    disposeCalls: () => disposeCalls,
    post: (value: unknown, requestHeaders: Record<string, string> = headers) =>
      fetch(`${host.origin}/api/files/mutate`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(value),
      }),
    close: async () => {
      await host.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("workspace file HTTP changes authenticate, reject extra authority, and preserve a large original file", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.post(f.body, {
          Authorization: "",
          "Content-Type": "application/json",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await f.post(f.body, {
          ...f.headers,
          Origin: "https://foreign.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.post({ ...f.body, access: "read-file" })).status,
      400,
    );
    assert.equal((await f.post({ ...f.body, overwrite: true })).status, 400);
    assert.equal(
      (await f.post({ ...f.body, sessionPath: "another-session.jsonl" }))
        .status,
      403,
    );
    assert.equal((await f.post(f.body)).status, 201);
    const conflict = await f.post(f.body);
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, "ARTIFACT_EXISTS");
    assert.equal((await readFile(join(f.cwd, "new.txt"))).length, 0);
    const bytes = Buffer.alloc(32 * 1024 * 1024, 0x9f);
    const imported = await f.post({
      ...f.body,
      kind: "import-file",
      name: "large.bin",
      data: bytes.toString("base64"),
    });
    assert.equal(imported.status, 201);
    assert.equal((await imported.json()).bytes, bytes.length);
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(f.cwd, "large.bin")))
        .digest("hex"),
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.deepEqual((await readdir(f.cwd)).sort(), ["large.bin", "new.txt"]);
  } finally {
    await f.close();
  }
});

test("a delayed workspace-file body cannot write to a copied native Session with the same id", async () => {
  const f = await fixture();
  try {
    const copy = join(f.root, "copied.jsonl");
    await writeFile(copy, await readFile(f.body.sessionPath));
    const response = new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${f.host.origin}/api/files/mutate`,
        { method: "POST", headers: f.headers },
        (incoming) => {
          incoming.resume();
          incoming.once("end", () => resolve(incoming.statusCode ?? 0));
        },
      );
      request.once("error", reject);
      const body = JSON.stringify(f.body);
      request.write(body.slice(0, body.length / 2));
      f.switchTo(copy);
      assert.equal(f.runtime.sessionManager.getSessionId(), f.body.sessionId);
      assert.notEqual(
        f.runtime.sessionManager.getSessionFile(),
        f.body.sessionPath,
      );
      request.end(body.slice(body.length / 2));
    });
    assert.equal(await response, 403);
    assert.deepEqual(await readdir(f.cwd), []);
  } finally {
    await f.close();
  }
});

test("organization HTTP requests require exact identity, reject extra authority and expose only authenticated workspace trash", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.cwd, "original.txt"), "original bytes");
    const listing = await fetch(
      `${f.host.origin}/api/artifacts/files?${new URLSearchParams({ sessionId: f.body.sessionId, sessionPath: f.body.sessionPath, path: ".", query: "" })}`,
      { headers: f.headers },
    );
    assert.equal(listing.status, 200);
    const { entries } = (await listing.json()) as {
      entries: { path: string; identity: string }[];
    };
    const identity = entries.find(
      (entry) => entry.path === "original.txt",
    )?.identity;
    assert.ok(identity);
    const common = {
      sessionId: f.body.sessionId,
      sessionPath: f.body.sessionPath,
      access: f.body.access,
    };
    const move = {
      ...common,
      kind: "move",
      path: "original.txt",
      identity,
      directory: ".",
      name: "renamed.txt",
    };
    assert.equal((await f.post({ ...move, identity: undefined })).status, 400);
    assert.equal((await f.post({ ...move, overwrite: true })).status, 400);
    assert.equal(
      (await f.post({ ...move, sessionPath: "/sessions/copied" })).status,
      403,
    );
    assert.equal((await f.post(move)).status, 201);
    const next = await fetch(
      `${f.host.origin}/api/artifacts/files?${new URLSearchParams({ sessionId: f.body.sessionId, sessionPath: f.body.sessionPath, path: ".", query: "" })}`,
      { headers: f.headers },
    );
    const nextListing = (await next.json()) as {
      entries: { path: string; identity: string }[];
    };
    const removed = await f.post({
      ...common,
      kind: "trash",
      path: "renamed.txt",
      identity: nextListing.entries.find(
        (entry) => entry.path === "renamed.txt",
      )?.identity,
    });
    assert.equal(removed.status, 201);
    const { trashed } = (await removed.json()) as {
      trashed: { id: string; identity: string };
    };
    const url = `${f.host.origin}/api/artifacts/trash?${new URLSearchParams({ sessionId: f.body.sessionId, sessionPath: f.body.sessionPath })}`;
    assert.equal((await fetch(url)).status, 401);
    const trash = await fetch(url, { headers: f.headers });
    assert.equal(trash.status, 200);
    assert.equal(
      ((await trash.json()) as { entries: unknown[] }).entries.length,
      1,
    );
    assert.equal(
      (
        await f.post({
          ...common,
          kind: "restore",
          ...trashed,
          arbitraryPath: "../escape",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.post({
          ...common,
          kind: "restore",
          id: trashed.id,
          identity: trashed.identity,
        })
      ).status,
      201,
    );
    assert.equal(
      await readFile(join(f.cwd, "renamed.txt"), "utf8"),
      "original bytes",
    );
  } finally {
    await f.close();
  }
});

for (const operation of ["save", "create"] as const) {
  test(`Host stop drains an admitted Files ${operation} before disposing its runtime`, async () => {
    const f = await fixture();
    const entered = barrier();
    const proceed = barrier();
    const reader = (f.host as unknown as { artifacts: ArtifactReader })
      .artifacts;
    try {
      let request: Promise<Response>;
      if (operation === "save") {
        await writeFile(join(f.cwd, "existing.txt"), "original");
        const handle = await reader.resolveFile(
          f.body.sessionId,
          "existing.txt",
        );
        const { preview } = await reader.read(handle, f.body.sessionId);
        const save = reader.save.bind(reader);
        reader.save = async (...args) => {
          entered.release();
          await proceed.promise;
          return save(...args);
        };
        request = fetch(`${f.host.origin}/api/artifacts/save`, {
          method: "POST",
          headers: f.headers,
          body: JSON.stringify({
            sessionId: f.body.sessionId,
            handle,
            revision: preview.artifact.revision,
            text: "draft",
            access: "write-workspace-file",
          }),
        });
      } else {
        const mutate = reader.mutateFile.bind(reader);
        reader.mutateFile = async (...args) => {
          entered.release();
          await proceed.promise;
          return mutate(...args);
        };
        request = f.post(f.body);
      }
      await entered.promise;
      const stopping = f.host.stop();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(
        f.disposeCalls(),
        0,
        "authority must remain owned until the admitted request settles",
      );
      proceed.release();
      assert.equal((await request).status, 403);
      await stopping;
      assert.equal(f.disposeCalls(), 1);
      assert.deepEqual(
        await readdir(f.cwd),
        operation === "save" ? ["existing.txt"] : [],
      );
      if (operation === "save")
        assert.equal(
          await readFile(join(f.cwd, "existing.txt"), "utf8"),
          "original",
        );
    } finally {
      proceed.release();
      await f.close();
    }
  });
}
