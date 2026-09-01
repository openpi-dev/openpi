import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SUBAGENT_ROLE_NAMES } from "../../../extensions/shared/subagent-roles.ts";
import {
  OPENPI_SETUP_EPISODE_CHANNEL,
  type OpenPiSetupEpisodeState,
} from "../../../extensions/shared/setup-episode-state.ts";
const setupAgentDir = mkdtempSync(join(tmpdir(), "openpi-setup-index-"));
process.env.PI_CODING_AGENT_DIR = setupAgentDir;

const {
  default: setupExtension,
  applySubagentRoleModelUpdates,
  buildInteractiveSetupPrompt,
  buildSetupNoopClosureText,
  buildSetupSuccessText,
  CONFIGURE_MY_PI_SETUP_TOOL_NAME,
  SUBAGENT_ROLE_MODELS_SCHEMA,
} = await import("../../../extensions/setup/index.ts");
const { SETUP_CONFIG_PATH, loadSetupConfig } = await import(
  "../../../extensions/shared/setup-config.ts"
);

after(() => rmSync(setupAgentDir, { recursive: true, force: true }));

type Handler = (
  event: Record<string, unknown>,
  ctx: ExtensionContext,
) => unknown;

interface CapturedSetupTool {
  readonly name: string;
  readonly parameters: unknown;
  readonly execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: unknown) => void,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
}

function visibilityHarness(
  options: {
    initialActive?: string[];
    mode?: ExtensionCommandContext["mode"];
    idle?: boolean;
    setupSourcePath?: string;
  } = {},
) {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
  >();
  const tools = new Map<string, CapturedSetupTool>();
  const handlers = new Map<string, Handler[]>();
  let activeTools = [
    ...(options.initialActive ?? ["read", "bash", "edit", "write"]),
  ];
  const userMessages: Array<{ content: unknown; options: unknown }> = [];
  const customMessages: Array<{ message: unknown; options: unknown }> = [];
  const setActiveCalls: string[][] = [];
  const setupEpisodeStates: OpenPiSetupEpisodeState[] = [];
  const notifications: Array<{ message: string; level: string | undefined }> =
    [];
  let idle = options.idle ?? true;
  let setupSourcePath = options.setupSourcePath;

  const pi = {
    events: {
      emit(channel: string, state: OpenPiSetupEpisodeState) {
        if (channel === OPENPI_SETUP_EPISODE_CHANNEL) {
          setupEpisodeStates.push(state);
        }
      },
    },
    registerCommand(
      name: string,
      command: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) {
      commands.set(name, command);
    },
    registerTool(tool: CapturedSetupTool) {
      tools.set(tool.name, tool);
      // Pi refreshTools() adds newly registered names to the active set.
      if (!activeTools.includes(tool.name)) {
        activeTools = [...activeTools, tool.name];
      }
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      setActiveCalls.push([...names]);
      activeTools = [...names];
    },
    getAllTools() {
      return [...tools.keys()].map((name) => ({
        name,
        ...(name === CONFIGURE_MY_PI_SETUP_TOOL_NAME && setupSourcePath
          ? {
              sourceInfo: {
                path: setupSourcePath,
                source: "extension",
              },
            }
          : {}),
      }));
    },
    getThinkingLevel() {
      return "off";
    },
    sendUserMessage(content: unknown, sendOptions?: unknown) {
      userMessages.push({ content, options: sendOptions });
    },
    sendMessage(message: unknown, sendOptions?: unknown) {
      customMessages.push({ message, options: sendOptions });
    },
  } as unknown as ExtensionAPI;

  setupExtension(pi);

  const ctx = {
    mode: options.mode ?? "rpc",
    hasUI: false,
    cwd: "/tmp/setup-visibility-test",
    isIdle: () => idle,
    model: undefined,
    ui: {
      confirm: async () => false,
      notify(message: string, level?: string) {
        notifications.push({ message, level });
      },
      setWorkingMessage() {},
    },
  } as unknown as ExtensionCommandContext & ExtensionContext;

  return {
    tools,
    commands,
    userMessages,
    customMessages,
    setActiveCalls,
    setupEpisodeStates,
    notifications,
    ctx,
    isActive() {
      return activeTools.includes(CONFIGURE_MY_PI_SETUP_TOOL_NAME);
    },
    activeNames() {
      return [...activeTools];
    },
    setActiveNames(names: string[]) {
      activeTools = [...names];
    },
    setupRequests() {
      return customMessages.filter(
        ({ message }) =>
          (message as { customType?: string }).customType ===
          "openpi-setup-request",
      );
    },
    closures() {
      return customMessages.filter(
        ({ message }) =>
          (message as { customType?: string }).customType ===
          "openpi-setup-closed",
      );
    },
    async emit(event: string, data: Record<string, unknown> = {}) {
      const results = [];
      for (const handler of handlers.get(event) ?? []) {
        results.push(await handler({ type: event, ...data }, ctx));
      }
      return results;
    },
    async runCommand(name: string, args = "") {
      const command = commands.get(name);
      assert.ok(command, `missing command ${name}`);
      await command.handler(args, ctx);
    },
    setIdle(value: boolean) {
      idle = value;
    },
    setSetupSourcePath(value: string) {
      setupSourcePath = value;
    },
  };
}

