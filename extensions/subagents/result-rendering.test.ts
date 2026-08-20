import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  initTheme,
  type EntryRenderer,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

initTheme("dark", false);

test("compact automatic results keep the report behind expansion", async () => {
  const agentDir = await mkdtemp(path.join(tmpdir(), "openpi-result-render-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  try {
    await writeFile(
      path.join(agentDir, "my-pi-setup.json"),
      JSON.stringify({ ui: { subagentResultDisplay: "compact" } }),
    );
    const { default: subagents } = await import("./index.ts");
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
    const entry = {
      type: "custom" as const,
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
          status: "done" as const,
        },
      },
    };

    const compact = renderer(entry, { expanded: false }, theme);
    assert.ok(compact);
    const compactText = compact.render(120).join("\n");
    assert.match(compactText, /1 subagent settled/);
    assert.match(compactText, /sa-3 · investigate plan mode · done/);
    assert.match(compactText, /Results passed to main agent/);
    assert.doesNotMatch(compactText, /Plan Mode investigation report/);

    const expanded = renderer(entry, { expanded: true }, theme);
    assert.ok(expanded);
    assert.match(
      expanded.render(120).join("\n"),
      /Plan Mode investigation report/,
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});
