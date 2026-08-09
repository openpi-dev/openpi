import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_ROLE_NAMES } from "../shared/subagent-roles.ts";
import setupExtension, {
  applySubagentRoleModelUpdates,
  buildInteractiveSetupPrompt,
  SUBAGENT_ROLE_MODELS_SCHEMA,
} from "./index.ts";

test("registers one natural-language setup command and one constrained tool", () => {
  const commands = new Set<string>();
  const tools = new Set<string>();
  let parameterNames: string[] = [];
  const api = {
    registerCommand: (name: string) => commands.add(name),
    registerTool: (tool: { name: string; parameters: unknown }) => {
      tools.add(tool.name);
      parameterNames = Object.keys(
        (tool.parameters as { properties: Record<string, unknown> }).properties,
      );
    },
  } as unknown as ExtensionAPI;

  setupExtension(api);

  assert.deepEqual(commands, new Set(["my-pi-setup"]));
  assert.deepEqual(tools, new Set(["configure_my_pi_setup"]));
  assert.equal(parameterNames.includes("suggestions_enabled"), true);
  assert.equal(parameterNames.includes("suggestion_model"), true);
  assert.equal(
    parameterNames.some((name) => name.startsWith("summary")),
    false,
  );
});

test("the role-model schema exposes every built-in role as an optional property", () => {
  const schema = SUBAGENT_ROLE_MODELS_SCHEMA as unknown as {
    readonly properties: Record<
      string,
      { readonly anyOf: readonly { readonly additionalProperties?: boolean }[] }
    >;
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean;
  };
  assert.deepEqual(Object.keys(schema.properties), [...SUBAGENT_ROLE_NAMES]);
  assert.equal(schema.required, undefined);
  assert.equal(schema.additionalProperties, false);
  assert.equal(
    schema.properties.explorer?.anyOf[0]?.additionalProperties,
    false,
  );
});

test("builds a model-guided first-run setup prompt with impacts", () => {
  const message = buildInteractiveSetupPrompt({
    currentConfiguration: "Next-action suggestions: disabled",
    currentModel: "seal/gpt-5.6-sol",
    currentThinking: "high",
    savedConfigExists: false,
  }).join("\n");

  assert.match(message, /This is the first setup/);
  assert.match(message, /Use ask_user/);
  assert.match(message, /Current Pi model: seal\/gpt-5\.6-sol/);
  assert.match(message, /dim inline text on the first row/);
  assert.match(message, /reserved cells.*CJK IME preedit/);
  assert.match(message, /Right accepts it without submitting/);
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
  assert.match(message, /Agent role models/);
  assert.match(message, /explorer, implementer, reviewer, and advisor/);
  assert.match(message, /subagent_spawn and workflow agent_type/);
  assert.match(message, /subagent_role_models=\{explorer/);
  assert.match(message, /maximum 500 characters/);
  assert.match(message, /successful Write\/Edit operations/);
  assert.match(message, /post_edit_command="npm run format"/);
  assert.match(message, /call configure_my_pi_setup at most once/);
});

test("partially assigns and clears validated subagent role models", () => {
  const registry = (provider: string, model: string) =>
    provider === "input" && model === "requested"
      ? { provider: "canonical", id: "resolved" }
      : undefined;

  const assigned = applySubagentRoleModelUpdates(
    { explorer: { provider: "old", model: "old-model" } },
    {
      explorer: { provider: "input", model: "requested" },
      advisor: { provider: "input", model: "requested" },
    },
    registry,
  );
  assert.deepEqual(assigned, {
    explorer: { provider: "canonical", model: "resolved" },
    advisor: { provider: "canonical", model: "resolved" },
  });

  assert.deepEqual(
    applySubagentRoleModelUpdates(assigned, { explorer: null }, registry),
    { advisor: { provider: "canonical", model: "resolved" } },
  );
  assert.throws(
    () =>
      applySubagentRoleModelUpdates(
        {},
        { reviewer: { provider: "unknown", model: "missing" } },
        registry,
      ),
    /Unknown configured subagent role model for reviewer: unknown\/missing/,
  );
});

test("builds a focused review prompt when configuration already exists", () => {
  const message = buildInteractiveSetupPrompt({
    currentConfiguration:
      "Next-action suggestions: seal/deepseek-v4-flash · off · Right accepts\nWorkflows: 8 concurrent agents · 128 total calls",
    currentModel: "seal/gpt-5.6-sol",
    currentThinking: "high",
    savedConfigExists: true,
  }).join("\n");

  assert.match(message, /already been configured/);
  assert.match(message, /Explain the current settings/);
  assert.match(
    message,
    /keep them or change Next-action suggestions, Workflow limits, UI\/Footer, result detail display, Post-edit, Agent role models/,
  );
  assert.match(message, /keeps the current settings, do not call/);
  assert.doesNotMatch(message, /This is the first setup/);
});
