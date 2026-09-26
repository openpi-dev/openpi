import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { AxeBuilder } from "@axe-core/playwright";
import {
  createEditTool,
  createReadTool,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "@playwright/test";
import { GitReviewBaselineStore } from "../../web/host/git-review.ts";
import { WebHost } from "../../web/host/web-host.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";
import type {
  WebRuntimeController,
  WebRuntimeEvent,
} from "../../web/runtime/types.ts";
import { createEvidenceWriteTool } from "../../web/runtime/write-evidence.ts";

const execFileAsync = promisify(execFile);

test("real file evidence, authenticated downloads, edits, refresh and failure states", async ({
  browser,
}) => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-evidence-browser-"));
  const outside = await mkdtemp(join(tmpdir(), "openpi-external-file-"));
  const externalPath = join(outside, "external%25.ts");
  await writeFile(externalPath, "export const otherWorktree = 42;");
  const manager = SessionManager.inMemory(cwd);
  const path = join(cwd, "report space.md");
  const writeTool = createEvidenceWriteTool(cwd);
  const writer = {
    execute: (id: string, args: { path: string; content: string }) =>
      writeTool.execute(id, args, undefined, undefined, undefined!),
  };
  const initial = await writer.execute("write-1", {
    path,
    content: "# First report\nInitial content\n\n[Related](./sibling.md)",
  });
  await writer.execute("sibling", {
    path: join(cwd, "sibling.md"),
    content: "# Related report",
  });
  await execFileAsync("git", ["-C", cwd, "init", "-b", "main"]);
  await execFileAsync("git", ["-C", cwd, "config", "user.name", "OpenPI Test"]);
  await execFileAsync("git", [
    "-C",
    cwd,
    "config",
    "user.email",
    "openpi@example.invalid",
  ]);
  await execFileAsync("git", ["-C", cwd, "add", "."]);
  await execFileAsync("git", ["-C", cwd, "commit", "-m", "base"]);
  const baselineDirectory = await mkdtemp(
    join(tmpdir(), "openpi-evidence-git-baseline-"),
  );
  const gitReviews = new GitReviewBaselineStore(cwd, baselineDirectory);
  await gitReviews.capture(`current:${manager.getSessionId()}`, cwd);
  const read = await createReadTool(cwd).execute("read-1", { path });
  const edit = await createEditTool(cwd).execute("edit-1", {
    path,
    edits: [{ oldText: "Initial content", newText: "Reviewed content" }],
  });
  const zeroUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistant = (content: string) =>
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: content }],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: Date.now(),
    });
  manager.appendMessage({
    role: "user",
    content: "Create a report and verify it",
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "write-1",
        name: "write",
        arguments: {
          path,
          content: "# First report\nInitial content\n\n[Related](./sibling.md)",
        },
      },
      {
        type: "toolCall",
        id: "read-1",
        name: "read",
        arguments: { path, offset: 1 },
      },
      {
        type: "toolCall",
        id: "edit-1",
        name: "edit",
        arguments: {
          path,
          edits: [{ oldText: "Initial content", newText: "Reviewed content" }],
        },
      },
      {
        type: "toolCall",
        id: "test-1",
        name: "bash",
        arguments: { command: "node --test" },
      },
      {
        type: "toolCall",
        id: "term-1",
        name: "bash",
        arguments: { command: "fixture-command" },
      },
      {
        type: "toolCall",
        id: "future-1",
        name: "future_tool",
        arguments: { input: "unknown" },
      },
    ],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage: zeroUsage,
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  for (const row of [
    { id: "write-1", name: "write", result: initial },
    { id: "read-1", name: "read", result: read },
    { id: "edit-1", name: "edit", result: edit },
  ])
    manager.appendMessage({
      role: "toolResult",
      toolCallId: row.id,
      toolName: row.name,
      ...row.result,
      isError: false,
      timestamp: Date.now(),
    });
  for (const row of [
    {
      id: "test-1",
      name: "bash",
      content:
        "TAP version 13\nnot ok 1 - fixture failure\n# tests 1\n# pass 0\n# fail 1\n\nCommand exited with code 1",
      isError: true,
    },
    {
      id: "term-1",
      name: "bash",
      content: "fixture log\n\nCommand aborted",
      isError: true,
    },
    {
      id: "future-1",
      name: "future_tool",
      content: "unknown tool evidence",
      isError: false,
    },
  ])
    manager.appendMessage({
      role: "toolResult",
      toolCallId: row.id,
      toolName: row.name,
      content: [{ type: "text", text: row.content }],
      isError: row.isError,
      timestamp: Date.now(),
    });
  assistant(
    `[Report](./report%20space.md)\n\n[Missing](./missing.md)\n\n[Other worktree](${encodeURI(externalPath)})`,
  );
  const listeners = new Set<(event: WebRuntimeEvent) => void>();
  const runtime: WebRuntimeController = {
    searchModels: (query, limit) =>
      projectWebModelSearch(runtime.listModels(), query, limit),
    cwd,
    workspaceSelected: true,
    sessionDirectory: cwd,
    sessionManager: manager,
    isIdle: () => true,
    getActiveTurn: () => undefined,
    listModels: () => [
      {
        provider: "fixture",
        id: "fixture",
        name: "Fixture",
        label: "Fixture",
        current: true,
      },
    ],
    setModel: async () => {
      throw new Error("unused");
    },
    newSession: async () => ({
      cancelled: true,
      sessionId: runtime.sessionManager.getSessionId(),
    }),
    switchSession: async () => ({ cancelled: true }),
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: async () => {
      listeners.clear();
    },
    sendPrompt: async (content) => {
      manager.appendMessage({ role: "user", content, timestamp: Date.now() });
      await writer.execute("write-2", {
        path,
        content: "# Updated report\nSecond version",
      });
      assistant("The report has been updated.");
      for (const listener of listeners)
        listener({
          type: "message_end",
          detail: { sessionId: manager.getSessionId() },
        });
      return { pendingFollowUps: 0 };
    },
  };
  const host = new WebHost({ runtime, gitReviews });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await host.start();
    await page.goto(host.origin);
    await expect(
      page.getByRole("button", { name: "Report", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /打开工具|Open tools/u, exact: true })
      .click();
    const workbar = page.locator(".workbar-panel");
    await workbar
      .getByRole("button", { name: /^(生成文件|Generated files)/u })
      .click();
    const generatedReport = workbar.getByRole("button", {
      name: /report space\.md/u,
    });
    await expect(generatedReport).toBeVisible();
    await generatedReport.click();
    const generatedPreview = page.getByRole("complementary", {
      name: /文件预览|File preview/u,
    });
    await expect(generatedPreview).toContainText("Reviewed content");
    await generatedPreview
      .getByRole("button", { name: /关闭预览|Close preview/u })
      .click();
    await expect(page.locator(".session-changes-trigger")).toHaveCount(0);
    for (const group of await page.locator(".process-sequence > summary").all())
      await group.click();
    for (const summary of await page
      .locator(".tool-evidence-card > summary")
      .all())
      await summary.click();
    const readCard = page
      .locator(".tool-evidence-card")
      .filter({ has: page.locator("summary strong", { hasText: "read" }) });
    const toolTitleColors = await readCard
      .locator(":scope > summary")
      .evaluate((summary) => {
        const label = summary.querySelector<HTMLElement>(".tool-name");
        const detail = summary.querySelector<HTMLElement>(
          ":scope > span:not(.evidence-status):not(.evidence-summary-meta)",
        );
        return {
          label: label ? getComputedStyle(label).color : "",
          detail: detail ? getComputedStyle(detail).color : "",
        };
      });
    expect(toolTitleColors.label).not.toBe(toolTitleColors.detail);
    const evidenceFile = readCard.getByRole("button", { name: path });
    await evidenceFile.click();
    await expect(
      page.getByRole("complementary", { name: /文件预览|File preview/u }),
    ).toContainText("Reviewed content");
    await page.getByRole("button", { name: /关闭预览|Close preview/u }).click();
    await expect(evidenceFile).toBeFocused();
    await expect(
      page.getByRole("figure", { name: "File content" }),
    ).toContainText("Initial content");
    await expect(
      page
        .locator(".tool-evidence-card")
        .filter({ has: page.locator("summary strong", { hasText: "edit" }) })
        .getByRole("figure", { name: "Change diff" }),
    ).toContainText("Reviewed content");
    const writeCard = page
      .locator(".tool-evidence-card")
      .filter({ has: page.locator("summary strong", { hasText: "write" }) });
    await expect(writeCard).toContainText(
      "reading the previous contents was not authorized",
    );
    await expect(
      writeCard.getByRole("figure", { name: "Change diff" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("figure", { name: "Test evidence" }),
    ).toContainText("1 failed");
    await expect(page.locator(".evidence-terminal")).toContainText("cancelled");
    expect(
      (await new AxeBuilder({ page }).include(".tool-evidence-card").analyze())
        .violations,
    ).toEqual([]);
    await page.locator(".evidence-file").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: join(tmpdir(), "openpi-345-renderers.png"),
      fullPage: true,
    });
    await expect(
      page.getByText("unknown tool evidence", { exact: true }).first(),
    ).toBeAttached();
    await page
      .getByRole("button", { name: /打开工具|Open tools/u, exact: true })
      .click();
    await workbar.locator(".workbar-add-tab").click();
    await page.getByRole("menuitem", { name: /^(?:变更|Changes)/u }).click();
    const review = page.getByRole("complementary", {
      name: /变更|Changes/u,
    });
    await review
      .getByRole("combobox", { name: /变更范围|Change scope/u })
      .selectOption("session");
    await expect(review).toContainText(
      /自本会话开始后的变更|Changes since this session started/u,
    );
    await expect(review.locator(".session-review-file")).toHaveCount(1);
    await review.locator(".session-review-file").click();
    await expect(
      review.getByRole("figure", { name: /变更差异|Change diff/u }),
    ).toContainText("Reviewed content");
    await review
      .getByRole("button", { name: /返回变更文件|Back to changed files/u })
      .click();
    await expect(review.locator(".session-review-file")).toHaveCount(1);
    await review.locator(".session-review-file").click();
    await expect(
      review.getByRole("figure", { name: /变更差异|Change diff/u }),
    ).toContainText("Reviewed content");
    await review.getByRole("button", { name: /^(?:关闭|Close)$/u }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole("button", { name: /打开工具|Open tools/u, exact: true })
      .click();
    await workbar.locator(".workbar-add-tab").click();
    await page.getByRole("menuitem", { name: /^(?:变更|Changes)/u }).click();
    const mobileReview = page.getByRole("complementary", {
      name: /变更|Changes/u,
    });
    await expect(mobileReview).toBeVisible();
    await expect(page.locator(".conversation-shell")).toBeHidden();
    expect(
      await mobileReview.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await mobileReview
      .getByRole("button", { name: /^(?:关闭|Close)$/u })
      .click();
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.getByRole("button", { name: "Report", exact: true }).click();
    const artifactPanel = page.getByRole("complementary", {
      name: /文件预览|File preview/u,
    });
    await expect(artifactPanel).toContainText("Reviewed content");
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: /下载文件|Download file/u }).click();
    const downloaded = await downloadPromise;
    expect(await readFile((await downloaded.path())!, "utf8")).toContain(
      "Reviewed content",
    );
    await page.screenshot({
      path: join(tmpdir(), "openpi-345-evidence-preview.png"),
      fullPage: true,
    });
    const accessibility = await new AxeBuilder({ page })
      .include(".artifact-panel")
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await page.getByRole("button", { name: "Related", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Related report" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /刷新文件|Refresh file/u }).click();
    await expect(
      page.getByRole("heading", { name: "Related report" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /关闭预览|Close preview/u }).click();
    const prompt = page.getByRole("textbox", { name: /描述任务|Describe/i });
    await prompt.fill("Update the report");
    await prompt.press("Enter");
    await expect(page.getByText("The report has been updated.")).toBeVisible();
    await page.getByRole("button", { name: "Report", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Updated report" }),
    ).toBeVisible();
    await writer.execute("write-external", {
      path,
      content: "# Latest report\nExternal revision",
    });
    await expect(
      page.getByRole("heading", { name: "Latest report" }),
    ).toBeVisible({ timeout: 8_000 });
    await rm(path);
    await expect(artifactPanel).toContainText(
      /当前显示旧版预览|Showing an older preview/u,
      { timeout: 8_000 },
    );
    await writer.execute("write-restore", {
      path,
      content: "# Restored report",
    });
    await page.reload();
    await page.getByRole("button", { name: "Report", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Restored report" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /关闭预览|Close preview/u }).click();
    await page.getByRole("button", { name: "Missing", exact: true }).click();
    await expect(artifactPanel).toContainText("File no longer exists");
    await page.getByRole("button", { name: /关闭预览|Close preview/u }).click();
    await page
      .getByRole("button", { name: "Other worktree", exact: true })
      .click();
    await expect(artifactPanel).not.toContainText("export const otherWorktree");
    await page
      .getByRole("button", { name: /只读打开此文件|Open this file read-only/u })
      .click();
    await expect(artifactPanel).toContainText(
      "export const otherWorktree = 42;",
    );
    await page.getByRole("button", { name: /刷新文件|Refresh file/u }).click();
    await expect(artifactPanel).toContainText(
      "export const otherWorktree = 42;",
    );
  } finally {
    await context.close();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await rm(baselineDirectory, { recursive: true, force: true });
  }
});
