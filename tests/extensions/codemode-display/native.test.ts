import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  initTheme,
  SessionManager,
  SettingsManager,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  KeybindingsManager,
  setCapabilities,
  setKeybindings,
  stripTerminalSequences,
  type TUI,
} from "@earendil-works/pi-tui";
import type { CodemodeRenderers } from "../../../extensions/codemode-display/render.ts";

test("native loader selects the public renderer seam while retaining native Code Mode tools and images", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "openpi-codemode-renderer-"));
  const agentDir = path.join(cwd, "agent");
  const extensionPath = fileURLToPath(
    new URL("../../../extensions/codemode-display/index.ts", import.meta.url),
  );
  const settingsManager = SettingsManager.inMemory(undefined, {
    projectTrusted: false,
  });
  let session:
    | Awaited<ReturnType<typeof createAgentSession>>["session"]
    | undefined;
  const capabilities = getCapabilities();
  try {
    await mkdir(agentDir);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [extensionPath],
      extensionFactories: [createCodemodeExtension()],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const extension = loaded.extensions.find(
      (entry) => entry.resolvedPath === extensionPath,
    );
    assert.ok(extension);
    assert.equal(
      extension.tools.size,
      0,
      "presentation never replaces an executor",
    );
    assert.equal(
      extension.handlers.size,
      0,
      "presentation does not alter lifecycle",
    );
    assert.equal(extension.commands.size, 0);
    session = (
      await createAgentSession({
        cwd,
        agentDir,
        settingsManager,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
      })
    ).session;
    await session.bindExtensions({ mode: "print" });
    const native = session.getToolDefinition("codemode");
    const read = session.getToolDefinition("read");
    assert.ok(native);
    assert.ok(read);
    const surfaceBefore = JSON.stringify(session.getAllTools());
    const executor = native.execute;
    const parameters = native.parameters;
    const runner = session.extensionRunner as typeof session.extensionRunner & {
      resolveToolRenderers?: (
        name: string,
        base: () => CodemodeRenderers | undefined,
      ) => CodemodeRenderers | undefined;
    };
    if (typeof runner.resolveToolRenderers !== "function") {
      assert.equal(
        (extension as typeof extension & { toolRenderers?: unknown[] })
          .toolRenderers,
        undefined,
      );
      assert.equal(session.getToolDefinition("codemode"), native);
      t.diagnostic(
        "older native SDK: renderer API absent; extension leaves native presentation untouched",
      );
      return;
    }
    const selected = runner.resolveToolRenderers("codemode", () => native);
    assert.ok(selected);
    assert.equal(selected.renderShell, "self");
    assert.notEqual(selected.renderCall, native.renderCall);
    assert.equal(
      runner.resolveToolRenderers("read", () => read),
      read,
    );
    assert.equal(session.getToolDefinition("codemode")?.execute, executor);
    assert.equal(session.getToolDefinition("codemode")?.parameters, parameters);
    assert.equal(JSON.stringify(session.getAllTools()), surfaceBefore);
    initTheme("dark", false);
    setKeybindings(
      new KeybindingsManager({
        "app.tools.expand": {
          defaultKeys: "ctrl+o",
          description: "Toggle tool output",
        },
      }),
    );
    const screen = { requestRender() {} } as TUI;
    const code =
      "const results = await Promise.allSettled([tools.bash({command: 'very long shell command'}), tools.read({path: 'example.ts'})]);\nreturn JSON.stringify(results);";
    const component = new ToolExecutionComponent(
      "codemode",
      "native-code-1",
      { code },
      { showImages: false },
      selected,
      screen,
      cwd,
    );
    component.markExecutionStarted();
    component.setArgsComplete();
    const output = JSON.stringify(
      "first output line\nsecond output line\nthird output line",
    );
    const content = [
      {
        type: "text",
        text: "Script completed\nWall time 1.7 seconds\nOutput:\n",
      },
      { type: "text", text: output },
    ];
    const details = {
      fullOutputPath: "/tmp/codemode-output-evidence.txt",
      calls: [
        {
          id: "1",
          name: "earlier-read",
          args: '{"path":"example.ts"}',
          status: "error",
          error: "file missing",
        },
        {
          id: "2",
          name: "earlier-bash",
          args: '{"command":"long shell"}',
          status: "cancelled",
        },
        ...Array.from({ length: 6 }, (_, index) => ({
          id: String(index + 3),
          name: index === 5 ? "bash" : "read",
          args:
            index === 5
              ? `${JSON.stringify({ command: `git status --short; ${"echo long; ".repeat(40)}` }).slice(0, 197)}...`
              : "{}",
          status: "ok",
          durationMs: 2,
        })),
      ],
    };
    component.updateResult(
      {
        content,
        details: {
          ...details,
          calls: details.calls.map((call) => ({
            ...call,
            status: "running",
            error: undefined,
          })),
        },
        isError: false,
      },
      true,
    );
    const pending = component
      .render(300)
      .map(stripTerminalSequences)
      .join("\n");
    assert.doesNotMatch(
      pending,
      /^\s*…|codemode running| · running|more calls?/mu,
    );
    assert.match(pending, /earlier-read example\.ts/u);
    assert.match(pending, /earlier-bash long shell/u);
    assert.match(pending, /Bash git status --short.*… · 2ms/u);
    component.updateResult({ content, details, isError: false }, false);
    const compact = component.render(80).map(stripTerminalSequences).join("\n");
    assert.match(
      compact,
      /codemode completed · 1\.7s · 8 calls · 2 script lines/u,
    );
    assert.doesNotMatch(compact, /very long shell command/u);
    assert.match(compact, /✗ earlier-read example\.ts · error: file missing/u);
    assert.match(compact, /⊘ earlier-bash long shell · cancelled/u);
    assert.match(compact, /Bash git status --short.*… · 2ms/u);
    assert.doesNotMatch(
      compact,
      /\\n|first output line|Full output:|codemode-output-evidence/u,
    );
    const artifacts = process.env.OPENPI_CODEMODE_RENDER_ARTIFACT_DIR;
    if (artifacts) await mkdir(artifacts, { recursive: true });
    for (const width of [80, 40]) {
      component.setExpanded(false);
      const collapsed = component
        .render(width)
        .map(stripTerminalSequences)
        .map((row) => row.trimEnd())
        .join("\n");
      component.setExpanded(true);
      const expanded = component
        .render(width)
        .map(stripTerminalSequences)
        .map((row) => row.trimEnd())
        .join("\n");
      assert.match(expanded, /Script/u);
      assert.match(expanded, /Calls/u);
      assert.match(expanded, /Output/u);
      assert.match(expanded, /Raw output/u);
      assert.match(expanded, /first output line/u);
      assert.match(expanded, /Full output:/u);
      assert.doesNotMatch(collapsed, /first output line|Full output:/u);
      assert.match(collapsed, /Bash git status/u);
      if (artifacts) {
        await writeFile(
          path.join(artifacts, `compact-${width}.txt`),
          collapsed,
        );
        await writeFile(
          path.join(artifacts, `expanded-${width}.txt`),
          expanded,
        );
      }
    }
    component.setExpanded(false);
    component.updateResult(
      {
        content: [{ type: "text", text: "historical error" }],
        details: undefined,
        isError: true,
      },
      false,
    );
    assert.match(
      component.render(80).map(stripTerminalSequences).join("\n"),
      /failed · time unknown/u,
    );
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
    component.setShowImages(true);
    component.updateResult(
      {
        content: [
          {
            type: "image",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
            mimeType: "image/png",
          },
        ],
        details: undefined,
        isError: false,
      },
      false,
    );
    const imageRows = component.render(80);
    assert.ok(
      imageRows.some((row) => row.includes("\u001b_G")),
      "self shell still appends Pi-owned image components",
    );
    assert.match(
      imageRows.map(stripTerminalSequences).join("\n"),
      /Images: 1/u,
    );
    t.diagnostic(
      "new native SDK: loader/runner selects presentation-only resolver; native self shell retains images",
    );
  } finally {
    setCapabilities(capabilities);
    session?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
