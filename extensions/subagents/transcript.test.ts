import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentSnapshot } from "./src/domain.ts";
import {
  SPINNER_INTERVAL_MS,
  TranscriptRenderer,
  buildTranscriptLines,
  sanitizeText,
  spinnerFrame,
  summarizeToolArgs,
} from "./src/ui/transcript.ts";

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

test("transcript sanitization strips terminal control sequences before rendering", () => {
  assert.equal(
    sanitizeText("\u001b]52;c;Y2xpcGJvYXJk\u0007**safe**\u001b[31m"),
    "**safe**",
  );
});

test("takeover transcript renders finalized and live assistant Markdown within its width", () => {
  const lines = buildTranscriptLines(
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

  assert.doesNotMatch(rendered, /\*\*|`|- first item|- active item/);
  assert.match(
    rendered,
    /Request:|takeover\.ts|Counts:|npm test|• first item|Live:|Markdown|Plan:/,
  );
  assert.ok(lines.every((line) => visibleWidth(line) <= 24));
});

test("thinking renders Markdown but preserves redaction", () => {
  const rendered = plain(
    buildTranscriptLines(
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
    summarizeToolArgs(
      "rg",
      '{"pattern":"buildTranscriptLines","path":"extensions"}',
    ),
    "buildTranscriptLines · extensions",
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
    "src/a.ts",
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
  const lines = buildTranscriptLines(
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

  assert.deepEqual(lines, [
    "✓ fd *.mjs · scripts",
    "    scripts/benchmark-arm-selection.mjs",
  ]);
});

test("bash tool calls use shell prompts while other tools go bare", () => {
  const rendered = plain(
    buildTranscriptLines(
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

  assert.match(rendered, /^· \$ git status --porcelain/m);
  assert.match(rendered, /· read src\/index\.ts/);
});

test("adjacent tool results form one block with a success glyph", () => {
  const lines = buildTranscriptLines(
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

  // One glyph per execution, on the command line; the output sits under it.
  assert.deepEqual(lines, ["✓ $ printf ok", "    ok"]);
  assert.ok(!lines.slice(0, -1).some((line) => line === ""));
});

test("tool errors and empty results use status glyphs", () => {
  const rendered = plain(
    buildTranscriptLines(
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
  assert.match(rendered, /✗ bash/);
  assert.match(rendered, /command failed/);
  assert.match(rendered, /✓ bash/);
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
  const running = buildTranscriptLines(
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
  const settled = buildTranscriptLines(
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

  // The command appears exactly once while running, and only the glyph changes
  // when the tool settles: same line count, same columns.
  assert.deepEqual(running, ["⠋ $ git status", "    clean"]);
  assert.deepEqual(settled, ["✓ $ git status", "    clean"]);
  assert.equal(running[0]?.slice(1), settled[0]?.slice(1));
  assert.equal(running[1], settled[1]);
});

test("the spinner advances between frames instead of freezing in the cache", () => {
  const renderer = new TranscriptRenderer();
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

  const first = renderer.render(snap, 80, theme, { now: 0 });
  const later = renderer.render(snap, 80, theme, { now: SPINNER_INTERVAL_MS });
  assert.notEqual(first[0], later[0]);
  assert.equal(first[0]?.slice(1), later[0]?.slice(1));
});

test("cached items are keyed by width and by tool phase", () => {
  const renderer = new TranscriptRenderer();
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
  const wide = renderer.render(pending, 80, theme, { now: 0 });
  const narrow = renderer.render(pending, 24, theme, { now: 0 });
  assert.ok(wide.every((line) => visibleWidth(line) <= 80));
  assert.ok(narrow.every((line) => visibleWidth(line) <= 24));
  assert.notDeepEqual(wide, narrow);

  // The same item re-renders once its result lands: a width-only cache key
  // would serve the stale pending glyph forever.
  const settled = renderer.render(
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
    80,
    theme,
    { now: 0 },
  );
  assert.match(wide[0]!, /^·/);
  assert.match(settled[0]!, /^✓/);
});

test("spinnerFrame is deterministic and advances every 120ms", () => {
  assert.equal(spinnerFrame(0), "⠋");
  assert.equal(spinnerFrame(119), "⠋");
  assert.equal(spinnerFrame(120), "⠙");
  assert.equal(spinnerFrame(10 * 120), "⠋");
});

test("tool rendering keeps every line within a narrow width", () => {
  const lines = buildTranscriptLines(
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
  const renderer = new TranscriptRenderer();
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
    plain(buildTranscriptLines(cached, 80, taggedTheme("first"), renderer)),
    /\[first:dim\]\$ npm test/,
  );
  assert.match(
    plain(buildTranscriptLines(cached, 80, taggedTheme("second"), renderer)),
    /\[first:dim\]\$ npm test/,
  );
  renderer.invalidate();
  assert.match(
    plain(buildTranscriptLines(cached, 80, taggedTheme("second"), renderer)),
    /\[second:dim\]\$ npm test/,
  );
});