test("setup broadcasts its episode demand for interaction tools", async () => {
  const h = visibilityHarness();
  await h.emit("session_start");
  assert.deepEqual(h.setupEpisodeStates.at(-1), { active: false });

  await h.runCommand("openpi-setup", "调整 Footer");
  assert.deepEqual(h.setupEpisodeStates.at(-1), { active: true });
  await h.emit("agent_settled");
  assert.deepEqual(h.setupEpisodeStates.at(-1), { active: false });
});

test("registers the canonical setup command, legacy alias, and one constrained tool", () => {
  const h = visibilityHarness();
  assert.deepEqual([...h.commands.keys()].sort(), [
    "my-pi-setup",
    "openpi-setup",
  ]);
  assert.equal(h.tools.has(CONFIGURE_MY_PI_SETUP_TOOL_NAME), true);
  const parameters = h.tools.get(CONFIGURE_MY_PI_SETUP_TOOL_NAME)!
    .parameters as {
    properties: Record<string, unknown>;
  };
  assert.equal("suggestions_enabled" in parameters.properties, true);
  assert.equal("suggestion_model" in parameters.properties, true);
  assert.equal("capability_discovery" in parameters.properties, true);
  const postEdit = parameters.properties.post_edit_command as {
    description?: string;
  };
  assert.match(postEdit.description ?? "", /only when.*explicitly asks/i);
  assert.match(postEdit.description ?? "", /omit to preserve/i);
  assert.equal(
    Object.keys(parameters.properties).some((name) =>
      name.startsWith("summary"),
    ),
    false,
  );
});

test("post-edit stays off or preserved unless the setup request changes it", async () => {
  rmSync(SETUP_CONFIG_PATH, { force: true });
  const h = visibilityHarness();
  const tool = h.tools.get(CONFIGURE_MY_PI_SETUP_TOOL_NAME);
  assert.ok(tool);
  const apply = (params: Record<string, unknown>) =>
    tool.execute(
      "setup-call",
      params,
      new AbortController().signal,
      () => {},
      h.ctx,
    );

  await apply({ ui_show_header: true });
  assert.equal(loadSetupConfig().postEdit.command, "");

  await apply({ post_edit_command: "  npm run format  " });
  assert.equal(loadSetupConfig().postEdit.command, "npm run format");

  await apply({ workflow_concurrency: 4 });
  assert.equal(loadSetupConfig().postEdit.command, "npm run format");

  await apply({ post_edit_command: "" });
  assert.equal(loadSetupConfig().postEdit.command, "");
});

test("legacy ui_footer_items stays an input adapter and persists only footerLines", async () => {
  rmSync(SETUP_CONFIG_PATH, { force: true });
  const h = visibilityHarness();
  const tool = h.tools.get(CONFIGURE_MY_PI_SETUP_TOOL_NAME);
  assert.ok(tool);

  await tool.execute(
    "setup-footer-call",
    { ui_footer_items: ["model", "cache", "git"] },
    new AbortController().signal,
    () => {},
    h.ctx,
  );

  assert.deepEqual(loadSetupConfig().ui.footerLines, [
    ["model", "cache", "flex", "git"],
  ]);
  const stored = JSON.parse(readFileSync(SETUP_CONFIG_PATH, "utf8"));
  assert.equal("footerItems" in stored.ui, false);
});

test("session_start hides configure_my_pi_setup after registration refresh", async () => {
  const h = visibilityHarness();
  assert.equal(h.isActive(), true, "registerTool refresh activates the tool");
  await h.emit("session_start");
  assert.equal(h.isActive(), false);
  assert.equal(h.tools.has(CONFIGURE_MY_PI_SETUP_TOOL_NAME), true);
});

