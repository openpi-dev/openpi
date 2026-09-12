import { AxeBuilder } from "@axe-core/playwright";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, type Page, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const token = process.env.OPENPI_WEB_E2E_TOKEN;
if (!token) throw new Error("OPENPI_WEB_E2E_TOKEN is required");

const authenticatedPath = "/";

async function openWorkbench(page: Page) {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.protocol.startsWith("http") &&
      url.origin !== "http://127.0.0.1:57109"
    ) {
      externalRequests.push(request.url());
    }
  });
  await page.goto(authenticatedPath, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("textbox", { name: "描述任务" })).toBeVisible();
  return externalRequests;
}

test("production workbench is local, keyboard-operable, and accessible", async ({
  page,
}) => {
  const externalRequests = await openWorkbench(page);

  await expect(
    page.getByRole("heading", { level: 1, name: "OpenPI" }),
  ).toBeAttached();
  await expect(page.locator('script[src*="@vite/client"]')).toHaveCount(0);
  await expect.poll(() => externalRequests).toEqual([]);

  const logo = page.getByRole("button", {
    name: "Replay OpenPI logo animation",
  });
  await logo.click();
  await expect
    .poll(
      () =>
        logo
          .locator(".pixel-mark i")
          .first()
          .evaluate((node) => getComputedStyle(node).opacity),
      { timeout: 1_500 },
    )
    .not.toBe("0");

  const workspaceMenu = page.getByRole("button", {
    name: "Workspace options",
  });
  await workspaceMenu.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("menu", { name: "Workspace options" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
  const width = await page.evaluate(() => ({
    client: document.body.clientWidth,
    scroll: document.body.scrollWidth,
  }));
  expect(width.scroll).toBe(width.client);

  const turnRailLayout = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".conversation-shell");
    const conversation = document.querySelector<HTMLElement>(".conversation");
    if (!shell || !conversation)
      throw new Error("conversation shell is missing");
    const message = document.createElement("article");
    message.className = "message-row assistant";
    message.textContent = "Layout probe";
    const rail = document.createElement("nav");
    rail.className = "turn-rail";
    conversation.append(message);
    shell.append(rail);
    const messageRect = message.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    message.remove();
    rail.remove();
    return {
      gutter: shellRect.right - railRect.right,
      messageRight: messageRect.right,
      railLeft: railRect.left,
    };
  });
  expect(turnRailLayout.gutter).toBeCloseTo(24, 0);
  expect(turnRailLayout.railLeft).toBeGreaterThanOrEqual(
    turnRailLayout.messageRight,
  );
});

