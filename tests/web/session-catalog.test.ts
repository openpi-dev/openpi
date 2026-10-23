import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionCatalog } from "../../web/adapter/session-catalog.ts";

test("completed catalog scans release caller cancellation listeners", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openpi-catalog-listeners-"));
  const controller = new AbortController();
  try {
    const catalog = new SessionCatalog();
    for (let index = 0; index < 5; index++) {
      await catalog.list(directory, { signal: controller.signal });
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog preserves chunk-spanning UTF-8 records and unterminated final lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openpi-catalog-records-"));
  try {
    const content = "你好😀".repeat(32_768);
    const records = [
      { type: "session", id: "session", cwd: directory },
      {
        type: "message",
        id: "first",
        parentId: null,
        message: { role: "user", content },
      },
      {
        type: "message",
        id: "last",
        parentId: "first",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      },
    ];
    await writeFile(
      join(directory, "session.jsonl"),
      records.map((record) => JSON.stringify(record)).join("\n"),
    );
    const page = await new SessionCatalog().list(directory);
    assert.equal(page.sessions.length, 1);
    assert.equal(page.sessions[0]?.firstMessage, content.slice(0, 2_000));
    assert.equal(page.sessions[0]?.messageCount, 2);
    assert.equal(page.partial, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
