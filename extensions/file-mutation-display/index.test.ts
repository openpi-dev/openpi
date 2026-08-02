import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import fileMutationDisplay from "./index.ts";

async function withSession(
  run: (
    session: Awaited<ReturnType<typeof createAgentSession>>["session"],
    cwd: string,
  ) => Promise<void>,
) {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-file-mutation-display-"));
  const agentDir = path.join(cwd, "agent");
  await mkdir(agentDir, { recursive: true });
  const settingsManager = SettingsManager.inMemory(undefined, {
    projectTrusted: false,
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [fileMutationDisplay],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
  });
  try {
    await session.bindExtensions({ mode: "print" });
    await run(session, cwd);
  } finally {
    session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}

test("overrides rendering while retaining native Bash/Write/Edit execution", async () => {
  await withSession(async (session, cwd) => {
    const bash = session.getToolDefinition("bash");
    const write = session.getToolDefinition("write");
    const edit = session.getToolDefinition("edit");
    assert.ok(bash?.renderCall);
    assert.ok(bash?.renderResult);
    assert.ok(write?.renderCall);
    assert.ok(edit?.renderCall);
    assert.match(bash?.description ?? "", /Execute a bash command/);
    assert.match(write?.description ?? "", /Creates the file/);
    assert.match(edit?.description ?? "", /exact text replacement/);

    const ctx = {
      cwd,
      sessionManager: {
        getSessionId: () => "session-test",
        getSessionFile: () => undefined,
      },
    } as unknown as ExtensionContext;
    const bashResult = await bash!.execute(
      "bash-1",
      { command: "printf native-bash" },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(bashResult.content[0]?.type, "text");
    assert.match(
      bashResult.content[0]?.type === "text" ? bashResult.content[0].text : "",
      /native-bash/,
    );
    await write!.execute(
      "write-1",
      { path: "fixture.txt", content: "before\n" },
      undefined,
      undefined,
      ctx,
    );
    await edit!.execute(
      "edit-1",
      {
        path: "fixture.txt",
        edits: [{ oldText: "before", newText: "after" }],
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(
      await readFile(path.join(cwd, "fixture.txt"), "utf8"),
      "after\n",
    );
  });
});
