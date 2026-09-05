import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  initTheme,
  type AgentToolResult,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { withActivityRenderer } from "../../../extensions/file-mutation-display/render.ts";

initTheme("dark", false);

const theme = new Proxy(
  {},
  {
    get: (_target, property) =>
      property === "fg" || property === "bg"
        ? (_color: string, text: string) => text
        : (text: string) => text,
  },
) as Theme;

const cwd = "/workspace";

function modelSurfaceHash(definition: ToolDefinition<any, any, any>) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        promptSnippet: definition.promptSnippet,
        promptGuidelines: definition.promptGuidelines,
        constrainedSampling: definition.constrainedSampling,
        prepareArguments: definition.prepareArguments?.toString(),
        executionMode: definition.executionMode,
      }),
    )
    .digest("hex");
}

const fixtures: Array<{
  name: string;
  icon: string;
  definition: ToolDefinition<any, any, any>;
  args: Record<string, any>;
  result: AgentToolResult<any>;
  success: RegExp;
}> = [
  {
    name: "read",
    icon: "\ueaa4",
    definition: createReadToolDefinition(cwd),
    args: { path: `${cwd}/src/long-file.ts`, offset: 10, limit: 20 },
    result: {
      content: [{ type: "text", text: "one\ntwo" }],
      details: undefined,
    },
    success: /Read\s+src[\\/]long-file\.ts:10-29/,
  },
  {
    name: "bash",
    icon: "\uea85",
    definition: createBashToolDefinition(cwd),
    args: { command: 'rg -n "renderCall|renderResult" extensions' },
    result: {
      content: [{ type: "text", text: "one\ntwo" }],
      details: undefined,
    },
    success: /Ran\s+rg -n/,
  },
  {
    name: "write",
    icon: "\uea73",
    definition: createWriteToolDefinition(cwd),
    args: { path: "src/new.ts", content: "one\ntwo\nthree\n" },
    result: {
      content: [
        {
          type: "text",
          text: "Successfully wrote 14 bytes to src/new.ts",
        },
      ],
      details: undefined,
    },
    success: /Wrote\s+src\/new\.ts\s+3 lines/,
  },
  {
    name: "edit",
    icon: "\uea73",
    definition: createEditToolDefinition(cwd),
    args: {
      path: "README.md",
      edits: [{ oldText: "old", newText: "new\nsecond" }],
    },
    result: {
      content: [
        {
          type: "text",
          text: "Successfully replaced 1 block(s) in README.md.",
        },
      ],
      details: {
        diff: "  before\n-old\n+new\n+second\n  after",
        patch: "@@ -1 +1,2 @@\n-old\n+new\n+second",
      },
    },
    success: /Edited\s+README\.md\s+\+2 -1/,
  },
  {
    name: "grep",
    icon: "\uea6d",
    definition: createGrepToolDefinition(cwd),
    args: { pattern: "renderCall", path: "extensions" },
    result: {
      content: [
        {
          type: "text",
          text: "a.ts:1:renderCall\nb.ts:2:renderCall",
        },
      ],
      details: undefined,
    },
    success: /Searched\s+renderCall\s+in extensions\s+2 matches/,
  },
  {
    name: "find",
    icon: "\uea6d",
    definition: createFindToolDefinition(cwd),
    args: { pattern: "**/*.ts", path: "extensions" },
    result: {
      content: [{ type: "text", text: "a.ts\nb.ts\nc.ts" }],
      details: undefined,
    },
    success: /Searched\s+\*\*\/\*\.ts\s+in extensions\s+3 results/,
  },
  {
    name: "ls",
    icon: "\uea83",
    definition: createLsToolDefinition(cwd),
    args: { path: cwd },
    result: {
      content: [{ type: "text", text: "a/\nb/\nfile.ts" }],
      details: undefined,
    },
    success: /Listed\s+\.\s+3 entries/,
  },
];

