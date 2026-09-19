import assert from "node:assert/strict";
import test from "node:test";
import { parseSetupConfig } from "../../extensions/shared/setup-config.ts";
import {
  projectWebSettingsResources,
  projectWebSetupConfig,
} from "../../web/runtime/settings-catalog.ts";

const packageSource = {
  source: "openpi",
  scope: "user" as const,
  origin: "package" as const,
  baseDir: "/packages/openpi",
};

test("projects bounded Pi resources into the settings catalog", () => {
  const catalog = projectWebSettingsResources({
    getExtensions: () => ({
      extensions: [
        {
          path: "/packages/openpi/extensions/setup/index.ts",
          sourceInfo: packageSource,
          tools: new Map([["configure_my_pi_setup", {}]]),
          commands: new Map([["openpi-setup", {}]]),
        },
        {
          hidden: true,
          path: "/packages/openpi/extensions/hidden/index.ts",
          sourceInfo: packageSource,
          tools: new Map(),
          commands: new Map(),
        },
      ],
      errors: [new Error("fixture extension warning")],
    }),
    getSkills: () => ({
      skills: [
        {
          name: "subagents",
          description: "Delegate a bounded task.",
          filePath: "/packages/openpi/skills/subagents/SKILL.md",
          sourceInfo: packageSource,
          disableModelInvocation: false,
        },
      ],
      diagnostics: [],
    }),
    getPrompts: () => ({
      prompts: [{ name: "review", sourceInfo: packageSource }],
    }),
    getThemes: () => ({
      themes: [{ name: "openpi", sourceInfo: packageSource }],
    }),
  });

  assert.equal(catalog.skills.length, 1);
  assert.equal(catalog.skills[0]?.name, "subagents");
  assert.equal(catalog.plugins.length, 1);
  assert.deepEqual(catalog.plugins[0]?.extensions, [
    {
      name: "setup",
      path: "/packages/openpi/extensions/setup/index.ts",
      toolCount: 1,
      commandCount: 1,
    },
  ]);
  assert.deepEqual(catalog.plugins[0]?.prompts, ["review"]);
  assert.deepEqual(catalog.plugins[0]?.themes, ["openpi"]);
  assert.deepEqual(catalog.totals, {
    extensions: 1,
    skills: 1,
    prompts: 1,
    themes: 1,
  });
  assert.deepEqual(catalog.diagnostics, {
    extensionErrors: 1,
    skillErrors: 0,
  });
});

test("projects canonical Web appearance values without exposing the post-edit command", () => {
  const projection = projectWebSetupConfig(
    parseSetupConfig({
      ui: {
        webTheme: "pine",
        webChatWidth: 960,
        webChatFontSize: 16,
        webExpandThinking: true,
      },
      postEdit: { command: "npm run format" },
    }),
  );

  assert.deepEqual(
    {
      webTheme: projection.ui.webTheme,
      webChatWidth: projection.ui.webChatWidth,
      webChatFontSize: projection.ui.webChatFontSize,
      webExpandThinking: projection.ui.webExpandThinking,
    },
    {
      webTheme: "pine",
      webChatWidth: 960,
      webChatFontSize: 16,
      webExpandThinking: true,
    },
  );
  assert.equal(projection.postEditConfigured, true);
  assert.equal("command" in projection, false);
});
