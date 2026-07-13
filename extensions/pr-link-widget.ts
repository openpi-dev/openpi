/**
 * PR Link Widget
 *
 * On session start (and whenever the checked-out branch changes), checks whether
 * there's an open pull request for the current branch via the GitHub CLI (`gh`).
 * If there is, it shows a persistent widget above the editor with a clickable
 * link to the PR.
 *
 * Requires: `gh` installed and authenticated, inside a GitHub repo checkout.
 * Use `/pr` to re-check on demand (e.g. after pushing a branch / opening a PR).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WIDGET_ID = "pr-link-widget";
const GIT_TIMEOUT_MS = 3_000;
const GH_TIMEOUT_MS = 10_000;
const DETACHED = "\0detached";

interface PrInfo {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
}

interface Lifecycle {
  active: boolean;
  /** Branch (or DETACHED) we last ran a PR lookup for. */
  queriedKey?: string;
}

async function runGit(args: string[], cwd: string) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trimEnd();
}

async function getRepoBranch(cwd: string) {
  try {
    await runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  } catch {
    return { inRepo: false as const };
  }
  // Empty output means a detached HEAD (no branch to look up a PR for).
  const branch = await runGit(["branch", "--show-current"], cwd);
  return { inRepo: true as const, branch: branch.length > 0 ? branch : undefined };
}

async function getOpenPr(cwd: string, branch: string) {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", branch, "--json", "number,title,url,state,isDraft"],
      { cwd, timeout: GH_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    const pr = JSON.parse(stdout) as PrInfo;
    return pr.state === "OPEN" ? pr : undefined;
  } catch {
    // gh missing, not authenticated, no GitHub remote, or no PR for this branch.
    return undefined;
  }
}

function formatPrLine(ctx: ExtensionContext, pr: PrInfo) {
  const theme = ctx.ui.theme;
  const tag = pr.isDraft ? "draft PR" : "PR";
  const label = theme.fg("accent", `🔗 ${tag} #${pr.number}`);
  const styledUrl = theme.fg("muted", pr.url);
  const link = getCapabilities().hyperlinks ? hyperlink(styledUrl, pr.url) : styledUrl;
  const title = pr.title ? theme.fg("dim", ` — ${pr.title}`) : "";
  return ` ${label}  ${link}${title}`;
}

function applyWidget(ctx: ExtensionContext, pr: PrInfo | undefined) {
  if (pr) {
    ctx.ui.setWidget(WIDGET_ID, [formatPrLine(ctx, pr)]);
  } else {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }
}

export default function (pi: ExtensionAPI) {
  let state: Lifecycle = { active: false };
  let querying = false;

  // Re-check only when the branch changed since the last lookup. The fast git
  // call runs often; the slower `gh` call only runs on an actual branch change.
  async function refresh(ctx: ExtensionContext, lifecycle: Lifecycle) {
    if (!lifecycle.active || !ctx.hasUI || querying) return;

    const repo = await getRepoBranch(ctx.cwd);
    if (!lifecycle.active || lifecycle !== state) return;

    if (!repo.inRepo) {
      lifecycle.queriedKey = undefined;
      ctx.ui.setWidget(WIDGET_ID, undefined);
      return;
    }

    const key = repo.branch ?? DETACHED;
    if (key === lifecycle.queriedKey) return;
    lifecycle.queriedKey = key;

    if (!repo.branch) {
      ctx.ui.setWidget(WIDGET_ID, undefined);
      return;
    }

    querying = true;
    try {
      const pr = await getOpenPr(ctx.cwd, repo.branch);
      if (!lifecycle.active || lifecycle !== state) return;
      applyWidget(ctx, pr);
      if (pr) {
        ctx.ui.notify(`Open ${pr.isDraft ? "draft PR" : "PR"} #${pr.number}: ${pr.url}`, "info");
      }
    } finally {
      querying = false;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    state = { active: true };
    await refresh(ctx, state);
  });

  pi.on("input", async (_event, ctx) => {
    void refresh(ctx, state);
    return { action: "continue" };
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    void refresh(ctx, state);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    state.active = false;
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
  });

  pi.registerCommand("pr", {
    description: "Check for an open PR on the current branch and show its link",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      const repo = await getRepoBranch(ctx.cwd);
      if (!repo.inRepo) {
        ctx.ui.setWidget(WIDGET_ID, undefined);
        state.queriedKey = undefined;
        ctx.ui.notify("Not a git repository", "warning");
        return;
      }
      if (!repo.branch) {
        ctx.ui.setWidget(WIDGET_ID, undefined);
        state.queriedKey = DETACHED;
        ctx.ui.notify("Detached HEAD — no branch to check for a PR", "warning");
        return;
      }

      const pr = await getOpenPr(ctx.cwd, repo.branch);
      state.queriedKey = repo.branch;
      applyWidget(ctx, pr);
      if (pr) {
        ctx.ui.notify(`Open ${pr.isDraft ? "draft PR" : "PR"} #${pr.number}: ${pr.url}`, "info");
      } else {
        ctx.ui.notify(`No open PR found for ${repo.branch}`, "info");
      }
    },
  });
}
