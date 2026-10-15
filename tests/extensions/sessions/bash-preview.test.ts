import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  buildSessionPreview,
  type SessionInfoLike,
} from "../../../extensions/sessions/sessions.ts";

type BashExecutionMessage = Extract<
  Awaited<ReturnType<typeof createAgentSession>>["session"]["messages"][number],
  { role: "bashExecution" }
>;

const info: SessionInfoLike = {
  id: "bash-preview",
  cwd: "/tmp/project",
  modified: new Date(0),
  firstMessage: "",
  path: "/tmp/session.jsonl",
};

for (const [name, exitCode, cancelled, expectedError] of [
  ["successful", 0, false, false],
  ["failed", 7, false, true],
  ["cancelled", undefined, true, true],
  ["cancelled despite zero exit code", 0, true, true],
  ["unknown exit status", undefined, false, false],
] as const) {
  test(`Bash preview preserves ${name} native status`, () => {
    const message: BashExecutionMessage = {
      role: "bashExecution",
      command: "fixture-command",
      output: "safe\u001b[2J output",
      exitCode,
      cancelled,
      truncated: false,
      timestamp: 1,
    };
    const before = structuredClone(message);
    const preview = buildSessionPreview(info, [message]);
    assert.equal(preview.blocks.length, 1);
    const block = preview.blocks[0];
    assert.ok(block?.kind === "bash");
    assert.equal(block.command, "fixture-command");
    assert.equal(block.output, "safe output");
    assert.equal(Boolean(block.isError), expectedError);
    assert.deepEqual(message, before, "preview must not mutate native history");
  });
}

test("Bash preview retains existing explicit error flags", () => {
  const preview = buildSessionPreview(info, [
    { role: "bashExecution", command: "legacy-command", isError: true },
  ]);
  assert.equal(preview.blocks[0]?.kind, "bash");
  assert.equal(
    preview.blocks[0]?.kind === "bash" && preview.blocks[0].isError,
    true,
  );
});

test("real native Bash execution failure reaches the session preview", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-bash-preview-"));
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  const settingsManager = SettingsManager.inMemory(undefined, {
    projectTrusted: false,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
  });
  try {
    const result = await session.executeBash("exit 7");
    assert.equal(result.exitCode, 7);
    const messages = session.messages.filter(
      (message) => message.role === "bashExecution",
    );
    assert.equal(messages.length, 1);
    const before = structuredClone(messages);
    const preview = buildSessionPreview({ ...info, cwd }, messages);
    assert.deepEqual(preview.blocks, [
      { kind: "bash", command: "exit 7", output: "", isError: true },
    ]);
    assert.deepEqual(messages, before);
  } finally {
    session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
