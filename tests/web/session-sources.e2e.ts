import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "@playwright/test";
import { WebHost } from "../../web/host/web-host.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";
import type { WebRuntimeController } from "../../web/runtime/types.ts";

test("overview totals and native sources survive reload, preview and mobile navigation", async ({
  browser,
}, testInfo) => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-sources-ui-"));
  const exec = promisify(execFile);
  await exec("git", ["-C", cwd, "init", "-b", "main"]);
  await writeFile(join(cwd, "notes.txt"), "source fixture\nsecond line\n");
  const manager = SessionManager.inMemory(cwd);
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const images = Array.from({ length: 4 }, (_, index) => ({
    type: "image" as const,
    data: png,
    mimeType: "image/png",
    name: `Design ${index + 1}.png`,
  }));
  manager.appendMessage({
    role: "user",
    timestamp: Date.now(),
    content: [
      ...images,
      { type: "text", text: "Review [notes.txt](<notes.txt>)" },
    ],
  });
  const runtime: WebRuntimeController = {
    cwd,
    workspaceSelected: true,
    sessionDirectory: cwd,
    sessionManager: manager,
    isIdle: () => true,
    getActiveTurn: () => undefined,
    cancelTurn: async (options) => ({ ...options, state: "stale-turn" }),
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
    subscribe: () => () => undefined,
    dispose: async () => undefined,
    sendPrompt: async () => {
      throw new Error("read only fixture");
    },
  };
  const host = new WebHost({ runtime });
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  // Override only presentation preferences; Sources and Git use the real Host.
  await page.route("**/api/snapshot*", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    await route.fulfill({
      response,
      json: {
        ...snapshot,
        preferences: { ...snapshot.preferences, theme: "system" },
      },
    });
  });
  await page.emulateMedia({ colorScheme: "light" });
  try {
    await host.start();
    await page.goto(host.origin);
    await page.getByRole("button", { name: "会话概览", exact: true }).click();
    const overview = page.locator(".session-overview");
    await expect(overview.locator(".session-source-row")).toHaveCount(3);
    await expect(overview.locator(".session-overview-diff")).toHaveText("+2−0");
    await expect(overview.locator(".session-source-icon img")).toHaveCount(3);
    await page.screenshot({
      path: testInfo.outputPath("overview-light-desktop.png"),
    });
    await overview
      .getByRole("button", { name: "Design 1.png", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("img", { name: "Design 1.png" }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "返回来源列表" }).click();
    await expect(dialog.locator(".session-source-row")).toHaveCount(5);
    await dialog
      .getByRole("button", { name: "notes.txt", exact: true })
      .click();
    await expect(page.locator(".artifact-panel")).toContainText(
      "source fixture",
    );
    await page.keyboard.press("Escape");
    await page.reload();
    await page.getByRole("button", { name: "会话概览", exact: true }).click();
    await overview
      .getByRole("button", { name: "查看全部", exact: true })
      .click();
    await expect(dialog.locator(".session-source-row")).toHaveCount(5);
    await page.keyboard.press("Escape");
    const input = page.locator(".composer textarea");
    await input.fill("Preserve my draft");
    await page.getByRole("button", { name: "会话概览", exact: true }).click();
    await overview
      .getByRole("button", { name: "添加来源", exact: true })
      .click();
    await expect(
      page.getByRole("menuitem", { name: /引用工作区文件/u }),
    ).toBeVisible();
    await expect(input).toHaveValue("Preserve my draft");
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.getByRole("button", { name: "会话概览", exact: true }).click();
    await expect(overview).toBeVisible();
    const bounds = await overview.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(
      await overview.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("overview-dark-mobile.png"),
    });
    await overview
      .getByRole("button", { name: "Design 2.png", exact: true })
      .click();
    await expect(
      dialog.getByRole("img", { name: "Design 2.png" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "会话概览", exact: true }),
    ).toBeFocused();
  } finally {
    await context.close();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
