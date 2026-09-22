import { expect, test } from "@playwright/test";
import type {
  WebCommandDiscoveryResult,
  WebSnapshot,
} from "../../web/protocol/types.ts";

test("long session titles stay compact and elapsed time survives refresh with confirmed settlement", async ({
  page,
}, testInfo) => {
  const title =
    "持续优化侧边工具与配置体验，保留原生执行事实并验证真实浏览器。".repeat(12);
  let settled = false;
  const start = Date.now() - 2142000;
  await page.route("**/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": heartbeat\n\n",
    }),
  );
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const value = (await response.json()) as WebSnapshot;
    const session = value.selectedSession;
    if (!session) throw new Error("Missing real Session fixture");
    value.sessions = value.sessions.map((item) =>
      item.path === session.path ? { ...item, name: title } : item,
    );
    value.cursor = settled ? 92002 : 92001;
    value.runtime = {
      ...value.runtime,
      status: settled ? "idle" : "running",
      activeTurn: settled
        ? undefined
        : {
            sessionId: session.id,
            sessionPath: session.path,
            commandId: "current-fixture",
            epoch: 2,
            startedAt: start,
            elapsedMs: 2142000,
          },
    };
    value.selectedExecution = {
      sessionId: session.id,
      sessionPath: session.path,
      status: value.runtime.status,
      activeTurn: value.runtime.activeTurn,
      pendingFollowUps: 0,
      liveTools: [],
      liveToolsOmitted: 0,
    };
    session.entries = [
      {
        id: "question-previous",
        type: "message",
        timestamp: new Date(start - 200000).toISOString(),
        message: { role: "user", content: "Previous request" },
      },
      {
        id: "answer-previous",
        type: "message",
        timestamp: new Date(start - 43000).toISOString(),
        message: {
          role: "assistant",
          content: "Previous completed answer",
          stopReason: "stop",
        },
      },
      {
        id: "timing-previous",
        type: "custom",
        timestamp: new Date(start - 43000).toISOString(),
        turnTiming: {
          version: 1,
          sessionId: session.id,
          commandId: "previous-fixture",
          epoch: 1,
          startedAt: start - 200000,
          finishedAt: start - 43000,
          elapsedMs: 157000,
          outcome: "completed",
        },
      },
      {
        id: "question-current",
        type: "message",
        timestamp: new Date(start).toISOString(),
        message: { role: "user", content: "Current request" },
      },
    ];
    if (settled)
      session.entries.push(
        {
          id: "answer-current",
          type: "message",
          timestamp: new Date(start + 2145000).toISOString(),
          message: {
            role: "assistant",
            content: "Current completed answer",
            stopReason: "stop",
          },
        },
        {
          id: "timing-current",
          type: "custom",
          timestamp: new Date(start + 2145000).toISOString(),
          turnTiming: {
            version: 1,
            sessionId: session.id,
            commandId: "current-fixture",
            epoch: 2,
            startedAt: start,
            finishedAt: start + 2145000,
            elapsedMs: 2145000,
            outcome: "completed",
          },
        },
      );
    await route.fulfill({ response, json: value });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  const row = page.locator(".session.active");
  await expect(row).toBeVisible();
  expect((await row.boundingBox())!.height).toBeLessThanOrEqual(40);
  await expect(row.locator(".session-title")).toHaveAttribute("title", title);
  await expect(page.getByRole("timer")).toContainText("已处理 35分钟");
  await expect(page.getByText("用时 2m37s", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("compact-sidebar-running-time.png"),
  });
  await page.reload();
  await expect(page.getByRole("timer")).toContainText("已处理 35分钟");
  settled = true;
  await page.reload();
  await expect(page.getByRole("timer")).toHaveCount(0);
  const elapsed = page.getByText("用时 35m45s", { exact: true });
  await expect(elapsed).toBeVisible();
  const answer = page.getByText("Current completed answer", { exact: true });
  expect((await elapsed.boundingBox())!.y).toBeLessThan(
    (await answer.boundingBox())!.y,
  );
  await page.screenshot({
    path: testInfo.outputPath("settled-time-before-answer.png"),
  });
});

test("native command discovery offers real Web panels without sending a model prompt", async ({
  page,
}) => {
  const prompts: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/prompt") && request.method() === "POST")
      prompts.push(request.postData() ?? "");
  });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "描述任务" });
  const discovered = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/commands" && response.ok(),
  );
  await input.fill("/");
  const commands = (await (
    await discovered
  ).json()) as WebCommandDiscoveryResult;
  expect(
    commands.commands.find((command) => command.name === "openpi-setup"),
  ).toMatchObject({ availability: "available", source: "extension" });
  expect(
    commands.commands.find((command) => command.name === "usage"),
  ).toMatchObject({ availability: "available", action: "runtime" });
  await expect(
    page.getByRole("option", { name: /openpi-setup/ }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: /usage/ }).first(),
  ).toBeVisible();
  await input.fill("/btw keep this question");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(input).toHaveValue("/btw keep this question");
  await expect(page.getByRole("alert")).toContainText("不能携带参数或图片");
  expect(prompts).toEqual([]);
  await input.fill("/usage");
  await input.press("Escape");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(input).toHaveValue("");
  expect(prompts).toEqual([]);
});
