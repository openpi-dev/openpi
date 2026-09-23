import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "@playwright/test";
import { WebHost } from "../../web/host/web-host.ts";
import {
  WEB_TURN_CHANGES_ENTRY,
  type WebTurnChangesDetail,
} from "../../web/protocol/turn-changes.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";
import type { WebRuntimeController } from "../../web/runtime/types.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("saved per-turn review and full native message load at desktop and mobile widths", async ({
  browser,
}, testInfo) => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-turn-ui-"));
  const manager = SessionManager.inMemory(cwd);
  const first = manager.appendMessage({
    role: "user",
    content: "Update the report",
    timestamp: 1,
  });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "The report is updated." }],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage,
    stopReason: "stop",
    timestamp: 2,
  });
  const changes: WebTurnChangesDetail = {
    version: 1,
    sessionId: manager.getSessionId(),
    promptEntryId: first,
    state: "complete",
    fileCount: 5,
    additions: 15,
    deletions: 5,
    files: Array.from({ length: 5 }, (_, index) => ({
      path: `src/report-${index + 1}.ts`,
      status: "modified" as const,
      additions: index + 1,
      deletions: 1,
      diff: `@@ -1 +1 @@\n-old-${index}\n+saved-turn-${index}`,
      diffLoaded: true,
      diffTruncated: false,
    })),
  };
  manager.appendCustomEntry(WEB_TURN_CHANGES_ENTRY, changes);
  const longMessage = `Initial question: ${"long message content ".repeat(800)}END_OF_NATIVE_MESSAGE`;
  manager.appendMessage({ role: "user", content: longMessage, timestamp: 3 });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "A separate, later answer." }],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage,
    stopReason: "stop",
    timestamp: 4,
  });
  const runtime: WebRuntimeController = {
    cwd,
    workspaceSelected: true,
    sessionDirectory: cwd,
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
      throw new Error("Fixture is read only");
    },
  };
  const host = new WebHost({ runtime });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  });
  const page = await context.newPage();
  try {
    await host.start();
    await page.goto(host.origin);
    const card = page
      .locator(".conversation-turn")
      .first()
      .locator(".turn-changes");
    await expect(card).toContainText("此轮期间 5 个文件发生变化");
    await expect(
      card.locator(".turn-changes-list .turn-changes-file"),
    ).toHaveCount(3);
    await card.getByRole("button", { name: "再显示 2 个文件" }).click();
    await expect(
      card.locator(".turn-changes-list .turn-changes-file"),
    ).toHaveCount(5);
    await card.getByRole("button", { name: "审阅本轮变更" }).click();
    await expect(card.getByRole("figure", { name: "变更差异" })).toContainText(
      "saved-turn-0",
    );
    await expect(page.locator(".session-changes-trigger")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("turn-review-desktop.png"),
    });
    await card.getByRole("button", { name: "返回本轮变更" }).click();

    const full = page.getByRole("button", { name: "加载完整消息" });
    await expect(full).toHaveCount(1);
    await expect(page.getByText("END_OF_NATIVE_MESSAGE")).toHaveCount(0);
    await full.click();
    await expect(page.getByText("END_OF_NATIVE_MESSAGE")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();
    expect(
      await card.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
    const jump = page.getByRole("button", { name: "跳至最新" });
    await expect(jump).toBeVisible();
    const jumpBox = await jump.boundingBox();
    const composerBox = await page.locator(".composer").boundingBox();
    expect(
      jumpBox && composerBox && jumpBox.y + jumpBox.height < composerBox.y,
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("turn-review-mobile.png"),
    });
  } finally {
    await context.close();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
