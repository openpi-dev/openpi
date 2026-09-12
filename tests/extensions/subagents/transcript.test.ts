import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  defineTool,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { AgentToolRenderLedger } from "../../../extensions/shared/agent-tool-renderer.ts";
import {
  AgentTranscriptRenderer,
  sanitizeText,
} from "../../../extensions/shared/agent-transcript.ts";
import {
  SPINNER_INTERVAL_MS,
  spinnerFrame,
} from "../../../extensions/shared/spinner.ts";
import { summarizeToolArgs } from "../../../extensions/shared/tool-activity.ts";
import type { SubagentSnapshot } from "../../../extensions/subagents/src/domain.ts";
import { subagentTranscriptDocument } from "../../../extensions/subagents/src/ui/transcript.ts";

initTheme("dark", false);

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as Theme;

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "sa-1",
    origin: "model",
    backend: "pi",
    title: "render test",
    prompt: "render test",
    cwd: process.cwd(),
    status: "running",
    createdAt: 0,
    meta: { backend: "pi" },
    usage: {},
    transcriptVersion: 0,
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
    ...overrides,
  };
}

function plain(lines: readonly string[]) {
  return stripVTControlCharacters(lines.join("\n"));
}

function renderSnapshot(
  value: SubagentSnapshot,
  width: number,
  renderTheme: Theme,
  renderer = new AgentTranscriptRenderer(),
  options?: { readonly now?: number },
  toolRenderer?: AgentToolRenderLedger,
) {
  return renderer.render(
    subagentTranscriptDocument(value, toolRenderer),
    width,
    renderTheme,
    options,
  );
}

test("transcript sanitization strips terminal control sequences before rendering", () => {
  assert.equal(
    sanitizeText("\u001b]52;c;Y2xpcGJvYXJk\u0007**safe**\u001b[31m"),
    "**safe**",
  );
});

