import assert from "node:assert/strict";
import test from "node:test";
import { posix, win32 } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  DEFAULT_FOOTER_LINES,
  normalizeFooterLines,
  parseSetupConfig,
} from "../../../extensions/shared/setup-config.ts";
import {
  buildSegmentCatalog,
  fitSegmentsToWidth,
  formatDirectory,
  renderFooter,
  resolveLineSegments,
  type FooterSegment,
} from "../../../extensions/ui-customization/footer.ts";
import type {
  GitInfoState,
  ModelInfoState,
} from "../../../extensions/shared/dashboard-state.ts";

const theme = {
  fg: (_name: string, text: string) => text,
};

const modelInfo: ModelInfoState = {
  provider: "seal",
  modelId: "gpt-5.6-sol",
  modelName: "GPT-5.6 Sol",
  thinking: "high",
  contextTokens: 250_000,
  contextWindow: 1_000_000,
  contextPercent: 25,
  cachePercent: 82.4,
  cost: 4.03,
  tokensPerSecond: 41,
  generating: false,
};

const gitInfo: GitInfoState = {
  isRepository: true,
  branch: "main",
  changedFiles: 7,
  pullRequest: { number: 42, url: "https://example.com/pr/42", isDraft: false },
};

test("formatDirectory shortens Windows Home paths", () => {
  assert.equal(
    formatDirectory("C:\\Users\\Adam\\project", "C:\\Users\\Adam", win32),
    "~/project",
  );
  assert.equal(
    formatDirectory("C:\\Users\\Adam", "C:\\Users\\Adam", win32),
    "~",
  );
  assert.equal(
    formatDirectory("C:\\Users\\Adam2\\project", "C:\\Users\\Adam", win32),
    "C:\\Users\\Adam2\\project",
  );
  assert.equal(
    formatDirectory("/Users/adam/project", "/Users/adam"),
    "~/project",
  );
});

test("formatDirectory respects POSIX backslashes as filename characters", () => {
  assert.equal(
    formatDirectory("/Users/adam\\project", "/Users/adam", posix),
    "/Users/adam\\project",
  );
});

test("formatDirectory compares Windows paths case-insensitively", () => {
  assert.equal(
    formatDirectory("c:\\users\\adam\\project", "C:\\Users\\Adam", win32),
    "~/project",
  );
});