test("openpi-setup and my-pi-setup expose the tool then inject the setup message", async () => {
  for (const name of ["openpi-setup", "my-pi-setup"] as const) {
    const h = visibilityHarness();
    await h.emit("session_start");
    assert.equal(h.isActive(), false);
    await h.runCommand(name, "关闭下一步预测");
    assert.equal(h.isActive(), true);
    assert.deepEqual(h.setupRequests()[0]?.options, { triggerTurn: true });
    const content = (h.setupRequests()[0]?.message as { content?: unknown })
      .content;
    assert.match(String(content), /关闭下一步预测/);
    assert.match(String(content), /available only for this setup run/i);
    assert.match(String(content), /\/openpi-setup <request>/);
    assert.doesNotMatch(String(content), /intercom/i);
    assert.deepEqual(h.userMessages, []);
  }
});

test("setup activation fails closed for a foreign same-name writer", async () => {
  const h = visibilityHarness({
    setupSourcePath: "<foreign:configure_my_pi_setup>",
  });
  await h.emit("session_start");

  await assert.rejects(
    h.runCommand("openpi-setup", "关闭下一步预测"),
    /could not find its owned configuration writer/i,
  );

  assert.equal(
    h.isActive(),
    true,
    "OpenPI must preserve the foreign namesake while refusing setup",
  );
  assert.deepEqual(h.userMessages, []);
  assert.deepEqual(h.setupEpisodeStates.at(-1), { active: false });
});

test("successful configure_my_pi_setup hides the tool", async () => {
  const h = visibilityHarness();
  await h.emit("session_start");
  await h.runCommand("openpi-setup", "关闭下一步预测");
  assert.equal(h.isActive(), true);
  await h.emit("tool_execution_end", {
    toolCallId: "configure-1",
    toolName: CONFIGURE_MY_PI_SETUP_TOOL_NAME,
    isError: false,
  });
  assert.equal(
    h.isActive(),
    true,
    "unadmitted results cannot close the episode",
  );
  await h.emit("tool_call", {
    toolCallId: "configure-1",
    toolName: CONFIGURE_MY_PI_SETUP_TOOL_NAME,
    input: {},
  });
  await h.emit("tool_execution_end", {
    toolCallId: "configure-1",
    toolName: CONFIGURE_MY_PI_SETUP_TOOL_NAME,
    isError: false,
  });
  assert.equal(h.isActive(), false);
  await h.emit("agent_settled");
  assert.deepEqual(h.closures(), []);
});

test("successful setup result closes the episode and names the only re-entry", () => {
  const result = buildSetupSuccessText(
    "Capability discovery: explicit.",
    " Normalized or migrated stored values: ui.footerStyle.",
  );

  assert.match(result, /Updated OpenPI setup/);
  assert.match(result, /Capability discovery: explicit/);
  assert.match(result, /Normalized or migrated.*ui\.footerStyle/);
  assert.match(result, /setup episode is complete/i);
  assert.match(result, /configure_my_pi_setup.*hidden/i);
  assert.match(result, /do not call it again/i);
  assert.match(result, /do not edit.*configuration files/i);
  assert.match(result, /\/openpi-setup <request>/);
});

test("no-op setup result records the bounded re-entry contract", () => {
  const result = buildSetupNoopClosureText();

  assert.match(result, /no configuration update was confirmed/i);
  assert.match(result, /now hidden/i);
  assert.match(result, /\/openpi-setup <request>/);
  assert.match(result, /do not edit configuration files directly/i);
});

test("keep-without-apply hides after the setup agent run settles", async () => {
  const h = visibilityHarness();
  await h.emit("session_start");
  await h.runCommand("openpi-setup", "");
  assert.equal(h.isActive(), true);
  await h.emit("agent_settled");
  assert.equal(h.isActive(), false);
  assert.equal(h.closures().length, 1);
  assert.equal(h.closures()[0]?.options, undefined);
  assert.deepEqual(h.closures()[0]?.message, {
    customType: "openpi-setup-closed",
    content: buildSetupNoopClosureText(),
    display: true,
    details: { reason: "settled_without_successful_apply" },
  });
  assert.equal(
    h.userMessages.length,
    0,
    "closure must not trigger a user turn",
  );
});

test("busy follow-up keeps the writer hidden until its request is delivered", async () => {
  const h = visibilityHarness({ idle: false });
  await h.emit("session_start");
  await h.runCommand("openpi-setup", "切换 Footer 为 powerline");
  assert.deepEqual(h.setupRequests(), []);
  assert.equal(h.isActive(), false);
  // Retry/continuation events from the prior run cannot expose the writer.
  await h.emit("agent_start");
  assert.equal(h.isActive(), false);
  await h.emit("agent_settled");
  assert.deepEqual(h.setupRequests()[0]?.options, { triggerTurn: true });
  assert.equal(h.isActive(), true);
  await h.emit("agent_settled");
  assert.equal(h.isActive(), false);
});

