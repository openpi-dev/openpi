import assert from "node:assert/strict";
import { once } from "node:events";
import fs, {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  parsePromptFiles,
  persistPromptFiles,
  PromptFileError,
} from "../../web/host/prompt-files.ts";
import { WebHost } from "../../web/host/web-host.ts";
import {
  WEB_PROMPT_FILE_MAX_BYTES,
  WEB_PROMPT_FILE_MAX_COUNT,
  WEB_PROMPT_FILE_MAX_TEXT_BYTES,
} from "../../web/protocol/prompt-files.ts";
import type { WebPromptFilesResponse } from "../../web/protocol/prompt-files.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";
import type { WebRuntimeController } from "../../web/runtime/types.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "openpi-prompt-files-"));
  const sessionDirectory = join(root, "sessions");
  await mkdir(sessionDirectory, { mode: 0o700 });
  let manager = SessionManager.create(root, sessionDirectory);
  const runtime: WebRuntimeController = {
    cwd: root,
    workspaceSelected: true,
    sessionDirectory,
    get sessionManager() {
      return manager;
    },
    isIdle: () => true,
    getActiveTurn: () => undefined,
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    sendPrompt: async () => {
      throw new Error("Attachment upload must not prompt the model");
    },
    newSession: async () => {
      throw new Error("Not used");
    },
    switchSession: async () => {
      throw new Error("Not used");
    },
    listModels: () => [],
    searchModels: (query, limit) => projectWebModelSearch([], query, limit),
    setModel: async () => {
      throw new Error("Not used");
    },
    subscribe: () => () => undefined,
    dispose: async () => undefined,
  };
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = (
    files = [
      {
        name: "报告.txt",
        data: Buffer.from("原始文件\n", "utf8").toString("base64"),
      },
    ],
  ) => ({
    sessionId: manager.getSessionId(),
    sessionPath: manager.getSessionFile()!,
    files,
  });
  return {
    root,
    sessionDirectory,
    runtime,
    body,
    replaceManager: (value: SessionManager) => {
      manager = value;
    },
  };
}

const denied = (error: unknown) =>
  error instanceof PromptFileError && error.statusCode === 403;
const conflict = (error: unknown) =>
  error instanceof PromptFileError && error.code === "SESSION_CONFLICT";

test("native future Session paths accept original binary bytes and bounded extracted text privately without model execution", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from([0, 255, 127, 129, 1]);
  const request = {
    ...f.body(),
    files: [
      {
        name: "报告.xlsx",
        data: bytes.toString("base64"),
        mimeType: "application/octet-stream",
        text: "表格提取\nA1: 42",
      },
    ],
  };
  await assert.rejects(lstat(request.sessionPath), { code: "ENOENT" });
  const receipt = await persistPromptFiles(f.runtime, request);
  assert.equal(receipt.sessionId, request.sessionId);
  assert.equal(receipt.sessionPath, request.sessionPath);
  assert.equal(receipt.files[0].name, "报告.xlsx");
  assert.equal(receipt.files[0].size, bytes.length);
  assert.deepEqual(await readFile(receipt.files[0].path), bytes);
  assert.equal(
    await readFile(receipt.files[0].textPath!, "utf8"),
    request.files[0].text,
  );
  if (process.platform !== "win32") {
    assert.equal(
      Number((await lstat(receipt.files[0].path)).mode & 0o777),
      0o600,
    );
    assert.equal(
      Number((await lstat(receipt.files[0].textPath!)).mode & 0o777),
      0o600,
    );
    assert.equal(
      Number((await lstat(dirname(receipt.files[0].path))).mode & 0o777),
      0o700,
    );
  }
  assert.deepEqual(await readdir(f.root), ["sessions"]);
  await assert.rejects(lstat(request.sessionPath), { code: "ENOENT" });
  assert.equal(f.runtime.sessionManager.getEntries().length, 0);
});

