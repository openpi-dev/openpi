import { expect, type Page, test } from "@playwright/test";
import { DEFAULT_SETUP_CONFIG } from "../../extensions/shared/setup-config.ts";
import { projectWebSetupConfig } from "../../web/runtime/settings-catalog.ts";

// Browser state checks use a controlled HTTP fixture. The separate production
// smoke verifies Pi provenance, real persistence, and restore without mocks.
async function installSettingsFixture(page: Page) {
  const config = structuredClone(DEFAULT_SETUP_CONFIG);
  const posts: Record<string, unknown>[] = [];
  let fail = false;
  let archived = true;
  let failRestore = true;
  const queries: URLSearchParams[] = [];
  // Keep the owned Host's event stream open. A finite SSE response repeatedly
  // reconnects and can supersede the snapshot confirming an archive restore.
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch({
      url: new URL("/api/snapshot", route.request().url()).href,
    });
    const snapshot = await response.json();
    snapshot.currentSessionId = "settings-fixture";
    snapshot.currentSessionPath = "/fixture/active.jsonl";
    snapshot.sessions = [
      {
        id: "settings-fixture",
        path: "/fixture/active.jsonl",
        cwd: "/fixture",
        name: "Active chat",
        created: "2026-10-01T00:00:00Z",
        modified: "2026-10-02T00:00:00Z",
        messageCount: 0,
        firstMessage: "",
        source: "web-session",
        origin: "web",
        controller: "web",
        readOnly: false,
      },
    ];
    snapshot.selectedSession = {
      id: "settings-fixture",
      path: "/fixture/active.jsonl",
      cwd: "/fixture",
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
    snapshot.workspaces = [{ path: "/fixture", name: "OpenPI", current: true }];
    snapshot.runtime = { status: "idle", capabilities: {} };
    snapshot.models = [];
    snapshot.preferences = {
      theme: config.ui.webTheme,
      appearance: config.ui.webAppearance,
      chatWidth: config.ui.webChatWidth,
      chatFontSize: config.ui.webChatFontSize,
      expandThinking: config.ui.webExpandThinking,
    };
    await route.fulfill({ json: snapshot });
  });
  await page.route("**/api/settings/catalog?**", (route) =>
    route.fulfill({
      json: {
        sessionId: "settings-fixture",
        sessionPath: "/fixture/active.jsonl",
        setup: projectWebSetupConfig(config),
        webSearch: { available: false },
        resources: {
          skills: [],
          plugins: [],
          totals: { extensions: 0, skills: 0, prompts: 0, themes: 0 },
          diagnostics: { extensionErrors: 0, skillErrors: 0 },
          truncation: {
            truncated: false,
            skillsOmitted: 0,
            pluginsOmitted: 0,
            resourcesOmitted: 0,
          },
        },
      },
    }),
  );
  await page.route("**/api/settings/preferences", async (route) => {
    const patch = route.request().postDataJSON();
    posts.push(patch);
    if (fail) {
      fail = false;
      await route.fulfill({
        status: 422,
        json: { error: "fixture write failed" },
      });
      return;
    }
    for (const [key, field] of Object.entries({
      theme: "webTheme",
      chatWidth: "webChatWidth",
      chatFontSize: "webChatFontSize",
      expandThinking: "webExpandThinking",
    })) {
      if (patch[key] !== undefined)
        Object.assign(config.ui, { [field]: patch[key] });
    }
    if (patch.appearance !== undefined)
      Object.assign(config.ui, {
        webAppearance: { ...config.ui.webAppearance, ...patch.appearance },
      });
    await route.fulfill({
      json: { saved: true, setup: projectWebSetupConfig(config) },
    });
  });
  await page.route("**/api/sessions/archived?**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    queries.push(params);
    const matches =
      archived &&
      (!params.get("query") ||
        "Archived design".includes(params.get("query")!));
    await route.fulfill({
      json: {
        sessions: matches
          ? [
              {
                id: "archived-design",
                path: "/fixture/archived-design.jsonl",
                cwd: "/fixture",
                name: "Archived design",
                created: "2026-10-01T00:00:00Z",
                modified: "2026-10-03T00:00:00Z",
                messageCount: 3,
                firstMessage: "Review the design",
                archived: true,
              },
            ]
          : [],
        truncation: {
          truncated: false,
          matchesOmitted: 0,
          recordsUnscanned: 0,
          maxPageSize: 50,
          maxScanned: 5000,
        },
      },
    });
  });
  await page.route("**/api/sessions/unarchive?**", async (route) => {
    posts.push({
      path: new URL(route.request().url()).searchParams.get("path"),
    });
    if (failRestore) {
      failRestore = false;
      await route.fulfill({
        status: 422,
        json: { error: "fixture restore failed" },
      });
      return;
    }
    archived = false;
    await route.fulfill({ json: { path: "/fixture/archived-design.jsonl" } });
  });
  return {
    posts,
    queries,
    failNextWrite: () => {
      fail = true;
    },
  };
}

