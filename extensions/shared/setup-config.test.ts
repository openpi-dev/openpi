import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// getAgentDir() reads this at import time, so it must be set before the module
// under test is loaded.
const agentDir = mkdtempSync(join(tmpdir(), "my-pi-setup-config-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const {
  DEFAULT_SETUP_CONFIG,
  SETUP_CONFIG_PATH,
  loadSetupConfig,
  saveSetupConfig,
  updateSetupConfig,
} = await import("./setup-config.ts");

test("an unreadable config blocks the write and survives untouched", async () => {
  const corrupt = '{ "summaries": { "enabled": false }, oops\n';
  writeFileSync(SETUP_CONFIG_PATH, corrupt);

  // The loader still degrades to defaults so rendering paths never throw.
  assert.deepEqual(loadSetupConfig(), DEFAULT_SETUP_CONFIG);

  await assert.rejects(
    saveSetupConfig(DEFAULT_SETUP_CONFIG),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes(SETUP_CONFIG_PATH) &&
      error.message.includes("delete it"),
  );
  assert.equal(readFileSync(SETUP_CONFIG_PATH, "utf8"), corrupt);
});

test("a readable or absent config saves normally", async () => {
  const config = {
    ...DEFAULT_SETUP_CONFIG,
    summaries: { ...DEFAULT_SETUP_CONFIG.summaries, enabled: false },
  };

  writeFileSync(SETUP_CONFIG_PATH, "{}\n");
  await saveSetupConfig(config);
  assert.deepEqual(loadSetupConfig(), config);

  await saveSetupConfig(DEFAULT_SETUP_CONFIG);
  assert.deepEqual(loadSetupConfig(), DEFAULT_SETUP_CONFIG);
});

test("an update patches the document as it is on disk, not as it was read", async () => {
  await saveSetupConfig(DEFAULT_SETUP_CONFIG);

  // Another session changes a different field after this one loaded.
  const stale = loadSetupConfig();
  await saveSetupConfig({
    ...stale,
    workflows: { ...stale.workflows, concurrency: 17 },
  });

  const { config, replaced } = await updateSetupConfig((current) => ({
    ...current,
    summaries: { ...current.summaries, enabled: false },
  }));
  assert.equal(config.workflows.concurrency, 17);
  assert.equal(config.summaries.enabled, false);
  assert.deepEqual(replaced, []);
});

test("a stored value that had to be normalized is reported, not hidden", async () => {
  writeFileSync(
    SETUP_CONFIG_PATH,
    JSON.stringify({ workflows: { concurrency: "12" }, ui: { showHeader: 3 } }),
  );

  const { config, replaced } = await updateSetupConfig((current) => current);
  assert.equal(
    config.workflows.concurrency,
    DEFAULT_SETUP_CONFIG.workflows.concurrency,
  );
  assert.deepEqual(replaced.sort(), ["ui.showHeader", "workflows.concurrency"]);
});
