import { expect, test } from "@playwright/test";
import type { WebSnapshot } from "../../web/protocol/types.ts";

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
    const link = page.getByRole("button", {
      name: "session-history.ts",
      exact: true,
    });
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