test("queued setup fails closed if writer provenance changes before delivery", async () => {
  const h = visibilityHarness({ idle: false });
  await h.emit("session_start");
  await h.runCommand("openpi-setup", "切换 Footer 为 powerline");
  h.setSetupSourcePath("<foreign:configure_my_pi_setup>");
  h.setActiveNames([...h.activeNames(), CONFIGURE_MY_PI_SETUP_TOOL_NAME]);

  await h.emit("agent_settled");

  assert.deepEqual(h.setupRequests(), []);
  assert.equal(h.isActive(), true, "the foreign namesake must be preserved");
  assert.deepEqual(h.setupEpisodeStates.at(-1), { active: false });
  assert.deepEqual(h.notifications, []);
  assert.deepEqual(h.closures()[0]?.options, undefined);
  assert.match(
    String(
      (h.closures()[0]?.message as { content?: unknown } | undefined)?.content,
    ),
    /setup was not started/i,
  );
});

test("one setup episode admits one writer call at a time and permits retry after failure", async () => {
  const h = visibilityHarness();
  await h.emit("session_start");
  await h.runCommand("openpi-setup", "关闭下一步预测");

  const first = await h.emit("tool_call", {
    toolCallId: "",
    toolName: CONFIGURE_MY_PI_SETUP_TOOL_NAME,
    input: {},
  });
  const parallel = await h.emit("tool_call", {
    toolCallId: "",
    toolName: CONFIGURE_MY_PI_SETUP_TOOL_NAME,
    input: {},
  });
  assert.deepEqual(first, [undefined]);
  assert.deepEqual(parallel, [
    {
      block: true,
      reason:
        "This setup episode already admitted one configure_my_pi_setup call. Wait for its result before retrying.",
    },
  ]);

  await h.emit("tool_execution_end", {
    toolCallId: "",
    toolName: CONFIGURE_MY_PI_SETUP_TOOL_NAME,
    isError: true,
  });
  const prematureRetry = await h.emit("tool_call", {
    toolCallId: "apply-3",
    toolName: CONFIGURE_MY_PI_SETUP_TOOL_NAME,
    input: {},
  });
  assert.equal(
    (prematureRetry[0] as { block?: boolean } | undefined)?.block,
    true,
  );
  await h.emit("tool_execution_end", {
    toolCallId: "",
    toolName: CONFIGURE_MY_PI_SETUP_TOOL_NAME,
    isError: true,
  });
  const retry = await h.emit("tool_call", {
    toolCallId: "apply-3",
    toolName: CONFIGURE_MY_PI_SETUP_TOOL_NAME,
    input: {},
  });
  assert.deepEqual(retry, [undefined]);
  await h.emit("tool_execution_end", {
    toolCallId: "apply-3",
    toolName: CONFIGURE_MY_PI_SETUP_TOOL_NAME,
    isError: false,
  });
  assert.equal(h.isActive(), false);
});

test("overlapping openpi-setup follow-up survives the prior apply", async () => {
  const h = visibilityHarness();
  await h.emit("session_start");
  await h.runCommand("openpi-setup", "关闭下一步预测");
  h.setIdle(false);
  await h.runCommand("openpi-setup", "开启下一步预测");
  assert.equal(h.setupRequests().length, 1);
  assert.equal(h.isActive(), true);
  await h.emit("tool_call", {
    toolCallId: "first-apply",
    toolName: CONFIGURE_MY_PI_SETUP_TOOL_NAME,
    input: {},
  });
  await h.emit("tool_execution_end", {
    toolCallId: "first-apply",
    toolName: CONFIGURE_MY_PI_SETUP_TOOL_NAME,
    isError: false,
  });
  assert.equal(h.isActive(), false);
  await h.emit("agent_settled");
  assert.equal(h.setupRequests().length, 2);
  assert.deepEqual(h.setupRequests()[1]?.options, { triggerTurn: true });
  assert.equal(h.isActive(), true);
  await h.emit("agent_settled");
  assert.equal(h.isActive(), false);
});

test("a second openpi-setup after hide re-exposes via get+add", async () => {
  const h = visibilityHarness({
    initialActive: ["read", "bash", "ask_user", "workflow"],
  });
  await h.emit("session_start");
  await h.runCommand("openpi-setup", "关闭下一步预测");
  await h.emit("agent_settled");
  assert.equal(h.isActive(), false);

  const beforeSecond = h.setActiveCalls.length;
  await h.runCommand("openpi-setup", "开启下一步预测");
  assert.equal(h.isActive(), true);
  const last = h.setActiveCalls.at(-1);
  assert.ok(last);
  assert.ok(last.includes("ask_user"));
  assert.ok(last.includes("workflow"));
  assert.ok(last.includes(CONFIGURE_MY_PI_SETUP_TOOL_NAME));
  assert.ok(h.setActiveCalls.length > beforeSecond);
});

