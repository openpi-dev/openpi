import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  type AgentToolResult,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  setKeybindings,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { codemodeRenderers } from "../../../extensions/codemode-display/render.ts";

initTheme("dark", false);
setKeybindings(
  new KeybindingsManager({
    "app.tools.expand": {
      defaultKeys: "ctrl+o",
      description: "Toggle tool output",
    },
  }),
);
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const code =
  "const result = await tools.read({path: 'secret.ts'});\nreturn result;";
function context(expanded = false, isError = false, showImages = false) {
  return {
    args: { code },
    toolCallId: "code-1",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: "/workspace",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded,
    showImages,
    isError,
  };
}
const header = "Script completed\nWall time 2.3 seconds\nOutput:\n";
function result(
  text = "done",
  calls: unknown[] = [],
): AgentToolResult<unknown> {
  return {
    content: [
      { type: "text", text: header },
      { type: "text", text },
    ],
    details: { calls },
  };
}
function rendered(
  value: AgentToolResult<unknown>,
  options: {
    expanded?: boolean;
    partial?: boolean;
    error?: boolean;
    width?: number;
    images?: boolean;
  } = {},
) {
  const expanded = options.expanded ?? false;
  return codemodeRenderers.renderResult!(
    value,
    { expanded, isPartial: options.partial ?? false },
    theme,
    context(expanded, options.error, options.images),
  )
    .render(options.width ?? 120)
    .map((row) => unframe(row, options.width ?? 120));
}
/** Drop the one-column tool padding that mirrors Pi's default shell. */
function unframe(row: string, width: number) {
  const text = stripTerminalSequences(row).trimEnd();
  return width > 8 ? text.replace(/^ /u, "") : text;
}

test("compact call hides script and expanded call retains its complete source", () => {
  const compact = codemodeRenderers.renderCall!({ code }, theme, context())
    .render(120)
    .map(stripTerminalSequences)
    .join("\n");
  assert.match(compact, /codemode · 2 script lines/u);
  assert.match(compact, /ctrl\+o.*to expand/iu);
  assert.doesNotMatch(compact, /secret\.ts|await tools/u);
  const expanded = codemodeRenderers.renderCall!({ code }, theme, context(true))
    .render(120)
    .map((row) => unframe(row, 120))
    .join("\n");
  assert.match(expanded, /Script/u);
  assert.ok(expanded.includes(code));
  assert.equal(codemodeRenderers.renderShell, "self");
});

test("all nested statuses include earlier failures and cancellations despite outer success", () => {
  const calls = [
    {
      name: "early-read",
      args: "PRIVATE ARGS",
      status: "error",
      error: "permission denied",
    },
    { name: "early-cancel", args: "PRIVATE ARGS", status: "cancelled" },
    ...Array.from({ length: 12 }, (_, index) => ({
      name: `read-${index}`,
      args: "PRIVATE ARGS",
      status: "ok",
      durationMs: 3,
    })),
    { name: "pending", status: "running" },
  ];
  const rows = rendered(result("done", calls));
  const text = rows.join("\n");
  assert.match(text, /✓ completed · 2\.3s · 15 calls/u);
  assert.match(text, /✗ early-read · error: permission denied/u);
  assert.match(text, /⊘ early-cancel · cancelled/u);
  assert.match(text, /… pending · running/u);
  assert.match(text, /⋯ 9 more calls/u);
  assert.match(text, /ctrl\+o.*to expand/iu);
  assert.doesNotMatch(text, /PRIVATE ARGS|read-0/u);
  assert.ok(
    rows.length <= 15,
    "collapsed height does not grow with the ledger",
  );
  const full = rendered(result("done", calls), { expanded: true }).join("\n");
  assert.match(full, /Calls/u);
  assert.match(full, /15 calls · 1 error · 1 cancelled · 1 running · 12 ok/u);
  assert.match(full, /✓ read-0 · 3ms/u);
  assert.match(full, /PRIVATE ARGS/u);
  assert.match(
    full,
    /Native result header\nScript completed\nWall time 2\.3 seconds\nOutput:/u,
  );
});

