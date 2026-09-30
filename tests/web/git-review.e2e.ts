import { execFile, execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  await mkdir(join(root, "web/ui"), { recursive: true });
  await writeFile(join(root, "web/ui/App.tsx"), "export const app = true;\n");
  await git("add", "web/ui/App.tsx");
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
    await page.getByRole("button", { name: "会话概览", exact: true }).click();
    await page.getByRole("button", { name: /^变更/u }).click();
    const workbar = page.locator(".workbar-panel");
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
    await expect(
      workbar.getByRole("button", { name: "查看最新差异" }),
    ).toBeVisible();
    await expect(diff).toContainText("staged-a");
    await expect(draft).toBeFocused();
    await workbar.getByRole("button", { name: "查看最新差异" }).click();
    await expect(diff).toContainText("staged-b", { timeout: 10_000 });
    await expect(diff).not.toContainText("staged-a");
    await expect(draft).toHaveValue("保留正在编辑的草稿");
    await page.screenshot({
      path: testInfo.outputPath("native-index-refresh.png"),
    });
    await workbar
      .getByRole("button", { name: "展开审阅", exact: true })
      .click();
    await expect(workbar.locator(".review-wide")).toBeVisible();
    const navigation = workbar.locator(".review-navigation");
    const treeFile = navigation.getByRole("button", {
      name: "web/ui/App.tsx",
      exact: true,
    });
    await treeFile.click();
    await expect(treeFile).toHaveAttribute("aria-current", "true");
    await expect(diff).toContainText("export const app = true");
    const navBox = await navigation.boundingBox();
    const previewBox = await workbar
      .locator(".review-file-screen")
      .boundingBox();
    expect(navBox!.x).toBeGreaterThanOrEqual(
      previewBox!.x + previewBox!.width - 1,
    );
    await navigation
      .getByRole("button", { name: "web/ui", exact: true })
      .click();
    await expect(treeFile).toHaveCount(0);
    await navigation.getByRole("searchbox").fill("App.tsx");
    await expect(treeFile).toBeVisible();
    await navigation.getByRole("searchbox").fill("");
    await expect(treeFile).toHaveCount(0);
    await navigation
      .getByRole("button", { name: "web/ui", exact: true })
      .click();
    await page.screenshot({
      path: testInfo.outputPath("review-tree-wide.png"),
    });
    await workbar
      .getByRole("button", { name: "恢复会话", exact: true })
      .click();
    await expect(draft).toHaveValue("保留正在编辑的草稿");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(diff).toContainText("export const app = true");
    await workbar.getByRole("button", { name: "返回变更文件" }).click();
    await expect(treeFile).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("review-tree-mobile.png"),
    });
  } finally {
    await context.close();
    await host.stop();
    await rm(root, { recursive: true, force: true });
  }
});
