import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import setupExtension from "./index.ts";

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

test("starts an interactive model-guided setup when invoked without arguments", async () => {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let message = "";
  const api = {
    registerTool: () => undefined,
    registerCommand: (
      _name: string,
      command: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => {
      handler = command.handler;
    },
    getThinkingLevel: () => "high",
    sendUserMessage: (text: string) => {
      message = text;
    },
  } as unknown as ExtensionAPI;

  setupExtension(api);
  assert.ok(handler);
  await handler("", {
    isIdle: () => true,
    model: { provider: "seal", id: "gpt-5.6-sol" },
  });

  assert.match(message, /Guide me through configuring/);
  assert.match(message, /Use ask_user/);
  assert.match(message, /Current Pi model: seal\/gpt-5\.6-sol/);
  assert.match(message, /Current Pi thinking level: high/);
  assert.match(message, /call configure_my_pi_setup once/);
});