test("session_start after host re-includes tools hides configure tool", async () => {
  let activeTools = ["read", "bash", CONFIGURE_MY_PI_SETUP_TOOL_NAME];
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, { name: string }>();
  const pi = {
    events: { emit() {} },
    registerCommand() {},
    registerTool(tool: { name: string; parameters: unknown }) {
      tools.set(tool.name, tool);
      if (!activeTools.includes(tool.name)) {
        activeTools = [...activeTools, tool.name];
      }
    },
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    getAllTools() {
      return [...tools.keys()].map((name) => ({ name }));
    },
    getThinkingLevel() {
      return "off";
    },
    sendUserMessage() {},
  } as unknown as ExtensionAPI;
  setupExtension(pi);
  // Host reload includes all extension tools.
  activeTools = [
    "read",
    "bash",
    "edit",
    "write",
    CONFIGURE_MY_PI_SETUP_TOOL_NAME,
  ];
  const ctx = { mode: "rpc", hasUI: false } as unknown as ExtensionContext;
  for (const handler of handlers.get("session_start") ?? []) {
    await handler({ type: "session_start" }, ctx);
  }
  assert.equal(activeTools.includes(CONFIGURE_MY_PI_SETUP_TOOL_NAME), false);
  assert.equal(tools.has(CONFIGURE_MY_PI_SETUP_TOOL_NAME), true);
});

test("setActiveTools never snapshot-restores unrelated tools away", async () => {
  const h = visibilityHarness({
    initialActive: ["read", "bash", "ask_user", "workflow", "fd"],
  });
  await h.emit("session_start");
  assert.deepEqual(h.activeNames().sort(), [
    "ask_user",
    "bash",
    "fd",
    "read",
    "workflow",
  ]);
  await h.runCommand("openpi-setup", "x");
  assert.deepEqual(h.activeNames().sort(), [
    "ask_user",
    "bash",
    CONFIGURE_MY_PI_SETUP_TOOL_NAME,
    "fd",
    "read",
    "workflow",
  ]);
  await h.emit("agent_settled");
  assert.deepEqual(h.activeNames().sort(), [
    "ask_user",
    "bash",
    "fd",
    "read",
    "workflow",
  ]);
});

test("failed configure_my_pi_setup stays visible until the setup run settles", async () => {
  const h = visibilityHarness();
  await h.emit("session_start");
  await h.runCommand("openpi-setup", "关闭下一步预测");
  await h.emit("tool_call", {
    toolCallId: "failed-apply",
    toolName: CONFIGURE_MY_PI_SETUP_TOOL_NAME,
    input: {},
  });
  await h.emit("tool_execution_end", {
    toolCallId: "failed-apply",
    toolName: CONFIGURE_MY_PI_SETUP_TOOL_NAME,
    isError: true,
  });
  assert.equal(h.isActive(), true);
  await h.emit("agent_settled");
  assert.equal(h.isActive(), false);
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
  assert.match(message, /Capability discovery/);
  assert.match(message, /explicit.*adaptive/);
  assert.match(message, /adaptive.*opt-in/);
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
  assert.match(message, /all three default to compact/);
  assert.match(message, /Recommend compact/);
  assert.match(message, /Post-edit defaults off/);
  assert.match(message, /Agent role models/);
  assert.doesNotMatch(message, /intercom/i);
  assert.match(message, /explorer, implementer, reviewer, and advisor/);
  assert.match(message, /subagent_spawn and workflow agent_type/);
  assert.match(message, /subagent_role_models=\{explorer/);
  assert.match(message, /maximum 500 characters/);
  assert.match(message, /successful Write\/Edit operations/);
  assert.match(message, /post_edit_command="npm run format"/);
  assert.match(message, /call configure_my_pi_setup at most once/);
  assert.match(message, /available only for this setup run/i);
  assert.match(message, /\/openpi-setup <request>/);
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
    /keep them or change Capability discovery, Next-action suggestions, Workflow limits, UI\/Footer, result detail display, Post-edit, Agent role models/,
  );
  assert.match(message, /keeps the current settings, do not call/);
  assert.match(message, /available only for this setup run/i);
  assert.match(message, /\/openpi-setup <request>/);
  assert.doesNotMatch(message, /This is the first setup/);
});
