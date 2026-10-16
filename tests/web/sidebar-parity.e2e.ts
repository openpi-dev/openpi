import { expect, type Page, test } from "@playwright/test";
import type {
  WebSessionSummary,
  WebSnapshot,
} from "../../web/protocol/types.ts";
import { createAttachmentHost } from "./file-formats-e2e-support.ts";

// Complete pending fixture responses before Playwright disposes their context.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

async function installSidebarFixture(
  page: Page,
  theme: "light" | "dark" = "light",
) {
  let selected = "current";
  let sessions: WebSessionSummary[] = [];
  const preferences: Partial<WebSnapshot["preferences"]> = {
    theme,
    sidebarGrouping: "project",
    chatsSort: "updated",
    pinnedSort: "manual",
    projectsInRecents: undefined,
  };
  const preferenceWrites: unknown[] = [];
  const readWrites: { id: string; read: boolean }[] = [];
  const prompts: unknown[] = [];
  const now = Date.now();
  await page.route(/\/api\/prompts?$/u, (route) => {
    prompts.push(route.request().postDataJSON());
    return route.fulfill({ status: 500, json: { error: "No model calls" } });
  });
  await page.route("**/api/settings/preferences", async (route) => {
    const patch = route.request().postDataJSON();
    preferenceWrites.push(patch);
    Object.assign(preferences, patch);
    await route.fulfill({ json: { saved: true } });
  });
  await page.route("**/api/sessions/read", async (route) => {
    const body = route.request().postDataJSON();
    const session = sessions.find(
      (item) => item.id === body.id && item.path === body.path,
    );
    expect(session).toBeDefined();
    expect(body.expectedRevision).toBe(session!.readRevision);
    session!.unread = !body.read;
    session!.readRevision = `fixture-${body.id}-read-${readWrites.length + 1}`;
    readWrites.push({ id: body.id, read: body.read });
    await route.fulfill({ json: { saved: true } });
  });
  await page.route("**/api/sessions/select", async (route) => {
    const session = sessions.find(
      (item) => item.path === route.request().postDataJSON().path,
    );
    expect(session).toBeDefined();
    selected = session!.id;
    await route.fulfill({ json: { cancelled: false } });
  });
  await page.route("**/api/thinking**", (route) =>
    route.fulfill({
      json: {
        sessionId: selected,
        supported: false,
        available: [],
        level: "unknown",
        revision: 1000,
      },
    }),
  );
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    const snapshot = (await response.json()) as WebSnapshot;
    if (!sessions.length) {
      const real = snapshot.sessions[0]!;
      sessions = ["current", "waiting", "completed", "failed", "read"].map(
        (id, index) => ({
          ...real,
          id,
          path: `/preview/${id}.jsonl`,
          cwd: id === "current" ? "/preview/current" : "/preview/work",
          name: ["当前会话", "等待回复", "已完成工作", "失败工作", "已读工作"][
            index
          ],
          modified: new Date(now - (index || 10) * 60_000).toISOString(),
          order: index,
          pinOrder: undefined,
          archived: false,
          unread: id === "completed" || id === "failed",
          readRevision: `fixture-${id}-initial`,
          execution:
            id === "waiting"
              ? { status: "running", waitingForInput: true }
              : {
                  status: "idle",
                  ...(id !== "current"
                    ? {
                        lastTurn: {
                          commandId: `${id}-turn`,
                          outcome: id === "failed" ? "failed" : "completed",
                          finishedAt: now - index * 60_000,
                        },
                      }
                    : {}),
                },
        }),
      );
    }
    snapshot.preferences = { ...snapshot.preferences, ...preferences };
    snapshot.sessions = sessions;
    snapshot.workspaces = [
      {
        path: "/preview/current",
        name: "当前项目",
        current: selected === "current",
      },
      {
        path: "/preview/work",
        name: "设计项目",
        current: selected !== "current",
      },
    ];
    const session = sessions.find((item) => item.id === selected)!;
    snapshot.currentSessionId = session.id;
    snapshot.currentSessionPath = session.path;
    snapshot.selectedSession = {
      ...snapshot.selectedSession!,
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      entries: [],
    };
    snapshot.runtime = { status: "idle", capabilities: {} };
    snapshot.selectedExecution = {
      sessionId: session.id,
      sessionPath: session.path,
      status: "idle",
      pendingFollowUps: 0,
      liveTools: [],
      liveToolsOmitted: 0,
    };
    await route.fulfill({ response, json: snapshot });
  });
  return { preferenceWrites, readWrites, prompts };
}

