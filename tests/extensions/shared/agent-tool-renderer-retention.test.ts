import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  defineTool,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  AgentToolRenderLedger,
  MAX_RETAINED_TOOL_RENDER_BYTES,
  MAX_RETAINED_TOOL_RENDERS,
} from "../../../extensions/shared/agent-tool-renderer.ts";
import { AgentTranscriptRenderer } from "../../../extensions/shared/agent-transcript.ts";
import type { SubagentSnapshot } from "../../../extensions/subagents/src/domain.ts";
import { subagentTranscriptDocument } from "../../../extensions/subagents/src/ui/transcript.ts";

initTheme("dark", false);

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as Theme;

/** Deeply frozen so any write into a canonical Pi payload throws. */
function frozenResult(text: string) {
  return Object.freeze({
    content: Object.freeze([Object.freeze({ type: "text", text })]),
  });
}

function retained(ledger: AgentToolRenderLedger) {
  const { toolIds, bytes } = ledger.retention();
  return { records: toolIds.length, bytes, ids: toolIds };
}

test("FAIL: a long-lived child keeps ledger records and payload bytes within budget", () => {
  const ledger = new AgentToolRenderLedger();
  for (let index = 0; index < 5000; index++)
    ledger.end(
      `id-${index}`,
      "read",
      frozenResult(`${index}${"x".repeat(32 * 1024)}`),
      false,
    );
  const { records, bytes, ids } = retained(ledger);
  assert.ok(records <= MAX_RETAINED_TOOL_RENDERS, `${records} records`);
  assert.ok(bytes <= MAX_RETAINED_TOOL_RENDER_BYTES, `${bytes} bytes`);
  // Independent of the ledger's own counter: every retained record holds one
  // ~32 KiB result, so the count alone bounds what stays reachable.
  assert.ok(records * (32 * 1024 + 4) <= MAX_RETAINED_TOOL_RENDER_BYTES);
  // Eviction is oldest-first: the newest tools are the ones still retained.
  assert.equal(ids.at(-1), "id-4999");
  assert.equal(ids[0], `id-${5000 - records}`);
});

test("FAIL: many small tools are capped at the visible transcript size", () => {
  const ledger = new AgentToolRenderLedger();
  for (let index = 0; index < 5000; index++) {
    ledger.start(`id-${index}`, "read", { path: `f${index}.ts` });
    ledger.end(`id-${index}`, "read", frozenResult("ok"), false);
  }
  const { records, ids } = retained(ledger);
  assert.equal(records, MAX_RETAINED_TOOL_RENDERS);
  assert.equal(ids.at(-1), "id-4999");
  assert.equal(ids[0], `id-${5000 - MAX_RETAINED_TOOL_RENDERS}`);
});

test("running tools are never evicted, and the newest oversized result still renders", () => {
  const ledger = new AgentToolRenderLedger();
  for (let index = 0; index < 4; index++)
    ledger.start(`running-${index}`, "bash", { command: "sleep 600" });
  for (let index = 0; index < 600; index++)
    ledger.end(
      `done-${index}`,
      "read",
      frozenResult("y".repeat(64 * 1024)),
      false,
    );
  ledger.end(
    "huge",
    "read",
    frozenResult("z".repeat(MAX_RETAINED_TOOL_RENDER_BYTES + 1)),
    false,
  );
  const { ids } = retained(ledger);
  for (let index = 0; index < 4; index++)
    assert.ok(ids.includes(`running-${index}`), `running-${index} kept`);
  assert.ok(ids.includes("huge"));
  assert.ok(ledger.renderTool({ toolId: "huge", name: "read" }, 80)?.length);
  // A running tool settles later and still renders natively.
  ledger.end("running-0", "bash", frozenResult("done"), false);
  assert.ok(
    ledger.renderTool({ toolId: "running-0", name: "bash" }, 80)?.length,
  );
});

test("an evicted tool falls back to its bounded transcript preview", () => {
  const definition = defineTool({
    name: "git_log",
    label: "Git Log",
    description: "test renderer",
    parameters: Type.Object({ revision: Type.String() }),
    execute: async () => ({
      content: [{ type: "text", text: "unused" }],
      details: undefined,
    }),
    renderCall: (args, nativeTheme) =>
      new Text(
        nativeTheme.fg("toolTitle", `native git log ${args.revision}`),
        0,
        0,
      ),
  });
  const ledger = new AgentToolRenderLedger();
  const total = MAX_RETAINED_TOOL_RENDERS + 1;
  for (let index = 0; index < total; index++) {
    ledger.start(
      `tool-${index}`,
      "git_log",
      { revision: `r${index}` },
      definition,
    );
    ledger.end(`tool-${index}`, "git_log", frozenResult(`log ${index}`), false);
  }
  const item = (index: number) => [
    {
      kind: "assistant" as const,
      parts: [
        {
          type: "toolCall" as const,
          toolId: `tool-${index}`,
          name: "git_log",
          argsPreview: `{"revision":"r${index}"}`,
        },
      ],
    },
    {
      kind: "toolResult" as const,
      toolId: `tool-${index}`,
      name: "git_log",
      isError: false,
      outputPreview: `log ${index}`,
    },
  ];
  const render = (index: number, expanded: boolean) =>
    stripVTControlCharacters(
      new AgentTranscriptRenderer()
        .render(
          subagentTranscriptDocument(
            {
              id: "sa-1",
              origin: "model",
              backend: "pi",
              title: "retention",
              prompt: "retention",
              cwd: process.cwd(),
              status: "done",
              createdAt: 0,
              meta: { backend: "pi" },
              usage: {},
              transcriptVersion: 0,
              transcript: item(index),
              liveTools: [],
              queued: [],
              finalText: "",
              turns: 0,
            } satisfies SubagentSnapshot,
            ledger,
          ),
          80,
          theme,
          { now: 0, ...(expanded ? { expanded } : {}) },
        )
        .join("\n"),
    );

  assert.match(render(total - 1, false), /native git log r512/);
  const evicted = render(0, false);
  assert.doesNotMatch(evicted, /native git log/);
  assert.match(evicted, /git_log|r0/);
});