test.describe("touch viewport", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("keeps navigation and dialogs inside the mobile viewport", async ({
    page,
  }) => {
    await openWorkbench(page);
    await page.getByRole("button", { name: "打开侧边栏" }).click();

    const sidebar = page.locator(".session-sidebar");
    await expect(sidebar).toHaveCSS("backdrop-filter", "none");
    await expect
      .poll(async () => (await sidebar.boundingBox())?.x, { timeout: 1_500 })
      .toBe(0);
    const sidebarBox = await sidebar.boundingBox();
    expect(sidebarBox?.width).toBeLessThanOrEqual(300);

    const sessionMenu = sidebar
      .getByRole("button", { name: "会话选项" })
      .first();
    await expect(sessionMenu).toBeVisible();
    await sessionMenu.click();
    await expect(page.getByRole("menu", { name: "会话选项" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Workspace options" }).click();
    await page.getByRole("menuitem", { name: "重命名工作区" }).click();
    const dialog = page.getByRole("dialog", { name: "重命名工作区" });
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(390);
    await page.getByRole("button", { name: "取消" }).click();

    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations).toEqual([]);
    const width = await page.evaluate(() => ({
      client: document.body.clientWidth,
      scroll: document.body.scrollWidth,
    }));
    expect(width.scroll).toBe(width.client);
  });
});

for (const width of [320, 390]) {
  test(`mobile sidebar contains keyboard focus at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const requests = await openWorkbench(page);
    const trigger = page.getByRole("button", { name: "打开侧边栏" });
    const sidebar = page.locator(".session-sidebar");
    await page.keyboard.press("Tab");
    await expect(trigger).toBeFocused();
    await expect(sidebar).not.toBeVisible();
    await page.keyboard.press("Enter");
    await expect(sidebar).toHaveAttribute("role", "dialog");
    await expect(sidebar).toHaveAttribute("aria-modal", "true");
    await expect(page.locator("main")).toHaveAttribute("inert", "");
    const close = sidebar.getByRole("button", { name: "收起侧边栏" });
    await expect(close).toBeFocused();
    await expect.poll(async () => (await sidebar.boundingBox())?.x).toBe(0);

    const last = sidebar.getByRole("button", { name: "会话选项" }).last();
    for (const source of ["brand", "search"] as const) {
      for (const key of ["Tab", "Shift+Tab", "Escape"]) {
        if (source === "brand") {
          await sidebar.locator(".brand-lockup").click();
          await expect(sidebar).toBeFocused();
        } else {
          const search = sidebar.getByRole("button", { name: "搜索会话" });
          await search.click();
          await sidebar.getByRole("button", { name: "关闭搜索" }).click();
          await expect(search).toBeFocused();
        }
        await page.keyboard.press(key);
        if (key === "Escape") {
          await expect(sidebar).not.toBeVisible();
          await expect(trigger).toBeFocused();
          await trigger.click();
        } else {
          expect(
            await sidebar.evaluate((element) =>
              element.contains(document.activeElement),
            ),
          ).toBe(true);
        }
      }
    }
    await expect(close).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(last).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    await last.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("menuitem", { name: "重命名会话" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(close).toBeFocused();
    for (let step = 0; step < 15; step++) {
      await page.keyboard.press("Tab");
      expect(
        await sidebar.evaluate((element) =>
          element.contains(document.activeElement),
        ),
      ).toBe(true);
    }

    const menu = sidebar.getByRole("button", { name: "Workspace options" });
    await menu.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("menuitem", { name: "重命名工作区" }),
    ).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
    await expect(sidebar).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("menuitem", { name: "重命名工作区" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "重命名工作区" });
    await expect(
      dialog.getByRole("textbox", { name: "工作区名称" }),
    ).toBeFocused();
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox?.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(menu).toBeFocused();
    await expect(sidebar).toBeVisible();
    await expect(menu).toHaveCSS("outline-style", "solid");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`sidebar-keyboard-${width}.png`),
      fullPage: true,
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await page.keyboard.press("Escape");
    await expect(sidebar).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("main")).not.toHaveAttribute("inert", "");
    await page.keyboard.press("Tab");
    expect(
      await sidebar.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(false);
    expect(requests).toEqual([]);
  });
}

test("mobile sidebar releases focus isolation when resized to desktop", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkbench(page);
  const trigger = page.getByRole("button", { name: "打开侧边栏" });
  await trigger.click();
  await page.setViewportSize({ width: 1280, height: 844 });
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
  await expect(page.locator(".session-sidebar")).not.toHaveAttribute(
    "role",
    "dialog",
  );
  await page.getByRole("textbox", { name: "描述任务" }).focus();
  await expect(page.getByRole("textbox", { name: "描述任务" })).toBeFocused();
  await page.getByRole("button", { name: "收起侧边栏" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".session-sidebar")).not.toBeVisible();
  await trigger.click();
  await page.getByRole("button", { name: "收起侧边栏" }).click();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.locator(".sidebar-scrim").click({ position: { x: 380, y: 400 } });
  await expect(page.locator(".session-sidebar")).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test("mobile sidebar recovers focus when archived and restored rows disappear", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkbench(page);
  const snapshot = await (
    await page.request.get("/api/snapshot", {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  // Pi does not persist empty new Sessions; use a header-only fixture, not a model response.
  const fixture = SessionManager.inMemory(snapshot.selectedSession.cwd);
  const path = join(
    dirname(snapshot.selectedSession.path),
    `${fixture.getSessionId()}.jsonl`,
  );
  await writeFile(path, `${JSON.stringify(fixture.getHeader())}\n`, {
    flag: "wx",
  });
  try {
    await page.reload();
    const trigger = page.getByRole("button", { name: "打开侧边栏" });
    const sidebar = page.locator(".session-sidebar");
    const close = sidebar.getByRole("button", { name: "收起侧边栏" });
    await trigger.click();
    for (const action of ["归档会话", "恢复会话"]) {
      const rows = sidebar.locator(".session-row");
      const count = await rows.count();
      await rows
        .filter({ hasNot: page.locator('[aria-current="page"]') })
        .first()
        .getByRole("button", { name: "会话选项" })
        .focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: action }).click();
      await expect(rows).toHaveCount(count - 1);
      await expect(close).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(
        sidebar.getByRole("button", { name: "新建会话", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(sidebar).not.toBeVisible();
      await expect(trigger).toBeFocused();
      await trigger.click();
      await sidebar
        .getByRole("button", { name: "已归档", exact: true })
        .click();
    }
  } finally {
    await rm(path, { force: true });
  }
});

test.describe("reduced motion", () => {
  test.use({
    contextOptions: { locale: "zh-CN", reducedMotion: "reduce" },
  });

  test("renders the logo in its final static state", async ({ page }) => {
    await openWorkbench(page);
    const logo = page.getByRole("button", {
      name: "Replay OpenPI logo animation",
    });
    const state = await logo.evaluate((element) => {
      const word = element.querySelector<HTMLElement>(".brand-word");
      const pixel = element.querySelector<HTMLElement>(".pixel-mark i");
      return {
        pixelAnimation: pixel ? getComputedStyle(pixel).animationName : "",
        wordAnimation: word ? getComputedStyle(word).animationName : "",
        wordOpacity: word ? getComputedStyle(word).opacity : "",
      };
    });
    expect(state).toEqual({
      pixelAnimation: "none",
      wordAnimation: "none",
      wordOpacity: "1",
    });
  });
});

test("restores a running turn and canonical dark theme without losing cancellation", async ({
  page,
}, testInfo) => {
  const turn = {
    sessionId: "browser-parity-session",
    commandId: "browser-parity-turn",
    epoch: 7,
  };
  const cancelRequests: unknown[] = [];
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.preferences = { theme: "dark" };
    snapshot.currentSessionId = turn.sessionId;
    snapshot.selectedSession = {
      id: turn.sessionId,
      path: "/browser-parity/session.jsonl",
      cwd: "/browser-parity",
      entries: [
        {
          id: "user",
          type: "message",
          timestamp: "2026-09-07T00:00:00Z",
          message: { role: "user", content: "Inspect the current task" },
        },
        {
          id: "assistant",
          type: "message",
          timestamp: "2026-09-07T00:00:01Z",
          message: {
            role: "assistant",
            content:
              "Working on the current task.\nStreaming output stays readable.",
          },
        },
      ],
      bytes: 200,
      truncation: {
        truncated: false,
        maxBytes: 2097152,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
      },
    };
    snapshot.runtime = {
      status: "running",
      activeTurn: turn,
      capabilities: {},
    };
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": heartbeat\n\n",
    }),
  );
  await page.route("**/api/turns/cancel", async (route) => {
    cancelRequests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 202,
      json: { ...turn, state: "accepted", accepted: true, cursor: 0 },
    });
  });
  await openWorkbench(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator(".message-row.assistant")).toContainText(
    "Streaming output stays readable.",
  );
  await page.screenshot({
    path: testInfo.outputPath("running-dark.png"),
    fullPage: true,
  });
  const stop = page.getByRole("button", { name: "停止当前轮次", exact: true });
  await expect(stop).toBeVisible();
  await stop.click();
  await expect.poll(() => cancelRequests).toEqual([turn]);
  const accessibility = await new AxeBuilder({ page }).analyze();
  expect(accessibility.violations).toEqual([]);
});

test("inspects session-scoped runtime and terminal details on desktop and mobile", async ({
  page,
}, testInfo) => {
  const sessionId = "inspection-browser-session";
  const reads: string[] = [];
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.currentSessionId = sessionId;
    snapshot.selectedSession = {
      id: sessionId,
      path: "/inspection/session.jsonl",
      cwd: "/inspection",
      entries: [],
      bytes: 0,
      truncation: {
        truncated: false,
        maxBytes: 2097152,
        entriesOmitted: 0,
        messagesTruncated: 0,
        messagePartsOmitted: 0,
      },
    };
    snapshot.runtime = {
      status: "idle",
      capabilities: {
        "background-terminals": {
          items: [
            {
              id: "bt-1",
              title: "Build logs",
              status: "done",
              createdAt: 1,
              settledAt: 2,
            },
          ],
          omitted: 0,
        },
      },
    };
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": heartbeat\n\n",
    }),
  );
  for (const endpoint of [
    "thinking",
    "trust",
    "providers/auth-status",
    "capabilities/detail",
  ]) {
    await page.route(`**/api/${endpoint}?**`, async (route) => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get("sessionId")).toBe(sessionId);
      reads.push(endpoint);
      const body =
        endpoint === "thinking"
          ? { sessionId, level: "medium", available: ["low", "medium", "high"] }
          : endpoint === "trust"
            ? {
                workspace: "/inspection",
                state: "restricted",
                refreshRequired: false,
              }
            : endpoint === "providers/auth-status"
              ? {
                  providers: [
                    { id: "example", name: "Example", configured: true },
                  ],
                  truncation: { truncated: false },
                }
              : {
                  sessionId,
                  detail: {
                    id: "bt-1",
                    title: "Build logs",
                    command: "bun run check",
                    cwd: "/inspection",
                    status: "done",
                    createdAt: 1,
                    exitCode: 0,
                    stdout: {
                      text:
                        '<script>alert("literal output")</script>\n' +
                        "long output ".repeat(100),
                      truncated: true,
                      omittedBytes: 100,
                    },
                    stderr: { text: "" },
                    truncated: true,
                  },
                };
      await route.fulfill({ json: body });
    });
  }
  await openWorkbench(page);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole("button", { name: "运行状态", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("medium");
    await expect(dialog).toContainText("Example");
    await expect
      .poll(() => reads.filter((x) => x === "thinking").length)
      .toBe(width === 1280 ? 1 : 2);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`status-${width}.png`),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await page.getByRole("button", { name: /Build logs/ }).click();
    await expect(dialog.locator("pre").first()).toContainText(
      '<script>alert("literal output")</script>',
    );
    await expect(dialog.locator("script")).toHaveCount(0);
    await expect(dialog).toContainText("已完成");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`terminal-${width}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "关闭", exact: true }).click();
  }
});

