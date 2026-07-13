import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  emptyGitInfoState,
  GIT_INFO_CHANNEL,
  REFRESH_CHANNEL,
  type PullRequestInfo,
} from "../shared/dashboard-state.ts";
import { loadChangedFiles, showChangedFiles } from "./changed-files-view.ts";

const POLL_INTERVAL_MS = 3_000;
const GIT_TIMEOUT_MS = 3_000;
const GH_TIMEOUT_MS = 10_000;

function countChangedFiles(status: string) {
  if (!status.trim()) return 0;
  return status.split("\n").filter(Boolean).length;
}

function parsePullRequest(value: unknown) {
  if (typeof value !== "object" || value === null) return null;
  if (!("number" in value) || typeof value.number !== "number") return null;
  if (!("url" in value) || typeof value.url !== "string") return null;
  if (!("state" in value) || value.state !== "OPEN") return null;

  return {
    number: value.number,
    url: value.url,
    isDraft: "isDraft" in value && value.isDraft === true,
  } satisfies PullRequestInfo;
}

export default function gitInfo(pi: ExtensionAPI) {
  let state = emptyGitInfoState();
  let interval: ReturnType<typeof setInterval> | undefined;
  let currentContext: ExtensionContext | undefined;
  let generation = 0;
  let refreshing = false;
  let queriedPrBranch: string | null = null;

  const publish = () => pi.events.emit(GIT_INFO_CHANNEL, { ...state });

  async function run(
    command: string,
    args: string[],
    ctx: ExtensionContext,
    timeout: number,
  ) {
    return pi.exec(command, args, { cwd: ctx.cwd, timeout });
  }

  async function lookupPullRequest(ctx: ExtensionContext, branch: string) {
    const result = await run(
      "gh",
      ["pr", "view", branch, "--json", "number,url,state,isDraft"],
      ctx,
      GH_TIMEOUT_MS,
    );
    if (result.code !== 0) return null;

    try {
      return parsePullRequest(JSON.parse(result.stdout));
    } catch {
      return null;
    }
  }

  async function refresh(ctx: ExtensionContext, forcePullRequest = false) {
    if (refreshing) return;
    refreshing = true;
    currentContext = ctx;
    const refreshGeneration = generation;

    try {
      const repo = await run(
        "git",
        ["rev-parse", "--is-inside-work-tree"],
        ctx,
        GIT_TIMEOUT_MS,
      );
      if (refreshGeneration !== generation) return;

      if (repo.code !== 0 || repo.stdout.trim() !== "true") {
        queriedPrBranch = null;
        state = emptyGitInfoState();
        publish();
        return;
      }

      const [branchResult, headResult, statusResult] = await Promise.all([
        run("git", ["branch", "--show-current"], ctx, GIT_TIMEOUT_MS),
        run("git", ["rev-parse", "--short", "HEAD"], ctx, GIT_TIMEOUT_MS),
        run(
          "git",
          ["status", "--porcelain=v1", "--untracked-files=all"],
          ctx,
          GIT_TIMEOUT_MS,
        ),
      ]);
      if (refreshGeneration !== generation) return;

      const branchName = branchResult.stdout.trim();
      const shortHead = headResult.stdout.trim();
      const branch =
        branchName || (shortHead ? `detached@${shortHead}` : "detached");
      const branchChanged = branchName !== queriedPrBranch;

      state = {
        ...state,
        isRepository: true,
        branch,
        changedFiles:
          statusResult.code === 0 ? countChangedFiles(statusResult.stdout) : 0,
        pullRequest: branchChanged ? null : state.pullRequest,
      };
      publish();

      if (!branchName) {
        // queriedPrBranch is never "", so branchChanged already cleared pullRequest.
        queriedPrBranch = null;
        return;
      }

      if (forcePullRequest || branchChanged) {
        queriedPrBranch = branchName;
        const pullRequest = await lookupPullRequest(ctx, branchName);
        if (refreshGeneration !== generation) return;
        state = { ...state, pullRequest };
        publish();
      }
    } finally {
      refreshing = false;
    }
  }

  pi.events.on(REFRESH_CHANNEL, () => {
    if (currentContext) void refresh(currentContext);
  });

  pi.on("session_start", async (_event, ctx) => {
    generation += 1;
    queriedPrBranch = null;
    if (interval) clearInterval(interval);

    await refresh(ctx);
    interval = setInterval(() => {
      if (currentContext) void refresh(currentContext);
    }, POLL_INTERVAL_MS);
  });

  pi.on("input", (_event, ctx) => {
    void refresh(ctx);
    return { action: "continue" };
  });

  pi.on("tool_execution_end", (_event, ctx) => {
    void refresh(ctx);
  });

  pi.on("session_shutdown", () => {
    generation += 1;
    currentContext = undefined;
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
  });

  pi.registerCommand("lg", {
    description: "Browse changed files and their diffs",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          "The local changes viewer requires the interactive TUI",
          "warning",
        );
        return;
      }

      const files = await loadChangedFiles(pi, ctx);
      if (files === null) {
        ctx.ui.notify("Not a git repository", "warning");
        return;
      }
      if (files.length === 0) {
        ctx.ui.notify("Working tree is clean", "info");
        return;
      }

      await showChangedFiles(ctx, files);
    },
  });

  pi.registerCommand("pr", {
    description: "Refresh git and pull request information",
    handler: async (_args, ctx) => {
      await refresh(ctx, true);
      if (!state.isRepository) {
        ctx.ui.notify("Not a git repository", "warning");
      } else if (state.pullRequest) {
        ctx.ui.notify(
          `PR #${state.pullRequest.number}: ${state.pullRequest.url}`,
          "info",
        );
      } else {
        ctx.ui.notify(`No open PR found for ${state.branch}`, "info");
      }
    },
  });
}
