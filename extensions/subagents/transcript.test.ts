import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentSnapshot } from "./src/domain.ts";
import {
  TranscriptRenderer,
  buildTranscriptLines,
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

test("takeover transcript renders finalized and live assistant Markdown within its width", () => {
  const lines = buildTranscriptLines(
    snapshot({
      transcript: [
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
  assert.match(rendered, /Counts:|npm test|• first item|Live:|Markdown|Plan:/);
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
    '{"query":" safe\\npreview "}',
  );
  assert.equal(summarizeToolArgs("bash", '{"command":'), '{"command":');
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
    /\[first:toolTitle\]bash/,
  );
  assert.match(
    plain(buildTranscriptLines(cached, 80, taggedTheme("second"), renderer)),
    /\[first:toolTitle\]bash/,
  );
  renderer.invalidate();
  assert.match(
    plain(buildTranscriptLines(cached, 80, taggedTheme("second"), renderer)),
    /\[second:toolTitle\]bash/,
  );
});