test("restores archived history without switching the active Session", async ({
  page,
}) => {
  let archived = true;
  let restores = 0;
  const activations: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      ["/api/sessions", "/api/sessions/select"].includes(pathname)
    )
      activations.push(pathname);
  });
  const path = "/archived/browser.jsonl";
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.sessions = [
      {
        id: "archived-browser",
        path,
        cwd: "/archived",
        name: "Saved browser work",
        archived,
        source: "web-session",
        origin: "web",
        controller: "none",
        readOnly: false,
        created: "2026-09-07T00:00:00Z",
        modified: "2026-09-07T00:00:00Z",
        messageCount: 1,
        firstMessage: "saved",
      },
    ];
    snapshot.workspaces = [];
    snapshot.truncation.sessionsOmitted = 20;
    snapshot.truncation.workspacesOmitted = 1;
    snapshot.truncation.truncated = true;
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": heartbeat\n\n",
    }),
  );
  await page.route("**/api/sessions/unarchive?**", async (route) => {
    expect(new URL(route.request().url()).searchParams.get("path")).toBe(path);
    restores++;
    if (restores === 1)
      await route.fulfill({ status: 500, json: { error: "Try again" } });
    else {
      archived = false;
      await route.fulfill({ json: { path, archived: false } });
    }
  });
  await openWorkbench(page);
  await page.getByRole("button", { name: "已归档", exact: true }).click();
  await expect(
    page.getByText("Saved browser work", { exact: true }),
  ).toBeVisible();
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByText("Saved browser work", { exact: true }).hover();
    await page.getByRole("button", { name: "会话选项" }).click();
    await page.getByRole("menuitem", { name: "恢复会话" }).click();
    if (!attempt)
      await expect(
        page.getByText("暂时无法确认恢复结果，请刷新后重试。"),
      ).toBeVisible();
    if (!attempt)
      await expect(
        page.getByText("Saved browser work", { exact: true }),
      ).toBeVisible();
  }
  await expect(
    page.getByText("Saved browser work", { exact: true }),
  ).toHaveCount(0);
  expect(restores).toBe(2);
  expect(activations).toEqual([]);
  await page.getByRole("button", { name: "当前", exact: true }).click();
  await expect(
    page.getByText("Saved browser work", { exact: true }),
  ).toBeVisible();
});

