import assert from "node:assert/strict";
import fs, {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type WebAttachmentBinding,
  WebAttachmentStagingError,
  type WebAttachmentStagingLimits,
  WebAttachmentStagingStore,
} from "../../web/runtime/attachment-staging.ts";

const limits: WebAttachmentStagingLimits = {
  maxAttachments: 2,
  maxAttachmentBytes: 8,
  maxTotalBytes: 12,
  maxStagedBytes: 16,
  maxStagedBatches: 4,
  maxSettledReceipts: 2,
  stagingTtlMs: 60 * 60 * 1000,
};

const binding: WebAttachmentBinding = {
  workspace: process.cwd(),
  sessionId: "session-1",
  commandId: "command-1",
};

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "openpi-attachment-test-"));
  const store = await WebAttachmentStagingStore.create(parent, limits);
  return {
    parent,
    store,
    async cleanup() {
      await store.dispose();
      await rm(parent, { recursive: true, force: true });
    },
  };
}

test("stages with server-owned paths and consumes once for the exact binding", async () => {
  const value = await fixture();
  try {
    const batch = await value.store.stage(binding, [
      {
        name: "../browser-name-is-metadata.txt",
        mime: "text/plain",
        bytes: Buffer.from("hello"),
      },
    ]);
    assert.equal(batch.count, 1);
    assert.equal(batch.totalBytes, 5);

    const [storeDirectory] = await readdir(value.parent);
    const [batchDirectory] = await readdir(join(value.parent, storeDirectory));
    const [payloadName] = await readdir(
      join(value.parent, storeDirectory, batchDirectory),
    );
    assert.equal(payloadName.includes("browser-name"), false);
    assert.equal(
      await readFile(
        join(value.parent, storeDirectory, batchDirectory, payloadName),
        "utf8",
      ),
      "hello",
    );

    assert.deepEqual(
      await value.store.consume(batch.id, {
        ...binding,
        commandId: "wrong-command",
      }),
      { status: "stale" },
    );
    const consumed = await value.store.consume(batch.id, binding);
    assert.equal(consumed.status, "consumed");
    if (consumed.status === "consumed") {
      assert.equal(
        consumed.attachments[0]?.name,
        "../browser-name-is-metadata.txt",
      );
      assert.equal(
        Buffer.from(consumed.attachments[0]?.bytes ?? []).toString(),
        "hello",
      );
    }
    assert.deepEqual(await value.store.consume(batch.id, binding), {
      status: "settled",
      outcome: "consumed",
    });
  } finally {
    await value.cleanup();
  }
});

test("rejects same-length changed bytes and substitution at open", async (t) => {
  for (const race of [false, true]) {
    const value = await fixture();
    try {
      const batch = await value.store.stage(binding, [
        { name: "safe", mime: "text/plain", bytes: Buffer.from("safe") },
      ]);
      const directory = (await readdir(value.parent)).find(
        (name) => !name.endsWith(".owner"),
      )!;
      const batchPath = join(value.parent, directory, batch.id);
      const payload = join(batchPath, (await readdir(batchPath))[0]!);
      if (race) {
        const originalOpen = fs.open;
        t.mock.method(
          fs,
          "open",
          async (...args: Parameters<typeof fs.open>) => {
            await writeFile(payload, "evil");
            return originalOpen(...args);
          },
        );
        syncBuiltinESMExports();
      } else await writeFile(payload, "evil");
      assert.equal(
        (await value.store.consume(batch.id, binding)).status,
        "failed",
      );
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await value.cleanup();
    }
  }
});

