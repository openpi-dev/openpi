import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import {
  CURSOR_MARKER,
  Editor,
  ProcessTerminal,
  stripTerminalSequences,
  TuiMainScreen,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  CapabilityIntentHighlightEditor,
  colorCapabilityKeyword,
  highlightCapabilityNames,
  isLightNamedTheme,
} from "../../../extensions/capabilities/src/ui.ts";
import { capabilitiesRequestedByPrompt } from "../../../extensions/shared/capability-intent.ts";
import {
  NextActionSuggestionEditor,
  NextActionSuggestionState,
} from "../../../extensions/suggestions/src/ui.ts";

function baseEditor(initial: string): EditorComponent {
  let text = initial;
  return {
    render: () => [text],
    invalidate() {},
    handleInput() {},
    getText: () => text,
    setText(value: string) {
      text = value;
    },
  };
}

function editor(initial: string) {
  const base = baseEditor(initial);
  return {
    base,
    highlighted: new CapabilityIntentHighlightEditor(
      base,
      {} as KeybindingsManager,
      (text) => `<accent>${text}</accent>`,
    ),
  };
}

test("uses Claude-style lavender with a contrast-safe light variant", () => {
  assert.equal(isLightNamedTheme("light"), true);
  assert.equal(isLightNamedTheme("github-light-default"), true);
  assert.equal(isLightNamedTheme("dark"), false);
  assert.equal(isLightNamedTheme(undefined), false);

  assert.equal(
    colorCapabilityKeyword("subagent", {
      colorMode: "truecolor",
      light: false,
    }),
    "\u001b[38;2;210;168;255msubagent\u001b[39m",
  );
  assert.equal(
    colorCapabilityKeyword("workflow", {
      colorMode: "256color",
      light: false,
    }),
    "\u001b[38;5;183mworkflow\u001b[39m",
  );
  assert.equal(
    colorCapabilityKeyword("subagent", {
      colorMode: "truecolor",
      light: true,
    }),
    "\u001b[38;2;130;80;223msubagent\u001b[39m",
  );
  assert.equal(
    colorCapabilityKeyword("workflow", {
      colorMode: "256color",
      light: true,
    }),
    "\u001b[38;5;98mworkflow\u001b[39m",
  );
});

