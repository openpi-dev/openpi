import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import type { BrowserSettingsStatus } from "../../web/protocol/browser.ts";
import { installThinkingFixture } from "./thinking-e2e-support.ts";

test("browser installation remains reachable by wheel in short and narrow settings windows", async ({
  page,
}, info) => {
  await installThinkingFixture(page);
  const status: BrowserSettingsStatus = {
    config: {
      control: false,
      embedded: true,
      defaultBrowser: "embedded",
      externalBrowsers: [],
    },
    profiles: [],
    browsers: [{ id: "chrome", installed: true }],
    extensionPath: "/Applications/OpenPI/browser-extension/",
    extensionVersion: "0.4.0",
  };
  await page.route("**/api/settings/browser", (route) =>
    route.fulfill({ json: status }),
  );
  for (const width of [1147, 390]) {
    await page.setViewportSize({ width, height: 640 });
    await page.goto("/?settings=browser");
    const dialog = page.getByRole("dialog", { name: "设置", exact: true });
    const panel = dialog.locator("#settings-panel-browser");
    await panel
      .getByRole("button", { name: "设置 OpenPI 内置浏览器", exact: true })
      .click();
    const guide = panel.getByRole("region", {
      name: "连接 OpenPI 内置浏览器",
      exact: true,
    });
    await guide
      .getByRole("button", { name: "第 3 步：添加扩展", exact: true })
      .click();
    const before = await panel.evaluate((element) => element.scrollTop);
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, 2400);
    await expect
      .poll(() => panel.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(before + 20);
    await expect(
      guide.getByRole("button", { name: "已添加，连接 OpenPI", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(
      dialog.getByRole("button", { name: "关闭", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: info.outputPath(`browser-install-scroll-${width}.png`),
    });
    await page.mouse.wheel(0, -2400);
    await expect(
      panel.getByRole("heading", { name: "浏览器", exact: true }),
    ).toBeInViewport({ ratio: 1 });
  }
});

test("separate guide shares live connection state, native family steps and opener cleanup", async ({
  page,
}, info) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "documentPictureInPicture", {
      value: undefined,
    }),
  );
  await installThinkingFixture(page);
  const status: BrowserSettingsStatus = {
    config: {
      control: false,
      embedded: true,
      defaultBrowser: "embedded",
      externalBrowsers: [],
    },
    profiles: [],
    browsers: ["chrome", "edge", "brave", "chromium", "safari", "firefox"].map(
      (id) => ({
        id: id as BrowserSettingsStatus["browsers"][number]["id"],
        installed: true,
      }),
    ),
    extensionPath: "/OpenPI/browser-extension/",
    portableExtensionPath: "/OpenPI/browser-extension-portable/",
    extensionVersion: "0.4.0",
  };
  const writes: unknown[] = [];
  await page.route("**/api/settings/browser", async (route) => {
    if (route.request().method() === "POST") {
      const patch = route.request().postDataJSON();
      writes.push(patch);
      status.config = { ...status.config, ...patch };
    }
    await route.fulfill({ json: status });
  });
  await page.route("**/api/settings/browser/action", (route) =>
    route.fulfill({ json: { opened: true } }),
  );
  await page.goto("/?settings=browser");
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await dialog.getByText("更多浏览器", { exact: true }).click();
  for (const browser of [
    "Chrome",
    "Microsoft Edge",
    "Brave",
    "Chromium",
    "Safari",
    "Firefox",
  ])
    await expect(
      dialog.getByRole("button", { name: `设置 ${browser}`, exact: true }),
    ).toBeVisible();
  await dialog
    .getByRole("button", { name: "设置 Safari", exact: true })
    .click();
  const popupReady = page.waitForEvent("popup");
  await dialog
    .getByRole("button", { name: "打开 Safari 扩展页", exact: true })
    .click();
  const popup = await popupReady;
  const guide = popup.getByRole("region", { name: "连接 Safari", exact: true });
  await expect(guide).toHaveCSS("border-radius", "14px");
  await expect(
    guide.getByRole("heading", { name: "显示 Safari 开发者设置" }),
  ).toBeVisible();
  await expect(
    page.getByText("引导已在独立窗口打开，可以对照浏览器设置逐步完成。"),
  ).toBeVisible();
  await popup.screenshot({ path: info.outputPath("safari-guide-step-2.png") });
  await guide
    .getByRole("button", { name: "已开启，下一步", exact: true })
    .click();
  await expect(
    guide.getByText(status.portableExtensionPath!, { exact: true }),
  ).toBeVisible();
  await popup.screenshot({ path: info.outputPath("safari-guide-step-3.png") });
  expect(
    (
      await new AxeBuilder({ page: popup })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(writes).toEqual([]);
  status.profiles.push({
    id: "safari-test",
    browser: "safari",
    profileId: "test",
    extensionId: "test",
    version: "0.4.0",
    current: true,
    connected: true,
  });
  await expect(
    guide.getByText("连接正常，可选择是否允许 OpenPI 使用。"),
  ).toBeVisible({ timeout: 10_000 });
  await guide
    .getByRole("button", { name: "允许 OpenPI 使用", exact: true })
    .click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ control: true, externalBrowsers: ["safari"] });
  await popup.close();
  await expect(
    dialog.getByRole("region", { name: "连接 Safari", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "设置 Firefox", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "第 2 步：此 Firefox", exact: true })
    .click();
  await expect(
    dialog.getByRole("heading", { name: "选择「此 Firefox」" }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "已选中，下一步", exact: true })
    .click();
  await expect(
    dialog.getByText("/OpenPI/browser-extension-portable/manifest.json", {
      exact: true,
    }),
  ).toBeVisible();
  const secondReady = page.waitForEvent("popup");
  await dialog
    .getByRole("button", { name: "在独立窗口中跟随操作", exact: true })
    .click();
  const second = await secondReady;
  await expect(
    second.getByRole("heading", {
      name: "安装 OpenPI Browser Bridge",
      exact: true,
    }),
  ).toBeVisible();
  await second.screenshot({
    path: info.outputPath("firefox-guide-step-3.png"),
  });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect.poll(() => second.isClosed()).toBe(true);
});

test("browser setup preserves the settings shell, works during a turn and explains installation before granting access", async ({
  page,
}, info) => {
  // The separate window is covered below; this case checks the blocked-popup fallback.
  await page.addInitScript(() => {
    Object.defineProperty(window, "documentPictureInPicture", {
      value: undefined,
    });
    window.open = () => null;
  });
  await installThinkingFixture(page, { runtimeStatus: "running" });
  const status: BrowserSettingsStatus = {
    config: {
      control: false,
      embedded: true,
      defaultBrowser: "embedded",
      externalBrowsers: [],
    },
    profiles: [],
    browsers: [
      { id: "chrome", installed: true },
      { id: "edge", installed: false },
      { id: "brave", installed: false },
      { id: "chromium", installed: true },
    ],
    extensionPath: "/Applications/OpenPI/browser-extension",
    extensionVersion: "0.3.0",
  };
  const writes: unknown[] = [];
  await page.route("**/api/settings/browser", async (route) => {
    if (route.request().method() === "POST") {
      const patch = route.request().postDataJSON();
      writes.push(patch);
      status.config = { ...status.config, ...patch };
    }
    await route.fulfill({ json: status });
  });
  const actions: unknown[] = [];
  await page.route("**/api/settings/browser/action", async (route) => {
    actions.push(route.request().postDataJSON());
    await route.fulfill({ json: { opened: true } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  await dialog.getByRole("tab", { name: "浏览器", exact: true }).click();
  const panel = dialog.locator("#settings-panel-browser");
  await expect(
    panel.getByRole("heading", { name: "浏览器", exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByRole("switch", { name: "浏览器控制", exact: true }),
  ).toBeEnabled();
  await dialog.screenshot({
    path: info.outputPath("browser-settings-light.png"),
  });
  const accessibility = await new AxeBuilder({ page })
    .include("#settings-panel-browser")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await panel.getByRole("button", { name: "设置 Chrome", exact: true }).click();
  const guide = panel.getByRole("region", { name: "连接 Chrome", exact: true });
  await guide.scrollIntoViewIfNeeded();
  await expect(
    guide.getByRole("heading", { name: "打开 Chrome 扩展页", exact: true }),
  ).toBeVisible();
  await dialog.screenshot({
    path: info.outputPath("browser-settings-step-1.png"),
  });
  await guide
    .getByRole("button", { name: "打开 Chrome 扩展页", exact: true })
    .click();
  await expect(
    guide.getByRole("heading", { name: "开启「开发者模式」", exact: true }),
  ).toBeVisible();
  await dialog.screenshot({
    path: info.outputPath("browser-settings-step-2.png"),
  });
  expect(actions).toEqual([{ browser: "chrome", action: "manage" }]);
  await guide
    .getByRole("button", { name: "已开启，下一步", exact: true })
    .click();
  await expect(
    guide.getByRole("heading", {
      name: "安装 OpenPI Browser Bridge",
      exact: true,
    }),
  ).toBeVisible();
  await expect(guide.getByText(status.extensionPath)).toBeVisible();
  await guide.scrollIntoViewIfNeeded();
  await dialog.screenshot({
    path: info.outputPath("browser-settings-step-3.png"),
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await guide
    .getByRole("button", { name: "复制扩展文件夹路径", exact: true })
    .click();
  await expect(
    guide.getByRole("button", { name: "已复制路径", exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    status.extensionPath,
  );
  await guide.getByRole("button", { name: "打开文件夹", exact: true }).click();
  await expect(
    guide.getByRole("button", { name: "已添加，连接 OpenPI", exact: true }),
  ).toBeEnabled();
  await guide
    .getByRole("button", { name: "已添加，连接 OpenPI", exact: true })
    .click();
  await expect(
    guide.getByRole("heading", { name: "连接 OpenPI", exact: true }),
  ).toBeVisible();
  await dialog.screenshot({
    path: info.outputPath("browser-settings-step-4.png"),
  });
  expect(actions).toEqual([
    { browser: "chrome", action: "manage" },
    { browser: "chrome", action: "folder" },
    { browser: "chrome", action: "connect" },
  ]);
  await expect(
    guide.getByRole("button", { name: "允许 OpenPI 使用", exact: true }),
  ).toHaveCount(0);
  expect(writes).toEqual([]);
  // Exercise the longest step at narrow widths and in dark mode.
  await guide
    .getByRole("button", { name: "第 3 步：添加扩展", exact: true })
    .click();
  await page.emulateMedia({ colorScheme: "dark" });
  await dialog.screenshot({
    path: info.outputPath("browser-settings-guide-dark.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await guide.scrollIntoViewIfNeeded();
  await dialog.screenshot({
    path: info.outputPath("browser-settings-guide-mobile.png"),
  });
  expect(
    await panel.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(false);
  const guideAccessibility = await new AxeBuilder({ page })
    .include("#settings-panel-browser")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(guideAccessibility.violations).toEqual([]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "light" });
  await guide
    .getByRole("button", { name: "第 4 步：连接", exact: true })
    .click();
  status.profiles = [
    {
      id: "test-connection",
      browser: "chrome",
      profileId: "test-profile",
      extensionId: "test-extension",
      version: "0.3.0",
      connected: true,
      current: true,
    },
  ];
  await expect(
    guide.getByRole("button", { name: "允许 OpenPI 使用", exact: true }),
  ).toBeVisible({ timeout: 6000 });
  expect(writes).toEqual([]);
  await dialog.screenshot({
    path: info.outputPath("browser-settings-ready.png"),
  });
  await guide.getByRole("button", { name: "收起浏览器设置引导" }).click();
  await panel
    .getByRole("switch", { name: "允许使用 Chrome", exact: true })
    .click();
  await expect(
    panel.getByRole("switch", { name: "允许使用 Chrome", exact: true }),
  ).toBeEnabled();
  await panel
    .getByRole("combobox", { name: "默认浏览器" })
    .selectOption("chrome");
  await expect(
    panel.getByRole("combobox", { name: "默认浏览器" }),
  ).toBeEnabled();
  await panel.getByRole("switch", { name: "浏览器控制", exact: true }).click();
  await expect(
    panel.getByRole("switch", { name: "浏览器控制", exact: true }),
  ).toBeChecked();
  expect(writes).toEqual([
    { externalBrowsers: ["chrome"] },
    { defaultBrowser: "chrome" },
    { control: true },
  ]);
  status.profiles = [
    {
      id: "test-connection",
      browser: "chrome",
      profileId: "test-profile",
      extensionId: "test-extension",
      version: "0.3.0",
      connected: true,
      current: true,
    },
  ];
  await expect(
    panel.getByRole("button", { name: "管理 Chrome", exact: true }),
  ).toBeVisible({ timeout: 6000 });
  await dialog.screenshot({
    path: info.outputPath("browser-settings-connected.png"),
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await dialog.screenshot({
    path: info.outputPath("browser-settings-dark.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    panel.getByRole("combobox", { name: "默认浏览器" }),
  ).toBeVisible();
  await dialog.screenshot({
    path: info.outputPath("browser-settings-mobile.png"),
  });
  const overflows = await panel.evaluate(
    (element) => element.scrollWidth > element.clientWidth,
  );
  expect(overflows).toBe(false);
  await panel.getByRole("switch", { name: "浏览器控制", exact: true }).click();
  await expect(
    panel.getByRole("switch", { name: "浏览器控制", exact: true }),
  ).not.toBeChecked();
  expect(writes.at(-1)).toEqual({ control: false });
});