function renderCollapsed(
  definition: ToolDefinition<any, any, any>,
  args: Record<string, unknown>,
  result?: AgentToolResult<any>,
  isError = false,
  width = 120,
  renderTheme = theme,
) {
  const state = {};
  const context = {
    args,
    toolCallId: "call-1",
    invalidate() {},
    lastComponent: undefined,
    state,
    cwd,
    executionStarted: true,
    argsComplete: true,
    isPartial: result === undefined,
    expanded: false,
    showImages: false,
    isError,
  };
  const call = definition.renderCall?.(args, renderTheme, context);
  assert.ok(call);
  let resultComponent: Component | undefined;
  if (result) {
    resultComponent = definition.renderResult?.(
      result,
      { expanded: false, isPartial: false },
      renderTheme,
      { ...context, isPartial: false, isError },
    );
  }
  return [
    ...call.render(width),
    ...(resultComponent?.render(width) ?? []),
  ].filter((line) => line.trim().length > 0);
}

function recordingTheme(calls: Array<[string, string]>) {
  return new Proxy(
    {},
    {
      get: (_target, property) =>
        property === "fg" || property === "bg"
          ? (color: string, text: string) => {
              calls.push([color, text]);
              return text;
            }
          : (text: string) => text,
    },
  ) as Theme;
}

const ANSI_MUTED = "\x1b[38;5;244m";
const ANSI_FG_RESET = "\x1b[39m";

const ansiTheme = new Proxy(
  {},
  {
    get: (_target, property) =>
      property === "fg" || property === "bg"
        ? (color: string, text: string) =>
            color === "muted" ? `${ANSI_MUTED}${text}${ANSI_FG_RESET}` : text
        : (text: string) => text,
  },
) as Theme;

test("all activity tools render one semantic success row", () => {
  for (const fixture of fixtures) {
    const definition = withActivityRenderer(fixture.definition);
    const lines = renderCollapsed(definition, fixture.args, fixture.result);
    assert.equal(lines.length, 1, fixture.name);
    assert.equal(lines[0]?.at(2), fixture.icon, fixture.name);
    assert.ok(lines[0]?.startsWith("  "), fixture.name);
    assert.ok(lines[0]?.endsWith("  "), fixture.name);
    assert.match(lines[0] ?? "", fixture.success, fixture.name);
  }
});

test("completed targets are muted without weakening pending or failed targets", () => {
  const definition = withActivityRenderer(createBashToolDefinition(cwd));
  const args = { command: "bun run check" };

  const successColors: Array<[string, string]> = [];
  renderCollapsed(
    definition,
    args,
    { content: [{ type: "text", text: "ok" }], details: undefined },
    false,
    120,
    recordingTheme(successColors),
  );
  assert.ok(
    successColors.some(
      ([color, text]) => color === "muted" && text === args.command,
    ),
  );

  const cases: Array<{
    label: string;
    result?: AgentToolResult<any>;
    isError: boolean;
  }> = [
    { label: "pending", isError: false },
    {
      label: "failed",
      result: {
        content: [{ type: "text", text: "failed" }],
        details: undefined,
      },
      isError: true,
    },
  ];
  for (const { label, result, isError } of cases) {
    const calls: Array<[string, string]> = [];
    renderCollapsed(
      definition,
      args,
      result,
      isError,
      120,
      recordingTheme(calls),
    );
    assert.equal(
      calls.some(([color, text]) => color === "muted" && text === args.command),
      false,
      label,
    );
  }
});

test("wrapping changes only renderer slots and shell ownership", () => {
  for (const fixture of fixtures) {
    const native = fixture.definition;
    const wrapped = withActivityRenderer(native);
    assert.equal(wrapped.name, native.name, fixture.name);
    assert.equal(wrapped.label, native.label, fixture.name);
    assert.equal(wrapped.description, native.description, fixture.name);
    assert.equal(wrapped.parameters, native.parameters, fixture.name);
    assert.equal(wrapped.promptSnippet, native.promptSnippet, fixture.name);
    assert.equal(
      wrapped.promptGuidelines,
      native.promptGuidelines,
      fixture.name,
    );
    assert.equal(wrapped.execute, native.execute, fixture.name);
    assert.equal(wrapped.renderShell, "self", fixture.name);
    assert.equal(
      modelSurfaceHash(wrapped),
      modelSurfaceHash(native),
      `${fixture.name} model surface hash`,
    );
  }
});

