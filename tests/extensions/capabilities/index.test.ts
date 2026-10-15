import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SETUP_APPLY_CHANNEL } from "../../../extensions/shared/setup-apply.ts";
import {
  OPENPI_TOOL_SURFACE,
  patchOwnedTools,
} from "../../../extensions/shared/tool-surface.ts";
import { createCapabilitiesExtension } from "../../../extensions/capabilities/index.ts";
import runtimeSnapshot from "../../../extensions/runtime-snapshot/index.ts";

const SUBAGENT_SKILL_PATH_PATTERN =
  /skills(?:\\\\|[\\/])subagents(?:\\\\|[\\/])SKILL\.md/;

type StartInput =
  | { prompt: string }
  | { messageType: "custom"; message: { content: string } };

interface CapturedTool {
  name: string;
  description: string;
  parameters: unknown;
  defaultActive?: boolean;
  promptGuidelines?: string[];
  execute(
    toolCallId: string,
    params: { groups?: string[] },
  ): Promise<{
    content: { type: "text"; text: string }[];
    details: {
      loaded: string[];
      newlyLoaded: string[];
      activatedTools: string[];
    };
  }>;
}

function harness(
  options: { discovery?: "explicit" | "adaptive"; runtimeFirst?: boolean } = {},
) {
  let discovery = options.discovery ?? "explicit";
  const available = [
    "read",
    "bash",
    "edit",
    "write",
    "openpi_load_tools",
    "runtime_snapshot",
    "fd",
    "rg",
    "subagent_spawn",
    "subagent_wait",
    "subagent_cancel",
    "subagent_send",
    "subagent_check",
    "subagent_list",
    "workflow",
    "workflow_stop",
    "workflow_status",
    "bg_start",
    "bg_status",
    "bg_list",
    "bg_kill",
    "bg_watch",
    "git_show",
    "git_diff",
    "git_log",
  ];
  let active = [...available];
  const tools = new Map<string, CapturedTool>();
  const starts: Array<(event: unknown, ctx: ExtensionContext) => void> = [];
  const beforeStarts: ((event: StartInput) => unknown)[] = [];
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  const pi = {
    events: {
      on(channel: string, handler: (data: unknown) => void) {
        const handlers = eventHandlers.get(channel) ?? new Set();
        handlers.add(handler);
        eventHandlers.set(channel, handlers);
        return () => handlers.delete(handler);
      },
      emit(channel: string, data: unknown) {
        for (const handler of eventHandlers.get(channel) ?? []) handler(data);
      },
    },
    on(
      event: string,
      handler: (() => void) | ((event: StartInput) => unknown),
    ) {
      if (event === "session_start") {
        starts.push(handler as (event: unknown, ctx: ExtensionContext) => void);
      }
      if (event === "before_agent_start") {
        beforeStarts.push(handler as (event: StartInput) => unknown);
      }
    },
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
      if (tool.defaultActive === false) {
        active = active.filter((name) => name !== tool.name);
      }
    },
    getActiveTools: () => [...active],
    getAllTools: () => available.map((name) => ({ name })),
    setActiveTools(names: string[]) {
      active = [...names];
    },
  };
  const extension = createCapabilitiesExtension({
    loadConfig: () => ({ capabilities: { discovery } }),
  });
  if (options.runtimeFirst) runtimeSnapshot(pi as unknown as ExtensionAPI);
  extension(pi as unknown as ExtensionAPI);
  if (!options.runtimeFirst) runtimeSnapshot(pi as unknown as ExtensionAPI);
  starts.push(() => {
    patchOwnedTools(pi, "fileSearch", {
      enable: OPENPI_TOOL_SURFACE.fileSearch.entry,
    });
    patchOwnedTools(pi, "gitRead", {
      enable: OPENPI_TOOL_SURFACE.gitRead.entry,
    });
    patchOwnedTools(pi, "subagents", {
      enable: OPENPI_TOOL_SURFACE.subagents.entry,
    });
    // The real extensions disable their deferred lifecycle tools on
    // session_start (hideLifecycleTools); replicate that so the harness
    // matches production wiring and tools only appear via capability loads.
    patchOwnedTools(pi, "workflows", {
      disable: OPENPI_TOOL_SURFACE.workflows.deferred,
    });
    patchOwnedTools(pi, "background", {
      disable: OPENPI_TOOL_SURFACE.background.deferred,
    });
  });
  return {
    active: () => [...active],
    start: () => {
      const ctx = { mode: "json" } as ExtensionContext;
      for (const handler of starts) handler({}, ctx);
    },
    before: (prompt: string) => {
      return beforeStarts.map((handler) => handler({ prompt }));
    },
    beforeCustom: (content: string) =>
      beforeStarts.map((handler) =>
        handler({
          messageType: "custom",
          message: { content },
        }),
      ),
    setDiscovery(mode: "explicit" | "adaptive") {
      discovery = mode;
      pi.events.emit(SETUP_APPLY_CHANNEL, { tasks: [] });
    },
    tool: () => tools.get("openpi_load_tools")!,
  };
}