test("sidebar mixed project and conversation pins persist through reload and exclude pinned projects from Recent", async ({
  browser,
}) => {
  const fixture = await createAttachmentHost(browser);
  const { page } = fixture;
  const pinWrites: unknown[] = [];
  let workspacePath = "";
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/sidebar/pin")
      pinWrites.push(request.postDataJSON());
  });
  try {
    await page.route("**/api/snapshot**", async (route) => {
      const response = await route.fetch();
      const snapshot = (await response.json()) as WebSnapshot;
      workspacePath = snapshot.workspaces[0]!.path;
      snapshot.preferences = {
        ...snapshot.preferences,
        sidebarGrouping: "project",
        pinnedSort: "manual",
        projectsInRecents: undefined,
      };
      await route.fulfill({ response, json: snapshot });
    });
    await page.reload();
    const sidebar = page.locator(".session-sidebar");
    const recent = sidebar.getByRole("region", { name: "最近", exact: true });
    const project = sidebar
      .locator(".workspace-tree > .workspace-group")
      .first();
    await expect(project.getByText("Formats B", { exact: true })).toBeVisible();
    await expect(recent.getByText("Formats B", { exact: true })).toBeVisible();
    const first = project.getByRole("listitem", {
      name: "Formats A",
      exact: true,
    });
    await first.getByRole("button", { name: "会话选项", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "置顶", exact: true }).click();
    const pins = sidebar.getByRole("region", { name: "置顶", exact: true });
    await expect(pins.getByText("Formats A", { exact: true })).toBeVisible();
    await project
      .getByRole("button", { name: "工作区选项", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "置顶项目", exact: true }).click();
    const items = pins.locator(".pinned-sessions > li");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveClass(/session-row/u);
    await expect(items.nth(1)).toHaveClass(/pinned-workspace/u);
    await expect(recent.locator(".session-row")).toHaveCount(0);
    await pins.getByRole("button", { name: "工作区选项", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: "上移", exact: true }).click();
    await expect(items.nth(0)).toHaveClass(/pinned-workspace/u);
    await expect(items.nth(1)).toHaveClass(/session-row/u);
    expect(pinWrites).toContainEqual({
      target: { kind: "workspace", path: workspacePath },
      pinned: true,
      before: {
        kind: "session",
        id: fixture.first.getSessionId(),
        path: fixture.first.getSessionFile(),
      },
    });
    await page.reload();
    await expect(items.nth(0)).toHaveClass(/pinned-workspace/u);
    await expect(items.nth(1)).toHaveClass(/session-row/u);
    await expect(sidebar.getByText("Formats B", { exact: true })).toHaveCount(
      1,
    );
    await pins.getByRole("button", { name: "工作区选项", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page
      .getByRole("menuitem", { name: "取消置顶项目", exact: true })
      .click();
    await expect(recent.getByText("Formats B", { exact: true })).toBeVisible();
    await expect(recent.getByText("Formats A", { exact: true })).toHaveCount(0);
    await expect(project.getByText("Formats B", { exact: true })).toBeVisible();
    expect(fixture.prompts).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("sidebar header search opens a keyboard palette and Escape restores the invoking control", async ({
  browser,
}) => {
  const fixture = await createAttachmentHost(browser);
  const { page } = fixture;
  try {
    const search = page.getByRole("button", { name: "搜索会话", exact: true });
    await search.click();
    const dialog = page.getByRole("dialog", {
      name: "搜索消息内容",
      exact: true,
    });
    const query = dialog.getByRole("searchbox", {
      name: "搜索消息内容",
      exact: true,
    });
    await expect(query).toBeFocused();
    await expect(
      dialog.getByRole("group", { name: "最近会话", exact: true }),
    ).toBeVisible();
    await query.press("ArrowDown");
    await expect(query).toBeFocused();
    await expect(dialog.getByRole("option").nth(1)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(search).toBeFocused();
    const composer = page.getByRole("textbox", { name: "描述任务" });
    await composer.fill("保留未发送的草稿");
    await page.keyboard.press("ControlOrMeta+k");
    await expect(dialog).toBeHidden();
    await search.click();
    await expect(query).toBeFocused();
    await query.fill("Formats B");
    await query.press("Home");
    await expect(
      dialog.getByRole("option", { name: "打开会话 Formats B", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(query).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(search).toBeFocused();
    await expect(composer).toHaveValue("保留未发送的草稿");
    expect(fixture.prompts).toEqual([]);
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("sidebar grouping and sort menus preserve default project Recent entries and saved preferences", async ({
  page,
}) => {
  const fixture = await installSidebarFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const sidebar = page.locator(".session-sidebar");
  const recent = sidebar.getByRole("region", { name: "最近", exact: true });
  const project = sidebar.getByRole("region", {
    name: "设计项目",
    exact: true,
  });
  await expect(sidebar.locator(".sidebar-brand-title")).toHaveText("OpenPI");
  await expect(
    sidebar.locator(".sidebar-brand .astryx-menu-trigger"),
  ).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "筛选当前列表", exact: true }),
  ).toHaveCount(0);
  await expect(project.getByText("等待回复", { exact: true })).toBeVisible();
  await expect(recent.getByText("等待回复", { exact: true })).toBeVisible();
  await expect(recent.locator(".session-title").first()).toHaveText("等待回复");
  const recentOptions = recent.getByRole("button", {
    name: "会话侧栏选项",
    exact: true,
  });
  await recent.locator(".sidebar-section-heading").hover();
  await recentOptions.click();
  await page.getByRole("menuitem", { name: "会话排序", exact: true }).click();
  await page.getByRole("menuitem", { name: "手动排序", exact: true }).click();
  await expect(recent.locator(".session-title").first()).toHaveText("当前会话");
  await recent.locator(".sidebar-section-heading").hover();
  await recentOptions.click();
  await page.getByRole("menuitem", { name: "显示", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "在最近列表显示项目会话", exact: true })
    .click();
  await expect(recent.locator(".session-row")).toHaveCount(0);
  await sidebar
    .getByRole("button", { name: "项目侧栏选项", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "会话分组", exact: true }).click();
  await page.getByRole("menuitem", { name: "所有会话", exact: true }).click();
  await expect(project).toHaveCount(0);
  await expect(recent.locator(".session-row")).toHaveCount(5);
  await page.reload();
  await expect(project).toHaveCount(0);
  await expect(recent.locator(".session-title").first()).toHaveText("当前会话");
  expect(fixture.preferenceWrites).toEqual([
    { chatsSort: "manual" },
    { projectsInRecents: false },
    { sidebarGrouping: "list" },
  ]);
  expect(fixture.prompts).toEqual([]);
});

for (const width of [1440, 536]) {
  test(`sidebar controls follow pointer and keyboard state at ${width}px`, async ({
    page,
  }, testInfo) => {
    const fixture = await installSidebarFixture(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    expect(
      await page.evaluate(
        () => matchMedia("(hover: hover) and (pointer: fine)").matches,
      ),
    ).toBe(true);
    if (width <= 760) {
      await page
        .getByRole("button", { name: "打开侧边栏", exact: true })
        .click();
    }
    const sidebar = page.locator(".session-sidebar");
    const project = sidebar.getByRole("region", {
      name: "设计项目",
      exact: true,
    });
    const row = project.locator(".workspace-button");
    const toggle = project.locator(".workspace-label");
    const actions = project.locator(".workspace-row-actions");
    const heading = sidebar.locator(".workspace-heading");
    const sectionActions = heading.locator(".sidebar-section-actions");
    const current = sidebar.getByRole("region", {
      name: "当前项目",
      exact: true,
    });
    const session = current.locator(".session");
    const sessionActions = current.locator(
      ".session-row > .astryx-menu-trigger",
    );
    const pin = current.locator(".session-pin-button");
    await page.mouse.move(width - 4, 10);
    await expect(row).toHaveCSS("height", "30px");
    await expect(session).toHaveAttribute("aria-current", "page");
    for (const control of [actions, sectionActions, sessionActions, pin]) {
      await expect(control).toHaveCSS("opacity", "0");
      await expect(control).toHaveCSS("pointer-events", "none");
    }
    await page.screenshot({
      path: testInfo.outputPath("sidebar-mouse-idle.png"),
    });
    await row.hover();
    await expect(actions).toHaveCSS("opacity", "1");
    await expect(sectionActions).toHaveCSS("opacity", "0");
    await expect(heading.locator(".lucide-chevron-down")).toHaveCSS(
      "opacity",
      "1",
    );
    await expect(current.locator(".workspace-row-actions")).toHaveCSS(
      "opacity",
      "0",
    );
    await page.screenshot({
      path: testInfo.outputPath("sidebar-project-hover.png"),
    });
    await toggle.click();
    await page.mouse.move(width - 4, 10);
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(actions).toHaveCSS("opacity", "0");
    await toggle.click();
    await project
      .getByRole("button", { name: "工作区选项", exact: true })
      .click();
    await page.mouse.move(width - 4, 10);
    await expect(
      page.getByRole("menu", { name: "工作区选项", exact: true }),
    ).toBeVisible();
    expect(await row.evaluate((el) => el.matches(":focus-within"))).toBe(false);
    await expect(actions).toHaveCSS("opacity", "1");
    await page.keyboard.press("Escape");
    await expect(
      project.getByRole("button", { name: "工作区选项", exact: true }),
    ).toBeFocused();
    await expect(actions).toHaveCSS("opacity", "1");
    await toggle.focus();
    await page.keyboard.press("Tab");
    await expect(
      project.getByRole("button", { name: "工作区选项", exact: true }),
    ).toBeFocused();
    await expect(actions).toHaveCSS("opacity", "1");
    await page.keyboard.press("Tab");
    await expect(
      project.getByRole("button", { name: "新建会话 设计项目", exact: true }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(actions).toHaveCSS("opacity", "0");

    await heading.hover();
    await expect(sectionActions).toHaveCSS("opacity", "1");
    const sectionToggle = heading.getByRole("button", {
      name: "项目",
      exact: true,
    });
    await sectionToggle.click();
    await page.mouse.move(width - 4, 10);
    await expect(sectionToggle).toBeFocused();
    // The section title uses focus-within; ordinary project rows use keyboard-visible focus.
    await expect(sectionActions).toHaveCSS("opacity", "1");
    await page.keyboard.press("Tab");
    await expect(
      heading.getByRole("button", { name: "项目侧栏选项", exact: true }),
    ).toBeFocused();
    await expect(sectionActions).toHaveCSS("opacity", "1");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("menu", { name: "项目侧栏选项", exact: true }),
    ).toBeVisible();
    await expect(sectionActions).toHaveCSS("opacity", "1");
    await page.keyboard.press("Escape");
    await sectionToggle.click();

    await session.click();
    if (width <= 760) {
      // Selecting a conversation dismisses the drawer; reopening leaves selection intact.
      await page
        .getByRole("button", { name: "打开侧边栏", exact: true })
        .click();
    }
    await page.mouse.move(width - 4, 10);
    await expect(sessionActions).toHaveCSS("opacity", "0");
    await expect(pin).toHaveCSS("opacity", "0");
    await session.hover();
    await expect(sessionActions).toHaveCSS("opacity", "1");
    await expect(pin).toHaveCSS("opacity", "1");
    await page.mouse.move(width - 4, 10);
    await session.focus();
    await page.keyboard.press("Tab");
    await expect(pin).toBeFocused();
    await expect(pin).toHaveCSS("opacity", "1");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("menu", { name: "会话选项", exact: true }),
    ).toBeVisible();
    await expect(sessionActions).toHaveCSS("opacity", "1");
    await page.screenshot({
      path: testInfo.outputPath("sidebar-keyboard-menu.png"),
    });
    expect(fixture.prompts).toEqual([]);
  });
}

test.describe("touch project controls", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  test("project controls remain visible and reachable without hover", async ({
    page,
  }, testInfo) => {
    const fixture = await installSidebarFixture(page);
    await page.goto("/");
    expect(
      await page.evaluate(
        () => matchMedia("(hover: none) and (pointer: coarse)").matches,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "打开侧边栏", exact: true }).tap();
    const sidebar = page.locator(".session-sidebar");
    const project = sidebar.getByRole("region", {
      name: "设计项目",
      exact: true,
    });
    await expect(project.locator(".workspace-row-actions")).toHaveCSS(
      "opacity",
      "1",
    );
    await expect(
      sidebar.locator(".workspace-heading .sidebar-section-actions"),
    ).toHaveCSS("opacity", "1");
    const menu = project.getByRole("button", {
      name: "工作区选项",
      exact: true,
    });
    for (const control of [
      menu,
      project.locator(".workspace-label"),
      project.getByRole("button", { name: "新建会话 设计项目", exact: true }),
      sidebar.getByRole("button", { name: "已归档", exact: true }),
    ]) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({
      path: testInfo.outputPath("sidebar-touch-idle.png"),
    });
    await menu.tap();
    await expect(
      page.getByRole("menu", { name: "工作区选项", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeFocused();
    await expect(page.locator(".app-shell")).toHaveClass(/sidebar-open/u);
    const waiting = project.getByRole("listitem", {
      name: "等待回复",
      exact: true,
    });
    await waiting.getByRole("button", { name: "会话选项", exact: true }).tap();
    await expect(waiting.locator(".session-status")).toHaveCSS("opacity", "1");
    await page.keyboard.press("Escape");
    expect(fixture.prompts).toEqual([]);
  });
});

for (const theme of ["light", "dark"] as const) {
  test(`project rows preserve folder state and mark the viewed conversation in ${theme}`, async ({
    page,
  }, testInfo) => {
    const fixture = await installSidebarFixture(page, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "项目", exact: true }),
    ).toBeVisible();
    const project = page.getByRole("region", { name: "设计项目", exact: true });
    const toggle = project.locator(".workspace-label");
    const row = project.locator(".workspace-button");
    const folder = toggle.locator(".workspace-folder");
    const currentProject = page.getByRole("region", {
      name: "当前项目",
      exact: true,
    });
    const projectNames = page.locator(
      ".workspace-tree > .workspace-group .workspace-identity > strong",
    );
    const initialOrder = ["当前项目", "设计项目"];
    await expect(projectNames).toHaveText(initialOrder);
    const blue = theme === "light" ? "rgb(66, 99, 235)" : "rgb(139, 167, 255)";
    await expect(currentProject.locator(".workspace-folder")).toHaveCSS(
      "color",
      blue,
    );
    await expect(folder).not.toHaveCSS("color", blue);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await row.hover();
    await expect(folder).toHaveClass(/lucide-folder-open/);
    await expect(folder).toHaveCSS("opacity", "1");
    await expect(folder).toHaveCSS("width", "16px");
    const create = project.getByRole("button", {
      name: "新建会话 设计项目",
      exact: true,
    });
    await expect(create.locator(".lucide-square-pen")).toBeVisible();
    await project
      .getByRole("button", { name: "工作区选项", exact: true })
      .click();
    await expect(folder).toHaveCSS("opacity", "1");
    await page.keyboard.press("Escape");
    await toggle.focus();
    await expect(folder).toHaveCSS("opacity", "1");
    await toggle.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(folder).toHaveClass(/lucide-folder(?!-open)/);
    await expect(folder).toHaveCSS("opacity", "1");
    await expect(project.locator(".workspace-sessions")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("project-collapsed-hover.png"),
    });
    await toggle.press("Space");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(folder).toHaveClass(/lucide-folder-open/);
    await expect(project.locator(".session-row")).toHaveCount(4);
    await page.screenshot({
      path: testInfo.outputPath("project-expanded-focus.png"),
    });
    await project.locator(".session").first().click();
    await expect(toggle).toHaveAttribute("aria-current", "location");
    await expect(folder).toHaveCSS("color", blue);
    await expect(currentProject.locator(".workspace-folder")).not.toHaveCSS(
      "color",
      blue,
    );
    await expect(projectNames).toHaveText(initialOrder);
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-current", "location");
    await expect(folder).toHaveCSS("color", blue);
    await expect(projectNames).toHaveText(initialOrder);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(folder).toHaveCSS("color", blue);
    await toggle.click();
    await page.mouse.move(1000, 80);
    await expect(folder).toHaveClass(/lucide-folder-open/);
    await expect(folder).toHaveCSS("color", blue);
    await page.screenshot({
      path: testInfo.outputPath(`project-current-blue-${theme}.png`),
    });
    await currentProject.locator(".session").click();
    await expect(currentProject.locator(".workspace-folder")).toHaveCSS(
      "color",
      blue,
    );
    await expect(folder).not.toHaveCSS("color", blue);
    await expect(projectNames).toHaveText(initialOrder);
    expect(fixture.prompts).toEqual([]);
  });
}

test("sidebar activity retains read Priority rows until cleared and keeps waiting status separate", async ({
  page,
}) => {
  const fixture = await installSidebarFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator(".connection-state")).toHaveText("已连接");
  const sidebar = page.locator(".session-sidebar");
  await expect(sidebar.locator(".sidebar-unread-dot")).toBeVisible();
  await sidebar.getByRole("button", { name: "查看动态", exact: true }).click();
  const activity = sidebar.getByRole("region", { name: "动态", exact: true });
  const priority = activity.getByRole("region", {
    name: "优先关注",
    exact: true,
  });
  await expect(priority.locator(".session-row")).toHaveCount(3);
  await expect(
    activity.getByRole("region", { name: "今天", exact: true }),
  ).toContainText("已读工作");
  await expect(
    sidebar.getByRole("region", { name: "最近", exact: true }),
  ).toHaveCount(0);
  const completed = priority.getByRole("listitem", {
    name: "已完成工作",
    exact: true,
  });
  await completed.locator(".session").click();
  await expect
    .poll(() => fixture.readWrites)
    .toContainEqual({ id: "completed", read: true });
  await expect(completed).toBeVisible();
  await expect(completed.locator(".session-state-completed")).toHaveCount(0);
  await priority
    .getByRole("button", { name: "动态视图选项", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "全部标记为已读", exact: true })
    .click();
  await expect
    .poll(() => fixture.readWrites)
    .toContainEqual({ id: "failed", read: true });
  await expect(sidebar.locator(".sidebar-unread-dot")).toHaveCount(0);
  await expect(priority.locator(".session-row")).toHaveCount(3);
  await priority
    .getByRole("button", { name: "清除优先关注中的已读会话", exact: true })
    .click();
  await expect(priority.locator(".session-title")).toHaveText("等待回复");
  await expect(priority.locator(".session")).toHaveAccessibleName(
    /等待你的回复/u,
  );
  await expect(
    activity
      .getByRole("region", { name: "今天", exact: true })
      .locator(".session-row"),
  ).toHaveCount(3);
  await priority
    .getByRole("button", { name: "动态视图选项", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "优先关注", exact: true }).click();
  await expect(priority).toHaveCount(0);
  const todayOptions = activity
    .getByRole("region", { name: "今天", exact: true })
    .getByRole("button", { name: "动态视图选项", exact: true });
  await todayOptions.click();
  await page.getByRole("menuitem", { name: "优先关注", exact: true }).click();
  await expect(priority.locator(".session-title")).toHaveText("等待回复");
  await sidebar.getByRole("button", { name: "查看会话", exact: true }).click();
  await expect(activity).toHaveCount(0);
  await expect(
    sidebar.locator(".workspace-tree .session.active"),
  ).toContainText(["已完成工作", "已完成工作"]);
  await page.reload();
  await expect(sidebar.locator(".sidebar-unread-dot")).toHaveCount(0);
  expect(fixture.readWrites).toHaveLength(2);
  expect(fixture.prompts).toEqual([]);
});
