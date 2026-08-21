import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  OPENPI_TOOL_SURFACE,
  patchOwnedTools,
} from "../shared/tool-surface.ts";
import { SETUP_CONFIG_CHANGED_CHANNEL } from "../shared/setup-config.ts";
import { createCapabilitiesExtension } from "./index.ts";

interface CapturedTool {
  name: string;
  description: string;
  parameters: unknown;
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

function harness(options: { discovery?: "explicit" | "adaptive" } = {}) {
  let discovery = options.discovery ?? "explicit";
  const available = [
    "read",
    "bash",
    "edit",
    "write",
    "openpi_load_tools",
    "fd",
    "rg",
    "subagent_spawn",
  ];
  let active = [...available];
  const tools = new Map<string, CapturedTool>();
  const starts: (() => void)[] = [];
  const beforeStarts: ((event: { prompt: string }) => unknown)[] = [];
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
      handler: (() => void) | ((event: { prompt: string }) => unknown),
    ) {
      if (event === "session_start") starts.push(handler as () => void);
      if (event === "before_agent_start") {
        beforeStarts.push(handler as (event: { prompt: string }) => unknown);
      }
    },
    registerTool(tool: CapturedTool) {
      tools.set(tool.name, tool);
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
  extension(pi as unknown as ExtensionAPI);
  starts.push(() => {
    patchOwnedTools(pi, "fileSearch", {
      enable: OPENPI_TOOL_SURFACE.fileSearch.entry,
    });
    patchOwnedTools(pi, "subagents", {
      enable: OPENPI_TOOL_SURFACE.subagents.entry,
    });
  });
  return {
    active: () => [...active],
    start: () => {
      for (const handler of starts) handler();
    },
    before: (prompt: string) => {
      return beforeStarts.map((handler) => handler({ prompt }));
    },
    setDiscovery(mode: "explicit" | "adaptive") {
      discovery = mode;
      pi.events.emit(SETUP_CONFIG_CHANGED_CHANNEL, {});
    },
    tool: () => tools.get("openpi_load_tools")!,
  };
}

test("ordinary sessions add no resident OpenPI model tool", () => {
  const h = harness();
  h.start();
  assert.deepEqual(h.active(), ["read", "bash", "edit", "write"]);
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
    enum: ["search", "delegate", "workflow", "background", "session"],
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
  ]);
  assert.match(JSON.stringify(results), /skills\/subagents\/SKILL\.md/);
});

test("common Chinese and multi-agent delegation requests are explicit intent", () => {
  for (const prompt of ["来多子代理一起讨论", "Use multiple subagents."]) {
    const h = harness();
    h.start();

    h.before(prompt);

    assert.ok(h.active().includes("subagent_spawn"), prompt);
  }
});

test("the gateway returns progressive skill guidance for a loaded group", async () => {
  const h = harness();
  h.start();
  h.before("Use OpenPI capabilities for this task.");

  const result = await h.tool().execute("call-delegate", {
    groups: ["delegate"],
  });

  assert.match(result.content[0]!.text, /skills\/subagents\/SKILL\.md/);
});

test("conditional or negated capability boilerplate does not widen the tool surface", () => {
  for (const prompt of [
    "Work autonomously. If you delegate any work, every child must inherit the parent model.",
    "If you delegate this task, make sure every child reports back.",
    "If needed, delegate this task only after checking the repository.",
    "Do not use subagents.",
    "I prefer not to use subagents.",
    "You cannot use subagents.",
    "No parallel agents.",
    "Never delegate this task.",
    "Delegate this task if needed.",
    "如果需要，请使用子代理。",
    "不要使用子代理。",
    "不能使用子代理。",
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
  assert.deepEqual(first.details.activatedTools, ["fd", "rg"]);
  assert.deepEqual(h.active(), [
    "read",
    "bash",
    "edit",
    "write",
    "openpi_load_tools",
    "fd",
    "rg",
  ]);

  const second = await h.tool().execute("call-2", {
    groups: ["search"],
  });
  assert.deepEqual(second.details.newlyLoaded, []);
  assert.deepEqual(second.details.activatedTools, []);
  assert.deepEqual(second.details.loaded, ["search"]);
});
