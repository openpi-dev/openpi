import assert from "node:assert/strict";
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadSessionPreviewData } from "../../../extensions/sessions/preview-loader.ts";

const timestamp = (offset: number) =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();

const header = (version = 3) => ({
  type: "session",
  version,
  id: "preview-test",
  timestamp: timestamp(0),
  cwd: "/tmp/preview-test",
});

const message = (
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  text: string,
) => ({
  type: "message",
  id,
  parentId,
  timestamp: timestamp(Number.parseInt(id.replace(/\D/gu, ""), 10) || 1),
  message: {
    role,
    content: [{ type: "text", text }],
    timestamp: 1,
    ...(role === "assistant"
      ? { provider: "test-provider", model: "test-model", usage: {} }
      : {}),
  },
});

const legacyMessage = (
  role: "user" | "assistant",
  text: string,
  offset: number,
) => ({
  type: "message",
  timestamp: timestamp(offset),
  message: {
    role,
    content: [{ type: "text", text }],
    timestamp: offset,
    ...(role === "assistant"
      ? { provider: "test-provider", model: "test-model", usage: {} }
      : {}),
  },
});

async function writeSession(entries: unknown[]) {
  const directory = await mkdtemp(join(tmpdir(), "openpi-preview-loader-"));
  const path = join(directory, "session.jsonl");
  await writeFile(
    path,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  return { directory, path };
}

async function writeRawSession(content: string | Buffer) {
  const directory = await mkdtemp(join(tmpdir(), "openpi-preview-loader-"));
  const path = join(directory, "session.jsonl");
  await writeFile(path, content);
  return { directory, path };
}

test("v3 preview follows only the active branch and matches Pi context", async (t) => {
  const fixture = await writeSession([
    header(),
    message("m1", null, "user", "root"),
    message("m2", "m1", "assistant", "abandoned branch"),
    message("m3", "m1", "assistant", "active branch"),
    message("m4", "m3", "user", "latest"),
  ]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  const expected = SessionManager.open(fixture.path).buildSessionContext()
    .messages;
  const result = await loadSessionPreviewData(fixture.path);
  const file = await stat(fixture.path);

  assert.deepEqual(result.messages, expected.slice(-80));
  assert.equal(result.totalMessages, expected.length);
  assert.equal(result.truncatedBytes, 0);
  assert.ok(result.retainedBytes <= 1024 * 1024);
  assert.ok(result.bytesRead >= file.size);
  assert.ok(result.bytesRead <= file.size + 1024 * 1024);
  assert.equal(result.identity.path, fixture.path);
  assert.equal(result.identity.size, file.size);
});

test("v3 preview preserves Pi compaction ordering", async (t) => {
  const fixture = await writeSession([
    header(),
    message("m1", null, "user", "summarized"),
    message("m2", "m1", "assistant", "kept"),
    {
      type: "compaction",
      id: "c3",
      parentId: "m2",
      timestamp: timestamp(3),
      summary: "compact summary",
      firstKeptEntryId: "m2",
      tokensBefore: 100,
    },
    message("m4", "c3", "user", "after compaction"),
  ]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  const expected = SessionManager.open(fixture.path).buildSessionContext()
    .messages;
  const result = await loadSessionPreviewData(fixture.path);

  assert.deepEqual(result.messages, expected);
  assert.equal(result.totalMessages, expected.length);
});

test("v3 preview excludes pre-compaction entries when firstKeptEntryId is missing", async (t) => {
  const fixture = await writeSession([
    header(),
    message("m1", null, "user", "must stay omitted"),
    {
      type: "compaction",
      id: "c2",
      parentId: "m1",
      timestamp: timestamp(2),
      summary: "compact summary",
      firstKeptEntryId: "missing",
      tokensBefore: 100,
    },
    message("m3", "c2", "assistant", "after compaction"),
  ]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  const expected = SessionManager.open(fixture.path).buildSessionContext()
    .messages;
  const result = await loadSessionPreviewData(fixture.path);

  assert.deepEqual(result.messages, expected);
  assert.equal(result.totalMessages, expected.length);
});

test("v3 preview projects branch summaries and custom messages like Pi", async (t) => {
  const fixture = await writeSession([
    header(),
    message("m1", null, "user", "root"),
    {
      type: "branch_summary",
      id: "b2",
      parentId: "m1",
      timestamp: timestamp(2),
      fromId: "m1",
      summary: "branch summary",
    },
    {
      type: "custom_message",
      id: "m3",
      parentId: "b2",
      timestamp: timestamp(3),
      customType: "preview-test",
      content: "custom context",
      display: true,
    },
  ]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  const expected = SessionManager.open(fixture.path).buildSessionContext()
    .messages;
  const result = await loadSessionPreviewData(fixture.path);

  assert.deepEqual(result.messages, expected);
  assert.equal(result.totalMessages, expected.length);
});

test("v2 preview applies the legacy hookMessage migration without rewriting the file", async (t) => {
  const entries = [
    header(2),
    message("m1", null, "user", "root"),
    {
      type: "message",
      id: "m2",
      parentId: "m1",
      timestamp: timestamp(2),
      message: {
        role: "hookMessage",
        content: [{ type: "text", text: "legacy hook" }],
        timestamp: 2,
      },
    },
  ];
  const fixture = await writeSession(entries);
  const canonical = await writeSession(entries);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  t.after(() => rm(canonical.directory, { recursive: true, force: true }));
  const before = await readFile(fixture.path, "utf8");

  const result = await loadSessionPreviewData(fixture.path);
  const expected = SessionManager.open(canonical.path).buildSessionContext()
    .messages;

  assert.deepEqual(result.messages, expected);
  assert.equal(await readFile(fixture.path, "utf8"), before);
});

test("v1 preview handles index-based compaction without migrating the file", async (t) => {
  const entries = [
    header(1),
    legacyMessage("user", "summarized", 1),
    legacyMessage("assistant", "kept", 2),
    {
      type: "compaction",
      timestamp: timestamp(3),
      summary: "legacy compact summary",
      firstKeptEntryIndex: 2,
      tokensBefore: 100,
    },
    legacyMessage("user", "after compaction", 4),
  ];
  const fixture = await writeSession(entries);
  const canonical = await writeSession(entries);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  t.after(() => rm(canonical.directory, { recursive: true, force: true }));
  const before = await readFile(fixture.path, "utf8");

  const result = await loadSessionPreviewData(fixture.path);
  const expected = SessionManager.open(canonical.path).buildSessionContext()
    .messages;

  assert.deepEqual(result.messages, expected);
  assert.equal(result.totalMessages, expected.length);
  assert.equal(await readFile(fixture.path, "utf8"), before);
});

test("v1 preview keeps the newest 80 messages from a long linear session", async (t) => {
  const entries: unknown[] = [header(1)];
  for (let index = 1; index <= 120; index++) {
    entries.push(
      legacyMessage(index % 2 ? "user" : "assistant", `legacy-${index}`, index),
    );
  }
  const fixture = await writeSession(entries);
  const canonical = await writeSession(entries);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  t.after(() => rm(canonical.directory, { recursive: true, force: true }));

  const result = await loadSessionPreviewData(fixture.path);
  const expected = SessionManager.open(canonical.path).buildSessionContext()
    .messages;

  assert.deepEqual(result.messages, expected.slice(-80));
  assert.equal(result.totalMessages, 120);
});

test("preview retains the newest oversized message with an explicit byte omission marker", async (t) => {
  const oversized = "界".repeat(450_000);
  const fixture = await writeSession([
    header(),
    message("m1", null, "user", "older"),
    message("m2", "m1", "assistant", oversized),
  ]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  const result = await loadSessionPreviewData(fixture.path);
  const serialized = JSON.stringify(result.messages);

  assert.equal(result.messages.length, 1);
  assert.match(serialized, /bytes omitted from preview/);
  assert.ok(result.truncatedBytes > 0);
  assert.ok(result.retainedBytes <= 1024 * 1024);
  assert.ok(
    Buffer.byteLength(serialized, "utf8") <
      Buffer.byteLength(oversized, "utf8"),
  );
});

test("preview byte budget also bounds non-string structured message details", async (t) => {
  const fixture = await writeSession([
    header(),
    {
      type: "custom_message",
      id: "m1",
      parentId: null,
      timestamp: timestamp(1),
      customType: "structured-stress",
      content: "small visible content",
      display: true,
      details: { values: Array.from({ length: 800_000 }, () => 0) },
    },
  ]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  const result = await loadSessionPreviewData(fixture.path);

  assert.equal(result.messages.length, 1);
  assert.ok(result.truncatedBytes > 0);
  assert.ok(result.retainedBytes <= 1024 * 1024);
  assert.ok(
    Buffer.byteLength(JSON.stringify(result.messages), "utf8") <
      2 * 1024 * 1024,
  );
});

test("preview keeps exactly the newest 80 context messages", async (t) => {
  const entries: unknown[] = [header()];
  let parentId: string | null = null;
  for (let index = 1; index <= 120; index++) {
    const id = `m${index}`;
    entries.push(message(id, parentId, index % 2 ? "user" : "assistant", id));
    parentId = id;
  }
  const fixture = await writeSession(entries);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  const expected = SessionManager.open(fixture.path).buildSessionContext()
    .messages;
  const result = await loadSessionPreviewData(fixture.path);

  assert.deepEqual(result.messages, expected.slice(-80));
  assert.equal(result.totalMessages, 120);
  assert.equal(result.truncatedBytes, 0);
});

test("preview rejects malformed and truncated JSONL without echoing file content", async (t) => {
  const secret = "do-not-echo-this-content";
  const fixture = await writeRawSession(
    `${JSON.stringify(header())}\n{"type":"message","secret":"${secret}"`,
  );
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  await assert.rejects(
    loadSessionPreviewData(fixture.path),
    (error: unknown) => {
      assert.match(String(error), /malformed JSONL at byte offset/);
      assert.doesNotMatch(String(error), new RegExp(secret));
      return true;
    },
  );
});

test("preview rejects invalid UTF-8, missing headers, and future versions", async (t) => {
  const invalidUtf8 = await writeRawSession(
    Buffer.concat([
      Buffer.from(`${JSON.stringify(header())}\n`, "utf8"),
      Buffer.from([0xff, 0x0a]),
    ]),
  );
  const missingHeader = await writeSession([
    message("m1", null, "user", "no header"),
  ]);
  const futureVersion = await writeSession([header(4)]);
  t.after(() => rm(invalidUtf8.directory, { recursive: true, force: true }));
  t.after(() => rm(missingHeader.directory, { recursive: true, force: true }));
  t.after(() => rm(futureVersion.directory, { recursive: true, force: true }));

  await assert.rejects(
    loadSessionPreviewData(invalidUtf8.path),
    /invalid UTF-8/,
  );
  await assert.rejects(
    loadSessionPreviewData(missingHeader.path),
    /valid session header/,
  );
  await assert.rejects(
    loadSessionPreviewData(futureVersion.path),
    /unsupported session version/,
  );
});

test("v2/v3 preview rejects an active lineage with a missing parent", async (t) => {
  const fixture = await writeSession([
    header(),
    message("m2", "missing-parent", "user", "orphan"),
  ]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  await assert.rejects(
    loadSessionPreviewData(fixture.path),
    /active lineage references a missing parent/,
  );
});

for (const version of [1, 3]) {
  test(`v${version} preview rejects an atomic replacement of the session path`, async (t) => {
    const originalEntries =
      version === 1
        ? [header(1), legacyMessage("user", "original", 1)]
        : [header(3), message("m1", null, "user", "original")];
    const replacementEntries =
      version === 1
        ? [header(1), legacyMessage("user", "replaced", 1)]
        : [header(3), message("m1", null, "user", "replaced")];
    const fixture = await writeSession(originalEntries);
    const replacementPath = join(fixture.directory, "replacement.jsonl");
    const replacementContent = `${replacementEntries
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`;
    await writeFile(replacementPath, replacementContent);
    t.after(() => rm(fixture.directory, { recursive: true, force: true }));

    let replaced = false;
    await assert.rejects(
      loadSessionPreviewData(fixture.path, {
        onRead: () => {
          if (replaced) return;
          replaced = true;
          if (process.platform === "win32") {
            // Windows rejects rename-over-open. An in-place replacement still
            // exercises the loader's changed-file rejection on that platform.
            writeFileSync(fixture.path, `${replacementContent}\n`);
          } else {
            renameSync(replacementPath, fixture.path);
          }
        },
      }),
      /changed while preview was loading/,
    );
  });
}

test("preview rejects a physical JSONL line larger than 8 MiB", async (t) => {
  const fixture = await writeRawSession(
    Buffer.concat([
      Buffer.from(`${JSON.stringify(header())}\n`, "utf8"),
      Buffer.alloc(8 * 1024 * 1024 + 1, 0x20),
      Buffer.from("\n"),
    ]),
  );
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  await assert.rejects(
    loadSessionPreviewData(fixture.path),
    /line exceeds 8388608 bytes/,
  );
});

test("preview observes cancellation and rejects a file changed during scanning", async (t) => {
  const fixture = await writeSession([
    header(),
    message("m1", null, "user", "x".repeat(2 * 1024 * 1024)),
  ]);
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    loadSessionPreviewData(fixture.path, { signal: controller.signal }),
    {
      name: "AbortError",
    },
  );

  let changed = false;
  await assert.rejects(
    loadSessionPreviewData(fixture.path, {
      onRead: () => {
        if (changed) return;
        changed = true;
        appendFileSync(fixture.path, " \n");
      },
    }),
    /changed while preview was loading/,
  );
});
