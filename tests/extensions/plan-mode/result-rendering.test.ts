/**
 * plan_ready renders the recorded plan as Markdown.
 *
 * These tests pin two things: the renderer is wired at all (the regression
 * that motivated it was a missing `renderResult`, which silently fell back to
 * plain text), and a realistic plan survives rendering.
 *
 * Note on styling: `Markdown` colors itself from the global theme via
 * `getMarkdownTheme()`, not from the `theme` argument passed to `renderResult`.
 * That argument is only used for the fallback placeholder here. So rendered
 * output carries ANSI codes whenever the global theme is initialized, and
 * these assertions run against ANSI-stripped text.
 *
 * Two more global singletons are relied on: `initTheme("dark", false)` at
 * module scope (the `keyHint` helper reads the global theme, and expanded
 * rendering reads `getMarkdownTheme()`) and pi-tui's keybindings singleton
 * (keyHint's key name resolves from it — unset in this test process, so hint
 * rows render as bare " to expand"; assertions treat both that and the real
 * "ctrl+o to expand" layout structurally).
 *
 * Assertions stay structural — heading markers consumed, content preserved,
 * nothing throws — rather than pinning pi-tui's exact visual treatment.
 */

import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import {
  initTheme,
  ToolExecutionComponent,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  visibleWidth,
  wrapTextWithAnsi,
  type TUI,
} from "@earendil-works/pi-tui";

initTheme("dark", false);

/** Matches the SGR sequences the Markdown component emits. */
const ANSI = /\u001b\[[0-9;]*m/g;

/** Strip SGR escape sequences the Markdown component emits. */
function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

const THEME = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
  inverse: (text: string) => text,
};

interface RenderedComponent {
  render(width: number): string[];
  invalidate?(): void;
}

interface PlanTool {
  name: string;
  renderResult?: (
    result: {
      details?: { plan?: string } | null;
      content?: { type?: string; text?: string }[];
    },
    options: { expanded?: boolean },
    theme: unknown,
  ) => RenderedComponent;
}

/** Wide enough that line wrapping does not interfere with assertions. */
const WIDTH = 200;

