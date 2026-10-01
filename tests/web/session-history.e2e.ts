import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "@playwright/test";
import { WebHost } from "../../web/host/web-host.ts";
import type { WebRuntimeController } from "../../web/runtime/types.ts";
import { projectWebModelSearch } from "../../web/runtime/model-discovery.ts";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
async function historyFixture() {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-history-browser-"));
  const manager = SessionManager.inMemory(cwd);
  const root = manager.appendMessage({
    role: "user",
    content: "Shared fixture root",
    timestamp: 1,
  });
  manager.appendMessage({
    role: "user",
    content: "Original question unique to the old branch",
    timestamp: 2,
  });
  const assistant = (text: string) =>
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    });
  for (let index = 0; index < 130; index++) {
    manager.appendMessage({
      role: "assistant",
      content: [
        { type: "text", text: `History progress ${index}.` },
        {
          type: "toolCall",
          id: `call-${index}`,
          name: "bash",
          arguments: { command: `printf fixture-${index}` },
        },
      ],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      usage,
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "toolResult",
      toolName: "bash",
      toolCallId: `call-${index}`,
      content: [{ type: "text", text: `Fixture result ${index}` }],
      isError: false,
      timestamp: Date.now(),
    });
  }
  assistant("Latest fixture answer.");
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
    sendPrompt: async (content) => {
      manager.appendMessage({ role: "user", content, timestamp: Date.now() });
      host.publish("message_end", {
        sessionId: manager.getSessionId(),
        messageKey: "new-user",
        message: { role: "user", content },
      });
      return { pendingFollowUps: 0 };
    },
  };
  const host = new WebHost({ runtime });
  await host.start();
  return {
    host,
    manager,
    root,
    assistant,
    async close() {
      await host.stop();
      await rm(cwd, { recursive: true, force: true });
    },
  };
}

test("older native history restores the user's question without moving the visible reading anchor", async ({
  browser,
}, testInfo) => {
  const fixture = await historyFixture();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  });
  const page = await context.newPage();
  try {
    await page.goto(fixture.host.origin);
    const conversation = page.locator(".conversation");
    await expect(conversation).toBeVisible();
    await expect(conversation.locator(".message-row.user")).toHaveCount(0);
    await conversation.evaluate((element) =>
      element.scrollTo({ top: 0, behavior: "instant" }),
    );
    const load = page.getByRole("button", {
      name: "加载更早的消息",
      exact: true,
    });
    await expect(load).toBeVisible();
    const anchor = conversation
      .locator(".message-row.assistant.response")
      .first();
    const key = await anchor.getAttribute("data-history-entry");
    const before = await anchor.boundingBox();
    await load.click();
    await expect(
      conversation.getByText("Original question unique to the old branch", {
        exact: true,
      }),
    ).toHaveCount(1);
    const anchored = conversation.locator(`[data-history-entry="${key}"]`);
    await expect
      .poll(async () => Math.abs((await anchored.boundingBox())!.y - before!.y))
      .toBeLessThanOrEqual(2);
    const stableScroll = await conversation.evaluate(
      (element) => element.scrollTop,
    );
    expect(stableScroll).toBeGreaterThan(0);
    fixture.host.publish("message_update", {
      sessionId: fixture.manager.getSessionId(),
      messageKey: "live-answer",
      message: {
        role: "assistant",
        content: "A new streamed answer is growing.",
      },
    });
    await expect(
      conversation.getByText("A new streamed answer is growing.", {
        exact: true,
      }),
    ).toHaveCount(1);
    expect(
      Math.abs(
        (await conversation.evaluate((element) => element.scrollTop)) -
          stableScroll,
      ),
    ).toBeLessThanOrEqual(2);
    const newLeaf = fixture.assistant("A new streamed answer is growing.");
    const refresh = page.waitForResponse(async (response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/snapshot" &&
        url.searchParams.has("historyAnchor") &&
        response.ok() &&
        (await response.json()).selectedSession?.history?.leafEntryId ===
          newLeaf
      );
    });
    fixture.host.publish("message_end", {
      sessionId: fixture.manager.getSessionId(),
      messageKey: "live-answer",
      message: {
        role: "assistant",
        content: "A new streamed answer is growing.",
      },
    });
    const refreshed = await (await refresh).json();
    expect(refreshed.selectedSession.history.anchorOnBranch).toBe(true);
    await expect
      .poll(() => conversation.locator(".message-row.user").count())
      .toBe(2);
    await conversation.evaluate((element) =>
      element.scrollTo({ top: 0, behavior: "instant" }),
    );
    await expect(
      page.getByRole("button", { name: "加载更早的消息" }),
    ).toHaveCount(0);
    await expect(
      conversation.getByText("Original question unique to the old branch", {
        exact: true,
      }),
    ).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath("history-original-question-restored.png"),
    });
    const input = page.getByRole("textbox", { name: "描述任务" });
    await input.fill("New user request while reading old history");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect(input).toHaveValue("");
    await expect(
      conversation.getByText("New user request while reading old history", {
        exact: true,
      }),
    ).toBeInViewport();
  } finally {
    await context.close();
    await fixture.close();
  }
});

test("a late real history page cannot enter a different native branch", async ({
  browser,
}) => {
  const fixture = await historyFixture();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  });
  const page = await context.newPage();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const read = new Promise<void>((resolve) => {
    ready = resolve;
  });
  try {
    await page.route("**/api/session/history?**", async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      expect(
        payload.session.entries.some(
          (entry: { message?: { content?: string } }) =>
            entry.message?.content ===
            "Original question unique to the old branch",
        ),
      ).toBe(true);
      ready();
      await gate;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.goto(fixture.host.origin);
    const conversation = page.locator(".conversation");
    await expect(conversation).toBeVisible();
    await conversation.evaluate((element) =>
      element.scrollTo({ top: 0, behavior: "instant" }),
    );
    await page
      .getByRole("button", { name: "加载更早的消息", exact: true })
      .click();
    await read;
    fixture.manager.branch(fixture.root);
    fixture.manager.appendMessage({
      role: "user",
      content: "New branch question",
      timestamp: Date.now(),
    });
    fixture.assistant("New branch answer");
    fixture.host.publish("session_progress", {
      sessionId: fixture.manager.getSessionId(),
    });
    await expect(
      conversation.getByText("New branch question", { exact: true }),
    ).toBeVisible();
    release();
    await expect(
      conversation.getByText("Original question unique to the old branch", {
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      conversation.getByText("New branch answer", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("会话分支已更改，已切换到当前分支的历史。", {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    release();
    await context.close();
    await fixture.close();
  }
});