test("trajectory inspects bounded prompt and tool evidence on desktop and mobile", async ({
  page,
}, testInfo) => {
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    const entries = Array.from({ length: 55 }, (_, index) => ({
      id: `user-${index}`,
      type: "message",
      timestamp: "2026-09-07T00:00:00Z",
      message: { role: "user", content: "Repeated prompt" },
    }));
    snapshot.sessions = [];
    snapshot.workspaces = [];
    snapshot.currentSessionId = "trajectory-fixture";
    snapshot.selectedSession = {
      id: "trajectory-fixture",
      path: "/trajectory/a.jsonl",
      cwd: "/trajectory",
      bytes: 1000,
      truncation: {
        truncated: true,
        entriesOmitted: 4,
        messagePartsOmitted: 0,
        messagesTruncated: 1,
        maxBytes: 2097152,
      },
      entries: [
        ...entries,
        {
          id: "call",
          type: "message",
          timestamp: "2026-09-07T00:00:01Z",
          message: {
            role: "assistant",
            content: "",
            parts: [
              {
                type: "toolCall",
                id: "call-1",
                name: "bash",
                arguments: '{"command":"printf hello"}',
              },
            ],
          },
        },
        {
          id: "result",
          type: "message",
          timestamp: "2026-09-07T00:00:02Z",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            content: '<script>alert("evidence")</script>',
            isError: false,
          },
        },
      ],
    };
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: ": heartbeat\n\n",
    }),
  );
  await openWorkbench(page);
  await page.getByRole("button", { name: "执行轨迹", exact: true }).click();
  const view = page.getByRole("region", { name: "执行轨迹", exact: true });
  await expect(view.locator(".trajectory-record")).toHaveCount(50);
  await expect(view.getByText(/省略 4 条记录/)).toBeVisible();
  await view.getByRole("button", { name: /显示更早记录/ }).click();
  await expect(view.locator(".trajectory-record")).toHaveCount(56);
  await view.locator(".trajectory-record").filter({ hasText: "bash" }).click();
  await expect(view.locator(".trajectory-inspector")).toContainText(
    "printf hello",
  );
  await expect(view.locator(".trajectory-inspector")).toContainText(
    '<script>alert("evidence")</script>',
  );
  await expect(view.locator("script")).toHaveCount(0);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(view.locator(".trajectory-inspector")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (await new AxeBuilder({ page }).include(".conversation-shell").analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`trajectory-${width}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await expect(view).toHaveCount(0);
});

test("fresh browser contexts open the bare address and can request workspace selection", async ({
  browser,
}) => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.addInitScript(() => {
        sessionStorage.setItem("openpi.web.token", "stale-host-token");
        Object.defineProperty(Storage.prototype, "setItem", {
          value() {
            throw new Error("storage disabled");
          },
        });
      });
      let selections = 0;
      await page.route("**/api/workspaces/select", async (route) => {
        expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
        selections++;
        await route.fulfill({ json: { cancelled: true } });
      });
      const snapshot = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/snapshot" &&
          response.status() === 200,
      );
      await page.goto("http://127.0.0.1:57109/");
      await snapshot;
      await expect(page.locator(".notice")).toHaveCount(0);
      await page.locator(".workspace-heading button").last().click();
      await expect.poll(() => selections).toBe(1);
      await page.reload();
      await expect(page.locator(".notice")).toHaveCount(0);
      expect(new URL(page.url()).hash).toBe("");
    } finally {
      await context.close();
    }
  }
});

test("model picker distinguishes same-named models before choosing a directory", async ({
  page,
}) => {
  let modelWrites = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/model") modelWrites++;
  });
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    delete snapshot.currentSessionId;
    delete snapshot.selectedSession;
    snapshot.sessions = [];
    snapshot.workspaces = [];
    snapshot.runtime.status = "idle";
    snapshot.models = [
      {
        provider: "provider-alpha",
        id: "one",
        name: "Shared model",
        label: "Shared model",
        current: true,
      },
      {
        provider: "provider-beta",
        id: "two",
        name: "Shared model",
        label: "Shared model",
        current: false,
      },
    ];
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/events?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: ": idle\n\n",
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await openWorkbench(page);
  const modelPicker = page.getByRole("button", {
    name: "Shared model (provider-alpha/one)",
  });
  await expect(modelPicker).toHaveText("Shared model (provider-alpha/one)");
  expect(
    await modelPicker.evaluate((element) => {
      const label = element.querySelector(".model-picker-label");
      return (
        label instanceof HTMLElement &&
        getComputedStyle(label).whiteSpace === "normal" &&
        label.scrollWidth <= label.clientWidth
      );
    }),
  ).toBe(true);
  await modelPicker.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("option", {
      name: "Shared model (provider-alpha/one)",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", {
      name: "Shared model (provider-beta/two)",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", {
      name: "Shared model (provider-alpha/one)",
    }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("option", {
      name: "Shared model (provider-beta/two)",
    }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("button", {
      name: "Shared model (provider-beta/two)",
    }),
  ).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "描述任务" })).toHaveAttribute(
    "readonly",
    "",
  );
  expect(modelWrites).toBe(0);
});

test("same-named model selection sends the exact identity for an active Session", async ({
  page,
}) => {
  let selectedIdentity = "provider-alpha/one";
  const writes: Array<{
    provider: string;
    modelId: string;
    sessionId: string;
  }> = [];
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.runtime.status = "idle";
    snapshot.models = [
      {
        provider: "provider-alpha",
        id: "one",
        name: "Shared model",
        label: "Shared model",
        current: selectedIdentity === "provider-alpha/one",
      },
      {
        provider: "provider-beta",
        id: "two",
        name: "Shared model",
        label: "Shared model",
        current: selectedIdentity === "provider-beta/two",
      },
    ];
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/api/model", async (route) => {
    const body = route.request().postDataJSON();
    writes.push(body);
    selectedIdentity = `${body.provider}/${body.modelId}`;
    await route.fulfill({
      status: 200,
      json: {
        provider: body.provider,
        id: body.modelId,
        name: "Shared model",
        label: "Shared model",
        current: true,
      },
    });
  });
  await openWorkbench(page);

  await page
    .getByRole("button", { name: "Shared model (provider-alpha/one)" })
    .click();
  await page
    .getByRole("option", { name: "Shared model (provider-beta/two)" })
    .click();

  await expect(
    page.getByRole("button", { name: "Shared model (provider-beta/two)" }),
  ).toBeEnabled();
  expect(writes).toEqual([
    {
      provider: "provider-beta",
      modelId: "two",
      sessionId: expect.any(String),
    },
  ]);
});

test("finds and selects a model omitted from the bounded snapshot", async ({
  page,
}) => {
  const visibleModels = Array.from({ length: 250 }, (_, index) => ({
    provider: "fixture",
    id: `visible-${index}`,
    name: `Visible ${index}`,
    label: `Visible ${index}`,
    current: index === 0,
  }));
  const hiddenModel = {
    provider: "provider-hidden",
    id: "needle-251",
    name: "Needle 251",
    label: "Needle 251",
    current: false,
  };
  const searchRequests: URL[] = [];
  const modelWrites: Array<{
    provider: string;
    modelId: string;
    sessionId: string;
  }> = [];
  let activeSessionId: string | undefined;
  let selectedIdentity = "fixture/visible-0";

  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    activeSessionId = snapshot.currentSessionId;
    snapshot.runtime.status = "idle";
    snapshot.models =
      selectedIdentity === "provider-hidden/needle-251"
        ? [
            { ...hiddenModel, current: true },
            ...visibleModels.slice(0, 249).map((model) => ({
              ...model,
              current: false,
            })),
          ]
        : visibleModels;
    snapshot.truncation.modelsOmitted = 1;
    snapshot.truncation.truncated = true;
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/api/models?**", async (route) => {
    searchRequests.push(new URL(route.request().url()));
    await route.fulfill({
      status: 200,
      json: {
        models: [hiddenModel],
        totalAvailable: 251,
        totalMatches: 1,
        truncation: {
          truncated: false,
          matchesOmitted: 0,
          maxResults: 50,
          maxBytes: 64 * 1024,
          bytes: 128,
        },
      },
    });
  });
  await page.route("**/api/model", async (route) => {
    const body = route.request().postDataJSON();
    modelWrites.push(body);
    selectedIdentity = `${body.provider}/${body.modelId}`;
    await route.fulfill({
      status: 200,
      json: { ...hiddenModel, current: true },
    });
  });
  await openWorkbench(page);

  expect(activeSessionId).toBeTruthy();
  await page
    .getByRole("button", { name: "Visible 0 (fixture/visible-0)" })
    .click();
  await expect(
    page.getByText("当前显示 250 个模型，还有 1 个可用；搜索即可查找。"),
  ).toBeVisible();
  const hiddenOption = page.getByRole("option", {
    name: "Needle 251 (provider-hidden/needle-251)",
  });
  await expect(hiddenOption).toHaveCount(0);

  await page
    .getByPlaceholder("搜索服务商、模型名称或 ID...")
    .fill("needle-251");
  await expect(hiddenOption).toBeVisible();

  expect(searchRequests).toHaveLength(1);
  expect(searchRequests[0]?.searchParams.get("query")).toBe("needle-251");
  expect(searchRequests[0]?.searchParams.get("limit")).toBe("50");
  expect(searchRequests[0]?.searchParams.get("sessionId")).toBe(
    activeSessionId,
  );

  await hiddenOption.click();
  expect(modelWrites).toEqual([
    {
      provider: "provider-hidden",
      modelId: "needle-251",
      sessionId: activeSessionId,
    },
  ]);
  await expect(
    page.getByRole("button", {
      name: "Needle 251 (provider-hidden/needle-251)",
    }),
  ).toBeEnabled();
});

test("workspace selection survives refresh and creates the exact native Session before sending", async ({
  page,
}, testInfo) => {
  const workspace = await mkdtemp(join(tmpdir(), "openpi-issue-467-"));
  const headers = {
    Authorization: `Bearer ${token}`,
    Origin: "http://127.0.0.1:57109",
  };
  try {
    const imported = await page.request.post("/api/workspaces", {
      headers,
      data: { path: workspace },
    });
    expect(imported.status()).toBe(201);
    const { path: canonicalWorkspace } = await imported.json();
    const before = await page.request.get("/api/snapshot", { headers });
    const initial = await before.json();
    const workspaceName = canonicalWorkspace.split("/").at(-1);
    const prompts: Array<{ sessionId: string; content: string }> = [];
    // Only intercept model admission. Workspace import, snapshots and native
    // Session creation use the isolated real Host and Pi runtime.
    await page.route("**/api/prompt", async (route) => {
      const body = route.request().postDataJSON();
      prompts.push({ sessionId: body.sessionId, content: body.content });
      await route.fulfill({
        status: 202,
        json: { id: body.commandId, accepted: true },
      });
    });
    await openWorkbench(page);
    const picker = page.locator(".workspace-picker");
    await picker.click();
    await page
      .getByRole("menuitem", { name: workspaceName, exact: true })
      .click();
    await expect(picker).toHaveText(workspaceName);
    await expect(page.locator(".model-picker")).toBeEnabled();
    // Importing the same directory again triggers a real workspace event and
    // refresh while the canonical Session still belongs to the original cwd.
    const refresh = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/snapshot",
    );
    await page.request.post("/api/workspaces", {
      headers,
      data: { path: workspace },
    });
    await refresh;
    await expect(picker).toHaveText(workspaceName);
    await page
      .getByRole("textbox", { name: "描述任务" })
      .fill("Only work in the selected repository");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect.poll(() => prompts.length).toBe(1);
    const after = await page.request.get("/api/snapshot", { headers });
    const current = await after.json();
    expect(current.selectedSession.cwd).toBe(canonicalWorkspace);
    expect(current.currentSessionId).not.toBe(initial.currentSessionId);
    expect(prompts).toEqual([
      {
        sessionId: current.currentSessionId,
        content: "Only work in the selected repository",
      },
    ]);
    await page.screenshot({
      path: testInfo.outputPath("workspace-selection.png"),
      fullPage: true,
    });
  } finally {
    await page.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
