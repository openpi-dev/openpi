import assert from "node:assert/strict";
import test from "node:test";
import {
  initTheme,
  type MessageRenderer,
  type EntryRenderer,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripSubagentResultTransportInstruction } from "../../../extensions/subagents/src/prompt.ts";

initTheme("dark", false);

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Parameters<EntryRenderer>[2];

async function withResultDisplay(
  run: (
    getResultDisplay: () => "compact" | "full",
    setResultDisplay: (display: "compact" | "full") => void,
  ) => Promise<void>,
) {
  let display = "compact" as "compact" | "full";
  await run(
    () => display,
    (next) => {
      display = next;
    },
  );
}

test("legacy transport cleanup preserves identical text in the child answer", () => {
  const instruction =
    "(This result is already shown to the user. Act on it and relay only the decisions or next steps — do not repeat it verbatim.)";
  const childAnswer = `Subagent sa-1 "review" finished.\n\nThe child quoted this instruction:\n\n${instruction}\n\nThe actual conclusion follows.`;
  const visible = stripSubagentResultTransportInstruction(
    `${childAnswer}\n\n${instruction}`,
  );

  assert.ok(visible.includes(`quoted this instruction:\n\n${instruction}`));
  assert.ok(!visible.endsWith(`\n\n${instruction}`));
});