test("partial updates, outer errors and unknown historical evidence do not claim success", () => {
  const partial = rendered(
    result("not-final", [{ name: "read", status: "running" }]),
    { partial: true },
  ).join("\n");
  assert.match(partial, /… running · 1 call/u);
  assert.doesNotMatch(partial, /Output pending/u);
  assert.doesNotMatch(partial, /not-final/u);
  assert.match(
    rendered(result("failed"), { error: true }).join("\n"),
    /failed ·/u,
  );
  const unknown = rendered({
    content: [{ type: "text", text: "old raw output" }],
    details: undefined,
  }).join("\n");
  assert.match(unknown, /finished · time unknown · calls unknown/u);
  assert.doesNotMatch(unknown, /0 calls/u);
  assert.doesNotMatch(unknown, /completed|success/u);
  const fake = rendered({
    content: [
      {
        type: "text",
        text: "Script completed\nWall time 1.2.3 seconds\nOutput:\n",
      },
    ],
    details: { calls: [{ name: "future", status: "other" }] },
  }).join("\n");
  assert.match(fake, /time unknown/u);
  assert.match(fake, /\? future · unknown/u);
});

test("outer JSON string becomes readable text with raw evidence retained on expansion", () => {
  const raw = JSON.stringify("first line\nsecond line\nthird line");
  const compact = rendered(result(raw)).join("\n");
  assert.doesNotMatch(compact, /first line|second line|third line/u);
  assert.doesNotMatch(compact, /\\n/u);
  const expanded = rendered(result(raw), { expanded: true }).join("\n");
  assert.match(expanded, /Display projection \(outer JSON decoded\)/u);
  assert.match(expanded, /Raw output \(terminal controls stripped\)/u);
  assert.ok(expanded.includes(raw));
});

test("compact hides all output and spill paths without changing expanded evidence or results", () => {
  const output =
    "Warning: truncated output\nPRIVATE_OUTPUT\n" + "x".repeat(8_000);
  const calls = [
    { name: "bash", args: '{"command":"echo hello"}', status: "ok" },
    {
      name: "read",
      args: '{"path":"missing.ts"}',
      status: "error",
      error: "denied",
    },
    { name: "edit", status: "cancelled" },
    { name: "rg", status: "unknown" },
  ];
  const value = result(output, calls);
  value.details = { calls, fullOutputPath: "/tmp/private-output-evidence.txt" };
  const before = JSON.stringify(value);
  for (const options of [{}, { partial: true }, { error: true }]) {
    const compact = rendered(value, options).join("\n");
    assert.doesNotMatch(
      compact,
      /PRIVATE_OUTPUT|Warning:|Full output:|private-output-evidence/u,
    );
    assert.match(compact, /✓ \uea85 Bash echo hello/u);
    assert.match(compact, /✗ \ueaa4 Read missing\.ts · error: denied/u);
    assert.match(compact, /⊘ \uea73 Edit · cancelled/u);
    assert.match(compact, /\? \uea6d Rg · unknown/u);
    assert.match(compact, /ctrl\+o.*to expand/iu);
  }
  const expanded = rendered(value, { expanded: true, width: 200 }).join("\n");
  assert.match(expanded, /Warning: truncated output\nPRIVATE_OUTPUT/u);
  assert.match(expanded, /Full output: \/tmp\/private-output-evidence\.txt/u);
  assert.equal(JSON.stringify(value), before);
});