test("settings shell, hover/focus, mode previews, menus and disclosure follow the reference state table", async ({
  page,
}, testInfo) => {
  await installSettingsFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/?settings=appearance");
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(
    dialog.getByRole("heading", { name: "外观", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("radiogroup", { name: "模式", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("radio")).toHaveCount(3);
  await expect(dialog.getByRole("slider")).toHaveCount(0);
  const font = dialog.getByRole("button", { name: "字体", exact: true });
  await expect(font).toHaveText("Codex 默认");
  await font.click();
  await expect(
    page.getByRole("menuitem", { name: "Codex 默认", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "系统", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(
    dialog.getByRole("textbox", { name: "背景", exact: true }),
  ).toHaveValue("#17191C");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(
    dialog.getByRole("textbox", { name: "背景", exact: true }),
  ).toHaveValue("#FFFFFF");
  const geometry = await page.evaluate(() => {
    const sidebar = document
      .querySelector(".provider-settings-sidebar")!
      .getBoundingClientRect();
    const content = document
      .querySelector(".settings-appearance-panel")!
      .getBoundingClientRect();
    const previews = [
      ...document.querySelectorAll(".appearance-mode-preview"),
    ].map((node) => {
      const box = node.getBoundingClientRect();
      return { ratio: box.width / box.height, top: box.top };
    });
    return {
      sidebarWidth: sidebar.width,
      contentWidth: content.width,
      previews,
    };
  });
  expect(geometry.sidebarWidth).toBe(240);
  expect(geometry.contentWidth).toBe(768);
  for (const preview of geometry.previews) {
    expect(preview.ratio).toBeCloseTo(4 / 3, 1);
    expect(preview.top).toBe(geometry.previews[0]!.top);
  }
  const general = dialog.getByRole("tab", { name: "常规", exact: true });
  const background = await general.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  await general.hover();
  expect(
    await general.evaluate((node) => getComputedStyle(node).backgroundColor),
  ).not.toBe(background);
  await general.focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    dialog.getByRole("tab", { name: "外观", exact: true }),
  ).toBeFocused();
  const theme = dialog.getByRole("button", { name: "主题", exact: true });
  await theme.click();
  await expect(
    page.getByRole("menuitem", { name: "雾青", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(theme).toBeFocused();
  const advanced = dialog.getByRole("button", { name: "高级", exact: true });
  await advanced.click();
  await expect(advanced).toHaveAttribute("aria-expanded", "true");
  await expect(
    dialog.getByRole("slider", { name: "聊天内容宽度", exact: true }),
  ).toBeVisible();
  await advanced.click();
  await expect(dialog.getByRole("slider")).toHaveCount(0);
  await dialog.screenshot({
    path: testInfo.outputPath("appearance-desktop.png"),
  });
});

test("appearance import applies canonical tokens and font, survives reload, and rolls failed writes back", async ({
  page,
}, testInfo) => {
  const fixture = await installSettingsFixture(page);
  await page.goto("/?settings=appearance");
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await dialog.getByRole("button", { name: "导入主题", exact: true }).click();
  const importer = page.getByRole("dialog", { name: "导入主题", exact: true });
  await importer.getByRole("textbox").fill(
    JSON.stringify({
      version: 1,
      theme: "dark",
      appearance: {
        palette: "rose",
        accent: "#ABCDEF",
        background: "#17212B",
        foreground: "#F2F5F8",
        font: "serif",
      },
    }),
  );
  await importer.getByRole("button", { name: "导入", exact: true }).click();
  await expect(importer).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(
    dialog.getByRole("radio", { name: "深色", exact: true }),
  ).toBeChecked();
  expect(
    await dialog.evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe("rgb(23, 33, 43)");
  expect(
    await dialog.evaluate((node) => getComputedStyle(node).fontFamily),
  ).toContain("Georgia");
  expect(fixture.posts).toHaveLength(1);
  await page.reload();
  await expect(
    dialog.getByRole("heading", { name: "外观", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("radio", { name: "深色", exact: true }),
  ).toBeChecked();
  fixture.failNextWrite();
  await dialog.getByRole("radio", { name: "浅色", exact: true }).click();
  await expect(
    dialog.getByText("无法保存显示设置，请检查配置诊断后重试。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("radio", { name: "深色", exact: true }),
  ).toBeChecked();
  expect(
    await dialog.evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe("rgb(23, 33, 43)");
  await dialog.screenshot({
    path: testInfo.outputPath("appearance-dark-failed-save.png"),
  });
});

test("legacy theme import selects the Codex default and keeps it after reload", async ({
  page,
}) => {
  const fixture = await installSettingsFixture(page);
  await page.goto("/?settings=appearance");
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await dialog.getByRole("button", { name: "导入主题", exact: true }).click();
  const importer = page.getByRole("dialog", { name: "导入主题", exact: true });
  await importer.getByRole("textbox").fill(
    JSON.stringify({
      version: 1,
      theme: "light",
      appearance: { ...DEFAULT_SETUP_CONFIG.ui.webAppearance, font: "system" },
    }),
  );
  await importer.getByRole("button", { name: "导入", exact: true }).click();
  await expect(importer).toBeHidden();
  expect(fixture.posts[0]).toMatchObject({ appearance: { font: "codex" } });
  await page.reload();
  await expect(
    dialog.getByRole("button", { name: "字体", exact: true }),
  ).toHaveText("Codex 默认");
  expect(
    await dialog.evaluate((node) => getComputedStyle(node).fontFamily),
  ).toMatch(/^-apple-system,/u);
});

test("narrow mouse and touch layouts remain distinct and fit the viewport", async ({
  page,
  browser,
}, testInfo) => {
  await installSettingsFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?settings=appearance");
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(
    dialog.getByRole("combobox", { name: "设置导航", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("tablist")).toBeHidden();
  const theme = dialog.getByRole("button", { name: "主题", exact: true });
  expect(
    await theme.evaluate((node) => node.getBoundingClientRect().height),
  ).toBeLessThan(44);
  expect(
    await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true);
  await dialog.screenshot({
    path: testInfo.outputPath("appearance-narrow-mouse.png"),
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    locale: "zh-CN",
  });
  try {
    const touch = await context.newPage();
    await installSettingsFixture(touch);
    await touch.goto(`${new URL(page.url()).origin}/?settings=appearance`);
    const touchDialog = touch.getByRole("dialog", {
      name: "设置",
      exact: true,
    });
    const touchTheme = touchDialog.getByRole("button", {
      name: "主题",
      exact: true,
    });
    await expect(touchTheme).toBeVisible();
    await expect
      .poll(() =>
        touchTheme.evaluate((node) => node.getBoundingClientRect().height),
      )
      .toBeGreaterThanOrEqual(44);
    expect(
      await touchDialog.evaluate(
        (node) => node.scrollWidth <= node.clientWidth,
      ),
    ).toBe(true);
    await touchDialog.screenshot({
      path: testInfo.outputPath("appearance-touch.png"),
    });
  } finally {
    await context.close();
  }
});

test("archived chats query project/sort before paging and restore without activating the chat", async ({
  page,
}, testInfo) => {
  const fixture = await installSettingsFixture(page);
  await page.goto("/?settings=archived-chats");
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await expect(
    dialog.getByText("Archived design", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("combobox", { name: "归档聊天排序", exact: true })
    .selectOption("created");
  await dialog
    .getByRole("combobox", { name: "按项目筛选", exact: true })
    .selectOption("/fixture");
  await expect.poll(() => fixture.queries.at(-1)?.get("cwd")).toBe("/fixture");
  expect(fixture.queries.at(-1)?.get("sort")).toBe("created");
  const group = dialog.getByRole("button", {
    name: "OpenPI · 1 条归档聊天",
    exact: true,
  });
  await group.click();
  await expect(
    dialog.getByText("Archived design", { exact: true }),
  ).toHaveCount(0);
  await group.click();
  await dialog.screenshot({
    path: testInfo.outputPath("archived-chats-desktop.png"),
  });
  const restore = dialog.getByRole("button", {
    name: "恢复 Archived design",
    exact: true,
  });
  await restore.click();
  await expect(
    dialog.getByText("暂时无法确认恢复结果，请刷新后重试。", { exact: true }),
  ).toBeVisible();
  await expect(restore).toBeEnabled();
  await restore.click();
  await expect(
    dialog.getByText("Archived design", { exact: true }),
  ).toHaveCount(0);
  expect(fixture.posts.at(-1)).toEqual({
    path: "/fixture/archived-design.jsonl",
  });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "OpenPI", exact: true })
      .getByText("Active chat", { exact: true }),
  ).toBeVisible();
});
