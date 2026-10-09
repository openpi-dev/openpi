import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  initTheme,
  SessionManager,
  SettingsManager,
  ToolExecutionComponent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  setKeybindings,
  type TUI,
} from "@earendil-works/pi-tui";
import codemodeDisplay from "../../../extensions/codemode-display/index.ts";
import fileMutationDisplay from "../../../extensions/file-mutation-display/index.ts";
import {
  activityEnabled,
  activityRenderers,
} from "../../../extensions/file-mutation-display/render.ts";
import { createAgentToolRenderLedger } from "../../../extensions/shared/agent-tool-renderer.ts";
import { AgentTranscriptRenderer } from "../../../extensions/shared/agent-transcript.ts";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { loadSetupConfig } from "../../../extensions/shared/setup-config.ts";

initTheme("dark", false);
setKeybindings(
  new KeybindingsManager({
    "app.tools.expand": {
      defaultKeys: "ctrl+o",
      description: "Toggle tool output",
    },
  }),
);

test("child tool cards equal the main public renderer chain, without changing execution", async (t) => {
  t.mock.method(Date, "now", () => 1000);
  const cwd = await mkdtemp(path.join(tmpdir(), "openpi-child-parity-"));
  const agentDir = path.join(cwd, "agent");
  await mkdir(agentDir);
  const settingsManager = SettingsManager.inMemory(undefined, {
    projectTrusted: false,
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      createCodemodeExtension(),
      codemodeDisplay,
      fileMutationDisplay,
    ],
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
    const ledger = createAgentToolRenderLedger(session);
    type Presentation = Pick<
      ToolDefinition,
      "renderCall" | "renderResult" | "renderShell"
    >;
    type RendererResolver = Omit<
      typeof session.extensionRunner,
      "resolveToolRenderers"
    > & {
      resolveToolRenderers?: (
        name: string,
        base: () => Presentation | undefined,
      ) => Presentation | undefined;
    };
    const runner = session.extensionRunner as RendererResolver;
    const surfaceBefore = JSON.stringify(session.getAllTools());
    const fixtures = [
      ["read", { path: "fixture.ts" }],
      ["bash", { command: "printf evidence" }],
      ["write", { path: "fixture.ts", content: "evidence" }],
      [
        "edit",
        {
          path: "fixture.ts",
          edits: [{ oldText: "before", newText: "after" }],
        },
      ],
      ["grep", { pattern: "evidence", path: "." }],
      ["find", { pattern: "*.ts", path: "." }],
      ["ls", { path: "." }],
      ["codemode", { code: "text(await tools.read({path: 'fixture.ts'}));" }],
    ] as const;
    for (const [name, args] of fixtures) {
      const definition = session.getToolDefinition(name);
      assert.ok(definition, name);
      const executor = definition.execute;
      const selected = runner.resolveToolRenderers
        ? runner.resolveToolRenderers(name, () => definition)
        : activityEnabled(name, loadSetupConfig().ui)
          ? { ...definition, ...activityRenderers(name, definition) }
          : definition;
      for (const isError of [false, true]) {
        const id = `${name}-${isError}`;
        const parent = new ToolExecutionComponent(
          name,
          id,
          args,
          { showImages: false },
          selected,
          { requestRender() {} } as TUI,
          cwd,
        );
        parent.markExecutionStarted();
        parent.setArgsComplete();
        ledger.start(id, name, args, definition);
        const result = {
          content: [
            {
              type: "text" as const,
              text: "Script completed\nWall time 0.1 seconds\nOutput:\nevidence-sentinel",
            },
          ],
          details:
            name === "codemode"
              ? {
                  calls: [
                    {
                      id: "1",
                      name: "read",
                      args: '{"path":"fixture.ts"}',
                      status: isError ? "error" : "ok",
                      durationMs: 2,
                    },
                  ],
                }
              : undefined,
          isError,
        };
        parent.updateResult({ ...result, isError: false }, true);
        ledger.update(id, name, args, result);
        for (const width of [40, 80]) {
          assert.deepEqual(
            ledger.renderTool({ toolId: id, name, cwd }, width),
            parent.render(width),
            `${name} streaming ${width}`,
          );
        }
        parent.updateResult(result, false);
        ledger.end(id, name, result, isError);
        for (const expanded of [false, true, false]) {
          parent.setExpanded(expanded);
          for (const width of [40, 80]) {
            assert.deepEqual(
              ledger.renderTool({ toolId: id, name, cwd, expanded }, width),
              parent.render(width),
              `${name} error=${isError} expanded=${expanded} width=${width}`,
            );
          }
        }
        assert.equal(session.getToolDefinition(name)?.execute, executor);
      }
    }
    assert.equal(JSON.stringify(session.getAllTools()), surfaceBefore);
    const renderer = new AgentTranscriptRenderer();
    const document = {
      items: [
        {
          kind: "assistant" as const,
          parts: [
            { type: "thinking" as const, text: "thinking-sentinel" },
            { type: "text" as const, text: "**answer-sentinel**" },
          ],
        },
      ],
      toolRenderer: ledger,
    };
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      italic: (text: string) => text,
    } as Theme;
    const rendered = () =>
      stripVTControlCharacters(renderer.render(document, 80, theme).join("\n"));
    assert.match(rendered(), /thinking-sentinel/);
    settingsManager.setHideThinkingBlock(true);
    assert.doesNotMatch(rendered(), /thinking-sentinel/);
    assert.match(rendered(), /answer-sentinel/);
    settingsManager.setOutputPad(0);
    assert.equal(ledger.messagePresentation?.hideThinking, true);
    assert.equal(ledger.messagePresentation?.outputPad, 0);
    settingsManager.setHideThinkingBlock(false);
    assert.equal(ledger.messagePresentation?.hideThinking, false);
    assert.match(rendered(), /thinking-sentinel/);
    t.diagnostic(
      runner.resolveToolRenderers
        ? "public renderer resolver exercised"
        : "older SDK presentation-only compatibility exercised",
    );
  } finally {
    session.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