test("structured JSON remains structured and nested JSON-looking strings are not interpreted", () => {
  const raw = JSON.stringify({
    content: [{ text: "literal\\ntext" }],
    output: '{"unsafe":true}',
    payload: "line1\nline2",
  });
  const expanded = rendered(result(raw), { expanded: true }).join("\n");
  assert.match(expanded, /"content": \[/u);
  assert.match(expanded, /"output": "\{\\"unsafe\\":true\}"/u);
  assert.ok(expanded.includes(raw));
  assert.doesNotMatch(expanded, /^literal\\ntext$/mu);
});

test("long output is bounded in compact view and unchanged in expanded evidence", () => {
  const raw = JSON.stringify({ value: "z".repeat(40_000) });
  const value = result(raw);
  const before = createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
  const compact = rendered(value, { width: 24 });
  assert.ok(compact.length <= 9);
  assert.ok(compact.every((row) => visibleWidth(row) <= 24));
  const expanded = rendered(value, { expanded: true, width: 80 })
    .join("")
    .replace(/\s/gu, "");
  assert.ok(
    expanded.includes(raw),
    "over-budget JSON is retained raw, not partially decoded",
  );
  assert.equal(
    createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    before,
  );
});

test("external script, names, args, errors, output and evidence paths cannot issue terminal controls", () => {
  const attack = "safe\u001b[2J\u001b]52;c;clipboard\u0007\u202eevil\u009b31m";
  const value = result(attack, [
    { name: attack, args: attack, error: attack, status: "error" },
  ]);
  value.details = { ...(value.details as object), fullOutputPath: attack };
  const expanded = rendered(value, { expanded: true }).join("\n");
  assert.doesNotMatch(expanded, /\u001b|\u0007|\u202e|\u009b|clipboard/u);
  const script = codemodeRenderers.renderCall!(
    { code: attack },
    theme,
    context(true),
  )
    .render(80)
    .join("\n");
  assert.doesNotMatch(script, /\u001b|\u0007|\u202e|\u009b|clipboard/u);
  assert.match(expanded, /safeevil/u);
});

test("narrow Unicode terminals bound every compact row and image evidence remains visible", () => {
  const value = result("工作流✅".repeat(100), [
    { name: "读取🧑‍💻文件".repeat(20), status: "cancelled" },
  ]);
  value.content.push({
    type: "image",
    data: "ignored-in-text-projection",
    mimeType: "image/png",
  });
  for (const width of [1, 4, 12, 24]) {
    const rows = rendered(value, { width });
    assert.ok(
      rows.every((row) => visibleWidth(row) <= width),
      `width=${width}`,
    );
    assert.ok(rows.length <= 12);
  }
  assert.match(rendered(value).join("\n"), /\[image\] × 1/u);
  assert.match(rendered(value, { images: true }).join("\n"), /Images: 1/u);
  assert.doesNotMatch(
    rendered(value).join("\n"),
    /ignored-in-text-projection/u,
  );
});

test("expanded mode retains every call, Script/Calls/Output sections and spilled evidence path", () => {
  const calls = Array.from({ length: 20 }, (_, index) => ({
    name: `tool-${index}`,
    status: "ok",
    args: `argument-${index}`,
  }));
  const value = result("raw output", calls);
  value.details = { calls, fullOutputPath: "/tmp/full-evidence.txt" };
  const text = [
    ...codemodeRenderers.renderCall!({ code }, theme, context(true)).render(
      120,
    ),
    ...rendered(value, { expanded: true }),
  ].join("\n");
  assert.match(text, /Script/u);
  assert.match(text, /Calls/u);
  assert.match(text, /Output/u);
  assert.match(text, /argument-0/u);
  assert.match(text, /argument-19/u);
  assert.match(text, /raw output/u);
  assert.match(text, /Full output: \/tmp\/full-evidence.txt/u);
});

test("early cancellation stays identifiable at widths 1, 4 and 8 even when salient rows select later errors", () => {
  const calls = [
    { name: "first cancelled", status: "cancelled" },
    { name: "later error", status: "error" },
    { name: "latest error", status: "error" },
    ...Array.from({ length: 4 }, () => ({ name: "ok", status: "ok" })),
  ];
  for (const width of [1, 4, 8]) {
    const rows = rendered(result("done", calls), { width });
    assert.ok(
      rows.some((row) => row.startsWith("⊘")),
      `cancellation width=${width}`,
    );
    assert.ok(
      rows.some((row) => row.startsWith("✗")),
      `error width=${width}`,
    );
    assert.ok(rows.every((row) => visibleWidth(row) <= width));
  }
});

test("block tint is green only for a clean ledger, neutral for nested issues and red for failure", () => {
  const tinted = {
    fg: (_color: string, text: string) => text,
    bg: (color: string, text: string) => `<${color}>${text}`,
    bold: (text: string) => text,
  } as Theme;
  const tone = (value: AgentToolResult<unknown>, error = false) => {
    const state = {};
    const shared = { ...context(false, error), state };
    const body = codemodeRenderers.renderResult!(
      value,
      { expanded: false, isPartial: false },
      tinted,
      shared,
    ).render(80);
    const call = codemodeRenderers.renderCall!({ code }, tinted, shared).render(
      80,
    );
    const tones = new Set(
      [...call, ...body].map((row) => /^<(\w+)>/u.exec(row)?.[1]),
    );
    assert.equal(tones.size, 1, "call and result share one tint");
    return [...tones][0];
  };
  assert.equal(
    tone(result("ok", [{ name: "a", status: "ok" }])),
    "toolSuccessBg",
  );
  assert.equal(
    tone(result("ok", [{ name: "a", status: "error" }])),
    "toolPendingBg",
  );
  assert.equal(
    tone({ content: [{ type: "text", text: "legacy" }], details: undefined }),
    "toolPendingBg",
  );
  assert.equal(tone(result("boom"), true), "toolErrorBg");
});

test("compact call rows name their first string argument within the row budget", () => {
  const calls = [
    {
      name: "read",
      status: "ok",
      durationMs: 6,
      args: '{"path":"package.json"}',
    },
    {
      name: "bash",
      status: "ok",
      durationMs: 16,
      args: `{"command":"${"x".repeat(300)}","timeout":5}`,
    },
    { name: "bash", status: "ok", args: '{"command":"unterminated...' },
    { name: "web", status: "error", error: "boom", args: '{"query":"cats"}' },
  ];
  const rows = rendered(result("done", calls), { width: 60 });
  const text = rows.join("\n");
  assert.match(text, /✓ \ueaa4 Read package\.json · 6ms/u);
  assert.match(text, /✓ \uea85 Bash x+… · 16ms/u);
  assert.match(
    text,
    /^ {2}✓ \uea85 Bash$/mu,
    "truncated JSON yields no guessed hint",
  );
  assert.match(text, /✗ web cats · error: boom/u);
  assert.ok(rows.every((row) => visibleWidth(row) <= 60));
});

test("native 200-character previews keep long Bash commands and Read paths visible", () => {
  const command = `git status --short; echo ${"long-command ".repeat(40)}`;
  const path = `/workspace/${"long-directory/".repeat(30)}README.md`;
  const preview = (args: unknown) => `${JSON.stringify(args).slice(0, 197)}...`;
  const value = result("HIDDEN_OUTPUT", [
    { name: "bash", status: "ok", args: preview({ command }), durationMs: 102 },
    { name: "read", status: "ok", args: preview({ path }), durationMs: 19 },
  ]);
  const before = JSON.stringify(value);
  for (const width of [60, 120, 300]) {
    const rows = rendered(value, { width });
    const text = rows.join("\n");
    assert.match(
      text,
      /Bash git status --short; echo long-command.*… · 102ms/u,
    );
    assert.match(text, /Read \/workspace\/long-directory\/.*… · 19ms/u);
    assert.doesNotMatch(text, /HIDDEN_OUTPUT/u);
    assert.ok(rows.every((row) => visibleWidth(row) <= width));
  }
  assert.equal(JSON.stringify(value), before);
  const expanded = rendered(value, { expanded: true, width: 300 }).join("\n");
  assert.ok(expanded.includes(preview({ command })));
});

test("native preview cuts through escapes and Unicode retain a safe command prefix", () => {
  for (const suffix of ['"', "\\", "\n", "\t", "\u0001", "🧑‍💻", "你好"]) {
    for (let fill = 175; fill <= 187; fill++) {
      const command = `printf ${"x".repeat(fill)}${suffix}${"tail".repeat(30)}`;
      const raw = `${JSON.stringify({ command }).slice(0, 197)}...`;
      const value = result("hidden", [
        { name: "bash", status: "ok", args: raw, durationMs: 102 },
      ]);
      const rows = rendered(value, { width: 300 });
      const compact = rows.join("\n");
      assert.match(compact, /Bash printf x+.*… · 102ms/u);
      assert.doesNotMatch(compact, /[\u0001\u001b\ud800-\udfff]/u);
      assert.ok(rows.every((row) => visibleWidth(row) <= 300));
    }
  }
});

test("a shared row puts the status in the call header and hides output", () => {
  const state = {};
  const shared = { ...context(), state };
  const header = codemodeRenderers.renderCall!({ code }, theme, shared);
  const body = codemodeRenderers.renderResult!(
    result("first\n\n\nsecond", [{ name: "a", status: "ok" }]),
    { expanded: false, isPartial: false },
    theme,
    shared,
  )
    .render(80)
    .map((row) => unframe(row, 80));
  const top = header.render(80).map((row) => unframe(row, 80));
  assert.deepEqual(top, [
    "",
    "✓ codemode completed · 2.3s · 1 call · 2 script lines",
  ]);
  assert.doesNotMatch(body.join("\n"), /completed/u);
  assert.doesNotMatch(body.join("\n"), /first|second|│/u);
});
