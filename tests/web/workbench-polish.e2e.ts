import { expect, test } from "@playwright/test";
import type {
  WebCommandDiscoveryResult,
  WebSnapshot,
} from "../../web/protocol/types.ts";

test("conversation pin persists through browser reload and unpin returns it to its workspace", async ({
  page,
}) => {
  await page.goto("/");
  const sidebar = page.locator(".session-sidebar");
  const row = sidebar.locator(".workspace-sessions .session-row").first();
  await row.hover();
  const title = await row.locator(".session-title").textContent();
  await row.getByRole("button", { name: "会话选项" }).click();
  await expect(page.getByRole("menuitem", { name: "置顶会话" })).toHaveCount(0);
  await expect(
    page.getByRole("menuitem", { name: "重命名会话" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await row.getByRole("button", { name: "置顶会话", exact: true }).click();
  const pins = sidebar.getByRole("region", { name: "置顶", exact: true });
  await expect(pins.locator(".session-title")).toHaveText(title!);
  await page.reload();
  await expect(pins.locator(".session-title")).toHaveText(title!);
  await pins.locator(".session-row").hover();
  await pins.getByRole("button", { name: "会话选项" }).click();
  await expect(page.getByRole("menuitem", { name: "取消置顶" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await pins.getByRole("button", { name: "取消置顶", exact: true }).click();
  await expect(pins).toHaveCount(0);
  await expect(
    sidebar.locator(".workspace-sessions .session-title").first(),
  ).toHaveText(title!);
});

test("pinned section supports drag, keyboard ordering and light dark touch layouts", async ({
  page,
}, testInfo) => {
  let theme: "light" | "dark" = "light";
  let order = ["design", "navigation", "research"];
  let sort = "manual";
  await page.route("**/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": heartbeat\n\n",
    }),
  );
  await page.route("**/api/sessions/pin", async (route) => {
    const body = route.request().postDataJSON();
    order = order.filter((id) => id !== body.id);
    if (body.pinned)
      order.splice(
        body.before ? order.indexOf(body.before.id) : order.length,
        0,
        body.id,
      );
    await route.fulfill({ json: { saved: true } });
  });
  await page.route("**/api/settings/preferences", async (route) => {
    sort = route.request().postDataJSON().pinnedSort;
    await route.fulfill({ json: { saved: true } });
  });
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const value = (await response.json()) as WebSnapshot;
    const real = value.sessions[0]!;
    value.preferences = {
      ...value.preferences,
      theme,
      pinnedSort: sort as "manual" | "updated",
    };
    value.sessions = [
      ...["design", "navigation", "research"].map((id, index) => ({
        ...real,
        id,
        path: `/preview/${id}.jsonl`,
        name: [
          "工作区导航与交互细节",
          "优化 OpenPI 启动速度",
          "梳理项目里的设计参考",
        ][index],
        modified: `2026-09-2${index + 1}T10:00:00Z`,
        ...(order.includes(id) ? { pinOrder: order.indexOf(id) } : {}),
      })),
      { ...real, name: "下一轮界面细节" },
    ];
    value.workspaces[0]!.name = "openpi";
    await route.fulfill({ response, json: value });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const pins = page.getByRole("region", { name: "置顶", exact: true });
  const rows = pins.locator(".session-row");
  await expect(rows).toHaveCount(3);
  await rows.nth(2).dragTo(rows.nth(0), { targetPosition: { x: 60, y: 4 } });
  await expect(pins.locator(".session-title").first()).toHaveText(
    "梳理项目里的设计参考",
  );
  await pins.getByRole("button", { name: "会话选项" }).first().focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "下移", exact: true }).click();
  await expect(pins.locator(".session-title").first()).toHaveText(
    "工作区导航与交互细节",
  );
  await page.locator(".task-header").click();
  await page.screenshot({ path: testInfo.outputPath("pinned-light.png") });
  await pins.getByRole("button", { name: "置顶选项" }).click();
  await page.screenshot({ path: testInfo.outputPath("pinned-sort-menu.png") });
  await page.getByRole("menuitem", { name: "最近更新", exact: true }).click();
  await expect(pins.locator(".session-title").first()).toHaveText(
    "梳理项目里的设计参考",
  );
  await pins.getByRole("button", { name: "置顶选项" }).click();
  await page.getByRole("menuitem", { name: "手动排序", exact: true }).click();
  await expect(pins.locator(".session-title").first()).toHaveText(
    "工作区导航与交互细节",
  );
  theme = "dark";
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: testInfo.outputPath("pinned-dark.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开侧边栏" }).click();
  const pinButton = pins
    .getByRole("button", { name: "取消置顶", exact: true })
    .first();
  await expect(pinButton).toBeVisible();
  expect((await pinButton.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: testInfo.outputPath("pinned-mobile.png"),
    animations: "disabled",
  });
});

test("session rail separates live, waiting and terminal states without covering actions", async ({
  page,
}, testInfo) => {
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const value = (await response.json()) as WebSnapshot;
    const real = value.sessions[0]!;
    value.preferences.theme = "light";
    value.sessions = [
      {
        ...real,
        id: "live",
        path: "/preview/live",
        name: "重设计工作区前端",
        execution: { status: "running" },
      },
      {
        ...real,
        id: "waiting",
        path: "/preview/waiting",
        name: "等待确认设计方向",
        execution: { status: "running", waitingForInput: true },
      },
      ...(["completed", "failed", "cancelled", "uncertain"] as const).map(
        (outcome, index) => ({
          ...real,
          id: outcome,
          path: `/preview/${outcome}`,
          name: [
            "模型配置交互已完成",
            "连接检查需要处理",
            "已停止的会话",
            "执行结果待确认",
          ][index],
          execution: {
            status: "idle" as const,
            lastTurn: { commandId: outcome, outcome, finishedAt: 1 },
          },
        }),
      ),
      real,
    ];
    await route.fulfill({ response, json: value });
  });
  await page.goto("/");
  await expect(page.locator(".session-state-running")).toBeVisible();
  await expect(page.locator(".session-state-attention")).toHaveCount(2);
  await expect(page.locator(".session-state-completed")).toBeVisible();
  await expect(
    page.locator(".session-state-cancelled, .session-state-uncertain"),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("session-states.png"),
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开侧边栏" }).click();
  await page.screenshot({
    path: testInfo.outputPath("session-states-mobile.png"),
    animations: "disabled",
  });
});

