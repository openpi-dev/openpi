import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
  open,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import {
  SessionManager,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  createAgentSessionFromServices,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
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
  const {
    extension: recorder,
    writeTool,
    editTool,
  } = createTurnChangeRecorder(manager, root);
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
  return {
    emit,
    prompt,
    answer,
    write: (path: string, content: string, signal?: AbortSignal) =>
      writeTool.execute(
        "write",
        { path, content },
        signal,
        undefined,
        undefined!,
      ),
    edit: (path: string, oldText: string, newText: string) =>
      editTool.execute(
        "edit",
        { path, edits: [{ oldText, newText }] },
        undefined,
        undefined,
        undefined!,
      ),
  };
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
  await events.edit("file.txt", "preexisting", "first");
  events.answer("First edit done");
  const secondId = await events.prompt("Edit it again");
  await events.edit("file.txt", "first", "second");
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

test("recorder needs no Git baseline and ignores external changes", async () => {
  const root = await repository();
  const manager = SessionManager.create(root, await sessionDirectory());
  const events = recorderEvents(manager, root);
  const noChangeId = await events.prompt("Inspect only");
  events.answer("Nothing changed");
  await events.emit("agent_settled");
  assert.deepEqual(changes(manager)[0], {
    version: 2,
    source: "file-tools",
    sessionId: manager.getSessionId(),
    promptEntryId: noChangeId,
    state: "complete",
    fileCount: 0,
    files: [],
    additions: 0,
    deletions: 0,
  });

  // File-tool evidence remains available without a Git repository.
  await rename(join(root, ".git"), join(root, ".git-disabled"));
  const unavailableId = await events.prompt("Write a new file");
  await events.write("hi.txt", "hi\n");
  await writeFile(join(root, "external.txt"), "external\n");
  events.answer("Written");
  await events.emit("agent_settled");
  const latest = changes(manager)[1];
  assert.equal(latest?.promptEntryId, unavailableId);
  assert.equal(latest?.state, "complete");
  assert.equal(latest?.fileCount, 1);
  assert.equal(latest?.files[0]?.path, "hi.txt");
  assert.equal(latest?.files[0]?.additions, 1);
});

test("changing Git repositories without a file tool never manufactures edited files", async () => {
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
  assert.equal(changes(manager)[0]?.fileCount, 0);
});

test("large files retain identity and do not discard a small edit", async () => {
  const root = await repository();
  const manager = SessionManager.create(root, await sessionDirectory());
  const events = recorderEvents(manager, root);
  const id = await events.prompt("Write a large change");
  await events.write("large.txt", `${"x".repeat(300_000)}\n`);
  await events.write("hi.txt", "hi\n");
  events.answer("Large change done");
  await events.emit("agent_settled");
  const result = changes(manager)[0];
  assert.equal(result?.promptEntryId, id);
  assert.equal(result?.state, "partial");
  assert.equal(result?.fileCount, 2);
  assert.equal(result?.files[0]?.path, "large.txt");
  assert.equal(result?.files[0]?.diffTruncated, true);
  assert.equal(result?.additions, 1);
  assert.equal(result?.files[0]?.statsUnavailable, "content_limit");
  assert.equal(result?.files[1]?.additions, 1);
});

test("a 12000-file unborn workspace with 459 MiB of existing content records only the new file", async () => {
  const root = await sessionDirectory();
  await execFileAsync("git", ["-C", root, "init"]);
  const large = await open(join(root, "unrelated.bin"), "w");
  await large.truncate(459 * 1024 * 1024);
  await large.close();
  for (let offset = 0; offset < 12000; offset += 100) {
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        writeFile(join(root, `old-${offset + i}.txt`), "unrelated"),
      ),
    );
  }
  const manager = SessionManager.create(root, await sessionDirectory());
  const events = recorderEvents(manager, root);
  await events.prompt("Create hi.txt");
  await events.write("hi.txt", "hi\n");
  await events.emit("agent_settled");
  const result = changes(manager)[0];
  assert.equal(result?.source, "file-tools");
  assert.equal(result?.fileCount, 1);
  assert.equal(result?.files[0]?.path, "hi.txt");
  assert.equal(result?.additions, 1);
  assert.equal(result?.deletions, 0);
  assert.match(result?.files[0]?.diff ?? "", /\+hi/u);
});

