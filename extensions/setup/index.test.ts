import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import setupExtension, { buildInteractiveSetupPrompt } from "./index.ts";

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

test("builds a model-guided first-run setup prompt with impacts", () => {
  const message = buildInteractiveSetupPrompt({
    currentConfiguration: "Run recaps: disabled",
    currentModel: "seal/gpt-5.6-sol",
    currentThinking: "high",
    savedConfigExists: false,
  }).join("\n");

  assert.match(message, /This is the first setup/);
  assert.match(message, /Use ask_user/);
  assert.match(message, /Current Pi model: seal\/gpt-5\.6-sol/);
  assert.match(message, /local fallback.*mechanical output/);
  assert.match(message, /concurrency controls simultaneous agents/);
  assert.match(message, /large header costs vertical space/);
  assert.match(message, /powerline.*powerline-mono.*compact/);
  assert.match(message, /Nerd Font/);
  assert.match(message, /ui_footer_preset=powerline/);
  assert.match(message, /activity.*core status/);
  assert.match(message, /Result detail display/);
  assert.match(message, /Bash and Write\/Edit default to compact/);
  assert.match(message, /Recommend compact/);
  assert.match(message, /Post-edit defaults off/);
  assert.match(message, /maximum 500 characters/);
  assert.match(message, /successful Write\/Edit operations/);
  assert.match(message, /post_edit_command="npm run format"/);
  assert.match(message, /call configure_my_pi_setup at most once/);
});

test("builds a focused review prompt when configuration already exists", () => {
  const message = buildInteractiveSetupPrompt({
    currentConfiguration:
      "Run recaps: seal/deepseek-v4-flash · off\nWorkflows: 8 concurrent agents · 128 total calls",
    currentModel: "seal/gpt-5.6-sol",
    currentThinking: "high",
    savedConfigExists: true,
  }).join("\n");

  assert.match(message, /already been configured/);
  assert.match(message, /Explain the current settings/);
  assert.match(
    message,
    /keep them or change Recaps, Workflow limits, UI\/Footer, result detail display, Post-edit/,
  );
  assert.match(message, /keeps the current settings, do not call/);
  assert.doesNotMatch(message, /This is the first setup/);
});