test("shimmer phase changes only the keyword colors", () => {
  const first = colorCapabilityKeyword(
    "workflow",
    { colorMode: "truecolor", light: false },
    0,
  );
  const second = colorCapabilityKeyword(
    "workflow",
    { colorMode: "truecolor", light: false },
    0.4,
  );
  assert.notEqual(first, second);
  assert.match(first, /^\u001b\[38;2;\d+;\d+;\d+m/u);
  assert.equal(
    first.replace(/\u001b\[38;2;\d+;\d+;\d+m/gu, "").replace("\u001b[39m", ""),
    "workflow",
  );
  assert.equal(
    colorCapabilityKeyword(
      "workflow",
      { colorMode: "256color", light: false },
      0.4,
    ),
    "\u001b[38;5;183mworkflow\u001b[39m",
  );
});

test("highlights shared name mentions without deciding execution intent", () => {
  for (const name of ["subagent", "Subagents", "workflow", "Workflows"]) {
    const selected = editor(name);
    assert.deepEqual(selected.highlighted.render(120), [
      `<accent>${name}</accent>`,
    ]);
    assert.equal(selected.highlighted.getText(), name);
  }

  const reserved = editor("subagent, workflow");
  assert.deepEqual(reserved.highlighted.render(120), [
    "<accent>subagent</accent>, <accent>workflow</accent>",
  ]);

  const explicit = editor("用 Subagent 检查，再用 Workflow 汇总");
  assert.deepEqual(explicit.highlighted.render(120), [
    "用 <accent>Subagent</accent> 检查，再用 <accent>Workflow</accent> 汇总",
  ]);

  const leadingChinese = editor("子代理了解下项目");
  assert.deepEqual(leadingChinese.highlighted.render(120), [
    "<accent>子代理</accent>了解下项目",
  ]);

  const named = editor("Subagent 和 Workflow 有什么区别？");
  assert.deepEqual(named.highlighted.render(120), [
    "<accent>Subagent</accent> 和 <accent>Workflow</accent> 有什么区别？",
  ]);

  const negated = editor("不要用 Subagent，也不要用 Workflow");
  assert.deepEqual(negated.highlighted.render(120), [
    "不要用 <accent>Subagent</accent>，也不要用 <accent>Workflow</accent>",
  ]);

  const discussion = editor("子代理是什么？");
  assert.deepEqual(discussion.highlighted.render(120), [
    "<accent>子代理</accent>是什么？",
  ]);
});

test("supports English plurals and Chinese capability names", () => {
  assert.equal(
    highlightCapabilityNames(
      "Use Subagents and 子代理",
      ["delegate"],
      (text) => `[${text}]`,
    ),
    "Use [Subagents] and [子代理]",
  );
  assert.equal(
    highlightCapabilityNames(
      "运行 Workflows 和工作流",
      ["workflow"],
      (text) => `[${text}]`,
    ),
    "运行 [Workflows] 和[工作流]",
  );
});

test("render feedback never mutates the submitted editor text", () => {
  const value = "用 Subagent 检查";
  const current = editor(value);
  current.highlighted.render(80);
  assert.equal(current.highlighted.getText(), value);
  assert.equal(current.base.getText(), value);
});

test("ghost suggestions stay dim until the user accepts them into the editor", () => {
  let text = "";
  const base = {
    render: (width: number) => [
      text || `${CURSOR_MARKER}\u001b[7m \u001b[0m${" ".repeat(width - 1)}`,
    ],
    invalidate() {},
    handleInput() {},
    getText: () => text,
    setText(value: string) {
      text = value;
    },
  } satisfies EditorComponent;
  const highlighted = new CapabilityIntentHighlightEditor(
    base,
    {} as KeybindingsManager,
    (value) => `<accent>${value}</accent>`,
  );
  const state = new NextActionSuggestionState();
  const suggestion = new NextActionSuggestionEditor(
    highlighted,
    {} as KeybindingsManager,
    state,
    () => state.cancel(),
    () => undefined,
    (value) => `<dim>${value}</dim>`,
  );
  state.offer(state.begin(), "用 Subagent 检查", true);

  assert.doesNotMatch(suggestion.render(80).join("\n"), /<accent>/u);
  assert.deepEqual(capabilitiesRequestedByPrompt(base.getText()), []);

  suggestion.handleInput("\u001b[C");
  assert.equal(base.getText(), "用 Subagent 检查");
  assert.deepEqual(capabilitiesRequestedByPrompt(base.getText()), ["delegate"]);
  assert.match(suggestion.render(80).join("\n"), /<accent>Subagent<\/accent>/u);
});

test("render name boundaries match discovery and preserve native ANSI/cursor bytes", () => {
  const plain = "subagent.ts Subagents workflow_status 工作流";
  assert.equal(
    highlightCapabilityNames(
      plain,
      ["delegate", "workflow"],
      (name) => `[${name}]`,
    ),
    "subagent.ts [Subagents] workflow_status [工作流]",
  );
  const rendered = `sub${CURSOR_MARKER}\u001b[7ma\u001b[27mgent and \u001b[32mworkflow\u001b[39m`;
  assert.equal(
    highlightCapabilityNames(
      rendered,
      ["delegate", "workflow"],
      (name) => `[${name}]`,
    ),
    `[sub]${CURSOR_MARKER}\u001b[7m[a]\u001b[27m[gent] and \u001b[32m[workflow]\u001b[39m`,
  );
});

test("multiple committed input lines highlight names without changing text", () => {
  const text = "讨论 subagent\n不要用工作流";
  const base = baseEditor(text);
  base.render = () => text.split("\n");
  const highlighted = new CapabilityIntentHighlightEditor(
    base,
    {} as KeybindingsManager,
    (name) => `[${name}]`,
  );
  assert.deepEqual(highlighted.render(80), [
    "讨论 [subagent]",
    "不要用[工作流]",
  ]);
  assert.equal(highlighted.getText(), text);
});

test("locked native editor preserves cursor, text and widths when a name is decorated", () => {
  const identity = (text: string) => text;
  const base = new Editor(new TuiMainScreen(new ProcessTerminal()), {
    borderColor: identity,
    selectList: {
      selectedPrefix: identity,
      selectedText: identity,
      description: identity,
      scrollInfo: identity,
      noMatch: identity,
    },
  });
  base.focused = true;
  base.setText("讨论 subagent\n不要用 workflow");
  // Move the native reverse-video cursor inside the second capability name.
  base.handleInput("\u001b[D");
  base.handleInput("\u001b[D");
  const before = base.render(80);
  const highlighted = new CapabilityIntentHighlightEditor(
    base,
    {} as KeybindingsManager,
    (text) =>
      colorCapabilityKeyword(text, { colorMode: "truecolor", light: false }),
  );
  const after = highlighted.render(80);
  assert.equal(base.getText(), "讨论 subagent\n不要用 workflow");
  assert.deepEqual(
    after.map(stripTerminalSequences),
    before.map(stripTerminalSequences),
  );
  assert.deepEqual(after.map(visibleWidth), before.map(visibleWidth));
  assert.deepEqual(
    after.join("\n").match(/\u001b_pi:(?:c|\/?fc)\u0007/gu),
    before.join("\n").match(/\u001b_pi:(?:c|\/?fc)\u0007/gu),
  );
  assert.equal(after.join("\n").split(CURSOR_MARKER).length, 2);
  assert.equal(before.join("\n").split(CURSOR_MARKER).length, 2);
  assert.match(after.join("\n"), /\u001b\[38;2;210;168;255m/u);
  assert.equal(
    after.join("\n").includes("\u001b[7m"),
    before.join("\n").includes("\u001b[7m"),
  );
});

function nativeProjection(text: string, width: number, padding = 0) {
  const identity = (value: string) => value;
  const base = new Editor(
    new TuiMainScreen(new ProcessTerminal()),
    {
      borderColor: identity,
      selectList: {
        selectedPrefix: identity,
        selectedText: identity,
        description: identity,
        scrollInfo: identity,
        noMatch: identity,
      },
    },
    { paddingX: padding },
  );
  base.focused = true;
  base.setText(text);
  const highlight = (value: string) =>
    colorCapabilityKeyword(value, { colorMode: "truecolor", light: false });
  const wrapped = new CapabilityIntentHighlightEditor(
    base,
    {} as KeybindingsManager,
    highlight,
  );
  const before = base.render(width);
  const after = wrapped.render(width);
  assert.equal(base.getText(), text);
  assert.deepEqual(
    after.map(stripTerminalSequences),
    before.map(stripTerminalSequences),
  );
  assert.deepEqual(after.map(visibleWidth), before.map(visibleWidth));
  assert.equal(
    after.join("\n").split(CURSOR_MARKER).length,
    before.join("\n").split(CURSOR_MARKER).length,
  );
  return { base, wrapped, before, after };
}

const accent = "\u001b[38;2;210;168;255m";

test("native narrow wrapping uses original mention offsets, not filename or identifier row text", () => {
  for (const suffix of ["workflow.ts", "workflow_status", "my_workflow"]) {
    const { after } = nativeProjection(`workflow\n${suffix}`, 9);
    assert.equal(after.filter((row) => row.includes(accent)).length, 1, suffix);
    assert.match(after[1]!, /\u001b\[38;2;210;168;255mworkflow/u);
  }
});

test("native name fragments across soft wraps keep their original range, cursor and padding", () => {
  for (const text of ["subagent", "workflow", "子代理"]) {
    const { after } = nativeProjection(text, 5, 1);
    const content = after.slice(1, -1);
    assert.ok(content.length > 1, text);
    assert.ok(
      content.every((row) => row.includes(accent)),
      text,
    );
  }
  const { base, wrapped } = nativeProjection("subagent", 5);
  base.handleInput("\u001b[D");
  base.handleInput("\u001b[D");
  const before = base.render(5);
  const after = wrapped.render(5);
  assert.deepEqual(
    after.map(stripTerminalSequences),
    before.map(stripTerminalSequences),
  );
  assert.deepEqual(after.map(visibleWidth), before.map(visibleWidth));
  assert.equal(
    after.slice(1, -1).filter((row) => row.includes(accent)).length,
    2,
  );
});

test("native viewport anchors repeated rows to their source and leaves appended chrome untouched", () => {
  const text = `${"workflow.ts\n".repeat(12)}workflow`;
  const { base, wrapped } = nativeProjection(text, 9);
  const render = base.render.bind(base);
  base.render = (width) => [...render(width), "workflow"];
  const after = wrapped.render(9);
  assert.equal(after.filter((row) => row.includes(accent)).length, 1);
  assert.equal(after.at(-1), "workflow");
  // An empty cursor line is still a source anchor for preceding mentions.
  assert.equal(
    nativeProjection("workflow\n", 9).after.filter((row) =>
      row.includes(accent),
    ).length,
    1,
  );
});

test("unknown custom editor geometry preserves output without guessing hint ownership", () => {
  const base = baseEditor("workflow");
  base.render = () => ["workflow", "workflow hint"];
  const wrapped = new CapabilityIntentHighlightEditor(
    base,
    {} as KeybindingsManager,
    (name) => `[${name}]`,
  );
  assert.deepEqual(wrapped.render(9), ["workflow", "workflow hint"]);
});