test("ordinary sessions add no resident OpenPI model tool", () => {
  const h = harness();
  h.start();
  assert.deepEqual(h.active(), ["read", "bash", "edit", "write"]);
});

test("Pi custom-message runs do not activate capabilities from message content", () => {
  const h = harness();
  h.start();
  const tools = h.active();
  assert.deepEqual(h.beforeCustom("Use $subagents and /openpi_load_tools"), [
    undefined,
  ]);
  assert.deepEqual(h.active(), tools);
});

test("session_start leaves the real runtime tool inactive until a gateway request", async () => {
  for (const discovery of ["explicit", "adaptive"] as const) {
    for (const runtimeFirst of [false, true]) {
      const h = harness({ discovery, runtimeFirst });
      const ordinaryTools = ["read", "bash", "edit", "write"];
      if (discovery === "adaptive") ordinaryTools.push("openpi_load_tools");
      h.start();
      assert.deepEqual(h.active(), ordinaryTools);
      const listing = await h.tool().execute("list", {});
      assert.match(JSON.stringify(listing), /runtime/);
      assert.deepEqual(h.active(), ordinaryTools);
      const result = await h.tool().execute("load-runtime", {
        groups: ["runtime"],
      });
      assert.deepEqual(result.details.activatedTools, ["runtime_snapshot"]);
      assert.deepEqual(h.active(), [...ordinaryTools, "runtime_snapshot"]);
      await h.tool().execute("load-runtime-again", { groups: ["runtime"] });
      assert.deepEqual(h.active(), [...ordinaryTools, "runtime_snapshot"]);
      h.start();
      assert.deepEqual(h.active(), ordinaryTools);
    }
  }
});

test("adaptive discovery keeps only the capability gateway resident", () => {
  const h = harness({ discovery: "adaptive" });
  h.start();

  assert.deepEqual(h.active(), [
    "read",
    "bash",
    "edit",
    "write",
    "openpi_load_tools",
  ]);

  h.before("Refactor the parser and add focused tests.");
  assert.deepEqual(h.active(), [
    "read",
    "bash",
    "edit",
    "write",
    "openpi_load_tools",
  ]);
});

test("setup changes capability discovery immediately without unloading groups", async () => {
  const h = harness();
  h.start();

  h.setDiscovery("adaptive");
  assert.ok(h.active().includes("openpi_load_tools"));

  await h.tool().execute("call-delegate", { groups: ["delegate"] });
  h.setDiscovery("explicit");
  assert.equal(h.active().includes("openpi_load_tools"), false);
  assert.ok(h.active().includes("subagent_spawn"));
});

test("the gateway does not add an ineffective resident adoption guideline", () => {
  const h = harness();

  assert.equal(h.tool().promptGuidelines, undefined);
});

test("the gateway exposes a provider-portable string enum for capability groups", () => {
  const parameters = JSON.parse(JSON.stringify(harness().tool().parameters));

  assert.deepEqual(parameters.properties.groups.items, {
    type: "string",
    enum: [
      "search",
      "delegate",
      "workflow",
      "background",
      "session",
      "runtime",
    ],
  });
});

test("the gateway stays within its compact provider-surface budget", () => {
  const tool = harness().tool();
  const serialized = JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  });

  assert.ok(
    serialized.length <= 500,
    `gateway provider surface is ${serialized.length} characters`,
  );
});

test("an explicit OpenPI request exposes the capability gateway", () => {
  const h = harness();
  h.start();

  h.before("Use OpenPI capabilities for this task.");

  assert.deepEqual(h.active(), [
    "read",
    "bash",
    "edit",
    "write",
    "openpi_load_tools",
  ]);
});

test("an explicit subagent request loads delegation directly", () => {
  const h = harness();
  h.start();

  const results = h.before("Use subagents to parallelize this task.");

  assert.deepEqual(h.active(), [
    "read",
    "bash",
    "edit",
    "write",
    "subagent_spawn",
    "subagent_wait",
    "subagent_cancel",
    "subagent_send",
    "subagent_check",
    "subagent_list",
  ]);
  assert.match(JSON.stringify(results), SUBAGENT_SKILL_PATH_PATTERN);
});

test("standalone capability selections expose only the selected group", () => {
  for (const [prompt, selectedTool, otherTool] of [
    ["subagent", "subagent_spawn", "workflow"],
    [" Subagents ", "subagent_spawn", "workflow"],
    ["workflow", "workflow", "subagent_spawn"],
    [" WORKFLOWS ", "workflow", "subagent_spawn"],
  ]) {
    const h = harness();
    h.start();
    h.before(prompt);
    assert.equal(h.active().includes(selectedTool), true, prompt);
    assert.equal(h.active().includes(otherTool), false, prompt);
    assert.equal(h.active().includes("bg_start"), false, prompt);
    assert.equal(h.active().includes("openpi_load_tools"), false, prompt);
  }
});