test("all activity tools render pending and failure as one explicit row", () => {
  for (const fixture of fixtures) {
    const definition = withActivityRenderer(fixture.definition);
    const pending = renderCollapsed(definition, fixture.args);
    assert.equal(pending.length, 1, `${fixture.name} pending`);
    assert.match(
      pending[0] ?? "",
      /^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /,
      `${fixture.name} pending`,
    );
    assert.ok(pending[0]?.endsWith("  "), `${fixture.name} pending`);

    const failed = renderCollapsed(
      definition,
      fixture.args,
      {
        content: [
          {
            type: "text",
            text: "Permission denied\nfull diagnostic follows",
          },
        ],
        details: undefined,
      },
      true,
    );
    assert.equal(failed.length, 1, `${fixture.name} failed`);
    assert.match(failed[0] ?? "", /^ {2}✕ Failed\s+/, `${fixture.name} failed`);
    assert.ok(failed[0]?.endsWith("  "), `${fixture.name} failed`);
    assert.match(failed[0] ?? "", /Permission denied/, fixture.name);
  }
});

test("long activity rows stay one line and fit narrow terminals", () => {
  const definition = withActivityRenderer(createBashToolDefinition(cwd));
  const lines = renderCollapsed(
    definition,
    {
      command:
        "bun run test --filter a-very-long-suite-name-that-cannot-fit-on-screen",
    },
    undefined,
    false,
    24,
  );
  assert.equal(lines.length, 1);
  assert.ok(visibleWidth(lines[0]!) <= 24);
  assert.match(lines[0] ?? "", /^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Running\s+bun/);
  assert.ok(lines[0]?.endsWith("  "));
});

test("successful truncation ellipses use the target's muted foreground", () => {
  for (const fixture of fixtures) {
    const definition = withActivityRenderer(fixture.definition);
    const lines = renderCollapsed(
      definition,
      fixture.args,
      fixture.result,
      false,
      18,
      ansiTheme,
    );
    assert.equal(lines.length, 1, fixture.name);
    assert.ok(visibleWidth(lines[0]!) <= 18, fixture.name);
    assert.ok(
      lines[0]?.includes(`${ANSI_MUTED}…${ANSI_FG_RESET}`),
      fixture.name,
    );
  }

  const bash = withActivityRenderer(createBashToolDefinition(cwd));
  const args = {
    command: "bun run test --filter a-very-long-suite-name",
  };
  const pending = renderCollapsed(bash, args, undefined, false, 18, ansiTheme);
  const failed = renderCollapsed(
    bash,
    args,
    { content: [{ type: "text", text: "failed" }], details: undefined },
    true,
    18,
    ansiTheme,
  );
  assert.equal(pending[0]?.includes(`${ANSI_MUTED}…${ANSI_FG_RESET}`), false);
  assert.equal(failed[0]?.includes(`${ANSI_MUTED}…${ANSI_FG_RESET}`), false);
});

test("expanded mode delegates call and result to Pi native renderers", () => {
  for (const fixture of fixtures) {
    const native = fixture.definition;
    const wrapped = withActivityRenderer(native);
    const state = {};
    const context = {
      args: fixture.args,
      toolCallId: "call-expanded",
      invalidate() {},
      lastComponent: undefined,
      state,
      cwd,
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: true,
      showImages: false,
      isError: false,
    };
    const expectedCall = native.renderCall
      ? native.renderCall(fixture.args, theme, context).render(100)
      : [];
    const actualCall = wrapped.renderCall
      ? wrapped.renderCall(fixture.args, theme, context).render(100)
      : [];
    assert.deepEqual(actualCall, expectedCall, `${fixture.name} call`);

    const expectedResult = native.renderResult
      ? native
          .renderResult(
            fixture.result,
            { expanded: true, isPartial: false },
            theme,
            context,
          )
          .render(100)
      : [];
    const actualResult = wrapped.renderResult
      ? wrapped
          .renderResult(
            fixture.result,
            { expanded: true, isPartial: false },
            theme,
            context,
          )
          .render(100)
      : [];
    assert.deepEqual(actualResult, expectedResult, `${fixture.name} result`);
  }
});
