import { execFile, execFileSync } from "node:child_process";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "@playwright/test";
import { GitReviewBaselineStore } from "../../web/host/git-review.ts";
import { WebHost } from "../../web/host/web-host.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";
import type { WebRuntimeController } from "../../web/runtime/types.ts";

const exec = promisify(execFile);

test("real Git rename details and index-only edits refresh the open browser diff", async ({
  browser,
}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), "openpi-git-browser-"));
  const git = (...args: string[]) => exec("git", ["-C", root, ...args]);
  await git("init", "-b", "main");
  await git("config", "user.name", "OpenPI Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(root, "old.txt"), "rename source\n");
  await writeFile(join(root, "index.txt"), "base\n");
  await git("add", ".");
  await git("commit", "-m", "fixture");
  await git("mv", "old.txt", "new.txt");
  const updateIndex = async (content: string) => {
    const oid = execFileSync(
      "git",
      ["-C", root, "hash-object", "-w", "--stdin"],
      { input: content, encoding: "utf8" },
    ).trim();
    await git("update-index", "--cacheinfo", "100644", oid, "index.txt");
  };
  await updateIndex("staged-a\n");
  const originalStat = await lstat(join(root, "index.txt"), { bigint: true });
  const manager = SessionManager.inMemory(root);
  const runtime: WebRuntimeController = {
    cwd: root,
    workspaceSelected: true,
    sessionDirectory: join(root, ".git", "sessions"),
    sessionManager: manager,
    isIdle: () => true,
    getActiveTurn: () => undefined,
    listModels: () => [],
    searchModels: (query, limit) => projectWebModelSearch([], query, limit),
    setModel: async () => {
      throw new Error("unused");
    },
    newSession: async () => ({
      cancelled: true,
      sessionId: manager.getSessionId(),
    }),
    switchSession: async () => ({ cancelled: true }),
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    subscribe: () => () => {},
    dispose: async () => {},
    sendPrompt: async () => {
      throw new Error("Review must not call a model");
    },
  };
  const host = new WebHost({
    runtime,
    gitReviews: new GitReviewBaselineStore(
      runtime.sessionDirectory,
      join(root, ".git", "baselines"),
    ),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  });
  const page = await context.newPage();
  try {
    await host.start();
    await page.goto(host.origin);
    await page.locator(".task-tools-trigger").click();
    const workbar = page.locator(".workbar-panel");
    await workbar.getByRole("button", { name: /^变更/u }).click();
    await workbar
      .getByRole("combobox", { name: "变更范围" })
      .selectOption("staged");
    await workbar.getByRole("button", { name: "new.txt", exact: true }).click();
    const diff = workbar.getByRole("figure");
    await expect(diff).toContainText("rename from old.txt");
    await expect(diff).toContainText("rename to new.txt");
    await page.screenshot({ path: testInfo.outputPath("native-rename.png") });
    await workbar.getByRole("button", { name: "返回变更文件" }).click();
    await workbar
      .getByRole("button", { name: "index.txt", exact: true })
      .click();
    await expect(diff).toContainText("staged-a");
    const draft = page.getByRole("textbox", { name: "描述任务" });
    await draft.fill("保留正在编辑的草稿");
    await updateIndex("staged-b\n");
    const nextStat = await lstat(join(root, "index.txt"), { bigint: true });
    expect([nextStat.size, nextStat.mtimeNs, nextStat.ctimeNs]).toEqual([
      originalStat.size,
      originalStat.mtimeNs,
      originalStat.ctimeNs,
    ]);
    // Returning from an external Git operation triggers the existing refresh
    // path; keep the file open and the input focused during reconciliation.
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(diff).toContainText("staged-b", { timeout: 10_000 });
    await expect(diff).not.toContainText("staged-a");
    await expect(draft).toBeFocused();
    await expect(draft).toHaveValue("保留正在编辑的草稿");
    await page.screenshot({
      path: testInfo.outputPath("native-index-refresh.png"),
    });
  } finally {
    await context.close();
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});
