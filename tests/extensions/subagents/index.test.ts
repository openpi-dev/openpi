import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import type {
  EntryRenderer,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { PLAN_MODE_CHANNEL } from "../../../extensions/shared/plan-mode-state.ts";
import subagents, {
  createSubagentResultDispatcher,
  truncatedOutput,
} from "../../../extensions/subagents/index.ts";
import { projectResult } from "../../../extensions/subagents/src/result-artifact.ts";

const emptySessionManager = { getBranch: () => [] };

test("subagent results render before the hidden wake-up message", () => {
  const events: unknown[] = [];
  const pi = {
    appendEntry(customType: string, data: unknown) {
      events.push({ kind: "entry", customType, data });
    },
    sendMessage(message: unknown, options: unknown) {
      events.push({ kind: "message", message, options });
    },
  } as unknown as ExtensionAPI;
  const dispatch = createSubagentResultDispatcher(pi, () => "report");

  dispatch([
    {
      id: "sa-3",
      origin: "model",
      backend: "pi",
      title: "investigate plan mode",
      prompt: "inspect",
      cwd: process.cwd(),
      status: "done",
      createdAt: 0,
      settledAt: 1_000,
      meta: { backend: "pi" },
      usage: {},
      transcript: [],
      liveTools: [],
      queued: [],
      finalText: "report",
      turns: 1,
    },
  ]);

  assert.deepEqual(events, [
    {
      kind: "entry",
      customType: "subagent-result",
      data: {
        content:
          'Subagent sa-3 "investigate plan mode" finished.\n\nreport\n\n(This result is already shown to the user. Act on it and relay only the decisions or next steps — do not repeat it verbatim.)',
        details: {
          id: "sa-3",
          title: "investigate plan mode",
          status: "done",
        },
      },
    },
    {
      kind: "message",
      message: {
        customType: "subagent-result",
        content:
          'Subagent sa-3 "investigate plan mode" finished.\n\nreport\n\n(This result is already shown to the user. Act on it and relay only the decisions or next steps — do not repeat it verbatim.)',
        display: false,
        details: {
          id: "sa-3",
          title: "investigate plan mode",
          status: "done",
        },
      },
      options: { deliverAs: "followUp", triggerTurn: true },
    },
  ]);
});

test("automatic result projection keeps both ends and persists the exact final answer", () => {
  const finalText = `BEGIN\n${"evidence\n".repeat(100)}FINAL-VERDICT`;
  let persisted = "";
  const text = truncatedOutput(
    {
      id: "sa-3",
      origin: "model",
      backend: "pi",
      title: "inspect",
      prompt: "inspect",
      cwd: process.cwd(),
      status: "done",
      createdAt: 0,
      settledAt: 1_000,
      meta: { backend: "pi" },
      usage: {},
      transcript: [],
      liveTools: [],
      queued: [],
      finalText,
      turns: 1,
    },
    120,
    (content) => {
      persisted = content;
      return "/tmp/subagent-final.txt";
    },
  );

  assert.equal(persisted, finalText);
  assert.match(text, /^BEGIN/);
  assert.match(text, /FINAL-VERDICT/);
  assert.match(text, /Full final answer: "\/tmp\/subagent-final\.txt"/);
});

test("automatic result delivery shrinks a batch against authoritative parent headroom", () => {
  const budgets: number[] = [];
  const pi = {
    appendEntry() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const dispatch = createSubagentResultDispatcher(
    pi,
    (_snap, maxBytes) => {
      budgets.push(maxBytes);
      return "projected";
    },
    () => ({ tokens: 98_000, contextWindow: 100_000 }),
  );
  const snapshot = (id: string) => ({
    id,
    origin: "model" as const,
    backend: "pi" as const,
    title: id,
    prompt: "inspect",
    cwd: process.cwd(),
    status: "done" as const,
    createdAt: 0,
    settledAt: 1_000,
    meta: { backend: "pi" as const },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "x".repeat(40 * 1024),
    turns: 1,
  });

  dispatch([snapshot("sa-1"), snapshot("sa-2")]);

  assert.deepEqual(budgets, [2048, 2048]);
});

test("automatic result wrappers and projections stay inside the shared batch cap", () => {
  let delivered = "";
  const pi = {
    appendEntry(_customType: string, data: { content: string }) {
      delivered = data.content;
    },
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const dispatch = createSubagentResultDispatcher(
    pi,
    (snap, maxBytes) =>
      projectResult(snap.finalText, {
        maxBytes,
        maxLines: 600,
        writeArtifact: () => `/tmp/${snap.id}.txt`,
      }).text,
  );
  const snapshot = (id: string) => ({
    id,
    origin: "model" as const,
    backend: "pi" as const,
    title: `long report ${id}`,
    prompt: "inspect",
    cwd: process.cwd(),
    status: "done" as const,
    createdAt: 0,
    settledAt: 1_000,
    meta: { backend: "pi" as const },
    usage: {},
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: `BEGIN-${id}\n${"evidence\n".repeat(10_000)}END-${id}`,
    turns: 1,
  });

  dispatch([
    snapshot("sa-1"),
    snapshot("sa-2"),
    snapshot("sa-3"),
    snapshot("sa-4"),
  ]);

  assert.ok(Buffer.byteLength(delivered, "utf8") <= 48 * 1024);
  for (const id of ["sa-1", "sa-2", "sa-3", "sa-4"]) {
    assert.match(delivered, new RegExp(`BEGIN-${id}`));
    assert.match(delivered, new RegExp(`END-${id}`));
  }
});

test("the visible subagent result entry renders the completed report", () => {
  const renderers = new Map<string, EntryRenderer>();
  const pi = {
    on() {},
    events: { on() {} },
    registerTool() {},
    getActiveTools: () => [],
    setActiveTools() {},
    registerMessageRenderer() {},
    registerEntryRenderer(customType: string, renderer: EntryRenderer) {
      renderers.set(customType, renderer);
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;
  subagents(pi);

  const renderer = renderers.get("subagent-result");
  assert.ok(renderer);
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    strikethrough: (text: string) => text,
    inverse: (text: string) => text,
  } as unknown as Parameters<EntryRenderer>[2];
  const component = renderer(
    {
      type: "custom",
      id: "entry-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "subagent-result",
      data: {
        content:
          'Subagent sa-3 "investigate plan mode" finished.\n\nPlan Mode investigation report',
        details: {
          id: "sa-3",
          title: "investigate plan mode",
          status: "done",
        },
      },
    },
    { expanded: true },
    theme,
  );

  assert.ok(component);
  assert.match(component.render(120).join("\n"), /subagent sa-3/);
  assert.match(
    component.render(120).join("\n"),
    /Plan Mode investigation report/,
  );
});

test("session start preserves the complete registered subagent family", () => {
  let active = ["read", "third_party_tool"];
  const registered: string[] = [];
  let sessionStart:
    | ((event: unknown, ctx: ExtensionContext) => unknown)
    | undefined;
  const pi = {
    on(event: string, handler: unknown) {
      if (event === "session_start") {
        sessionStart = handler as typeof sessionStart;
      }
    },
    events: { on() {} },
    registerTool(tool: { name: string }) {
      registered.push(tool.name);
      active = [...active.filter((name) => name !== tool.name), tool.name];
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    registerCommand() {},
  } as unknown as ExtensionAPI;

  subagents(pi);
  assert.ok(sessionStart);
  sessionStart({}, {
    cwd: process.cwd(),
    hasUI: false,
    isProjectTrusted: () => false,
    sessionManager: emptySessionManager,
  } as unknown as ExtensionContext);

  assert.deepEqual(
    [...new Set(registered)],
    [
      "subagent_spawn",
      "subagent_wait",
      "subagent_cancel",
      "subagent_send",
      "subagent_check",
      "subagent_list",
    ],
  );
  assert.deepEqual(
    new Set(active),
    new Set(["read", "third_party_tool", ...registered]),
  );
});

test("the complete subagent family fails closed before the first spawn", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const tools = new Map<
    string,
    {
      execute: (...args: unknown[]) => Promise<{
        content: Array<{ type: string; text: string }>;
      }>;
    }
  >();
  const pi = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
    events: { on() {} },
    registerTool(tool: {
      name: string;
      execute: (...args: unknown[]) => Promise<{
        content: Array<{ type: string; text: string }>;
      }>;
    }) {
      tools.set(tool.name, tool);
    },
    getActiveTools: () => [],
    setActiveTools() {},
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    registerCommand() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => true,
    isProjectTrusted: () => false,
    sessionManager: emptySessionManager,
  } as unknown as ExtensionContext;

  subagents(pi);
  await handlers.get("session_start")?.({}, ctx);

  const invoke = (name: string, params: unknown) =>
    tools
      .get(name)!
      .execute(
        `call-${name}`,
        params,
        new AbortController().signal,
        undefined,
        ctx,
      );

  try {
    const listed = await invoke("subagent_list", {});
    assert.equal(listed.content[0]?.text, "No subagents.");
    await assert.rejects(
      invoke("subagent_check", { id: "sa-missing" }),
      /Unknown subagent id "sa-missing"\. Known: none\./,
    );
    await assert.rejects(
      invoke("subagent_send", { id: "sa-missing", text: "hello" }),
      /Unknown subagent id "sa-missing"\. Known: none\./,
    );
    for (const name of ["subagent_wait", "subagent_cancel"]) {
      await assert.rejects(
        invoke(name, { ids: ["sa-missing"] }),
        /Unknown subagent id\(s\): sa-missing\. Known: none\./,
      );
    }
  } finally {
    await handlers.get("session_shutdown")?.();
  }
});

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-subagent-roster-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(directory, "agent");
  try {
    await run(directory);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
}

test("session_start re-registers agent types for its cwd and live trust decision", async () => {
  await withTempDir(async (cwd) => {
    await mkdir(path.join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "agents", "session-only.md"),
      "---\nname: session-only\ndescription: Present only with live session trust.\ntools: [read]\n---\nRead only.",
    );
    await writeFile(
      path.join(cwd, ".pi", "agents", "inherited-tools.md"),
      "---\nname: inherited-tools\ndescription: Inherits the normal child tool set.\n---\nPerform general work.",
    );

    const sessionStarts: Array<
      (event: unknown, ctx: ExtensionContext) => unknown
    > = [];
    const spawnTools: Array<{
      parameters: { properties: { agent_type: { enum?: string[] } } };
      execute?: (...args: unknown[]) => Promise<unknown>;
    }> = [];
    const eventHandlers = new Map<string, (payload: unknown) => void>();
    const pi = {
      on(event: string, handler: unknown) {
        if (event === "session_start") {
          sessionStarts.push(
            handler as (event: unknown, ctx: ExtensionContext) => unknown,
          );
        }
      },
      events: {
        on(channel: string, handler: unknown) {
          eventHandlers.set(channel, handler as (payload: unknown) => void);
        },
      },
      registerTool(tool: unknown) {
        const candidate = tool as {
          name?: string;
          parameters?: { properties?: { agent_type?: { enum?: string[] } } };
          execute?: (...args: unknown[]) => Promise<unknown>;
        };
        if (
          candidate.name === "subagent_spawn" &&
          candidate.parameters?.properties?.agent_type
        ) {
          spawnTools.push({
            parameters: {
              properties: {
                agent_type: candidate.parameters.properties.agent_type,
              },
            },
            execute: candidate.execute,
          });
        }
      },
      getActiveTools: () => [],
      setActiveTools() {},
      registerMessageRenderer() {},
      registerEntryRenderer() {},
      registerCommand() {},
    } as unknown as ExtensionAPI;

    subagents(pi);
    assert.equal(sessionStarts.length, 1);
    const start = sessionStarts[0];
    assert.ok(start);

    start({}, {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      sessionManager: emptySessionManager,
    } as unknown as ExtensionContext);
    assert.ok(spawnTools.length > 1, "session_start re-registers spawn");
    assert.ok(
      spawnTools
        .at(-1)
        ?.parameters.properties.agent_type.enum?.includes("session-only"),
    );

    const alternateCwd = path.join(cwd, "alternate");
    await mkdir(path.join(alternateCwd, ".pi", "agents"), {
      recursive: true,
    });
    await writeFile(
      path.join(alternateCwd, ".pi", "agents", "alternate-only.md"),
      "---\nname: alternate-only\ndescription: Present only in another trusted session cwd.\ntools: [read]\n---\nRead only.",
    );
    start({}, {
      cwd: alternateCwd,
      hasUI: false,
      isProjectTrusted: () => true,
      sessionManager: emptySessionManager,
    } as unknown as ExtensionContext);
    assert.ok(
      spawnTools
        .at(-1)
        ?.parameters.properties.agent_type.enum?.includes("alternate-only"),
    );
    assert.equal(
      spawnTools
        .at(-1)
        ?.parameters.properties.agent_type.enum?.includes("session-only"),
      false,
    );

    start({}, {
      cwd,
      hasUI: false,
      isProjectTrusted: () => false,
      sessionManager: emptySessionManager,
    } as unknown as ExtensionContext);
    assert.equal(
      spawnTools
        .at(-1)
        ?.parameters.properties.agent_type.enum?.includes("session-only"),
      false,
    );

    const setPlanning = eventHandlers.get(PLAN_MODE_CHANNEL);
    assert.ok(setPlanning);
    setPlanning({ planning: true });
    const spawn = spawnTools.at(-1)?.execute;
    assert.ok(spawn);
    const context = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => false,
    } as unknown as ExtensionContext;
    await assert.rejects(
      () =>
        spawn(
          "call",
          {
            prompt: "Inspect only.",
            name: "inspect",
            agent_type: "implementer",
            isolation: "worktree",
          },
          undefined,
          undefined,
          context,
        ),
      /Plan mode is active: isolation: "worktree"/,
    );
    await assert.rejects(
      () =>
        spawn(
          "call",
          {
            prompt: "Inspect only.",
            name: "inspect",
            agent_type: "implementer",
          },
          undefined,
          undefined,
          context,
        ),
      /agent type "implementer" would be narrowed to capabilities that contradict its unchanged prompt/,
    );

    // A custom type that omits `tools` inherits the normal write-capable set;
    // it must not evade the same contradiction check merely because its
    // allowlist is undefined.
    start({}, {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      sessionManager: emptySessionManager,
    } as unknown as ExtensionContext);
    const trustedSpawn = spawnTools.at(-1)?.execute;
    assert.ok(trustedSpawn);
    await assert.rejects(
      () =>
        trustedSpawn(
          "call",
          {
            prompt: "Inspect only.",
            name: "inspect",
            agent_type: "inherited-tools",
          },
          undefined,
          undefined,
          context,
        ),
      /agent type "inherited-tools" would be narrowed to capabilities that contradict its unchanged prompt/,
    );
  });
});
