import { expect, test } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import type { BrowserSettingsStatus } from "../../web/protocol/browser.ts";
import { installThinkingFixture } from "./thinking-e2e-support.ts";

test("browser setup preserves the settings shell, works during a turn and explains installation before granting access", async ({
  page,
}, info) => {
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
    guide.getByText("安装 Browser Bridge", { exact: true }),
  ).toBeVisible();
  await dialog.screenshot({
    path: info.outputPath("browser-settings-install.png"),
  });
  await guide
    .getByRole("button", { name: "打开安装位置", exact: true })
    .click();
  expect(actions).toEqual([{ browser: "chrome", action: "install" }]);
  expect(writes).toEqual([]);
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
