import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  initTheme,
  SessionManager,
  SettingsManager,
  ToolExecutionComponent,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import fileMutationDisplay from "../../../extensions/file-mutation-display/index.ts";
import { withActivityRenderer } from "../../../extensions/file-mutation-display/render.ts";

initTheme("dark", false);

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

test("overrides all seven activity renderers without changing model-facing definitions", async () => {
  await withSession(async (session, cwd) => {
    const native = Object.fromEntries(
      [
        createBashToolDefinition(cwd),
        createReadToolDefinition(cwd),
        createWriteToolDefinition(cwd),
        createEditToolDefinition(cwd),
        createGrepToolDefinition(cwd),
        createFindToolDefinition(cwd),
        createLsToolDefinition(cwd),
      ].map((definition) => [definition.name, definition]),
    );
    const names = ["bash", "read", "write", "edit", "grep", "find", "ls"];
    for (const name of names) {
      const actual = session.getToolDefinition(name);
      const expected = native[name];
      assert.ok(actual, name);
      assert.ok(expected, name);
      assert.equal(actual.renderShell, "self", name);
      assert.equal(actual.name, expected.name, name);
      assert.equal(actual.label, expected.label, name);
      assert.equal(actual.description, expected.description, name);
      assert.deepEqual(actual.parameters, expected.parameters, name);
      assert.equal(actual.promptSnippet, expected.promptSnippet, name);
      assert.deepEqual(
        actual.promptGuidelines,
        expected.promptGuidelines,
        name,
      );
    }

    const bash = session.getToolDefinition("bash");
    const write = session.getToolDefinition("write");
    const edit = session.getToolDefinition("edit");

    const renderWrite = write?.renderCall;
    assert.ok(renderWrite);
    const identityTheme = new Proxy(
      {},
      {
        get: (_target, property) =>
          property === "fg" || property === "bg"
            ? (_color: string, text: string) => text
            : (text: string) => text,
      },
    ) as Theme;
    const args = {
      path: "large.ts",
      content: Array.from({ length: 30 }, (_, index) => `line ${index}`).join(
        "\n",
      ),
    };
    const renderContext: Parameters<typeof renderWrite>[2] = {
      args,
      toolCallId: "write-render",
      invalidate() {},
      lastComponent: undefined,
      state: {},
      cwd,
      executionStarted: false,
      argsComplete: false,
      isPartial: true,
      expanded: false,
      showImages: false,
      isError: false,
    };
    assert.equal(
      renderWrite(args, identityTheme, renderContext).render(100).length,
      1,
    );
    assert.equal(
      renderWrite(args, identityTheme, {
        ...renderContext,
        argsComplete: true,
      }).render(100).length,
      1,
    );

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

test("real ToolExecutionComponent toggles between one activity row and native evidence", () => {
  const definition = withActivityRenderer(
    createBashToolDefinition("/workspace"),
  );
  const ui = { requestRender() {} } as unknown as TUI;
  const component = new ToolExecutionComponent(
    "bash",
    "bash-component",
    { command: "printf alpha" },
    { showImages: false },
    definition,
    ui,
    "/workspace",
  );
  component.markExecutionStarted();
  component.setArgsComplete();
  component.updateResult({
    content: [{ type: "text", text: "alpha" }],
    isError: false,
  });

  const nonEmpty = () =>
    component
      .render(80)
      .map((line) => stripVTControlCharacters(line))
      .filter((line) => line.trim().length > 0);

  assert.equal(nonEmpty().length, 1);
  assert.match(nonEmpty()[0] ?? "", /Ran\s+printf alpha/);

  component.setExpanded(true);
  const expanded = nonEmpty();
  assert.ok(expanded.length > 1);
  assert.match(expanded.join("\n"), /alpha/);

  component.setExpanded(false);
  assert.equal(nonEmpty().length, 1);
});
