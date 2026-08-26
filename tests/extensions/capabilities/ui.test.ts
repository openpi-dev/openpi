import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import {
  NextActionSuggestionEditor,
  NextActionSuggestionState,
} from "../../../extensions/suggestions/src/ui.ts";
import {
  CapabilityIntentHighlightEditor,
  colorCapabilityKeyword,
  highlightCapabilityNames,
  isLightNamedTheme,
} from "../../../extensions/capabilities/src/ui.ts";

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

test("highlights capability names only when shared intent authorizes them", () => {
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
    "不要用 Subagent，也不要用 Workflow",
  ]);

  const discussion = editor("子代理是什么？");
  assert.deepEqual(discussion.highlighted.render(120), ["子代理是什么？"]);
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

  suggestion.handleInput("\u001b[C");
  assert.equal(base.getText(), "用 Subagent 检查");
  assert.match(suggestion.render(80).join("\n"), /<accent>Subagent<\/accent>/u);
});
