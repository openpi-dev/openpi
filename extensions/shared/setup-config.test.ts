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
    suggestions: { ...DEFAULT_SETUP_CONFIG.suggestions, enabled: false },
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
    suggestions: { ...current.suggestions, enabled: false },
  }));
  assert.equal(config.workflows.concurrency, 17);
  assert.equal(config.suggestions.enabled, false);
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

test("legacy model-free recaps are explicitly migrated to disabled suggestions", async () => {
  writeFileSync(
    SETUP_CONFIG_PATH,
    JSON.stringify({ summaries: { enabled: true } }),
  );

  const { config, replaced } = await updateSetupConfig((current) => current);

  assert.deepEqual(config.suggestions, { enabled: false });
  assert.deepEqual(replaced, ["summaries → suggestions"]);
  const stored = JSON.parse(readFileSync(SETUP_CONFIG_PATH, "utf8")) as Record<
    string,
    unknown
  >;
  assert.equal("summaries" in stored, false);
  assert.deepEqual(stored.suggestions, { enabled: false });
});

test("the post-edit command is off by default, trimmed, and length-bounded", () => {
  // Off by default: nothing executes until the user configures a command.
  assert.equal(DEFAULT_SETUP_CONFIG.postEdit.command, "");

  writeFileSync(
    SETUP_CONFIG_PATH,
    JSON.stringify({ postEdit: { command: "  npm run format  " } }),
  );
  assert.equal(loadSetupConfig().postEdit.command, "npm run format");

  // A malformed block degrades to off rather than to something executable.
  writeFileSync(SETUP_CONFIG_PATH, JSON.stringify({ postEdit: 42 }));
  assert.equal(loadSetupConfig().postEdit.command, "");

  writeFileSync(
    SETUP_CONFIG_PATH,
    JSON.stringify({ postEdit: { command: "x".repeat(900) } }),
  );
  assert.equal(loadSetupConfig().postEdit.command.length, 500);
});
