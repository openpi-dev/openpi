import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import setupExtension, {
  buildInteractiveSetupPrompt,
  shouldStartInteractiveSetup,
} from "./index.ts";

test("registers one natural-language setup command and one constrained tool", () => {
  const commands = new Set<string>();
  const tools = new Set<string>();
  const api = {
    registerCommand: (name: string) => commands.add(name),
    registerTool: (tool: { name: string }) => tools.add(tool.name),
  } as unknown as ExtensionAPI;

  setupExtension(api);

  assert.deepEqual(commands, new Set(["my-pi-setup"]));
  assert.deepEqual(tools, new Set(["configure_my_pi_setup"]));
});

test("only starts the interactive wizard before the first saved setup", () => {
  assert.equal(shouldStartInteractiveSetup("", false), true);
  assert.equal(shouldStartInteractiveSetup("", true), false);
  assert.equal(shouldStartInteractiveSetup("显示大标题", false), false);
  assert.equal(shouldStartInteractiveSetup("显示大标题", true), false);
});

test("builds a model-guided first-run setup prompt", () => {
  const message = buildInteractiveSetupPrompt({
    currentConfiguration: "Run recaps: disabled",
    currentModel: "seal/gpt-5.6-sol",
    currentThinking: "high",
  }).join("\n");

  assert.match(message, /Guide me through configuring/);
  assert.match(message, /Use ask_user/);
  assert.match(message, /Current Pi model: seal\/gpt-5\.6-sol/);
  assert.match(message, /Current Pi thinking level: high/);
  assert.match(message, /cache hit rate/);
  assert.match(message, /which footer metrics to show/);
  assert.match(message, /activity is core operational status/);
  assert.match(message, /call configure_my_pi_setup once/);
});
