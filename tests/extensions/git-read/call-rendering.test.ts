import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  initTheme,
  ToolExecutionComponent,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import gitRead from "../../../extensions/git-read/index.ts";

initTheme("dark", false);

const tools: ToolDefinition[] = [];
gitRead({
  on() {},
  registerTool(tool: ToolDefinition) {
    tools.push(tool);
  },
} as unknown as ExtensionAPI);

const titleControl = "\u001b]0;openpi-test-title\u0007";
const unsafe = `${titleControl}\u001b[2J\u202espoof\u202c\nnext`;

function render(tool: ToolDefinition, args: Record<string, unknown>) {
  const component = new ToolExecutionComponent(
    tool.name,
    `call-${tool.name}`,
    args,
    { showImages: false },
    tool,
    { requestRender() {} } as TUI,
    process.cwd(),
  );
  return component.render(160).join("\n");
}

for (const [name, fields] of [
  ["git_show", ["revision"]],
  ["git_diff", ["from", "to", "path"]],
  ["git_log", ["revision", "file"]],
] as const) {
  const tool = tools.find((candidate) => candidate.name === name)!;
  for (const field of fields) {
    test(`${name} ${field} is terminal-safe before argument validation`, async () => {
      const args = { [field]: `HEAD${unsafe}` };
      const before = structuredClone(args);
      const rendered = render(tool, args);
      assert.equal(rendered.includes(titleControl), false);
      assert.equal(rendered.includes("\u001b[2J"), false);
      assert.equal(rendered.includes("\u202e"), false);
      assert.equal(rendered.includes("\u202c"), false);
      const visible = stripVTControlCharacters(rendered);
      assert.match(visible, /HEADspoof next/);
      assert.doesNotMatch(visible, /openpi-test-title/);
      assert.deepEqual(args, before);
      await assert.rejects(
        tool.execute("invalid-call", args, undefined, undefined, {
          cwd: process.cwd(),
        } as ExtensionContext),
        /Invalid git revision|Invalid repository path/,
      );
      assert.deepEqual(
        args,
        before,
        "display must not clean executable arguments",
      );
    });
  }
}

test("normal git call labels keep revisions, options, and Unicode paths", () => {
  const fixtures: [string, Record<string, unknown>, string][] = [
    ["git_show", { revision: " HEAD~1 " }, "git show HEAD~1"],
    ["git_show", {}, "git show HEAD"],
    ["git_diff", {}, "git diff index → worktree"],
    ["git_diff", { staged: true }, "git diff HEAD (staged) → worktree"],
    [
      "git_diff",
      { from: "main", to: "feature", stat: true, path: "文档/👩‍💻.md" },
      "git diff main → feature (stat) 文档/👩‍💻.md",
    ],
    [
      "git_log",
      { revision: "main", file: "文档/👩‍💻.md", limit: 5 },
      "git log main -- 文档/👩‍💻.md -n 5",
    ],
  ];
  for (const [name, args, expected] of fixtures) {
    const tool = tools.find((candidate) => candidate.name === name)!;
    assert.equal(stripVTControlCharacters(render(tool, args)).trim(), expected);
  }
});