test("multiple edits use net counts, restore-to-original disappears, aliases do not double count", async () => {
  const root = await repository();
  await symlink(join(root, "file.txt"), join(root, "alias.txt"));
  const manager = SessionManager.create(root, await sessionDirectory());
  const events = recorderEvents(manager, root);
  await events.prompt("Edit twice");
  await events.edit("file.txt", "initial", "middle");
  await events.edit("alias.txt", "middle", "final");
  await events.emit("agent_settled");
  assert.equal(changes(manager)[0]?.fileCount, 1);
  assert.equal(changes(manager)[0]?.additions, 1);
  assert.equal(changes(manager)[0]?.deletions, 1);
  assert.doesNotMatch(changes(manager)[0]?.files[0]?.diff ?? "", /middle/u);
  await events.prompt("Restore this turn's edits");
  await events.edit("file.txt", "final", "temporary");
  await events.edit("file.txt", "temporary", "final");
  await events.emit("agent_settled");
  assert.equal(changes(manager)[1]?.fileCount, 0);
});

test("overwrite does not read private old contents and external edits break net continuity", async () => {
  const root = await repository();
  const manager = SessionManager.create(root, await sessionDirectory());
  const events = recorderEvents(manager, root);
  await writeFile(join(root, "file.txt"), "private contents");
  await events.prompt("Overwrite");
  await events.write("file.txt", "replacement");
  await events.emit("agent_settled");
  assert.equal(
    changes(manager)[0]?.files[0]?.statsUnavailable,
    "before_unavailable",
  );
  assert.doesNotMatch(JSON.stringify(changes(manager)), /private contents/);
  await events.prompt("Edit with outside interference");
  await events.edit("file.txt", "replacement", "first");
  await writeFile(join(root, "file.txt"), "outside");
  await events.edit("file.txt", "outside", "last");
  await events.emit("agent_settled");
  assert.equal(
    changes(manager)[1]?.files[0]?.statsUnavailable,
    "concurrent_change",
  );
  assert.equal(changes(manager)[1]?.files[0]?.diff, "");
});

test("native failure and cancellation do not add files; completed edits remain when a later operation fails", async () => {
  const root = await repository();
  const manager = SessionManager.create(root, await sessionDirectory());
  const events = recorderEvents(manager, root);
  await events.prompt("Write then fail");
  await events.write("hi.txt", "hi\n");
  await assert.rejects(
    events.write("cancelled.txt", "no", AbortSignal.abort()),
    /aborted/,
  );
  await assert.rejects(events.edit("missing.txt", "no", "yes"));
  await events.emit("agent_settled");
  assert.deepEqual(
    changes(manager)[0]?.files.map((file) => file.path),
    ["hi.txt"],
  );
});

test("native Pi admission, file tools and settled lifecycle persist one aggregate for a real Session", async () => {
  const cwd = await sessionDirectory();
  const agentDir = await sessionDirectory();
  const manager = SessionManager.create(cwd, agentDir);
  const recorder = createTurnChangeRecorder(manager, cwd);
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
    extensionFactories: [recorder.extension],
  });
  await loader.reload();
  const faux = fauxProvider({
    api: "turn-evidence-fixture",
    provider: "turn-evidence-fixture",
    models: [{ id: "fixture", name: "Fixture", reasoning: false }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(
        "write",
        { path: "hi.txt", content: "hi\n" },
        { id: "write-hi" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall(
        "edit",
        { path: "hi.txt", edits: [{ oldText: "hi", newText: "hello" }] },
        { id: "edit-hi" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Created hi.txt"),
  ]);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey("turn-evidence-fixture", "fixture-key");
  const { session } = await createAgentSessionFromServices({
    services: {
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoader: loader,
      diagnostics: [],
    },
    sessionManager: manager,
    model: faux.getModel(),
    tools: ["write", "edit"],
    customTools: [recorder.writeTool, recorder.editTool],
  });
  try {
    await session.prompt("Create a file and change its greeting");
    const result = changes(manager);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.version, 2);
    assert.equal(result[0]?.fileCount, 1);
    assert.equal(result[0]?.additions, 1);
    assert.equal(result[0]?.deletions, 0);
    assert.match(result[0]?.files[0]?.diff ?? "", /\+hello/u);
    assert.equal(await readFile(join(cwd, "hi.txt"), "utf8"), "hello\n");
  } finally {
    session.dispose();
  }
});
