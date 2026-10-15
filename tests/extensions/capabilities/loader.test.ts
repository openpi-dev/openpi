import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

test("capabilities load through Pi's native extension loader and SDK aliases", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "openpi-capabilities-loader-"));
  const agentDir = path.join(cwd, "agent");
  const extensionPath = fileURLToPath(
    new URL("../../../extensions/capabilities/index.ts", import.meta.url),
  );
  try {
    await mkdir(agentDir);
    // Do not import the factory directly: native Jiti package aliases are part
    // of the installed loading contract and differ from Node's direct imports.
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory(undefined, {
        projectTrusted: false,
      }),
      additionalExtensionPaths: [extensionPath],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const capabilities = loaded.extensions.find(
      (extension) => extension.resolvedPath === extensionPath,
    );
    assert.ok(capabilities, "the requested source extension was loaded");
    assert.ok(capabilities.tools.has("openpi_load_tools"));
    assert.ok(capabilities.handlers.has("session_start"));
    assert.ok(capabilities.handlers.has("before_agent_start"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
