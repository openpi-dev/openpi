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