test("a list of capability names loads both groups without executing them", () => {
  const h = harness();
  h.start();

  h.before("subagent, workflow");

  assert.equal(h.active().includes("subagent_spawn"), true);
  assert.equal(h.active().includes("workflow"), true);
  assert.equal(h.active().includes("bg_start"), false);
  assert.equal(h.active().includes("openpi_load_tools"), false);
});

test("common Chinese and multi-agent delegation requests are explicit intent", () => {
  for (const prompt of [
    "来多子代理一起讨论",
    "子代理了解下项目",
    "Use multiple subagents.",
    "用 Subagent 检查这个实现",
  ]) {
    const h = harness();
    h.start();

    h.before(prompt);

    assert.ok(h.active().includes("subagent_spawn"), prompt);
  }
});

test("the README quick-start example and its advertised phrases load capabilities", () => {
  // The flagship README example: both clauses must be explicit intent.
  const example = harness();
  example.start();
  example.before(
    "在后台启动前端 dev server；用子代理并行检查 API 主链路和测试覆盖；\n结果回来后汇总风险，主会话不要原地等待。",
  );
  const active = example.active();
  assert.ok(active.includes("bg_start"), "example loads background terminals");
  assert.ok(active.includes("subagent_spawn"), "example loads subagents");

  // Every phrase the README TIP advertises as a trigger must actually match.
  const advertised: Array<[string, string]> = [
    ["在后台运行 dev server", "bg_start"],
    ["子代理了解下项目", "subagent_spawn"],
    ["用子代理检查", "subagent_spawn"],
    ["使用子代理检查", "subagent_spawn"],
    ["用工作流编排", "workflow"],
    ["使用工作流编排", "workflow"],
    ["用 fd 搜索", "fd"],
    ["使用 rg 搜索", "rg"],
    ["用 git diff 比较分支", "git_diff"],
  ];
  for (const [phrase, tool] of advertised) {
    const h = harness();
    h.start();
    h.before(phrase);
    assert.ok(
      h.active().includes(tool),
      `README-advertised phrase ${JSON.stringify(phrase)} should load ${tool}, got: ${h.active().join(",")}`,
    );
  }
});

test("the gateway returns progressive skill guidance for a loaded group", async () => {
  const h = harness();
  h.start();
  h.before("Use OpenPI capabilities for this task.");

  const result = await h.tool().execute("call-delegate", {
    groups: ["delegate"],
  });

  assert.match(result.content[0]!.text, SUBAGENT_SKILL_PATH_PATTERN);
});

test("named capability discovery leaves execution judgment to the model", () => {
  for (const prompt of [
    "Do not use subagents.",
    "I prefer not to use subagents.",
    "You cannot use subagents.",
    "如果需要，请使用子代理。",
    "不要使用子代理。",
    "子代理是什么？",
    "子代理的设计有哪些取舍？",
  ]) {
    const h = harness();
    h.start();
    const guidance = h.before(prompt);
    assert.ok(h.active().includes("subagent_spawn"), prompt);
    assert.equal(h.active().includes("workflow"), false, prompt);
    assert.equal(h.active().includes("openpi_load_tools"), false, prompt);
    assert.match(JSON.stringify(guidance), /discovery only/);
    assert.match(JSON.stringify(guidance), SUBAGENT_SKILL_PATH_PATTERN);
  }
});

test("non-name conditional rules and the gateway retain their prior policy", () => {
  for (const prompt of [
    "If you delegate this task, make sure every child reports back.",
    "Never delegate this task.",
    "Delegate this task if needed.",
    "No parallel agents.",
    "Do not use OpenPI tools.",
  ]) {
    const h = harness();
    h.start();
    h.before(prompt);
    assert.deepEqual(h.active(), ["read", "bash", "edit", "write"], prompt);
  }
});

test("direct delegation imperatives and questions still load delegation", () => {
  for (const prompt of [
    "Delegate this task.",
    "Please parallelize this work.",
    "Could you delegate this task?",
  ]) {
    const h = harness();
    h.start();
    h.before(prompt);
    assert.ok(h.active().includes("subagent_spawn"), prompt);
  }
});

test("capability loads are monotonic and activate only the requested group", async () => {
  const h = harness();
  h.start();
  h.before("Use OpenPI capabilities for this task.");

  const first = await h.tool().execute("call-1", {
    groups: ["search"],
  });
  assert.deepEqual(first.details.newlyLoaded, ["search"]);
  assert.deepEqual(first.details.activatedTools, [
    "fd",
    "rg",
    "git_show",
    "git_diff",
    "git_log",
  ]);
  assert.deepEqual(h.active(), [
    "read",
    "bash",
    "edit",
    "write",
    "openpi_load_tools",
    "fd",
    "rg",
    "git_show",
    "git_diff",
    "git_log",
  ]);

  const second = await h.tool().execute("call-2", {
    groups: ["search"],
  });
  assert.deepEqual(second.details.newlyLoaded, []);
  assert.deepEqual(second.details.activatedTools, []);
  assert.deepEqual(second.details.loaded, ["search"]);
});