test("atomic content-addressed batches replay the same exact paths and handle duplicate names and extraction-name collisions", async (t) => {
  const f = await fixture(t);
  const request = {
    ...f.body(),
    files: [
      { name: "extracted.txt", data: "", text: "" },
      {
        name: "extracted.txt",
        data: Buffer.from("second").toString("base64"),
        text: "document",
      },
    ],
  };
  const [first, parallel] = await Promise.all([
    persistPromptFiles(f.runtime, request),
    persistPromptFiles(f.runtime, request),
  ]);
  assert.deepEqual(parallel, first);
  assert.deepEqual(await persistPromptFiles(f.runtime, request), first);
  assert.notEqual(first.files[0].path, first.files[0].textPath);
  assert.notEqual(first.files[0].path, first.files[1].path);
  assert.equal(await readFile(first.files[0].path, "utf8"), "");
  const folders = await readdir(dirname(dirname(first.files[0].path)));
  assert.deepEqual(folders, [basename(dirname(first.files[0].path))]);
  await writeFile(first.files[1].path, "tampered");
  await assert.rejects(persistPromptFiles(f.runtime, request), denied);
});

test("rename access errors recover only a verified concurrent batch and reject absent or tampered destinations", async (t) => {
  for (const code of ["EACCES", "EPERM"]) {
    const f = await fixture(t);
    const request = f.body();
    const originalRename = fs.rename;
    const barrier = Promise.withResolvers<void>();
    let arrivals = 0;
    let collisions = 0;
    const rename = t.mock.method(
      fs,
      "rename",
      async (...args: Parameters<typeof fs.rename>) => {
        if (++arrivals === 2) barrier.resolve();
        await barrier.promise;
        try {
          await originalRename(...args);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            !["EEXIST", "ENOTEMPTY", "EACCES", "EPERM"].includes(
              String(error.code),
            )
          )
            throw error;
          collisions++;
          throw Object.assign(new Error("Concurrent destination exists"), {
            code,
          });
        }
      },
    );
    syncBuiltinESMExports();
    try {
      const [first, parallel] = await Promise.all([
        persistPromptFiles(f.runtime, request),
        persistPromptFiles(f.runtime, request),
      ]);
      assert.equal(arrivals, 2);
      assert.equal(collisions, 1);
      assert.deepEqual(parallel, first);
      assert.deepEqual(
        await readFile(first.files[0].path),
        Buffer.from("原始文件\n"),
      );
      assert.deepEqual(await readdir(dirname(dirname(first.files[0].path))), [
        basename(dirname(first.files[0].path)),
      ]);
      rename.mock.mockImplementation(async () => {
        throw Object.assign(new Error("Access denied"), { code });
      });
      await assert.rejects(
        persistPromptFiles(f.runtime, {
          ...request,
          files: [{ name: "missing.txt", data: "" }],
        }),
        denied,
      );
      assert.deepEqual(await readdir(dirname(dirname(first.files[0].path))), [
        basename(dirname(first.files[0].path)),
      ]);
      await writeFile(first.files[0].path, "tampered");
      await assert.rejects(persistPromptFiles(f.runtime, request), denied);
    } finally {
      rename.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test("multibyte names are bounded by filesystem bytes while preserving document extensions", async (t) => {
  const f = await fixture(t);
  const name = `${"文".repeat(250)}.pdf`;
  const result = await persistPromptFiles(f.runtime, {
    ...f.body(),
    files: [{ name, data: "" }],
  });
  assert.equal(result.files[0].name, name);
  assert.ok(Buffer.byteLength(basename(result.files[0].path), "utf8") < 255);
  assert.ok(result.files[0].path.endsWith(".pdf"));
  assert.equal((await readFile(result.files[0].path)).length, 0);
});

test("file metadata, count, text, base64 and decoded aggregate limits are enforced before persistence", () => {
  const base = { name: "a.txt", data: Buffer.from("a").toString("base64") };
  for (const files of [
    undefined,
    [],
    Array.from({ length: WEB_PROMPT_FILE_MAX_COUNT + 1 }, () => base),
    [{ ...base, name: "../outside.txt" }],
    [{ ...base, name: "a\\b.txt" }],
    [{ ...base, name: "\u0000" }],
    [{ ...base, previewUrl: "blob:x" }],
    [{ ...base, data: "YQ=" }],
    [{ ...base, data: "YQ==\n" }],
    [{ ...base, data: "YQ__" }],
    [{ ...base, text: "a".repeat(WEB_PROMPT_FILE_MAX_TEXT_BYTES + 1) }],
  ]) {
    assert.throws(() => parsePromptFiles(files), PromptFileError);
  }
  const maximum = Buffer.alloc(WEB_PROMPT_FILE_MAX_BYTES).toString("base64");
  assert.equal(
    parsePromptFiles([{ name: "large.bin", data: maximum }])[0].bytes.length,
    WEB_PROMPT_FILE_MAX_BYTES,
  );
  assert.throws(
    () => parsePromptFiles([{ name: "large.bin", data: maximum }, base]),
    (error: unknown) =>
      error instanceof PromptFileError && error.statusCode === 413,
  );
  assert.throws(
    () => parsePromptFiles([{ name: "large.bin", data: `${maximum}AAAA` }]),
    (error: unknown) =>
      error instanceof PromptFileError && error.statusCode === 413,
  );
});

test("uploads reject stale ids, copied paths, in-memory Sessions and non-owned Session directories", async (t) => {
  const f = await fixture(t);
  const request = f.body();
  await assert.rejects(
    persistPromptFiles(f.runtime, { ...request, sessionId: "another" }),
    conflict,
  );
  await assert.rejects(
    persistPromptFiles(f.runtime, {
      ...request,
      sessionPath: join(f.sessionDirectory, "copied.jsonl"),
    }),
    conflict,
  );
  f.replaceManager(SessionManager.inMemory(f.root));
  await assert.rejects(persistPromptFiles(f.runtime, request), conflict);
  const outside = join(f.root, "outside-sessions");
  f.replaceManager(SessionManager.create(f.root, outside));
  await assert.rejects(persistPromptFiles(f.runtime, f.body()), conflict);
  assert.deepEqual(await readdir(f.sessionDirectory), []);
});

test("a late Session change removes the private pending batch before publishing any receipt", async (t) => {
  const f = await fixture(t);
  const request = f.body();
  const original = f.runtime.sessionManager;
  const next = SessionManager.create(f.root, f.sessionDirectory);
  let reads = 0;
  Object.defineProperty(f.runtime, "sessionManager", {
    get() {
      return ++reads >= 4 ? next : original;
    },
  });
  await assert.rejects(persistPromptFiles(f.runtime, request), conflict);
  const sessions = await readdir(join(f.sessionDirectory, ".prompt-files"));
  assert.equal(sessions.length, 1);
  assert.deepEqual(
    await readdir(join(f.sessionDirectory, ".prompt-files", sessions[0])),
    [],
  );
  assert.equal(original.getEntries().length, 0);
});

test("symlink and permission tampering fail closed at the Session file, attachment directories and stored files", {
  skip: process.platform === "win32",
}, async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "outside");
  await mkdir(outside);
  const request = f.body();
  await symlink(join(outside, "missing.jsonl"), request.sessionPath);
  await assert.rejects(persistPromptFiles(f.runtime, request), denied);
  await rm(request.sessionPath);
  const attachments = join(f.sessionDirectory, ".prompt-files");
  await symlink(outside, attachments);
  await assert.rejects(persistPromptFiles(f.runtime, request), denied);
  assert.deepEqual(await readdir(outside), []);
  await rm(attachments);
  const receipt = await persistPromptFiles(f.runtime, request);
  const original = receipt.files[0].path;
  await rename(original, join(outside, "original"));
  await symlink(join(outside, "original"), original);
  await assert.rejects(persistPromptFiles(f.runtime, request), denied);
  await rm(original);
  await rename(join(outside, "original"), original);
  await chmod(original, 0o644);
  await assert.rejects(persistPromptFiles(f.runtime, request), denied);
  await chmod(original, 0o600);
  const batch = dirname(original);
  await chmod(batch, 0o755);
  await assert.rejects(persistPromptFiles(f.runtime, request), denied);
  await chmod(batch, 0o700);
  const sessionAttachments = dirname(batch);
  await rename(sessionAttachments, join(outside, "session-attachments"));
  await symlink(join(outside, "session-attachments"), sessionAttachments);
  await assert.rejects(persistPromptFiles(f.runtime, request), denied);
});

test("authenticated Host upload preserves bytes, rejects foreign origins and a Session switched while its body arrives", async (t) => {
  const f = await fixture(t);
  const host = new WebHost({ runtime: f.runtime });
  await host.start();
  t.after(() => host.stop());
  const launched = new URL(host.url);
  const token = new URLSearchParams(launched.hash.slice(1)).get("token");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const url = `${launched.origin}/api/prompt-files`;
  const request = f.body();
  const post = (
    body: unknown,
    givenHeaders: Record<string, string> = headers,
  ) =>
    fetch(url, {
      method: "POST",
      headers: givenHeaders,
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post(request, { ...headers, Authorization: "Bearer incorrect" }))
      .status,
    401,
  );
  assert.equal(
    (
      await post(request, {
        ...headers,
        Origin: "https://foreign.example",
      })
    ).status,
    403,
  );
  const accepted = await post(request);
  assert.equal(accepted.status, 200);
  const receipt = (await accepted.json()) as WebPromptFilesResponse;
  assert.equal(await readFile(receipt.files[0].path, "utf8"), "原始文件\n");
  assert.deepEqual(await (await post(request)).json(), receipt);
  const socket = createConnection({
    host: "127.0.0.1",
    port: Number(launched.port),
  });
  socket.on("error", () => undefined);
  t.after(() => socket.destroy());
  await once(socket, "connect");
  const bytes = JSON.stringify(request);
  socket.write(
    `POST /api/prompt-files HTTP/1.1\r\nHost: ${launched.host}\r\nAuthorization: ${headers.Authorization}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(bytes)}\r\nConnection: close\r\n\r\n{`,
  );
  f.replaceManager(SessionManager.create(f.root, f.sessionDirectory));
  let response = "";
  socket.on("data", (chunk) => {
    response += chunk.toString();
  });
  const ended = once(socket, "end");
  socket.end(bytes.slice(1));
  await ended;
  assert.match(response, /409 Conflict/u);
  assert.match(response, /SESSION_CONFLICT/u);
});

test("Host reserves two upload slots before large bodies are read and releases them after disconnect", async (t) => {
  const f = await fixture(t);
  const host = new WebHost({ runtime: f.runtime });
  await host.start();
  t.after(() => host.stop());
  const launched = new URL(host.url);
  const token = new URLSearchParams(launched.hash.slice(1)).get("token");
  const sockets = [
    createConnection({ host: "127.0.0.1", port: Number(launched.port) }),
    createConnection({ host: "127.0.0.1", port: Number(launched.port) }),
  ];
  for (const socket of sockets) {
    socket.on("error", () => undefined);
    t.after(() => socket.destroy());
  }
  await Promise.all(sockets.map((socket) => once(socket, "connect")));
  for (const socket of sockets)
    socket.write(
      `POST /api/prompt-files HTTP/1.1\r\nHost: ${launched.host}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 1024\r\n\r\n{`,
    );
  const post = (body: unknown) =>
    fetch(`${launched.origin}/api/prompt-files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  let status = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    status = (await post({})).status;
    if (status === 429) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(status, 429);
  for (const socket of sockets) socket.destroy();
  for (let attempt = 0; attempt < 20; attempt++) {
    status = (await post(f.body())).status;
    if (status === 200) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(status, 200);
});
