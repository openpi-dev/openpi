import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import {
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { createTurnChangeRecorder } from "../../web/runtime/turn-changes.ts";
import {
  WEB_TURN_CHANGES_ENTRY,
  readTurnChangesDetail,
} from "../../web/protocol/turn-changes.ts";

const execFileAsync = promisify(execFile);
const roots = new Set<string>();
after(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "openpi-turn-record-"));
  roots.add(root);
  await execFileAsync("git", ["-C", root, "init", "-b", "main"]);
  await execFileAsync("git", [
    "-C",
    root,
    "config",
    "user.name",
    "OpenPI Test",
  ]);
  await execFileAsync("git", [
    "-C",
    root,
    "config",
    "user.email",
    "openpi@example.invalid",
  ]);
  await writeFile(join(root, "file.txt"), "initial\n");
  await execFileAsync("git", ["-C", root, "add", "file.txt"]);
  await execFileAsync("git", ["-C", root, "commit", "-m", "initial"]);
  return root;
}

async function sessionDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "openpi-turn-sessions-"));
  roots.add(directory);
  return directory;
}

function recorderEvents(manager: SessionManager, root: string) {
  const events = new Map<string, (event: unknown) => unknown>();
  const recorder = createTurnChangeRecorder(manager, root);
  if (typeof recorder === "function")
    throw new Error("Expected a named extension");
  recorder.factory({
    on(name: string, callback: (event: unknown) => unknown) {
      events.set(name, callback);
    },
  } as ExtensionAPI);
  const emit = async (name: string, event: unknown = { type: name }) => {
    const callback = events.get(name);
    if (!callback) throw new Error(`No ${name} handler`);
    await callback(event);
  };
  const prompt = async (text: string) => {
    const message = {
      role: "user" as const,
      content: text,
      timestamp: Date.now(),
    };
    await emit("message_start", { type: "message_start", message });
    return manager.appendMessage(message);
  };
  const answer = (text: string) =>
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
  return { emit, prompt, answer };
}

function changes(manager: SessionManager) {
  return manager
    .getBranch()
    .filter(
      (entry) =>
        entry.type === "custom" && entry.customType === WEB_TURN_CHANGES_ENTRY,
    )
    .map((entry) =>
      entry.type === "custom" ? readTurnChangesDetail(entry.data) : undefined,
    );
}

test("recorder finalizes each user prompt before a queued follow-up and survives reload", async () => {
  const root = await repository();
  await writeFile(join(root, "file.txt"), "preexisting\n");
  await writeFile(join(root, "untouched.txt"), "preexisting untracked\n");
  const sessions = await sessionDirectory();
  const manager = SessionManager.create(root, sessions);
  const events = recorderEvents(manager, root);
  const firstId = await events.prompt("Edit the file");
  await writeFile(join(root, "file.txt"), "first\n");
  events.answer("First edit done");
  const secondId = await events.prompt("Edit it again");
  await writeFile(join(root, "file.txt"), "second\n");
  events.answer("Second edit done");
  await events.emit("agent_settled");

  const results = changes(manager);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.promptEntryId, firstId);
  assert.equal(results[0]?.state, "complete");
  assert.equal(results[0]?.files[0]?.path, "file.txt");
  assert.match(results[0]?.files[0]?.diff ?? "", /\+first/u);
  assert.match(results[0]?.files[0]?.diff ?? "", /-preexisting/u);
  assert.ok(
    results.every((result) =>
      result?.files.every((file) => file.path !== "untouched.txt"),
    ),
  );
  assert.equal(results[1]?.promptEntryId, secondId);
  assert.equal(results[1]?.state, "complete");
  assert.match(results[1]?.files[0]?.diff ?? "", /\+second/u);
  assert.match(results[1]?.files[0]?.diff ?? "", /-first/u);

  const file = manager.getSessionFile();
  assert.ok(file);
  assert.ok((await readFile(file, "utf8")).includes(WEB_TURN_CHANGES_ENTRY));
  const reopened = SessionManager.open(file, sessions);
  assert.deepEqual(changes(reopened), results);
});

test("recorder persists zero changes separately from an unavailable baseline", async () => {
  const root = await repository();
  const manager = SessionManager.create(root, await sessionDirectory());
  const events = recorderEvents(manager, root);
  const noChangeId = await events.prompt("Inspect only");
  events.answer("Nothing changed");
  await events.emit("agent_settled");
  assert.deepEqual(changes(manager)[0], {
    version: 1,
    sessionId: manager.getSessionId(),
    promptEntryId: noChangeId,
    state: "complete",
    fileCount: 0,
    files: [],
    additions: 0,
    deletions: 0,
  });

  // A missing Git repository cannot be mistaken for a clean turn.
  await rename(join(root, ".git"), join(root, ".git-disabled"));
  const unavailableId = await events.prompt("This cannot be observed");
  events.answer("Cannot verify a change");
  await events.emit("agent_settled");
  const latest = changes(manager)[1];
  assert.equal(latest?.promptEntryId, unavailableId);
  assert.equal(latest?.state, "unavailable");
  assert.equal(latest?.fileCount, null);
});

test("recorder does not report a changed repository as a verified turn", async () => {
  const root = await repository();
  const nested = join(root, "nested");
  await mkdir(nested);
  const manager = SessionManager.create(nested, await sessionDirectory());
  const events = recorderEvents(manager, nested);
  const id = await events.prompt("Change the nested project");
  await execFileAsync("git", ["-C", nested, "init", "-b", "main"]);
  events.answer("Repository changed");
  await events.emit("agent_settled");
  assert.equal(changes(manager)[0]?.promptEntryId, id);
  assert.equal(changes(manager)[0]?.state, "unavailable");
});

test("large turn diffs persist as partial evidence instead of an exact file count", async () => {
  const root = await repository();
  const manager = SessionManager.create(root, await sessionDirectory());
  const events = recorderEvents(manager, root);
  const id = await events.prompt("Write a large change");
  await writeFile(join(root, "file.txt"), `${"x".repeat(300_000)}\n`);
  events.answer("Large change done");
  await events.emit("agent_settled");
  const result = changes(manager)[0];
  assert.equal(result?.promptEntryId, id);
  assert.equal(result?.state, "partial");
  assert.equal(result?.fileCount, null);
  assert.equal(result?.files[0]?.path, "file.txt");
  assert.equal(result?.files[0]?.diffTruncated, true);
  assert.equal(result?.additions, 1);
});
