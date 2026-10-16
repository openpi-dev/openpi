import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "@playwright/test";
import { WebHost } from "../../web/host/web-host.ts";
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

test("an image-only read result stays visible after refresh without embedding image bytes", async ({
  browser,
}) => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-tool-image-"));
  const manager = SessionManager.inMemory(cwd);
  const secret = "synthetic-image-data";
  manager.appendMessage({
    role: "user",
    content: "Look at the screenshot",
    timestamp: 1,
  });
  manager.appendMessage({
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "read-image",
        name: "read",
        arguments: { path: "shot.png" },
      },
    ],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage,
    stopReason: "toolUse",
    timestamp: 2,
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "read-image",
    toolName: "read",
    isError: false,
    timestamp: 3,
    content: [
      { type: "text", text: "Chart caption" },
      { type: "image", data: secret, mimeType: "image/png" },
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
  const context = await browser.newContext({ locale: "zh-CN" });
  const page = await context.newPage();
  try {
    await host.start();
    const snapshot = page.waitForResponse(
      (response) => response.url().includes("/api/snapshot") && response.ok(),
    );
    await page.goto(host.origin);
    expect(await (await snapshot).text()).not.toContain(secret);
    const sequence = page.locator(".process-sequence");
    await expect(sequence).toBeVisible();
    if ((await sequence.getAttribute("open")) === null)
      await sequence.locator(":scope > summary").click();
    const card = page.locator('[data-tool="read"]');
    const summary = card.locator(":scope > summary");
    await expect(summary).toContainText("1 张图片 · image/png");
    await expect(summary).toContainText("无法预览");
    await expect(card).toContainText("Chart caption");
    await expect(card).not.toContainText("无输出");
    await expect(card).not.toContainText(secret);
    await expect(card).toHaveAttribute("data-state", "returned");
    await page.reload();
    await expect(summary).toContainText("1 张图片 · image/png");
    await expect(card).not.toContainText(secret);
  } finally {
    await context.close();
    await host.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
