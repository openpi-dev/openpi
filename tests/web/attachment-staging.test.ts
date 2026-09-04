import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  WebAttachmentStagingError,
  WebAttachmentStagingStore,
  type WebAttachmentBinding,
  type WebAttachmentStagingLimits,
} from "../../web/runtime/attachment-staging.ts";

const limits: WebAttachmentStagingLimits = {
  maxAttachments: 2,
  maxAttachmentBytes: 8,
  maxTotalBytes: 12,
  maxStagedBytes: 16,
  maxSettledReceipts: 2,
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