/** Load plan-mode under a stub pi API and return the registered plan_ready tool. */
async function loadPlanReady(): Promise<PlanTool> {
  const { default: planMode } = await import(
    "../../../extensions/plan-mode/index.ts"
  );
  const tools = new Map<string, PlanTool>();
  const pi = {
    on() {},
    registerTool(definition: PlanTool) {
      tools.set(definition.name, definition);
    },
    registerCommand() {},
    appendEntry() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;
  planMode(pi);

  const tool = tools.get("plan_ready");
  assert.ok(tool, "plan_ready must be registered");
  assert.ok(tool.renderResult, "plan_ready must supply renderResult");
  return tool;
}

/** Render a plan through renderResult, ANSI-stripped, at the test width. */
function renderPlan(
  tool: PlanTool,
  details: { plan?: string } | null | undefined,
  expanded = false,
): string {
  const component = tool.renderResult?.({ details }, { expanded }, THEME);
  assert.ok(component, "renderResult must return a component");
  return stripAnsi(component.render(WIDTH).join("\n"));
}

const RICH_PLAN = [
  "# Migration plan",
  "",
  "## Goal",
  "Move the queue off Redis.",
  "",
  "### Steps",
  "1. Snapshot the queue",
  "2. Drain consumers",
  "   - verify depth is zero",
  "   - stop the workers",
  "3. Cut over",
  "",
  "> Do not run steps 2 and 3 in the same window.",
  "",
  "| Phase | Owner |",
  "| --- | --- |",
  "| snapshot | platform |",
  "| cutover | platform |",
  "",
  "Use `queuectl drain` first, then **stop** the workers.",
  "",
  "See [the runbook](https://example.com/runbook) for detail.",
  "",
  "```bash",
  "queuectl drain --timeout 30s",
  "```",
  "",
  "```",
  "plain fence with no language",
  "```",
  "",
  "```python",
  "def check(depth):",
  "    return depth == 0",
  "```",
  "",
  "---",
  "",
  "Inline `code` and a trailing [link](https://example.com).",
].join("\n");

test("plan_ready is registered with a renderer", async () => {
  const tool = await loadPlanReady();
  assert.equal(tool.name, "plan_ready");
  assert.equal(typeof tool.renderResult, "function");
});

test("headings lose their markers and keep their text", async () => {
  const tool = await loadPlanReady();
  const out = renderPlan(
    tool,
    {
      plan: "# Migration plan\n\n## Goal\n\n### Steps\n",
    },
    true,
  );

  assert.doesNotMatch(out, /^#\s/m, "no bare ATX heading markers");
  assert.match(out, /Migration plan/);
  assert.match(out, /Goal/);
  assert.match(out, /Steps/);
});

test("a rich plan renders without throwing and keeps its content", async () => {
  const tool = await loadPlanReady();
  const out = renderPlan(tool, { plan: RICH_PLAN }, true);

  // Headings and body.
  assert.match(out, /Migration plan/);
  assert.match(out, /Move the queue off Redis\./);

  // Ordered list plus a nested unordered sub-list.
  assert.match(out, /1\. Snapshot the queue/);
  assert.match(out, /2\. Drain consumers/);
  assert.match(out, /- verify depth is zero/);

  // Block quote: rendered with a gutter, text preserved.
  assert.match(out, /Do not run steps 2 and 3 in the same window\./);

  // Table: drawn with box characters, not echoed as pipes.
  assert.match(out, /┌/, "table has a top border");
  assert.match(out, /Phase/);
  assert.match(out, /platform/);
  assert.doesNotMatch(out, /\|\s*---\s*\|/, "delimiter row is consumed");

  // Inline code and bold: markers consumed, text kept.
  assert.match(out, /Use queuectl drain first, then stop the workers\./);
  assert.doesNotMatch(out, /\*\*stop\*\*/, "bold markers are consumed");

  // Link: label kept, URL surfaced.
  assert.match(out, /the runbook/);
  assert.match(out, /https:\/\/example\.com\/runbook/);

  // All three fences, with and without a language.
  assert.match(out, /queuectl drain --timeout 30s/);
  assert.match(out, /plain fence with no language/);
  assert.match(out, /def check\(depth\):/);
  assert.match(out, /return depth == 0/);

  // Thematic break becomes a rule, not a literal ---.
  assert.match(out, /─{10,}/, "thematic break is drawn as a rule");

  assert.match(out, /Inline code and a trailing link/);
});

test("fenced code body is indented while the fence stays visible", async () => {
  const tool = await loadPlanReady();
  const out = renderPlan(tool, { plan: "```\nhello\n```\n" }, true);

  // pi-tui colors the fence markers but does not draw a background block, so
  // the backticks remain; the body is what gets indented.
  assert.match(out, /```/);
  // Lines are padded to the render width, so allow trailing whitespace.
  assert.match(out, /^ {2}hello\s*$/m, "code body indented two spaces");
});

test("a missing or empty plan falls back to a placeholder", async () => {
  const tool = await loadPlanReady();

  assert.match(renderPlan(tool, undefined), /\(no plan content\)/);
  assert.match(renderPlan(tool, null), /\(no plan content\)/);
  assert.match(renderPlan(tool, { plan: "" }), /\(no plan content\)/);
});

test("plain prose with no markup renders as itself", async () => {
  const tool = await loadPlanReady();
  const out = renderPlan(
    tool,
    { plan: "Just a sentence.\nAnd another.\n" },
    true,
  );

  assert.match(out, /Just a sentence\./);
  assert.match(out, /And another\./);
});

test("a plan near the documented size cap still renders", async () => {
  const tool = await loadPlanReady();
  // MAX_READY_PLAN_CHARS is 50_000; stay under it but well past one screen.
  const plan = `# Long\n\n${"- item line to pad the plan out\n".repeat(1500)}`;
  assert.ok(plan.length > 40_000, "fixture is meaningfully large");

  const out = renderPlan(tool, { plan }, true);
  assert.match(out, /Long/);
  assert.match(out, /item line to pad the plan out/);
});

test("unusual characters do not break the renderer", async () => {
  const tool = await loadPlanReady();
  // execute() sanitizes before storing, so this is not a path the renderer
  // normally sees. It should degrade, not throw.
  const out = renderPlan(
    tool,
    {
      plan: "# Ünïcode ✓\n\n- 日本語のテキスト\n\n```\nemoji 🎉 here\n```\n",
    },
    true,
  );

  assert.match(out, /Ünïcode/);
  assert.match(out, /日本語のテキスト/);
  assert.match(out, /emoji 🎉 here/);
});

test("collapsed shows a bounded preview of a long plan", async () => {
  const tool = await loadPlanReady();
  const plan = `# Long\n\n${"- item line to pad the plan out\n".repeat(1500)}Final sentinel line`;
  const out = renderPlan(tool, { plan }, false);

  // Header line carries the source line count.
  assert.match(out, /^Plan ready · \d+ lines/);
  // The expand hint and tail live on their own rows.
  assert.match(out, /to expand/);
  // Preview exposes the first content lines ...
  assert.match(out, /Long/);
  assert.match(out, /item line to pad the plan out/);
  // ... the block is bounded: header + 10 preview rows + '... more' row.
  const rowCount = out.split("\n").length;
  assert.ok(rowCount <= 13, `bounded rows, got ${rowCount}`);
  // ... and content past the cap stays hidden.
  assert.doesNotMatch(out, /Final sentinel line/, "tail stays hidden");
});

test("collapsed short plan omits the expand hint", async () => {
  const tool = await loadPlanReady();
  const out = renderPlan(tool, { plan: "# Plan\n\n- one\n- two" }, false);

  // No hint and no 'more rows' when the preview already shows everything.
  assert.match(out, /^Plan ready · 4 lines/);
  assert.doesNotMatch(out, /to expand/);
  assert.doesNotMatch(out, /more/);
  assert.match(out, /- one/);
  assert.match(out, /- two/);
});

test("collapsed line-count boundaries at the preview cap", async () => {
  const tool = await loadPlanReady();
  // One line.
  const one = renderPlan(tool, { plan: "just a line" }, false);
  assert.match(one, /^Plan ready · 1 lines/);
  // Exactly at the cap: no hint, no 'more', all rows shown.
  const atCap = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );
  const ten = renderPlan(tool, { plan: atCap }, false);
  assert.match(ten, /^Plan ready · 10 lines/);
  assert.doesNotMatch(ten, /to expand/);
  assert.doesNotMatch(ten, /more/);
  assert.match(ten, /line 10/);
  // One past the cap: hint and '... (N more rows)' appear; row 11 hidden.
  const pastCap = Array.from({ length: 11 }, (_, i) => `line ${i + 1}`).join(
    "\n",
  );
  const eleven = renderPlan(tool, { plan: pastCap }, false);
  assert.match(eleven, /^Plan ready · 11 lines/);
  assert.match(eleven, /to expand/);
  assert.match(eleven, /\.\.\. \(1 more rows\)/);
  assert.match(eleven, /line 10/);
  assert.doesNotMatch(eleven, /line 11/);
});

test("collapsed counts a trailing newline", async () => {
  const tool = await loadPlanReady();
  // "a\n".split("\n") → ["a", ""] → the trailing empty element counts.
  const out = renderPlan(tool, { plan: "a\n" }, false);
  assert.match(out, /^Plan ready · 2 lines/);
});

test("collapsed preview wraps unbroken long lines at narrow width", async () => {
  const tool = await loadPlanReady();
  const plan = "short start\n" + "x".repeat(400) + "\nend line\n";
  const component = tool.renderResult?.(
    { details: { plan } },
    { expanded: false },
    THEME,
  );
  assert.ok(component, "renderResult must return a component");
  const lines = stripAnsi(component.render(40).join("\n")).split("\n");
  assert.ok(
    lines.every((line) => visibleWidth(line) <= 40),
    "no overflow beyond width",
  );
  assert.match(lines.join("\n"), /^Plan ready · 4 lines/);
  // The preview must stay bounded in rendered rows (header + preview + tail),
  // not just keep each row within the width.
  assert.ok(lines.length <= 13, `bounded rows, got ${lines.length}`);
});

test("collapsed long single line stays bounded at a narrow width", async () => {
  const tool = await loadPlanReady();
  // A 47k-char single source line (under MAX_READY_PLAN_CHARS) wraps into
  // more than a thousand rows at width 40; the preview must clip by rendered
  // rows, keep the expand hint, and never flood the transcript.
  const plan = "a".repeat(47_000);
  const component = tool.renderResult?.(
    { details: { plan } },
    { expanded: false },
    THEME,
  );
  assert.ok(component, "renderResult must return a component");
  const lines = stripAnsi(component.render(40).join("\n")).split("\n");
  assert.ok(
    lines.every((line) => visibleWidth(line) <= 40),
    "every row fits the viewport width",
  );
  assert.ok(lines.length <= 13, `bounded rows, got ${lines.length}`);
  // The hint is not a header suffix: it survives on its own row even
  // though the header ("Plan ready · 1 lines") plus the preview already
  // fill a 40-wide viewport. The hint row is keybinding-aware in a real
  // layout ("ctrl+o to expand"), so assert structurally: a row that
  // contains the hint text and is not the header.
  assert.ok(
    lines.some(
      (line) => line.includes("to expand") && !line.includes("Plan ready"),
    ),
    "hint is its own leading row, not a clipped header tail",
  );
  assert.match(
    lines.join("\n"),
    /\.\.\. \(\d+ more rows\)/,
    "rendered-row tail surfaces",
  );
});

test("collapsed preview handles wide glyphs at a narrow width", async () => {
  const tool = await loadPlanReady();
  const plan = [
    "# 中文计划标题",
    "",
    "- 步骤一：迁移队列",
    "- 步骤二：停写",
    "",
    "\uD83C\uDF89 完成",
    "很长的中文段落".repeat(50),
  ].join("\n");
  const component = tool.renderResult?.(
    { details: { plan } },
    { expanded: false },
    THEME,
  );
  assert.ok(component, "renderResult must return a component");
  const lines = stripAnsi(component.render(40).join("\n")).split("\n");
  assert.ok(
    lines.every((line) => visibleWidth(line) <= 40),
    "wide glyphs never overflow the viewport width",
  );
  assert.ok(lines.length <= 13, `bounded rows, got ${lines.length}`);
  assert.match(lines.join("\n"), /中文计划标题/, "preview keeps wide content");
  assert.match(
    lines.join("\n"),
    /to expand/,
    "hint surfaces for clipped wide content",
  );
});

test("collapsed preview stays bounded and width-clean on a wide viewport", async () => {
  const tool = await loadPlanReady();
  // 25 source lines that do not wrap at a wide width: rendered rows equal
  // source lines, the preview clips past the 10-row cap (so hint + tail must
  // appear), and no row may ever exceed the viewport width.
  const plan = Array.from(
    { length: 25 },
    (_, i) => `任务 ${i + 1} - "${"x".repeat(60)}"`,
  ).join("\n");
  const component = tool.renderResult?.(
    { details: { plan } },
    { expanded: false },
    THEME,
  );
  assert.ok(component, "renderResult must return a component");
  const width = 3000;
  const lines = stripAnsi(component.render(width).join("\n")).split("\n");
  assert.ok(
    lines.every((line) => visibleWidth(line) <= width),
    "no preview row exceeds the wide viewport",
  );
  assert.ok(lines.length <= 13, `bounded rows, got ${lines.length}`);
  assert.match(lines.join("\n"), /^Plan ready · 25 lines/);
  assert.match(lines.join("\n"), /to expand/);
  // Tail count is the rendered-row delta (body rows minus the 10-row cap),
  // cross-checked against the same wrapping primitive the renderer uses.
  const bodyRows = wrapTextWithAnsi(plan, width).length;
  assert.match(
    lines.join("\n"),
    new RegExp(`\\.\\.\\. \\(${bodyRows - 10} more rows\\)`),
    "wide-viewport tail matches the rendered-row delta",
  );
});

test("collapsed preview tolerates degenerate viewport widths", async () => {
  const tool = await loadPlanReady();
  const plan = ["# x", "", "body line", "second body line"].join("\n");
  for (const width of [0, 1]) {
    const component = tool.renderResult?.(
      { details: { plan } },
      { expanded: false },
      THEME,
    );
    assert.ok(component, "renderResult must return a component");
    const lines = stripAnsi(component.render(width).join("\n")).split("\n");
    assert.ok(lines.length >= 1, "still renders at degenerate width");
    assert.ok(
      lines.every((line) => visibleWidth(line) <= 1),
      "rows stay within the degenerate width",
    );
    assert.ok(
      lines.every((line) => !line.includes("\uFFFD")),
      "no broken surrogate artifacts at degenerate width",
    );
  }
});

test("rendering is stable across repeated calls", async () => {
  const tool = await loadPlanReady();
  const plan = "# Plan\n\n- one\n- two\n";
  assert.equal(
    renderPlan(tool, { plan }, false),
    renderPlan(tool, { plan }, false),
    "collapsed output is deterministic",
  );
  assert.equal(
    renderPlan(tool, { plan }, true),
    renderPlan(tool, { plan }, true),
    "expanded output is deterministic",
  );
});

test("expanded survives edge-content plans at extreme widths", async () => {
  const tool = await loadPlanReady();
  // Plan text is model-generated Markdown, so renderers must not throw or
  // corrupt output on hostile-but-plausible content, at any viewport width.
  // (width=1 is excluded from the width-discipline check: pi-tui's wrapper
  // keeps a wide glyph whole rather than splitting it, one cell over — the
  // expanded view is deliberately untruncated, so this is accepted upstream.)
  const edgePlans: Record<string, string> = {
    "47k-single-line": "a".repeat(47_000),
    "huge-table": [
      "| col0 | col1 | col2 | col3 | col4 | col5 | col6 | col7 | col8 | col9 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      "| v0 | v1 | v2 | v3 | v4 | v5 | v6 | v7 | v8 | v9 |",
      "| w0 | w1 | w2 | w3 | w4 | w5 | w6 | w7 | w8 | w9 |",
    ].join("\n"),
    "long-link": `[label](https://example.com/${"x".repeat(10_000)})`,
    "unclosed-html": "<b>bold without close & <i>italic",
    "nested-fence": "```\n```js\ncode\n```\n```",
    "zwj-family": "family 👨‍👩‍👧‍👦 and 👩‍👩‍👧‍👦 repeated ".repeat(50),
    flags: "🇨🇳 🇺🇸 🇯🇵 ".repeat(100),
  };
  for (const [name, plan] of Object.entries(edgePlans)) {
    for (const width of [0, 1, 40, 200, 100000]) {
      const component = tool.renderResult?.(
        { details: { plan } },
        { expanded: true },
        THEME,
      );
      assert.ok(component, `${name} @ ${width}: must return a component`);
      const rows = component.render(width); // must not throw
      const cleaned = rows.map(stripAnsi);
      assert.ok(
        cleaned.every((row) => !/\x1b/.test(row)),
        `${name} @ ${width}: ANSI leaked past strip`,
      );
      if (width >= 2) {
        assert.ok(
          cleaned.every((row) => visibleWidth(row) <= width),
          `${name} @ ${width}: row wider than viewport`,
        );
      }
    }
  }
});

test("collapsed preview stays clean on grapheme-heavy plans", async () => {
  const tool = await loadPlanReady();
  // The collapsed renderer truncates every row with truncateToWidth, which
  // must never split a grapheme cluster (ZWJ families, flags, combining
  // marks), or surface a broken character at degenerate widths. Note the
  // plan is always pre-sanitized (sanitizeTerminalText strips OSC/ESC), so
  // escape-bearing input is out of contract here; existing SGR styling is
  // handled by truncateToWidth's own ANSI tracking.
  const graphemePlans: Record<string, string> = {
    zwj: "👨‍👩‍👧‍👦".repeat(100),
    flags: "🇨🇳".repeat(100),
    combining: "e\u0301".repeat(200),
    "emoji-only": "🎉".repeat(200),
  };
  for (const [name, plan] of Object.entries(graphemePlans)) {
    for (const width of [0, 1, 2, 3, 40]) {
      const component = tool.renderResult?.(
        { details: { plan } },
        { expanded: false },
        THEME,
      );
      assert.ok(component, `${name} @ ${width}: must return a component`);
      const rows = component.render(width); // must not throw
      const cleaned = rows.map(stripAnsi);
      assert.ok(
        cleaned.every((row) => !/\x1b/.test(row)),
        `${name} @ ${width}: ANSI leaked past strip`,
      );
      if (width >= 1) {
        assert.ok(
          cleaned.every((row) => visibleWidth(row) <= width),
          `${name} @ ${width}: row wider than viewport`,
        );
      }
      assert.ok(
        rows.length <= 13,
        `${name} @ ${width}: bounded rows, got ${rows.length}`,
      );
      assert.ok(
        cleaned.every((row) => !row.includes("\uFFFD")),
        `${name} @ ${width}: replacement character surfaced`,
      );
    }
  }
});

test("failed plan_ready results surface the real error message", async () => {
  const tool = await loadPlanReady();
  // agent-loop's createErrorToolResult produces {content:[{text}], details:{}}
  // for every failure (not in plan mode, empty plan, size cap, abort, block);
  // the renderer must surface the reason instead of "(no plan content)".
  for (const expanded of [false, true]) {
    const component = tool.renderResult?.(
      {
        content: [
          { type: "text", text: "plan_ready requires active Plan Mode." },
        ],
        details: {},
      },
      { expanded },
      THEME,
    );
    assert.ok(component, "renderResult must return a component");
    const out = stripAnsi(component.render(200).join("\n"));
    assert.match(
      out,
      /requires active Plan Mode/,
      "error reason is surfaced in both states",
    );
    assert.doesNotMatch(out, /no plan content/, "placeholder not shown");
  }
  // With neither plan nor content, keep the placeholder.
  const empty = tool.renderResult?.(
    { content: [], details: {} },
    { expanded: false },
    THEME,
  );
  assert.ok(empty, "renderResult must return a component");
  assert.match(stripAnsi(empty.render(200).join("\n")), /no plan content/);
});

test("real ToolExecutionComponent shell keeps the preview bounded and expands fully", async () => {
  const tool = await loadPlanReady();
  const plan = "task x\n".repeat(40);
  const definition = {
    name: "plan_ready",
    renderShell: "default",
    renderCall: undefined,
    renderResult: tool.renderResult,
  } as unknown as ToolDefinition;
  const ui = { requestRender() {} } as unknown as TUI;
  const component = new ToolExecutionComponent(
    "plan_ready",
    "plan-component",
    { plan },
    { showImages: false },
    definition,
    ui,
    "/workspace",
  );
  component.markExecutionStarted();
  component.setArgsComplete();
  component.updateResult({
    content: [{ type: "text", text: "ok" }],
    details: { plan },
    isError: false,
  });

  const nonEmpty = () =>
    component
      .render(42)
      .map((line) => stripVTControlCharacters(line))
      .filter((line) => line.trim() !== "");

  // Box(1,1) shell: tool title row + bounded preview (content width 40).
  const rows = nonEmpty();
  assert.ok(
    rows.length >= 13 && rows.length <= 15,
    `shell keeps the preview bounded, got ${rows.length}`,
  );
  assert.ok(
    rows.every((row) => visibleWidth(row) <= 42),
    "shell rows fit the outer viewport width",
  );
  assert.match(rows.join("\n"), /Plan ready · 41 lines/);
  assert.match(rows.join("\n"), /to expand/);
  assert.match(rows.join("\n"), /\.\.\. \(\d+ more rows\)/);

  component.setExpanded(true);
  const expanded = nonEmpty();
  assert.ok(
    expanded.length > rows.length,
    "expanded shows the full plan, not the bounded preview",
  );
  assert.ok(
    expanded.some((row) => row.includes("task x")),
    "expanded keeps plan content",
  );

  component.setExpanded(false);
  assert.deepEqual(nonEmpty(), rows, "collapse restores the exact preview");
});

test("collapsed component invalidates cleanly and stays bounded across widths", async () => {
  const tool = await loadPlanReady();
  const plan = "line x\n".repeat(30);
  const component = tool.renderResult?.(
    { details: { plan } },
    { expanded: false },
    THEME,
  );
  assert.ok(component, "renderResult must return a component");
  const before = component.render(40);
  assert.equal(typeof component.invalidate, "function");
  component.invalidate?.();
  assert.deepEqual(
    component.render(40),
    before,
    "invalidate must not change the output",
  );
  assert.ok(component.render(3000).length <= 13, "wide render stays bounded");
  assert.ok(component.render(40).length <= 13, "narrow render stays bounded");
});

test("expanded restores the full plan", async () => {
  const tool = await loadPlanReady();
  const plan = `# Long\n\n${"- item line to pad the plan out\n".repeat(1500)}Final sentinel line`;
  const out = renderPlan(tool, { plan }, true);

  assert.match(out, /Long/);
  assert.match(out, /item line to pad the plan out/);
  assert.match(out, /Final sentinel line/, "tail restorable when expanded");
  assert.doesNotMatch(
    out,
    /^Plan ready · /,
    "no collapsed summary when expanded",
  );
});