test("default one-line layout leads with model context and ends with cwd", () => {
  const lines = renderFooter({
    cwd: "/Users/me/project",
    modelInfo,
    gitInfo,
    style: "plain",
    lines: DEFAULT_FOOTER_LINES,
    width: 140,
    theme,
    formatPullRequest: (n) => `PR #${n}`,
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /project/);
  assert.match(lines[0]!, /seal\/gpt-5\.6-sol/);
  assert.match(lines[0]!, /25%\/1\.0m/);
  // Cost is an opt-in metric and stays out of the default layout.
  assert.doesNotMatch(lines[0]!, /\$/);
  assert.match(lines[0]!, /main/);
  assert.match(lines[0]!, /PR #42/);
  const modelIndex = lines[0]!.indexOf("seal/gpt-5.6-sol");
  const contextIndex = lines[0]!.indexOf("25%/1.0m");
  const branchIndex = lines[0]!.indexOf("main");
  const prIndex = lines[0]!.indexOf("PR #42");
  const cwdIndex = lines[0]!.indexOf("project");
  assert.ok(modelIndex < contextIndex);
  assert.ok(contextIndex < branchIndex);
  assert.ok(branchIndex < prIndex);
  assert.ok(prIndex < cwdIndex);
  const gap = branchIndex - contextIndex - "25%/1.0m".length;
  assert.ok(gap > 1);
});

test("legacy footerItems migration preserves the rendered footer", () => {
  const migrated = parseSetupConfig({
    ui: { footerItems: ["model", "cache", "git"] },
  });
  const canonical = parseSetupConfig({
    ui: { footerLines: [["model", "cache", "flex", "git"]] },
  });
  const render = (lines: typeof migrated.ui.footerLines) =>
    renderFooter({
      cwd: "/Users/me/project",
      modelInfo,
      gitInfo,
      style: "plain",
      lines,
      width: 140,
      theme,
      formatPullRequest: (n) => `PR #${n}`,
    });

  const migratedLines = render(migrated.ui.footerLines);
  assert.deepEqual(migratedLines, render(canonical.ui.footerLines));
  assert.match(migratedLines[0]!, /cache 82%/);

  const optionalOnly = parseSetupConfig({
    ui: { footerItems: ["cache"] },
  });
  const optionalLines = render(optionalOnly.ui.footerLines);
  assert.match(optionalLines[0]!, /cache 82%/);
  assert.doesNotMatch(optionalLines[0]!, /seal\/gpt-5\.6-sol|main/);
});

test("powerline emits ANSI256 seams and stays within width", () => {
  const lines = renderFooter({
    cwd: "/tmp/project",
    modelInfo,
    gitInfo,
    style: "powerline",
    lines: [["cwd", "model", "context", "flex", "git"]],
    width: 80,
    theme,
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /\x1b\[38;5;\d+;48;5;\d+m/);
  assert.match(lines[0]!, /\ue0b0/);
  assert.ok(visibleWidth(lines[0]!) <= 80);
  assert.match(lines[0]!, /project/);
  assert.match(lines[0]!, /seal\/gpt-5\.6-sol/);
});

test("powerline-mono uses gray blocks", () => {
  const lines = renderFooter({
    cwd: "/tmp/project",
    modelInfo,
    gitInfo,
    style: "powerline-mono",
    lines: [["model", "context", "git"]],
    width: 80,
    theme,
  });

  assert.match(lines[0]!, /48;5;240/);
  assert.match(lines[0]!, /48;5;252/);
  assert.ok(visibleWidth(lines[0]!) <= 80);
});

test("narrow width hides lowest-priority segments before truncating", () => {
  const catalog = buildSegmentCatalog(
    "/tmp/very-long-project-name",
    modelInfo,
    gitInfo,
  );
  const resolved = resolveLineSegments(
    [
      "cwd",
      "model",
      "thinking",
      "context",
      "cache",
      "cost",
      "throughput",
      "flex",
      "git",
      "pr",
    ],
    catalog,
    "plain",
    modelInfo.contextPercent,
  );
  const fitted = fitSegmentsToWidth(
    resolved.left,
    resolved.right,
    40,
    "plain",
    theme,
  );

  const ids = [...fitted.left, ...fitted.right].map((s) => s.id);
  assert.ok(
    ids.includes("cwd") || ids.includes("model") || ids.includes("context"),
  );
  assert.ok(!ids.includes("throughput") || ids.length < 4);
  assert.ok(fitted.left.length >= 1 || fitted.right.length >= 1);
  // Each originally non-empty side keeps at least one segment when possible.
  if (resolved.left.length > 0) assert.ok(fitted.left.length >= 1);
  if (resolved.right.length > 0) assert.ok(fitted.right.length >= 1);

  const rendered = renderFooter({
    cwd: "/tmp/very-long-project-name",
    modelInfo,
    gitInfo,
    style: "plain",
    lines: [
      [
        "cwd",
        "model",
        "thinking",
        "context",
        "cache",
        "cost",
        "throughput",
        "flex",
        "git",
        "pr",
      ],
    ],
    width: 40,
    theme,
  });
  assert.ok(visibleWidth(rendered[0]!) <= 40);
});

test("context uses warning and error tones at thresholds", () => {
  const warn = buildSegmentCatalog(
    "/tmp",
    {
      ...modelInfo,
      contextPercent: 70,
    },
    gitInfo,
  ).context;
  const err = buildSegmentCatalog(
    "/tmp",
    {
      ...modelInfo,
      contextPercent: 90,
    },
    gitInfo,
  ).context;
  const ok = buildSegmentCatalog(
    "/tmp",
    {
      ...modelInfo,
      contextPercent: 25,
    },
    gitInfo,
  ).context;

  assert.equal(warn.tone, "warning");
  assert.equal(err.tone, "error");
  assert.equal(ok.tone, "muted");
});

test("uses one Codicon family for model, context, and directory", () => {
  const catalog = buildSegmentCatalog("/tmp/project", modelInfo, gitInfo);

  assert.match(catalog.model.text, /^\uec10 /);
  assert.match(catalog.context.text, /^\uebe4 /);
  assert.match(catalog.cwd.text, /^\uea83 /);
});

test("a single status inlines into the first footer line when it fits", () => {
  const lines = renderFooter({
    cwd: "/tmp/project",
    modelInfo,
    gitInfo,
    style: "plain",
    lines: DEFAULT_FOOTER_LINES,
    width: 140,
    theme,
    statuses: ["plan mode"],
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /seal\/gpt-5\.6-sol/);
  assert.match(lines[0]!, /plan mode/);
});

test("a single status stays on its own line when it cannot fit", () => {
  const lines = renderFooter({
    cwd: "/tmp/project",
    modelInfo,
    gitInfo,
    style: "plain",
    lines: [["model"]],
    width: 25,
    theme,
    statuses: ["plan mode"],
  });

  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /plan mode/);
});

test("operational statuses always append after layout lines", () => {
  const lines = renderFooter({
    cwd: "/tmp/project",
    modelInfo,
    gitInfo,
    style: "powerline",
    lines: [["model"]],
    width: 60,
    theme,
    statuses: ["1 running", "workflow · step 2"],
  });

  assert.equal(lines.length, 3);
  assert.match(lines[1]!, /1 running/);
  assert.match(lines[2]!, /workflow/);
});

test("statuses remain visible even when metric layout is empty after normalize", () => {
  const lines = renderFooter({
    cwd: "/tmp/project",
    modelInfo,
    gitInfo,
    style: "plain",
    lines: normalizeFooterLines([["bogus"], []]),
    width: 80,
    theme,
    statuses: ["bg: sleep"],
  });

  // normalize falls back to the default metric line; the status stays visible
  // whether it inlines into that line or lands on its own.
  assert.ok(lines.length >= 1);
  assert.match(lines.join("\n"), /bg: sleep/);
});

test("renderFooter renders only the configured segments", () => {
  const lines = renderFooter({
    cwd: "/tmp/project",
    modelInfo,
    gitInfo,
    style: "plain",
    lines: [["model", "context", "cache"]],
    width: 80,
    theme,
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /seal\/gpt-5\.6-sol/);
  assert.match(lines[0]!, /25%\/1\.0m/);
  assert.match(lines[0]!, /cache 82%/);
  assert.doesNotMatch(lines[0]!, /project|main|PR #42/);
});

test("fitSegmentsToWidth never empties a previously non-empty side first", () => {
  const left: FooterSegment[] = [
    {
      id: "cwd",
      text: "abcdefghij",
      priority: 100,
      tone: "text",
      fg: 231,
      bg: 33,
    },
    {
      id: "throughput",
      text: "~99 tok/s",
      priority: 30,
      tone: "muted",
      fg: 231,
      bg: 66,
    },
  ];
  const right: FooterSegment[] = [
    {
      id: "git",
      text: "feature/very-long-branch-name",
      priority: 80,
      tone: "muted",
      fg: 231,
      bg: 239,
    },
  ];
  const fitted = fitSegmentsToWidth(left, right, 20, "plain", theme);
  assert.equal(fitted.left.length, 1);
  assert.equal(fitted.right.length, 1);
  assert.equal(fitted.left[0]!.id, "cwd");
});