test("discard remains retryable after cleanup failure", async (t) => {
  const value = await fixture();
  try {
    const batch = await value.store.stage(binding, [
      { name: "safe", mime: "text/plain", bytes: Buffer.from("safe") },
    ]);
    const directory = (await readdir(value.parent)).find(
      (name) => !name.endsWith(".owner"),
    )!;
    const batchPath = join(value.parent, directory, batch.id);
    const originalRm = fs.rm;
    let fail = true;
    t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
      if (fail) {
        fail = false;
        throw new Error("injected cleanup failure");
      }
      return originalRm(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(
      value.store.discard(batch.id, binding),
      /cleanup failure/,
    );
    assert.ok((await lstat(batchPath)).isDirectory());
    assert.deepEqual(await value.store.discard(batch.id, binding), {
      status: "discarded",
    });
    await assert.rejects(lstat(batchPath), { code: "ENOENT" });
    assert.deepEqual(await value.store.discard(batch.id, binding), {
      status: "settled",
      outcome: "discarded",
    });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await value.cleanup();
  }
});

test("workspace aliases share canonical attachment ownership", async () => {
  const value = await fixture();
  try {
    const alias = join(value.parent, "workspace-alias");
    await symlink(binding.workspace, alias);
    const batch = await value.store.stage({ ...binding, workspace: alias }, [
      { name: "safe", mime: "text/plain", bytes: Buffer.from("safe") },
    ]);
    assert.equal(
      (await value.store.consume(batch.id, binding)).status,
      "consumed",
    );
  } finally {
    await value.cleanup();
  }
});

test("enforces count, per-file, aggregate, and store-wide byte bounds", async () => {
  const value = await fixture();
  try {
    await assert.rejects(
      value.store.stage(binding, []),
      (error) =>
        error instanceof WebAttachmentStagingError &&
        error.code === "ATTACHMENT_LIMIT",
    );
    await assert.rejects(
      value.store.stage(binding, [
        { name: "large", mime: "text/plain", bytes: Buffer.alloc(9) },
      ]),
      (error) =>
        error instanceof WebAttachmentStagingError &&
        error.code === "BYTE_LIMIT",
    );
    await assert.rejects(
      value.store.stage(binding, [
        { name: "a", mime: "text/plain", bytes: Buffer.alloc(7) },
        { name: "b", mime: "text/plain", bytes: Buffer.alloc(6) },
      ]),
      (error) =>
        error instanceof WebAttachmentStagingError &&
        error.code === "BYTE_LIMIT",
    );
    const first = await value.store.stage(binding, [
      { name: "a", mime: "text/plain", bytes: Buffer.alloc(8) },
    ]);
    const second = await value.store.stage(
      { ...binding, commandId: "command-2" },
      [{ name: "b", mime: "text/plain", bytes: Buffer.alloc(8) }],
    );
    await assert.rejects(
      value.store.stage({ ...binding, commandId: "command-3" }, [
        { name: "c", mime: "text/plain", bytes: Buffer.alloc(1) },
      ]),
      (error) =>
        error instanceof WebAttachmentStagingError &&
        error.code === "STORE_LIMIT",
    );
    assert.deepEqual(await value.store.discard(first.id, binding), {
      status: "discarded",
    });
    assert.equal(
      (
        await value.store.stage({ ...binding, commandId: "command-3" }, [
          { name: "c", mime: "text/plain", bytes: Buffer.alloc(1) },
        ])
      ).totalBytes,
      1,
    );
    assert.deepEqual(
      await value.store.discard(second.id, {
        ...binding,
        commandId: "command-2",
      }),
      { status: "discarded" },
    );
  } finally {
    await value.cleanup();
  }
});

test("bounds active zero-byte batches independently of payload bytes", async () => {
  const value = await fixture();
  try {
    for (let index = 0; index < limits.maxStagedBatches; index += 1) {
      await value.store.stage({ ...binding, commandId: `empty-${index}` }, [
        {
          name: "empty",
          mime: "application/octet-stream",
          bytes: Buffer.alloc(0),
        },
      ]);
    }
    await assert.rejects(
      value.store.stage({ ...binding, commandId: "empty-overflow" }, [
        {
          name: "empty",
          mime: "application/octet-stream",
          bytes: Buffer.alloc(0),
        },
      ]),
      (error) =>
        error instanceof WebAttachmentStagingError &&
        error.code === "STORE_LIMIT",
    );
  } finally {
    await value.cleanup();
  }
});

test("bounds display metadata and removes abandoned roots at startup", async () => {
  const parent = await mkdtemp(join(tmpdir(), "openpi-attachment-ttl-"));
  try {
    const abandoned = join(parent, ".openpi-web-attachments-abandoned");
    await mkdir(abandoned, { recursive: true });
    const old = new Date(Date.now() - 10_000);
    await utimes(abandoned, old, old);
    const store = await WebAttachmentStagingStore.create(parent, {
      ...limits,
      stagingTtlMs: 1_000,
    });
    await assert.rejects(
      store.stage(binding, [
        { name: "n".repeat(257), mime: "text/plain", bytes: Buffer.from("x") },
      ]),
      (error) =>
        error instanceof WebAttachmentStagingError &&
        error.code === "INVALID_PAYLOAD",
    );
    await assert.rejects(
      store.stage(binding, [
        { name: "safe", mime: "m".repeat(257), bytes: Buffer.from("x") },
      ]),
      (error) =>
        error instanceof WebAttachmentStagingError &&
        error.code === "INVALID_PAYLOAD",
    );
    await assert.rejects(lstat(abandoned));
    await store.dispose();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("does not reclaim an aged store that is still owned", async () => {
  const parent = await mkdtemp(join(tmpdir(), "openpi-attachment-owned-"));
  const first = await WebAttachmentStagingStore.create(parent, {
    ...limits,
    stagingTtlMs: 1_000,
  });
  try {
    const batch = await first.stage(binding, [
      { name: "kept", mime: "text/plain", bytes: Buffer.from("payload") },
    ]);
    const [storeDirectory] = await readdir(parent);
    const old = new Date(Date.now() - 10_000);
    await utimes(join(parent, storeDirectory), old, old);

    const second = await WebAttachmentStagingStore.create(parent, {
      ...limits,
      stagingTtlMs: 1_000,
    });
    try {
      assert.equal((await first.consume(batch.id, binding)).status, "consumed");
    } finally {
      await second.dispose();
    }
  } finally {
    await first.dispose();
    await rm(parent, { recursive: true, force: true });
  }
});

test("fails closed when a staged payload is replaced by a symlink", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation requires host-specific privileges on Windows");
    return;
  }
  const value = await fixture();
  try {
    const batch = await value.store.stage(binding, [
      { name: "safe.txt", mime: "text/plain", bytes: Buffer.from("safe") },
    ]);
    const [storeDirectory] = await readdir(value.parent);
    const [batchDirectory] = await readdir(join(value.parent, storeDirectory));
    const batchPath = join(value.parent, storeDirectory, batchDirectory);
    const [payloadName] = await readdir(batchPath);
    const payloadPath = join(batchPath, payloadName);
    await rm(payloadPath);
    await symlink("/etc/hosts", payloadPath);

    assert.deepEqual(await value.store.consume(batch.id, binding), {
      status: "failed",
      error: "staged attachment integrity check failed",
    });
    assert.equal(
      (await lstat(join(value.parent, storeDirectory))).isDirectory(),
      true,
    );
    await assert.rejects(lstat(batchPath));
  } finally {
    await value.cleanup();
  }
});

test("discard and host disposal remove private staged artifacts", async () => {
  const value = await fixture();
  const first = await value.store.stage(binding, [
    { name: "a", mime: "text/plain", bytes: Buffer.from("a") },
  ]);
  const [storeDirectory] = await readdir(value.parent);
  const storePath = join(value.parent, storeDirectory);
  assert.deepEqual(await value.store.discard(first.id, binding), {
    status: "discarded",
  });
  assert.deepEqual(await readdir(storePath), []);

  await value.store.stage({ ...binding, commandId: "command-2" }, [
    { name: "b", mime: "text/plain", bytes: Buffer.from("b") },
  ]);
  await value.store.dispose();
  await assert.rejects(lstat(storePath));
  assert.deepEqual(await readdir(value.parent), []);
  await assert.rejects(
    value.store.stage(binding, [
      { name: "c", mime: "text/plain", bytes: Buffer.from("c") },
    ]),
    (error) =>
      error instanceof WebAttachmentStagingError &&
      error.code === "STORE_CLOSED",
  );
  await rm(value.parent, { recursive: true, force: true });
});
