import { expect, test } from "@playwright/test";
import type { WebSnapshot } from "../../web/protocol/types.ts";

for (const theme of ["light", "dark"] as const) {
  test(`compaction interruption and reconnect notices stay aligned in ${theme}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({
      width: theme === "light" ? 1280 : 390,
      height: 900,
    });
    const reason =
      "Error running remote compact task: unexpected status 503 Service Unavailable: Service temporarily unavailable";
    await page.route("**/api/snapshot**", async (route) => {
      const response = await route.fetch();
      const snapshot = (await response.json()) as WebSnapshot;
      const session = snapshot.selectedSession;
      if (!session) throw new Error("Missing real Session fixture");
      snapshot.preferences = {
        ...snapshot.preferences,
        theme,
        chatFontSize: 16,
      };
      snapshot.runtime = {
        ...snapshot.runtime,
        status: "running",
        activeTurn: undefined,
      };
      session.entries = [
        {
          id: "status-prompt",
          type: "message",
          timestamp: "2026-10-13T00:00:00Z",
          message: { role: "user", content: "核对压缩中断和重新连接的展示。" },
        },
        {
          id: "status-error",
          type: "message",
          timestamp: "2026-10-13T00:00:01Z",
          message: {
            role: "assistant",
            content: "",
            stopReason: "error",
            errorMessage: "response stream closed",
          },
        },
      ];
      snapshot.selectedExecution = {
        sessionId: session.id,
        sessionPath: session.path,
        status: "running",
        liveTools: [],
        liveToolsOmitted: 0,
        compaction: { state: "failed", errorMessage: reason },
        retry: {
          attempt: 2,
          maxAttempts: 2,
          errorMessage: "response stream closed",
        },
      };
      await route.fulfill({ response, json: snapshot });
    });
    await page.goto("/");
    const conversation = page.locator(".conversation");
    const compaction = conversation.getByText("压缩已中断", { exact: true });
    const reconnect = conversation.getByText("正在重新连接 2/2", {
      exact: true,
    });
    const notice = conversation.getByRole("alert", { name: "上下文压缩失败" });
    await expect(compaction).toBeVisible();
    await expect(reconnect).toBeVisible();
    await expect(notice).toHaveText(reason);
    await expect(notice.locator("p")).toHaveCSS("font-size", "16px");
    await expect(notice.locator("svg.lucide-circle-alert")).toBeVisible();
    await expect(notice).toHaveCSS("border-top-style", "solid");
    await page.evaluate(() => document.fonts.ready);
    const compactBounds = (await compaction.boundingBox())!;
    const retryBounds = (await reconnect.boundingBox())!;
    const errorBounds = (await notice.boundingBox())!;
    expect(Math.abs(compactBounds.x - retryBounds.x)).toBeLessThanOrEqual(1);
    expect(compactBounds.y + compactBounds.height).toBeLessThan(retryBounds.y);
    expect(retryBounds.y + retryBounds.height).toBeLessThan(errorBounds.y);
    expect(
      await conversation.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    const disclosure = conversation.locator(".provider-attempts > summary");
    const arrow = disclosure.locator(".reconnect-chevron");
    await page.mouse.move(0, 0);
    await expect(arrow).toHaveCSS("opacity", "0");
    await disclosure.focus();
    await expect(arrow).toHaveCSS("opacity", "1");
    await page.keyboard.press("Enter");
    await expect(conversation.locator(".provider-attempts")).toHaveJSProperty(
      "open",
      true,
    );
    await expect(
      conversation.getByText("response stream closed", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Enter");
    await page.mouse.click(0, 0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(arrow).toHaveCSS("transition-duration", "0s");
    await page.screenshot({
      path: testInfo.outputPath(`compaction-reconnect-${theme}.png`),
    });
  });
}

test("conversation text stays readable and file links retain their exact target", async ({
  page,
}, testInfo) => {
  const path =
    "/workspace/packages/runtime-host/src/a-long-directory/session-history.ts";
  await page.route("**/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": heartbeat\n\n",
    }),
  );
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = (await response.json()) as WebSnapshot;
    if (!snapshot.selectedSession)
      throw new Error("Missing real Session fixture");
    snapshot.preferences = { ...snapshot.preferences, chatFontSize: 14 };
    snapshot.runtime = {
      ...snapshot.runtime,
      status: "idle",
      activeTurn: undefined,
    };
    snapshot.selectedSession.entries = [
      {
        id: "reading-question",
        timestamp: "2026-09-22T08:00:00Z",
        type: "message",
        message: {
          role: "user",
          content:
            "帮我检查这次修改，列出结论和仍需验证的地方。保留执行过程，我还想向上查看之前的问题。",
        },
      },
      {
        id: "reading-tool",
        timestamp: "2026-09-22T08:00:01Z",
        type: "message",
        message: {
          role: "assistant",
          content: "",
          parts: [
            {
              type: "toolCall",
              id: "reading-call",
              name: "read",
              arguments: JSON.stringify({ path }),
            },
          ],
        },
      },
      {
        id: "reading-result",
        timestamp: "2026-09-22T08:00:02Z",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "reading-call",
          toolName: "read",
          content: "Verified the current session path.",
          isError: false,
        },
      },
      {
        id: "reading-answer",
        timestamp: "2026-09-22T08:00:03Z",
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [
            "已经完成检查，**历史消息按会话保存**，界面应保留阅读位置。下方是这次修改的具体结果。",
            "## 检查结果",
            "1. 向上加载更早的消息时，当前内容仍留在原来的位置。\n2. 切换会话后，迟到的结果不会进入另一段对话。\n3. `sessionId`、`sessionPath` 与原生记录共同确定读取目标。",
            `相关实现：[session-history.ts](${path})。完整路径可以在链接提示中查看。`,
            "这里是一段中英文混合内容：OpenPI keeps the current reading position. 段落、列表和行内代码应自然换行，避免长路径挤占正文。",
            "```ts\nconst result = await loadEarlierMessages(sessionId);\nreturn result.entries;\n```",
          ].join("\n\n"),
        },
      },
    ];
    await route.fulfill({ response, json: snapshot });
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    const conversation = page.locator(".conversation");
    await expect(page.getByText("检查结果", { exact: true })).toBeVisible();
    await conversation.evaluate((element) => {
      element.scrollTo({ top: 0, behavior: "instant" });
    });
    await expect(
      page.getByText(
        "帮我检查这次修改，列出结论和仍需验证的地方。保留执行过程，我还想向上查看之前的问题。",
        { exact: true },
      ),
    ).toBeInViewport({ ratio: 1 });
    const link = page
      .locator(".message-row.response .markdown")
      .getByRole("button", { name: "session-history.ts", exact: true });
    await expect(link).toHaveAttribute("title", `Open read-only file: ${path}`);
    await expect(link.locator(".artifact-link-path")).toBeHidden();
    await expect(page.locator(".process-sequence")).toBeVisible();
    expect(
      await conversation.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    const response = page.locator(".message-row.response .markdown");
    await expect(response).toHaveCSS("font-size", "14px");
    await page.screenshot({
      path: testInfo.outputPath(`conversation-reading-${width}.png`),
    });
  }
});

for (const touch of [false, true]) {
  test.describe(touch ? "touch activity" : "desktop activity", () => {
    test.use({
      hasTouch: touch,
      isMobile: touch,
      viewport: { width: touch ? 390 : 1200, height: 900 },
    });

    test("keeps thinking folded and reveals activity details at the input boundary", async ({
      page,
    }, testInfo) => {
      await page.route("**/events?**", (route) =>
        route.fulfill({
          contentType: "text/event-stream",
          body: ": heartbeat\n\n",
        }),
      );
      await page.route("**/api/snapshot**", async (route) => {
        const response = await route.fetch();
        const snapshot = (await response.json()) as WebSnapshot;
        if (!snapshot.selectedSession)
          throw new Error("Missing real Session fixture");
        snapshot.preferences = {
          ...snapshot.preferences,
          expandThinking: false,
          theme: touch ? "light" : "dark",
        };
        snapshot.runtime = {
          ...snapshot.runtime,
          status: "idle",
          activeTurn: undefined,
        };
        snapshot.selectedSession.entries = [
          {
            id: "activity-question",
            timestamp: "2026-10-12T08:00:00Z",
            type: "message",
            message: { role: "user", content: "检查配置与实现。" },
          },
          {
            id: "activity-assistant",
            timestamp: "2026-10-12T08:00:01Z",
            type: "message",
            message: {
              role: "assistant",
              content: "",
              stopReason: "toolUse",
              parts: [
                {
                  type: "thinking",
                  text: "Inspecting implementation\n\n先读取配置，再核对检查结果。",
                },
                {
                  type: "toolCall",
                  id: "activity-read",
                  name: "read",
                  arguments: '{"path":"README.md"}',
                },
                {
                  type: "toolCall",
                  id: "activity-command",
                  name: "bash",
                  arguments: '{"command":"bun run check"}',
                },
              ],
            },
          },
          {
            id: "activity-read-result",
            timestamp: "2026-10-12T08:00:02Z",
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "activity-read",
              toolName: "read",
              content: "Configuration verified.",
              isError: false,
            },
          },
          {
            id: "activity-command-result",
            timestamp: "2026-10-12T08:00:03Z",
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "activity-command",
              toolName: "bash",
              content: "Checks passed.",
              isError: false,
            },
          },
          {
            id: "activity-answer",
            timestamp: "2026-10-12T08:00:04Z",
            type: "message",
            message: {
              role: "assistant",
              stopReason: "stop",
              content: "配置与检查结果已核对。",
            },
          },
        ];
        await route.fulfill({ response, json: snapshot });
      });
      await page.goto("/");
      const group = page.locator(".process-sequence:not(.single-process)");
      const summary = group.locator(":scope > summary");
      const counts = summary.locator(".process-sequence-counts");
      const arrow = summary.locator(".tool-disclosure");
      await expect(group).toHaveJSProperty("open", false);
      await expect(summary).toHaveAccessibleName(/2.*工具调用/);
      if (!touch) {
        await page.mouse.move(0, 0);
        await expect(counts).toHaveCSS("opacity", "0");
        await expect(arrow).toHaveCSS("opacity", "0");
        await page.evaluate(() => document.fonts.ready);
        const before = await summary.boundingBox();
        await summary.hover();
        await expect(counts).toHaveCSS("opacity", "1");
        await expect(arrow).toHaveCSS("opacity", "1");
        expect(await summary.boundingBox()).toEqual(before);
        await page.mouse.move(0, 0);
        await expect(counts).toHaveCSS("opacity", "0");
        await page.keyboard.press("Tab");
        await summary.focus();
        await expect(counts).toHaveCSS("opacity", "1");
        await page.keyboard.press("Enter");
      } else {
        await expect(counts).toHaveCSS("opacity", "1");
        await expect(arrow).toHaveCSS("opacity", "1");
        await summary.tap();
      }
      await expect(group).toHaveJSProperty("open", true);
      const thinking = group.locator(".thinking-line");
      const thinkingSummary = thinking.locator(":scope > summary");
      const thinkingArrow = thinkingSummary.locator(".tool-disclosure");
      await expect(thinking).toHaveJSProperty("open", false);
      await expect(thinkingSummary).toHaveText("Inspecting implementation");
      await expect(thinkingSummary.locator(".lucide-lightbulb")).toBeVisible();
      await expect(group.locator(".thought-tool-step")).toHaveCount(2);
      await expect(group.locator(".thought-tool-step").first()).toHaveCSS(
        "border-left-width",
        "1px",
      );
      if (!touch) {
        await expect(thinkingArrow).toHaveCSS("opacity", "0");
        await thinkingSummary.hover();
        await expect(thinkingArrow).toHaveCSS("opacity", "1");
        await page.mouse.move(0, 0);
        await expect(thinkingArrow).toHaveCSS("opacity", "0");
        await page.keyboard.press("Tab");
        await thinkingSummary.focus();
        await expect(thinkingArrow).toHaveCSS("opacity", "1");
        await page.keyboard.press("Enter");
      } else {
        await expect(thinkingArrow).toHaveCSS("opacity", "1");
        await thinkingSummary.tap();
      }
      await expect(thinking).toHaveJSProperty("open", true);
      await expect(thinkingArrow).toHaveCSS(
        "transform",
        "matrix(0, 1, -1, 0, 0, 0)",
      );
      await expect(thinking.locator(".thinking-evidence")).toContainText(
        "先读取配置，再核对检查结果。",
      );
      await thinkingSummary.click();
      await expect(thinking).toHaveJSProperty("open", false);
      await page.getByText("配置与检查结果已核对。", { exact: true }).click();
      await page.mouse.move(0, 0);
      await expect(thinkingArrow).toHaveCSS("opacity", touch ? "1" : "0");
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect(thinkingArrow).toHaveCSS("transition-duration", "0s");
      await page.screenshot({
        path: testInfo.outputPath("activity-disclosure.png"),
      });
    });
  });
}