test("workspace rail keeps names readable and archive navigation reachable across desktop and touch layouts", async ({
  page,
}, testInfo) => {
  let theme: "light" | "dark" = "light";
  await page.route("**/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": heartbeat\n\n",
    }),
  );
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const value = (await response.json()) as WebSnapshot;
    value.preferences = { ...value.preferences, theme };
    const current = value.selectedSession;
    if (!current) throw new Error("Missing real Session fixture");
    value.workspaces = [
      { path: current.cwd, name: "openpi", current: true },
      { path: "/design/notes", name: "设计笔记", current: false },
      { path: "/projects/experiments", name: "experiments", current: false },
    ];
    value.sessions = value.sessions.map((session) => ({
      ...session,
      name: "工作区导航与交互细节",
    }));
    await route.fulfill({ response, json: value });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const sidebar = page.locator(".session-sidebar");
  const workspace = sidebar.locator(".workspace-label").first();
  await expect(sidebar.getByText("工作区导航与交互细节")).toBeVisible();
  await expect(sidebar.locator(".workspace-identity small")).toHaveCount(0);
  await expect(workspace).toHaveAttribute("title", /openpi/);
  await expect(sidebar.locator(".session.active")).toHaveCSS(
    "box-shadow",
    "none",
  );
  const archive = sidebar.getByRole("button", { name: "已归档", exact: true });
  await archive.focus();
  await page.keyboard.press("Enter");
  await expect(archive).toHaveAttribute("aria-pressed", "true");
  await sidebar.getByRole("button", { name: "当前", exact: true }).click();
  await expect(workspace).toBeVisible();
  await workspace.focus();
  await expect(workspace.locator(".workspace-chevron")).toHaveCSS(
    "opacity",
    "1",
  );
  await page.keyboard.press("Enter");
  await expect(workspace).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  await expect(workspace).toHaveAttribute("aria-expanded", "true");
  await page.locator(".task-header").click();
  await page.screenshot({
    path: testInfo.outputPath("workspace-rail-light.png"),
  });
  theme = "dark";
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: testInfo.outputPath("workspace-rail-dark.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开侧边栏" }).click();
  await expect(sidebar).toBeVisible();
  for (const control of [
    archive,
    workspace,
    sidebar.locator(".session").first(),
  ]) {
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  expect(
    await sidebar.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("workspace-rail-mobile.png"),
  });
});

test("long session titles stay compact and elapsed time survives refresh with confirmed settlement", async ({
  page,
}, testInfo) => {
  const title =
    "持续优化侧边工具与配置体验，保留原生执行事实并验证真实浏览器。".repeat(12);
  let settled = false;
  const start = Date.now() - 2142000;
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const value = (await response.json()) as WebSnapshot;
    const session = value.selectedSession;
    if (!session) throw new Error("Missing real Session fixture");
    value.sessions = value.sessions.map((item) =>
      item.path === session.path ? { ...item, name: title } : item,
    );
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
  await expect(page.getByText("用时 2分钟37秒", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("compact-sidebar-running-time.png"),
  });
  await page.reload();
  await expect(page.getByRole("timer")).toContainText("已处理 35分钟");
  settled = true;
  await page.reload();
  await expect(page.getByRole("timer")).toHaveCount(0);
  const elapsed = page.getByText("用时 35分钟45秒", { exact: true });
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
  ).toMatchObject({ availability: "available", source: "extension" });
  expect(
    commands.commands.find((command) => command.name === "usage")?.action,
  ).toBeUndefined();
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
  await input.fill("/subagents");
  await input.press("Escape");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "子代理", exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue("");
  expect(prompts).toEqual([]);
});
