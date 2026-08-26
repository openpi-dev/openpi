import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  GIT_INFO_CHANNEL,
  isGitInfoState,
  type GitInfoState,
} from "../../../extensions/shared/dashboard-state.ts";
import gitInfo from "../../../extensions/git-info/index.ts";

interface RegisteredCommand {
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

test("automatic refresh stays local until /pr explicitly requests GitHub data", async () => {
  const root = mkdtempSync(join(tmpdir(), "git-info-explicit-pr-"));
  const bin = join(root, "bin");
  const callLog = join(root, "gh-calls.log");
  mkdirSync(bin);

  const gitPath = join(bin, "git");
  writeFileSync(
    gitPath,
    `#!/bin/sh
case "$1 $2" in
  "rev-parse --is-inside-work-tree") echo true ;;
  "branch --show-current") echo main ;;
  "rev-parse --short") echo abc123 ;;
  "status --porcelain=v1") printf ' M local.ts\\n?? new.ts\\n' ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(gitPath, 0o755);

  const ghPath = join(bin, "gh");
  writeFileSync(
    ghPath,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_CALL_LOG"
printf '%s\\n' '{"number":42,"url":"https://example.test/pr/42","state":"OPEN","isDraft":false}'
`,
  );
  chmodSync(ghPath, 0o755);

  const previousPath = process.env.PATH;
  const previousLog = process.env.GH_CALL_LOG;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.GH_CALL_LOG = callLog;

  const hooks = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  const commands = new Map<string, RegisteredCommand>();
  const notifications: string[] = [];
  let resolveLocal!: (state: GitInfoState) => void;
  const localPublished = new Promise<GitInfoState>((resolve) => {
    resolveLocal = resolve;
  });

  const api = {
    events: {
      on: () => () => undefined,
      emit: (channel: string, value: unknown) => {
        if (
          channel === GIT_INFO_CHANNEL &&
          isGitInfoState(value) &&
          value.isRepository
        ) {
          resolveLocal(value);
        }
      },
    },
    on: (
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) => {
      hooks.set(event, handler);
    },
    registerCommand: (name: string, command: RegisteredCommand) => {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: root,
    mode: "tui",
    signal: undefined,
    ui: {
      notify: (message: string) => notifications.push(message),
    },
  } as unknown as ExtensionContext;

  gitInfo(api);

  try {
    await hooks.get("session_start")?.({}, ctx);
    const local = await localPublished;
    assert.equal(local.branch, "main");
    assert.equal(local.changedFiles, 2);
    assert.equal(local.pullRequest, null);

    await commands.get("pr")?.handler("", ctx);

    assert.equal(existsSync(callLog), true);
    assert.deepEqual(readFileSync(callLog, "utf8").trim().split("\n"), [
      "pr view main --json number,url,state,isDraft",
    ]);
    assert.deepEqual(notifications, ["PR #42: https://example.test/pr/42"]);
  } finally {
    await hooks.get("session_shutdown")?.({}, ctx);
    process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.GH_CALL_LOG;
    else process.env.GH_CALL_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
});