test("automatic subagent results split model payload from bounded UI projection", async () => {
  await withResultDisplay(async (getResultDisplay, setResultDisplay) => {
    const { default: subagents } = await import(
      "../../../extensions/subagents/index.ts"
    );
    const entryRenderers = new Map<string, EntryRenderer>();
    const messageRenderers = new Map<string, MessageRenderer>();
    const pi = {
      on() {},
      events: { on() {} },
      registerTool() {},
      getActiveTools: () => [],
      setActiveTools() {},
      registerMessageRenderer(customType: string, renderer: MessageRenderer) {
        messageRenderers.set(customType, renderer);
      },
      registerEntryRenderer(customType: string, renderer: EntryRenderer) {
        entryRenderers.set(customType, renderer);
      },
      registerCommand() {},
    } as unknown as ExtensionAPI;
    subagents(pi, { getResultDisplay });

    const entryRenderer = entryRenderers.get("subagent-result");
    const messageRenderer = messageRenderers.get("subagent-result");
    assert.ok(entryRenderer);
    assert.ok(messageRenderer);

    const instruction =
      "(This result is already shown to the user. Act on it and relay only the decisions or next steps — do not repeat it verbatim.)";
    const displayContent =
      'Subagent sa-3 "investigate plan mode" finished.\n\nPlan Mode investigation report';
    const modelContent = `${displayContent}\n\n${instruction}`;
    const entry = {
      type: "custom" as const,
      id: "entry-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: "subagent-result",
      data: {
        content: displayContent,
        details: {
          id: "sa-3",
          title: "investigate plan mode",
          status: "done" as const,
          elapsed: "2s",
        },
      },
    };

    const compact = entryRenderer(entry, { expanded: false }, theme);
    assert.ok(compact);
    const compactText = compact.render(120).join("\n");
    assert.match(compactText, /1 subagent settled/);
    assert.match(compactText, /sa-3 · investigate plan mode · done · 2s/);
    assert.match(compactText, /Results passed to main agent/);
    assert.doesNotMatch(compactText, /Plan Mode investigation report/);
    assert.doesNotMatch(compactText, /This result is already shown/);

    const expanded = entryRenderer(entry, { expanded: true }, theme);
    assert.ok(expanded);
    const expandedText = expanded.render(120).join("\n");
    assert.match(expandedText, /Plan Mode investigation report/);
    assert.doesNotMatch(expandedText, /This result is already shown/);

    const quotedInstruction = entryRenderer(
      {
        ...entry,
        id: "entry-quoted-instruction",
        data: {
          content: `${displayContent}\n\n${instruction}`,
          details: {
            ...entry.data.details,
            displayContent: `${displayContent}\n\n${instruction}`,
          },
        },
      },
      { expanded: true },
      theme,
    );
    assert.ok(quotedInstruction);
    assert.match(
      quotedInstruction.render(120).join("\n"),
      /This result is already shown to the user/,
    );

    const message = messageRenderer(
      {
        role: "custom",
        customType: "subagent-result",
        content: modelContent,
        display: false,
        details: { ...entry.data.details, displayContent },
        timestamp: Date.now(),
      },
      { expanded: true, outputPad: 0 },
      theme,
    );
    assert.ok(message);
    const messageText = message.render(120).join("\n");
    assert.match(messageText, /Plan Mode investigation report/);
    assert.doesNotMatch(messageText, /This result is already shown/);

    const legacy = entryRenderer(
      {
        ...entry,
        id: "entry-legacy",
        data: { ...entry.data, content: modelContent },
      },
      { expanded: true },
      theme,
    );
    assert.ok(legacy);
    const legacyText = legacy.render(120).join("\n");
    assert.match(legacyText, /Plan Mode investigation report/);
    assert.doesNotMatch(legacyText, /This result is already shown/);

    setResultDisplay("full");
    const fullByDefault = entryRenderer(entry, { expanded: false }, theme);
    assert.ok(fullByDefault);
    assert.match(
      fullByDefault.render(120).join("\n"),
      /Plan Mode investigation report/,
    );
    setResultDisplay("compact");

    const failureContent =
      'Subagent sa-4 "run tests" failed.\nError: child crashed\n\npartial output';
    const failure = entryRenderer(
      {
        ...entry,
        id: "entry-2",
        data: {
          content: failureContent,
          details: {
            id: "sa-4",
            title: "run tests",
            status: "error" as const,
            elapsed: "3s",
          },
        },
      },
      { expanded: false },
      theme,
    );
    assert.ok(failure);
    const failureText = failure.render(120).join("\n");
    assert.match(failureText, /x .*sa-4 · run tests · error · 3s/);
    assert.doesNotMatch(failureText, /partial output/);
    const expandedFailure = entryRenderer(
      {
        ...entry,
        id: "entry-3",
        data: {
          content: failureContent,
          details: {
            id: "sa-4",
            title: "run tests",
            status: "error" as const,
            elapsed: "3s",
          },
        },
      },
      { expanded: true },
      theme,
    );
    assert.ok(expandedFailure);
    assert.match(expandedFailure.render(120).join("\n"), /child crashed/);

    const batchDisplay = [
      'Subagent sa-5 "review" finished.\n\nreview report',
      'Subagent sa-6 "tests" failed.\nError: failed\n\ntest failure',
    ].join("\n\n");
    const batch = entryRenderer(
      {
        ...entry,
        id: "entry-4",
        data: {
          content: batchDisplay,
          details: {
            count: 2,
            results: [
              {
                id: "sa-5",
                title: "review",
                status: "done" as const,
                elapsed: "1s",
              },
              {
                id: "sa-6",
                title: "tests",
                status: "error" as const,
                elapsed: "4s",
              },
            ],
          },
        },
      },
      { expanded: false },
      theme,
    );
    assert.ok(batch);
    const batchText = batch.render(120).join("\n");
    assert.match(batchText, /1 failed · 2 subagents settled/);
    assert.match(batchText, /sa-5 · review · done · 1s/);
    assert.match(batchText, /sa-6 · tests · error · 4s/);
    assert.doesNotMatch(batchText, /review report|test failure/);
    const expandedBatch = entryRenderer(
      {
        ...entry,
        id: "entry-5",
        data: {
          content: batchDisplay,
          details: {
            count: 2,
            results: [
              {
                id: "sa-5",
                title: "review",
                status: "done" as const,
                elapsed: "1s",
              },
              {
                id: "sa-6",
                title: "tests",
                status: "error" as const,
                elapsed: "4s",
              },
            ],
          },
        },
      },
      { expanded: true },
      theme,
    );
    assert.ok(expandedBatch);
    const expandedBatchText = expandedBatch.render(120).join("\n");
    assert.match(expandedBatchText, /review report/);
    assert.match(expandedBatchText, /test failure/);
    assert.match(expandedBatchText, /2 subagents · 1 failed/);
    assert.doesNotMatch(expandedBatchText, /This result is already shown/);

    const longTitle = `bad\n\x1b[31m${"title ".repeat(30)}`;
    const narrow = entryRenderer(
      {
        ...entry,
        id: "entry-6",
        data: {
          content: `Subagent sa-7 "${longTitle}" finished.\n\n${"long detail ".repeat(200)}`,
          details: {
            id: "sa-7\x1b[2J",
            title: longTitle,
            status: "done" as const,
            elapsed: "5s",
          },
        },
      },
      { expanded: false },
      theme,
    );
    assert.ok(narrow);
    const narrowLines = narrow.render(24);
    assert.ok(narrowLines.every((line) => visibleWidth(line) <= 24));
    assert.doesNotMatch(narrowLines.join("\n"), /\u001b\[31m/);
    assert.doesNotMatch(narrowLines.join("\n"), /long detail/);
  });
});