test("extension tool calls use their Pi-native renderer instead of raw JSON", () => {
  const definition = defineTool({
    name: "git_log",
    label: "Git Log",
    description: "test renderer",
    parameters: Type.Object({
      revision: Type.String(),
      limit: Type.Number(),
      oneline: Type.Boolean(),
    }),
    execute: async () => ({
      content: [{ type: "text", text: "unused" }],
      details: undefined,
    }),
    renderCall: (args, nativeTheme) =>
      new Text(
        nativeTheme.fg(
          "toolTitle",
          `git log ${args.revision} ${args.oneline ? "--oneline " : ""}-n ${args.limit}`,
        ),
        0,
        0,
      ),
  });
  const toolRenderer = new AgentToolRenderLedger();
  const args = { revision: "main", limit: 3, oneline: true };
  toolRenderer.start("git-log-1", "git_log", args, definition);
  toolRenderer.end(
    "git-log-1",
    "git_log",
    { content: [{ type: "text", text: "abc first\ndef second\nghi third" }] },
    false,
  );
  const rendered = plain(
    renderSnapshot(
      snapshot({
        status: "done",
        transcript: [
          {
            kind: "assistant",
            parts: [
              {
                type: "toolCall",
                toolId: "git-log-1",
                name: "git_log",
                argsPreview: '{"revision":"main","limit":3,"oneline":true}',
              },
            ],
          },
          {
            kind: "toolResult",
            toolId: "git-log-1",
            name: "git_log",
            isError: false,
            outputPreview: "abc first\ndef second\nghi third",
          },
        ],
      }),
      80,
      theme,
      undefined,
      { now: 0 },
      toolRenderer,
    ),
  );

  assert.match(rendered, /git log main --oneline -n 3/);
  assert.doesNotMatch(rendered, /\{"revision":"main"/);
});

test("takeover transcript renders finalized and live assistant Markdown within its width", () => {
  const lines = renderSnapshot(
    snapshot({
      transcript: [
        {
          kind: "user",
          text: "**Request:** inspect `takeover.ts`",
        },
        {
          kind: "assistant",
          parts: [
            {
              type: "text",
              text: "**Counts:** run `npm test`\n\n- first item\n- second item",
            },
            { type: "thinking", text: "**Plan:** inspect `transcript.ts`" },
          ],
        },
      ],
      liveAssistant: {
        text: "**Live:** use `Markdown`\n\n- active item",
        thinking: "*Live thought* about `width`",
      },
    }),
    24,
    theme,
  );
  const rendered = plain(lines);

  assert.doesNotMatch(rendered, /\*\*|`/);
  assert.doesNotMatch(rendered, /(?:^|\n)> Request:/);
  assert.match(
    rendered,
    /Request:|takeover\.ts|Counts:|npm test|- first item|Live:|Markdown|Plan:/,
  );
  assert.ok(lines.every((line) => visibleWidth(line) <= 24));
});

test("shared transcript renders fenced code and CJK deterministically at narrow widths", () => {
  const value = snapshot({
    transcript: [
      { kind: "user", text: "请检查这个非常长的中文文件名是否正确" },
      {
        kind: "assistant",
        parts: [
          {
            type: "text",
            text: '结果：\n\n```ts\nconst 状态 = "完成";\n```',
          },
        ],
      },
    ],
  });

  const first = renderSnapshot(value, 12, theme);
  const second = renderSnapshot(value, 12, theme);
  const rendered = plain(first);

  assert.deepEqual(second, first);
  assert.match(rendered, /请检查|中文|结果|const|状态|完成/);
  assert.match(rendered, /```ts/);
  assert.ok(first.length > 4);
  assert.ok(first.every((line) => visibleWidth(line) <= 12));
});

test("thinking renders Markdown but preserves redaction", () => {
  const rendered = plain(
    renderSnapshot(
      snapshot({
        transcript: [
          {
            kind: "assistant",
            parts: [
              {
                type: "thinking",
                text: "secret **reasoning**",
                redacted: true,
              },
            ],
          },
        ],
      }),
      80,
      theme,
    ),
  );

  assert.match(rendered, /\[redacted reasoning\]/);
  assert.doesNotMatch(rendered, /secret|\*\*/);
});

test("tool calls summarize known bounded JSON arguments and safely fall back", () => {
  assert.equal(summarizeToolArgs("bash", '{"command":"npm test"}'), "npm test");
  assert.equal(
    summarizeToolArgs("bash", JSON.stringify({ command: "printf x\\ " })),
    "printf x\\ ",
  );
  assert.equal(
    summarizeToolArgs("bash", '{"command":"printf \'a  b\'\\necho done"}'),
    "printf 'a  b' ↵ echo done",
  );
  assert.equal(summarizeToolArgs("read", '{"path":"src/a.ts"}'), "src/a.ts");
  assert.equal(
    summarizeToolArgs("rg", '{"pattern":"renderSnapshot","path":"extensions"}'),
    "renderSnapshot · extensions",
  );
  assert.equal(
    summarizeToolArgs("fd", '{"pattern":"*.test.ts","path":"extensions"}'),
    "*.test.ts · extensions",
  );
  assert.equal(
    summarizeToolArgs("custom", '{"query":"  safe\\npreview  "}'),
    '{"query":"  safe\\npreview  "}',
  );
  assert.equal(summarizeToolArgs("bash", '{"command":'), '{"command":');
});

test("tool argument summaries relativize paths inside the child cwd", () => {
  const cwd = "/repo";
  assert.equal(
    summarizeToolArgs("read", '{"path":"/repo/src/a.ts"}', cwd),
    path.join("src", "a.ts"),
  );
  assert.equal(
    summarizeToolArgs("rg", '{"pattern":"foo","path":"/repo/ext"}', cwd),
    "foo · ext",
  );
  assert.equal(summarizeToolArgs("read", '{"path":"/repo"}', cwd), ".");
  // Paths outside the checkout stay absolute.
  assert.equal(
    summarizeToolArgs("read", '{"path":"/elsewhere/a.ts"}', cwd),
    "/elsewhere/a.ts",
  );
  // A shared prefix that is not a path boundary does not relativize.
  assert.equal(
    summarizeToolArgs("read", '{"path":"/repo-other/a.ts"}', cwd),
    "/repo-other/a.ts",
  );
});

test("tool call and output lines drop the child cwd prefix", () => {
  const cwd = process.cwd();
  const lines = renderSnapshot(
    snapshot({
      transcript: [
        {
          kind: "assistant",
          parts: [
            {
              type: "toolCall",
              toolId: "fd-1",
              name: "fd",
              argsPreview: JSON.stringify({
                pattern: "*.mjs",
                path: `${cwd}/scripts`,
              }),
            },
          ],
        },
        {
          kind: "toolResult",
          toolId: "fd-1",
          name: "fd",
          isError: false,
          outputPreview: `${cwd}/scripts/benchmark-arm-selection.mjs`,
        },
      ],
    }),
    80,
    theme,
  );

  assert.deepEqual(lines, ["", "   Searched *.mjs  in scripts  1 result  "]);
});

test("pending tool calls use the parent activity verbs", () => {
  const rendered = plain(
    renderSnapshot(
      snapshot({
        transcript: [
          {
            kind: "assistant",
            parts: [
              {
                type: "toolCall",
                toolId: "bash-1",
                name: "bash",
                argsPreview: '{"command":"git status --porcelain"}',
              },
              {
                type: "toolCall",
                toolId: "read-1",
                name: "read",
                argsPreview: '{"path":"src/index.ts"}',
              },
            ],
          },
        ],
      }),
      80,
      theme,
    ),
  );

  assert.match(
    rendered,
    /^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Running {2}git status --porcelain {2}$/m,
  );
  assert.match(rendered, /^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Reading {2}src\/index\.ts {2}$/m);
});

test("settled tools use one semantic activity row", () => {
  const lines = renderSnapshot(
    snapshot({
      transcript: [
        {
          kind: "assistant",
          parts: [
            {
              type: "toolCall",
              toolId: "call-1",
              name: "bash",
              argsPreview: '{"command":"printf ok"}',
            },
          ],
        },
        {
          kind: "toolResult",
          toolId: "call-1",
          name: "bash",
          isError: false,
          outputPreview: "ok",
        },
      ],
    }),
    80,
    theme,
  );

  assert.deepEqual(lines, ["", "   Ran      printf ok  "]);
});

test("parallel tool results reuse their earlier command lines", () => {
  const lines = renderSnapshot(
    snapshot({
      transcript: [
        {
          kind: "assistant",
          parts: [
            {
              type: "toolCall",
              toolId: "read-a",
              name: "read",
              argsPreview: '{"path":"a.ts"}',
            },
            {
              type: "toolCall",
              toolId: "read-b",
              name: "read",
              argsPreview: '{"path":"b.ts"}',
            },
          ],
        },
        {
          kind: "toolResult",
          toolId: "read-a",
          name: "read",
          isError: false,
          outputPreview: "alpha",
        },
        {
          kind: "toolResult",
          toolId: "read-b",
          name: "read",
          isError: false,
          outputPreview: "beta",
        },
      ],
    }),
    80,
    theme,
  );

  assert.deepEqual(lines, [
    "",
    "   Read     a.ts  ",
    "",
    "   Read     b.ts  ",
  ]);
});

test("tool errors and empty results use status glyphs", () => {
  const rendered = plain(
    renderSnapshot(
      snapshot({
        transcript: [
          {
            kind: "toolResult",
            toolId: "error-1",
            name: "bash",
            isError: true,
            outputPreview: "command failed",
          },
          {
            kind: "toolResult",
            toolId: "empty-1",
            name: "bash",
            isError: false,
          },
        ],
      }),
      80,
      theme,
    ),
  );

  // Orphan results (no call above them) keep a glyph of their own.
  assert.match(rendered, /✕ Failed\s+bash/);
  assert.match(rendered, /command failed/);
  assert.match(rendered, / Ran\s+bash/);
});

test("a running tool becomes settled without reflowing", () => {
  const call = {
    kind: "assistant" as const,
    parts: [
      {
        type: "toolCall" as const,
        toolId: "live-1",
        name: "bash",
        argsPreview: '{"command":"git status"}',
      },
    ],
  };
  // Production order: the assistant message (with the call) lands in the
  // transcript before tool_execution_start, so both sources describe one tool.
  const running = renderSnapshot(
    snapshot({
      transcript: [call],
      liveTools: [
        {
          toolId: "live-1",
          name: "bash",
          argsPreview: '{"command":"git status"}',
          outputPreview: "clean",
        },
      ],
    }),
    80,
    theme,
    undefined,
    { now: 0 },
  );
  const settled = renderSnapshot(
    snapshot({
      transcript: [
        call,
        {
          kind: "toolResult",
          toolId: "live-1",
          name: "bash",
          isError: false,
          outputPreview: "clean",
        },
      ],
    }),
    80,
    theme,
    undefined,
    { now: 0 },
  );

  // The command appears exactly once and keeps the same target column.
  assert.deepEqual(running, ["", "  ⠋ Running  git status  "]);
  assert.deepEqual(settled, ["", "   Ran      git status  "]);
  assert.equal(
    running[1]?.indexOf("git status"),
    settled[1]?.indexOf("git status"),
  );
});

test("the spinner advances between frames instead of freezing in the cache", () => {
  const renderer = new AgentTranscriptRenderer();
  const snap = snapshot({
    transcript: [
      {
        kind: "assistant",
        parts: [
          {
            type: "toolCall",
            toolId: "live-1",
            name: "bash",
            argsPreview: '{"command":"sleep 1"}',
          },
        ],
      },
    ],
    liveTools: [
      { toolId: "live-1", name: "bash", argsPreview: '{"command":"sleep 1"}' },
    ],
  });

  const document = subagentTranscriptDocument(snap);
  const first = renderer.render(document, 80, theme, { now: 0 });
  const later = renderer.render(document, 80, theme, {
    now: SPINNER_INTERVAL_MS,
  });
  assert.notEqual(first[1], later[1]);
  assert.equal(first[1]?.slice(3), later[1]?.slice(3));
});

test("empty live assistant buffers do not hide live tools or Pi-style queued messages", () => {
  const rendered = plain(
    renderSnapshot(
      snapshot({
        liveAssistant: { text: "", thinking: "" },
        liveTools: [
          {
            toolId: "read-1",
            name: "read",
            argsPreview: '{"path":"src/index.ts"}',
          },
        ],
        queued: [
          { kind: "steer", text: "check tests" },
          { kind: "follow-up", text: "summarize" },
        ],
      }),
      80,
      theme,
      undefined,
      { now: 0 },
    ),
  );

  assert.match(rendered, /Reading {2}src\/index\.ts/);
  assert.match(rendered, /Steering: check tests/);
  assert.match(rendered, /Follow-up: summarize/);
  assert.doesNotMatch(rendered, /\[queued/);
});

test("cached items are keyed by width and by tool phase", () => {
  const renderer = new AgentTranscriptRenderer();
  const call = {
    kind: "assistant" as const,
    parts: [
      {
        type: "toolCall" as const,
        toolId: "call-1",
        name: "bash",
        argsPreview: '{"command":"printf a-very-long-command-name"}',
      },
    ],
  };
  const pending = snapshot({ transcript: [call] });
  const pendingDocument = subagentTranscriptDocument(pending);
  const wide = renderer.render(pendingDocument, 80, theme, { now: 0 });
  const narrow = renderer.render(pendingDocument, 24, theme, { now: 0 });
  assert.ok(wide.every((line) => visibleWidth(line) <= 80));
  assert.ok(narrow.every((line) => visibleWidth(line) <= 24));
  assert.notDeepEqual(wide, narrow);

  // The same item re-renders once its result lands: a width-only cache key
  // would serve the stale pending glyph forever.
  const settled = renderer.render(
    subagentTranscriptDocument(
      snapshot({
        transcript: [
          call,
          {
            kind: "toolResult",
            toolId: "call-1",
            name: "bash",
            isError: false,
            outputPreview: "a",
          },
        ],
      }),
    ),
    80,
    theme,
    { now: 0 },
  );
  assert.match(wide[1]!, /^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  assert.match(settled[1]!, /^ {2}/);
});

test("spinnerFrame is deterministic and advances every 120ms", () => {
  assert.equal(spinnerFrame(0), "⠋");
  assert.equal(spinnerFrame(119), "⠋");
  assert.equal(spinnerFrame(120), "⠙");
  assert.equal(spinnerFrame(10 * 120), "⠋");
});

test("tool rendering keeps every line within a narrow width", () => {
  const lines = renderSnapshot(
    snapshot({
      transcript: [
        {
          kind: "assistant",
          parts: [
            {
              type: "toolCall",
              toolId: "narrow-1",
              name: "bash",
              argsPreview: JSON.stringify({ command: "x".repeat(200) }),
            },
          ],
        },
        {
          kind: "toolResult",
          toolId: "narrow-1",
          name: "bash",
          isError: false,
          outputPreview: "y".repeat(200),
        },
      ],
      liveTools: [
        {
          toolId: "narrow-live",
          name: "custom-tool",
          argsPreview: JSON.stringify({ value: "z".repeat(200) }),
          outputPreview: "w".repeat(200),
        },
      ],
    }),
    24,
    theme,
    undefined,
    { now: 0 },
  );

  assert.ok(lines.every((line) => visibleWidth(line) <= 24));
});

test("cached finalized transcript output is rebuilt after invalidation", () => {
  const renderer = new AgentTranscriptRenderer();
  const cached = snapshot({
    transcript: [
      {
        kind: "assistant",
        parts: [
          {
            type: "toolCall",
            toolId: "call-1",
            name: "bash",
            argsPreview: '{"command":"npm test"}',
          },
        ],
      },
    ],
  });
  const taggedTheme = (tag: string) =>
    ({
      fg: (color: string, text: string) => `[${tag}:${color}]${text}`,
      bold: (text: string) => text,
      italic: (text: string) => text,
    }) as Theme;

  assert.match(
    plain(renderSnapshot(cached, 80, taggedTheme("first"), renderer)),
    /\[first:toolTitle\]Running\s+npm test/,
  );
  assert.match(
    plain(renderSnapshot(cached, 80, taggedTheme("second"), renderer)),
    /\[first:toolTitle\]Running\s+npm test/,
  );
  renderer.invalidate();
  assert.match(
    plain(renderSnapshot(cached, 80, taggedTheme("second"), renderer)),
    /\[second:toolTitle\]Running\s+npm test/,
  );
});
