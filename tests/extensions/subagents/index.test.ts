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
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { encodeStructuredResult } from "../../../extensions/shared/structured-output.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { PLAN_MODE_CHANNEL } from "../../../extensions/shared/plan-mode-state.ts";
import subagents, {
  createSubagentResultDispatcher,
  truncatedOutput,
} from "../../../extensions/subagents/index.ts";
import { projectResult } from "../../../extensions/subagents/src/result-artifact.ts";

initTheme("dark", false);

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
      transcriptVersion: 0,
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
        content: 'Subagent sa-3 "investigate plan mode" finished.\n\nreport',
        details: {
          id: "sa-3",
          title: "investigate plan mode",
          status: "done",
          elapsed: "1s",
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
          elapsed: "1s",
          displayContent:
            'Subagent sa-3 "investigate plan mode" finished.\n\nreport',
        },
      },
      options: { deliverAs: "followUp", triggerTurn: true },
    },
  ]);
});

test("automatic delivery exposes structured data and its canonical artifact", () => {
  let entry: { content: string; details: Record<string, unknown> } | undefined;
  const pi = {
    appendEntry(
      _customType: string,
      data: { content: string; details: Record<string, unknown> },
    ) {
      entry = data;
    },
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const dispatch = createSubagentResultDispatcher(pi);
  dispatch([
    {
      id: "sa-structured",
      origin: "model",
      backend: "pi",
      title: "structured review",
      prompt: "review",
      cwd: process.cwd(),
      status: "done",
      outcome: "completed",
      createdAt: 0,
      settledAt: 1_000,
      meta: { backend: "pi" },
      usage: {},
      transcriptVersion: 0,
      transcript: [],
      liveTools: [],
      queued: [],
      finalText: "",
      structuredResult: {
        value: { verdict: "pass" },
        json: '{"verdict":"pass"}',
        byteLength: 18,
        artifactPath: "/tmp/structured.json",
      },
      turns: 1,
    },
  ]);

  assert.match(entry?.content ?? "", /\{"verdict":"pass"\}/);
  assert.deepEqual(entry?.details.structured, { verdict: "pass" });
  assert.equal(entry?.details.structuredArtifactPath, "/tmp/structured.json");
});

test("automatic delivery keeps large structured values in runtime details, not parent model text", () => {
  const findings = "x".repeat(80 * 1024);
  const value = { findings };
  const encoded = encodeStructuredResult(value);
  let persisted = "";
  let sent: { content: string; details: Record<string, unknown> } | undefined;
  const pi = {
    appendEntry() {},
    sendMessage(message: {
      content: string;
      details: Record<string, unknown>;
    }) {
      sent = message;
    },
  } as unknown as ExtensionAPI;
  const dispatch = createSubagentResultDispatcher(pi, (snap, maxBytes) =>
    truncatedOutput(snap, maxBytes, (content) => {
      persisted = content;
      return "/tmp/structured-full.json";
    }),
  );

  dispatch([
    {
      id: "sa-structured-large",
      origin: "model",
      backend: "pi",
      title: "structured review",
      prompt: "review",
      cwd: process.cwd(),
      status: "done",
      outcome: "completed",
      createdAt: 0,
      settledAt: 1_000,
      meta: { backend: "pi" },
      usage: {},
      transcriptVersion: 0,
      transcript: [],
      liveTools: [],
      queued: [],
      finalText: "",
      structuredResult: {
        ...encoded,
        artifactPath: "/tmp/structured-full.json",
      },
      turns: 1,
    },
  ]);

  assert.ok(sent);
  assert.equal(persisted, encoded.json);
  assert.deepEqual(sent.details.structured, value);
  assert.equal(
    sent.details.structuredArtifactPath,
    "/tmp/structured-full.json",
  );
  assert.ok(Buffer.byteLength(sent.content, "utf8") < encoded.byteLength);
  assert.equal(sent.content.includes(findings), false);

  const llm = convertToLlm([
    {
      role: "custom",
      customType: "subagent-result",
      content: sent.content,
      display: false,
      details: sent.details,
      timestamp: Date.now(),
    },
  ]);
  const llmText = llm
    .flatMap((message) =>
      Array.isArray(message.content)
        ? message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
        : [],
    )
    .join("");
  assert.equal(llmText, sent.content);
  assert.equal(JSON.stringify(llm).includes(findings), false);
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
      transcriptVersion: 0,
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

test("automatic projection carries artifact save failures into result details", () => {
  let entryDetails: Record<string, unknown> | undefined;
  const pi = {
    appendEntry(
      _customType: string,
      data: { details: Record<string, unknown> },
    ) {
      entryDetails = data.details;
    },
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const dispatch = createSubagentResultDispatcher(pi, () => ({
    text: "Full final answer could not be saved; only the head and tail above are available.",
    artifactSaveFailed: true,
  }));

  dispatch([
    {
      id: "sa-artifact",
      origin: "model",
      backend: "pi",
      title: "artifact test",
      prompt: "inspect",
      cwd: process.cwd(),
      status: "done",
      createdAt: 0,
      settledAt: 1_000,
      meta: { backend: "pi" },
      usage: {},
      transcriptVersion: 0,
      transcript: [],
      liveTools: [],
      queued: [],
      finalText: "x".repeat(40 * 1024),
      turns: 1,
    },
  ]);

  assert.equal(entryDetails?.artifactSaveFailed, true);
});

test("automatic projection carries canonical outcome and recovery metadata", () => {
  let entryDetails: Record<string, unknown> | undefined;
  const pi = {
    appendEntry(
      _customType: string,
      data: { details: Record<string, unknown> },
    ) {
      entryDetails = data.details;
    },
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const dispatch = createSubagentResultDispatcher(pi, () => ({
    text: "projected result",
    truncated: true,
    artifactPath: "/tmp/subagent-final.txt",
  }));

  dispatch([
    {
      id: "sa-recovery",
      origin: "model",
      backend: "pi",
      title: "recovery test",
      prompt: "inspect",
      cwd: process.cwd(),
      status: "error",
      outcome: "interrupted",
      worktreeBranch: "pi/impl-1",
      createdAt: 0,
      settledAt: 1_000,
      meta: { backend: "pi" },
      usage: {},
      transcriptVersion: 0,
      transcript: [],
      liveTools: [],
      queued: [],
      finalText: "result",
      turns: 1,
    },
  ]);

  assert.equal(entryDetails?.outcome, "interrupted");
  assert.equal(entryDetails?.worktreeBranch, "pi/impl-1");
  assert.equal(entryDetails?.fullResultSaved, true);
});

test("automatic delivery reports real artifact save failures", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "openpi-artifact-dir-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;

  try {
    await writeFile(path.join(directory, "cache"), "not a directory");
    let entryDetails: Record<string, unknown> | undefined;
    const pi = {
      appendEntry(
        _customType: string,
        data: { details: Record<string, unknown> },
      ) {
        entryDetails = data.details;
      },
      sendMessage() {},
    } as unknown as ExtensionAPI;
    const dispatch = createSubagentResultDispatcher(pi);

    dispatch([
      {
        id: "sa-real-artifact",
        origin: "model",
        backend: "pi",
        title: "artifact test",
        prompt: "inspect",
        cwd: process.cwd(),
        status: "done",
        createdAt: 0,
        settledAt: 1_000,
        meta: { backend: "pi" },
        usage: {},
        transcriptVersion: 0,
        transcript: [],
        liveTools: [],
        queued: [],
        finalText: "x".repeat(40 * 1024),
        turns: 1,
      },
    ]);

    assert.equal(entryDetails?.artifactSaveFailed, true);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(directory, { recursive: true, force: true });
  }
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
    transcriptVersion: 0,
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
    transcriptVersion: 0,
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

test("automatic delivery keeps 64 results inside the hard batch cap", () => {
  let displayContent = "";
  let modelContent = "";
  const pi = {
    appendEntry(_customType: string, data: { content: string }) {
      displayContent = data.content;
    },
    sendMessage(message: { content: string }) {
      modelContent = message.content;
    },
  } as unknown as ExtensionAPI;
  const dispatch = createSubagentResultDispatcher(
    pi,
    (snap, maxBytes) =>
      projectResult(snap.finalText, {
        maxBytes,
        maxLines: 600,
        writeArtifact: () => `/tmp/${snap.id}.txt`,
      }).text,
    () => ({ tokens: 100_000, contextWindow: 100_000 }),
  );
  const snapshots = Array.from({ length: 64 }, (_, index) => {
    const id = `sa-${index + 1}`;
    return {
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
      transcriptVersion: 0,
      transcript: [],
      liveTools: [],
      queued: [],
      finalText: `BEGIN-${id}\n${"evidence\n".repeat(10_000)}END-${id}`,
      turns: 1,
    };
  });

  dispatch(snapshots);

  assert.ok(Buffer.byteLength(displayContent, "utf8") <= 48 * 1024);
  assert.ok(Buffer.byteLength(modelContent, "utf8") <= 48 * 1024);
  for (const { id } of snapshots) {
    assert.match(displayContent, new RegExp(`Subagent ${id} `));
    assert.match(modelContent, new RegExp(`Subagent ${id} `));
  }
});

test("automatic delivery fails closed when wrapper metadata exceeds the cap", () => {
  let displayContent = "";
  let modelContent = "";
  const pi = {
    appendEntry(_customType: string, data: { content: string }) {
      displayContent = data.content;
    },
    sendMessage(message: { content: string }) {
      modelContent = message.content;
    },
  } as unknown as ExtensionAPI;
  const dispatch = createSubagentResultDispatcher(pi, () => "report");

  dispatch([
    {
      id: "sa-oversized",
      origin: "model",
      backend: "pi",
      title: "title ".repeat(20_000),
      prompt: "inspect",
      cwd: process.cwd(),
      status: "error",
      errorText: "failure ".repeat(20_000),
      createdAt: 0,
      settledAt: 1_000,
      meta: { backend: "pi" },
      usage: {},
      transcriptVersion: 0,
      transcript: [],
      liveTools: [],
      queued: [],
      finalText: "report",
      turns: 1,
    },
  ]);

  for (const content of [displayContent, modelContent]) {
    assert.ok(Buffer.byteLength(content, "utf8") <= 48 * 1024);
    assert.match(content, /truncated at the 48 KiB total limit/);
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
  subagents(pi, { getResultDisplay: () => "full" });

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

test("the compact result renderer shows artifact save failures", () => {
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
  subagents(pi, { getResultDisplay: () => "compact" });

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
      id: "entry-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "subagent-result",
      data: {
        content: "Subagent sa-artifact finished.\n\nReport",
        details: {
          id: "sa-artifact",
          title: "artifact",
          status: "done",
          artifactSaveFailed: true,
        },
      },
    },
    { expanded: false },
    theme,
  );

  assert.ok(component);
  assert.match(component.render(120).join("\n"), /artifact not saved/);
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
