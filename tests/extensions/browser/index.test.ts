import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toolExecutionContext } from "../../support/extension-tool-context.ts";

const directory = mkdtempSync(join(tmpdir(), "openpi-browser-projection-"));
process.env.PI_CODING_AGENT_DIR = directory;
const {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} = await import("@earendil-works/pi-coding-agent");
const { applySetupConfiguration } = await import(
  "../../../extensions/shared/setup-apply.ts"
);
after(() => rmSync(directory, { recursive: true, force: true }));

test("native Pi browser tool is absent by default, exposed by setup apply, and revoked when disabled", async () => {
  let controller: ExtensionAPI | undefined;
  const settingsManager = SettingsManager.inMemory(undefined, {
    projectTrusted: false,
  });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    additionalExtensionPaths: [
      fileURLToPath(
        new URL("../../../extensions/browser/index.ts", import.meta.url),
      ),
    ],
    extensionFactories: [
      (pi) => {
        controller = pi;
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(directory),
  });
  try {
    await session.bindExtensions({ mode: "print" });
    const ordinary = ["read", "bash", "edit", "write"];
    assert.deepEqual(session.getActiveToolNames(), ordinary);
    const definition = session.getToolDefinition("openpi_browser");
    assert.ok(definition);
    const context = toolExecutionContext(
      session.createReplacedSessionContext(),
    );
    await assert.rejects(
      definition.execute(
        "off",
        { operation: "tabs" },
        undefined,
        undefined,
        context,
      ),
      /control is off/,
    );
    assert.ok(controller);
    writeFileSync(
      join(directory, "my-pi-setup.json"),
      JSON.stringify({ browser: { control: true } }),
    );
    await applySetupConfiguration(controller);
    assert.deepEqual(session.getActiveToolNames(), [
      ...ordinary,
      "openpi_browser",
    ]);
    await assert.rejects(
      definition.execute(
        "unbound",
        { operation: "tabs" },
        undefined,
        undefined,
        context,
      ),
      /unavailable in this Session/,
    );
    writeFileSync(
      join(directory, "my-pi-setup.json"),
      JSON.stringify({ browser: { control: false } }),
    );
    await applySetupConfiguration(controller);
    assert.deepEqual(session.getActiveToolNames(), ordinary);
  } finally {
    session.dispose();
  }
});
